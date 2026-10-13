// Talk mode: one character, one conversation, nothing being scored.
//
// Deliberately not the Director. That loop exists to run a panel — rotation,
// a private ledger, arcs, an end-of-round verdict — and none of it applies to
// two people talking. What is shared is the machinery underneath: the same
// avatar renderer, the same TTS, the same VAD, the same streaming IPC.
//
// The one rule that differs: here the person can interrupt. An interviewer
// talking over you is realism; a friend who will not stop talking is a bug.

import { PanelGrid } from "../panel/PanelGrid.js";
import { Listener, hotwordsFrom } from "../audio/stt.js";
import { hindiVoice, SystemSpeech } from "../audio/systemVoice.js";
import { cleanError } from "../util/errors.js";

const $ = (id) => document.getElementById(id);

/** Failures that clear on their own — see director.js for the same list. */
const RECOVERABLE = /limit|quota|429|503|busy|overload/i;

export class TalkScreen {
  /**
   * @param {object} deps
   * @param {object} deps.choice  { character, topic, candidate, stream }
   * @param {object} deps.speech
   * @param {() => void} deps.onLeave
   */
  constructor({ choice, speech, onLeave }) {
    this.choice = choice;
    this.speech = speech;
    this.onLeave = onLeave;
    this.stopped = false;
    this.chat = {
      character: choice.character,
      topic: choice.topic,
      candidate: choice.candidate,
      language: choice.language ?? "hinglish",
      history: [],
    };
  }

