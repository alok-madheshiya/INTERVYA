// The call itself: lobby, then the panel grid and the turn loop.
//
// The lobby is not decoration. Avatars have to download and build (a few
// seconds) and Whisper has to load, and a real video call has a "waiting for the
// host" phase anyway — so the work hides inside something that reads as realism.

import { PanelGrid } from "../panel/PanelGrid.js";
import { Listener, hotwordsFrom } from "../audio/stt.js";
import { Director, buildSession } from "../engine/director.js";
import { castPanel } from "../panel/identities.js";
import { cleanError } from "../util/errors.js";

const $ = (id) => document.getElementById(id);

export class CallScreen {
  constructor({ choice, speech, data, onFinished }) {
    this.choice = choice;
    this.speech = speech;
    this.data = data;
    this.onFinished = onFinished;
  }

  #lobby(text, sub = "") {
    $("lobby").innerHTML = `
      <div class="lobbyWrap">
        <div class="lobbyCard">
          <div class="lobbyPulse"><i></i><i></i><i></i></div>
          <div class="lobbyCo">${this.choice.company.name}</div>
          <div class="lobbyRound">${this.choice.round.name}</div>
          <div class="lobbyStatus"><i class="dot work"></i><span>${text}</span></div>
          <div class="sub">${sub}</div>
        </div>
      </div>`;
  }

  async start(show) {
    const { company, role, round, candidate, stream } = this.choice;
    show("lobby");
    this.#lobby("Waiting for the host to let you in…", "Setting up the interview room");

    const session = buildSession({
      company, role, round, candidate,
      personas: this.data.personas,
    });
    // Carried into the prompt so the panel grades against the right bar.
    session.roleCtc = this.choice.roleCtc ?? null;
    // Faces are the fixed point: the name, gender and voice come from the
    // identity, and the persona only supplies behaviour. Assigning avatars after
    // the fact is what put male names on female faces.
    session.roster = castPanel(session.roster, round.type, Math.random);

    // --- build the room ---
    $("call").innerHTML = `
      <div class="callRoot">
        <div class="grid" id="panelGrid"></div>
        <div class="caption" id="caption"></div>
        <div class="callBar">
          <div class="callInfo">
            <b>${company.name}</b> · ${round.name}
            <span class="sub" id="callStatus"></span>
          </div>
          <div class="callMid">
            <div class="levelWrap"><i id="callLevel"></i></div>
            <button id="doneTalking" disabled>Done (Space)</button>
          </div>
          <button id="leaveCall" class="danger">Leave</button>
        </div>
      </div>`;

    const panel = new PanelGrid($("panelGrid"), session.roster);
    await panel.mount((name) => this.#lobby("Waiting for the host to let you in…", `${name} joining…`));
    panel.addSelf(stream, candidate.name || "You");

    const listener = new Listener({
      model: (await window.agent.config.get()).stt?.model ?? "base",
      hotwords: hotwordsFrom(candidate.name, candidate.resume_text),
    });
    this.#lobby("Waiting for the host to let you in…", "Loading speech recognition…");
    await listener.warmUp();

    this.panel = panel;
    this.listener = listener;

    // --- wire the loop ---
    const director = new Director({
      session, panel, speech: this.speech, listener,
      ui: {
        onStatus: (t) => { $("callStatus").textContent = t; },
        onListening: (on) => {
          $("doneTalking").disabled = !on;
          $("caption").classList.toggle("you", on);
        },
        onLevel: (v) => { $("callLevel").style.width = Math.min(100, v * 260) + "%"; },
        onSpeaker: (member, text) => {
          $("caption").innerHTML = `<b>${member?.name ?? ""}</b> ${text}`;
        },
        onPanelText: (t) => { $("caption").innerHTML = `<i>${t}</i>`; },
        onAnswer: (heard) => {
          $("caption").innerHTML = `<b>You</b> ${heard.text || "(said nothing)"}`;
          if (heard.fixes?.length) console.log("[stt] corrected:", heard.fixes);
        },
        // Nothing here ends the interview on its own. Gemini's free tier runs
        // out mid-session often, and the other faults — a dropped worker, a
        // reply that would not parse — are just as survivable: one lost
        // question against a lost transcript is not a close call. So both
        // arrive as the same two buttons, worded for what actually happened.
        onStalled: (e, { retry, end, recoverable }) => {
          $("callStatus").textContent = "";
          const cap = $("caption");
          cap.classList.add("stalled");
          const head = recoverable
            ? "The panel has stopped"
            : "Something went wrong on this question";
          const hint = recoverable
            ? ""
            : `<div class="sub">Trying again costs you this one question. ` +
              `Everything said so far is kept either way.</div>`;
          cap.innerHTML =
            `<b>${head}</b> ${cleanError(e)}${hint}` +
            `<div class="acts">` +
            `<button id="stallRetry" class="primary">Try again</button>` +
            `<button id="stallEnd" class="ghost">End the interview</button>` +
            `</div>`;
          const clear = () => { cap.classList.remove("stalled"); cap.innerHTML = ""; };
          $("stallRetry").onclick = () => { clear(); retry(); };
          $("stallEnd").onclick = () => { clear(); end(); };
        },
        // One line lost its audio. Say so once, quietly, and carry on — the
        // words are already in the caption.
        onVoiceLost: () => {
          $("callStatus").textContent = "the panel's audio dropped for that line";
        },
        onError: (e) => {
          $("callStatus").textContent = "";
          $("caption").innerHTML =
            `<b style="color:#f85149">The interview has stopped</b> ${cleanError(e)}`;
        },
        onFinished: (s) => this.onFinished?.(s),
      },
    });
    this.director = director;

    $("doneTalking").onclick = () => listener.stop();
    $("leaveCall").onclick = () => {
      // Leaving early still earns a report — it is graded on what was said, and
      // walking out with nothing is the one outcome that teaches nothing.
      $("leaveCall").disabled = true;
      $("callStatus").textContent = "wrapping up the interview…";
      director.stop();
    };
    this.#keyHandler = (e) => {
      if (e.code === "Space" && !$("doneTalking").disabled) {
        e.preventDefault();
        listener.stop();
      }
    };
    window.addEventListener("keydown", this.#keyHandler);

    // A beat in the lobby before the panel appears — joining a call is never
    // instantaneous, and the pause sets the nerves the whole thing is for.
    await new Promise((r) => setTimeout(r, 1200));
    show("call");

    return director.run(stream);
  }

  #keyHandler = null;

  stop() {
    this.director?.stop();
    this.listener?.dispose();
    this.panel?.dispose();
    if (this.#keyHandler) window.removeEventListener("keydown", this.#keyHandler);
  }
}