  /**
   * Decides who speaks, and therefore what script the model must write in.
   *
   * Kokoro has Hindi voice packs but HeadTTS has no Hindi phoneme module, so
   * Hindi through it is English pronunciation in a Hindi voice. A Windows
   * Hindi voice is a real one — when the machine has it, use it, and ask for
   * Devanagari because that is what it reads. Without it, fall back to Kokoro
   * and romanised Hindi, which at least makes a sound.
   */
  async #chooseVoice() {
    if (this.chat.language !== "hindi") return;
    const voice = await hindiVoice().catch(() => null);
    if (voice) {
      this.speech = new SystemSpeech(voice);
      this.chat.script = "deva";
      console.log("[talk] Hindi through the system voice:", voice.name);
    } else {
      this.chat.script = "latin";
      console.warn("[talk] no Hindi system voice — falling back to romanised Hindi");
    }
  }

  async start(show) {
    const { character, candidate, stream } = this.choice;
    await this.#chooseVoice();
    show("lobby");
    $("lobby").innerHTML = `
      <div class="lobbyWrap"><div class="lobbyCard">
        <div class="lobbyPulse"><i></i><i></i><i></i></div>
        <div class="lobbyCo">${character.name}</div>
        <div class="lobbyRound">${character.role}</div>
        <div class="lobbyStatus"><i class="dot work"></i><span>Connecting the call&hellip;</span></div>
      </div></div>`;

    $("talk").innerHTML = `
      <div class="callRoot talkRoot">
        <div class="grid talkGrid" id="talkGrid"></div>
        <div class="caption" id="talkCaption"></div>
        <div class="callBar">
          <div class="callInfo">
            <b>${character.name}</b> · ${character.role}
            <span class="sub" id="talkStatus"></span>
          </div>
          <div class="callMid">
            <div class="levelWrap"><i id="talkLevel"></i></div>
            <button id="talkDone" disabled>Done (Space)</button>
          </div>
          <button id="talkLeave" class="danger">Leave</button>
        </div>
      </div>`;

    // PanelGrid takes a roster; a roster of one is still a roster.
    const member = {
      id: character.id, name: character.name, title: character.role,
      avatarId: character.id, voice: character.voice, body: character.body,
    };
    const panel = new PanelGrid($("talkGrid"), [member]);
    await panel.mount(() => {});
    panel.addSelf(stream, candidate.name || "You");
    this.panel = panel;

    // Hindi needs the multilingual model: the .en builds have no Hindi tokens
    // and will map Hindi sounds onto whichever English words come closest.
    // Hinglish stays on .en, which is what the interviews already use and what
    // is mirrored into models/ — only Hindi pays the download.
    const hindi = this.chat.language === "hindi";
    const listener = new Listener({
      model: hindi ? "multi" : ((await window.agent.config.get()).stt?.model ?? "base"),
      language: hindi ? "hi" : null,
      hotwords: hotwordsFrom(candidate.name, candidate.resume_text),
    });
    await listener.warmUp();
    this.listener = listener;

    $("talkDone").onclick = () => listener.stop();
    $("talkLeave").onclick = () => {
      $("talkLeave").disabled = true;
      this.stop();
    };
    this.#keyHandler = (e) => {
      if (e.code === "Space" && !$("talkDone").disabled) {
        e.preventDefault();
        listener.stop();
      }
    };
    window.addEventListener("keydown", this.#keyHandler);

    await new Promise((r) => setTimeout(r, 900));
    show("talk");
    return this.#loop(stream);
  }

  #say(who, text) {
    $("talkCaption").innerHTML = `<b>${who}</b> ${text}`;
  }

  /** One reply from the character: model call, then speak it. */
  async #turn(userText) {
    const { character } = this.choice;
    let streamedText = "";
    this.panel.setThinking(character.id, true);
    $("talkStatus").textContent = "thinking…";

    const res = await window.agent.runChat({
      chat: this.chat,
      userText,
      onStatus: (t) => { streamedText = ""; $("talkStatus").textContent = t; },
      onChunk: (c) => {
        streamedText += c;
        $("talkStatus").textContent = "";
        $("talkCaption").innerHTML = `<i>${streamedText}</i>`;
      },
    });

    this.panel.setThinking(character.id, false);
    if (userText !== null) this.chat.history.push({ role: "user", content: userText });
    this.chat.history.push({ role: "assistant", content: res.spoken });

    // Talk has no ledger, so the transcript is the only memory there is. Left
    // to grow it eventually costs more per turn than the conversation is worth,
    // and the oldest turns are the ones nobody refers back to.
    if (this.chat.history.length > 40) this.chat.history.splice(0, 8);

    this.#say(character.name, res.spoken);
    this.panel.setSpeaking(character.id);
    const head = this.panel.tiles.get(character.id)?.head;
    if (head) {
      await this.speech.speak(head, character.voice, res.spoken, {
        cancelled: () => this.stopped,
      });
    }
    this.panel.setSpeaking(null);
  }

  async #loop(stream) {
    try {
      await this.#turnOrAsk(null);

      while (!this.stopped) {
        $("talkStatus").textContent = "your turn — go ahead";
        $("talkDone").disabled = false;
        this.panel.setSpeaking("self");

        const heard = await this.listener.listen(stream, {
          onLevel: (v) => { $("talkLevel").style.width = Math.min(100, v * 260) + "%"; },
        });

        this.panel.setSpeaking(null);
        $("talkDone").disabled = true;
        if (this.stopped) break;

        this.#say("You", heard.text || "(said nothing)");
        await this.#turnOrAsk(heard.text);
      }
    } catch (e) {
      console.error("[talk] stopped:", e);
      $("talkStatus").textContent = "";
      $("talkCaption").innerHTML =
        `<b style="color:#f85149">The conversation stopped</b> ${cleanError(e)}`;
    }
  }

  /** Same bargain the interview makes: a busy server is the user's call, not ours. */
  async #turnOrAsk(userText) {
    for (;;) {
      try {
        return await this.#turn(userText);
      } catch (e) {
        if (this.stopped) return;
        if (!RECOVERABLE.test(e?.message ?? "")) throw e;
        const again = await new Promise((resolve) => {
          this.#resumeStall = resolve;
          const cap = $("talkCaption");
          cap.classList.add("stalled");
          cap.innerHTML =
            `<b>Gemini has stopped</b> ${cleanError(e)}` +
            `<div class="acts">` +
            `<button id="talkRetry" class="primary">Try again</button>` +
            `<button id="talkEnd" class="ghost">End the conversation</button></div>`;
          const clear = () => { cap.classList.remove("stalled"); cap.innerHTML = ""; };
          $("talkRetry").onclick = () => { clear(); this.#resumeStall = null; resolve(true); };
          $("talkEnd").onclick = () => { clear(); this.#resumeStall = null; resolve(false); };
        });
        if (!again || this.stopped) { this.stop(); return; }
      }
    }
  }

  #keyHandler = null;
  #resumeStall = null;

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    try { this.listener?.stop(); } catch { /* not listening */ }
    try { this.speech.cancel?.(); } catch { /* nothing playing */ }
    this.#resumeStall?.(false);
    this.#resumeStall = null;
    if (this.#keyHandler) window.removeEventListener("keydown", this.#keyHandler);
    this.listener?.dispose();
    this.panel?.dispose();
    this.onLeave?.();
  }
}
