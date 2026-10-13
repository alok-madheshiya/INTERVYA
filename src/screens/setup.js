// The setup screen — and, quietly, the reason the app feels fast.
//
// Building the TTS WebGPU session costs 86-121 s (measured, Phase 0). Rather
// than showing a spinner for two minutes, we start it the moment the app opens
// and spend that time on work the candidate has to do anyway: pick a company,
// paste a resume, test the mic. By the time "Join" matters, the room is warm.

import { VOICES } from "../audio/tts.js";
import { IDENTITIES } from "../panel/identities.js";
import { cleanError } from "../util/errors.js";
import { hindiVoice } from "../audio/systemVoice.js";

const $ = (id) => document.getElementById(id);

/**
 * The one key box.
 *
 * There used to be a box per provider, which meant knowing whose key you had
 * before you could paste it. Now there is one, and the main process works out
 * the rest — so the id here is the box's, not any provider's.
 */
const KEY_BOX = "llm";

/** Segments in the mic level meter — enough to show movement, few enough to read. */
const METER_SEGMENTS = 14;

/**
 * Monogram hues. A stable colour per company makes the grid scannable by sight
 * rather than by reading fifty labels.
 *
 * Picked from a list instead of taken modulo 360: a free hash lands on magenta
 * and violet as often as anything else, and a wall of purple tiles is exactly
 * the look this palette exists to avoid. These are all warm-or-cool but never
 * violet, and far enough apart to tell neighbours apart.
 */
const MONOGRAM_HUES = [190, 205, 222, 240, 168, 148, 118, 88, 52, 36, 20, 6];

/** Deterministic — the same company keeps its colour across launches. */
function hueOf(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 4096;
  return MONOGRAM_HUES[h % MONOGRAM_HUES.length];
}

/**
 * What Talk mode can be held in.
 *
 * Hindi is written in Roman letters rather than Devanagari everywhere in this
 * app — not a style choice: the voice engine ships an English and a Finnish
 * phoneme module and nothing else, so Devanagari would be silent.
 */
const TALK_LANGUAGES = [
  { id: "hinglish", label: "Hinglish",
    blurb: "English with Hindi mixed in — how most people actually talk" },
  { id: "english", label: "English",
    blurb: "Plain English throughout, for interview practice" },
  // Deliberately says nothing about script: which one gets used depends on
  // whether this machine has a Hindi voice, and the note under the picker is
  // where that is explained.
  { id: "hindi", label: "Hindi",
    blurb: "Hindi throughout, with technical words left in English" },
];

const EN_NOTE = "Speech recognition uses the English model, same as the interviews.";

/**
 * What to say under the language picker.
 *
 * Hindi is the only one with anything to report, and what it reports depends on
 * whether Windows has a Hindi voice: without one the app can still hold the
 * conversation, but it will sound like English pronouncing Hindi, which is
 * exactly the complaint this is here to head off before the call rather than
 * during it.
 */
function langNote(language, voiceName) {
  if (language !== "hindi") return EN_NOTE;
  const stt = "Understanding your Hindi needs the multilingual speech model — " +
              "about 250 MB, downloaded once on your first Hindi conversation.";
  return voiceName
    ? `Hindi voice found: ${voiceName}. ${stt}`
    : "No Hindi voice is installed, so Hindi would be spoken in an English " +
      "accent. To fix it: Windows Settings \u2192 Time & language \u2192 Language & region " +
      "\u2192 Add a language \u2192 हिन्दी, tick Speech, then restart this app. " + stt;
}

const MODES = [
  { id: "interview", icon: "▶", title: "Mock interview",
    blurb: "Full panel, cross-questions, and a report at the end" },
  { id: "talk", icon: "●", title: "Talk with an agent",
    blurb: "A relaxed conversation with one person — nothing is scored" },
];

/** "3.36 LPA" when a track pays one number, "26-45 LPA" when it is a band. */
function money([min, max]) {
  const n = (v) => String(Number.isInteger(v) ? v : +v.toFixed(2));
  return min === max ? `₹${n(min)} LPA` : `₹${n(min)}–${n(max)} LPA`;
}

const CATEGORIES = [
  { id: "service", label: "Service-based" },
  { id: "product", label: "Product" },
  { id: "startup", label: "Startups" },
  { id: "gcc", label: "GCC / Consulting" },
];

export class SetupScreen {
  /**
   * @param {object} deps
   * @param {object} deps.data      companies.json
   * @param {object} deps.config    current public config
   * @param {import("../audio/tts.js").Speech} deps.speech
   * @param {(choice: object) => void} deps.onJoin
   */
  constructor({ data, config, speech, onJoin }) {
    this.data = data;
    this.config = config;
    this.speech = speech;
    this.onJoin = onJoin;

    this.mode = config.mode === "talk" ? "talk" : "interview";
    this.category = "service";
    this.companyId = config.interview?.companyId || "tcs";
    this.roleTitle = config.interview?.role || null;
    this.characterId = config.talk?.characterId || IDENTITIES[0].id;
    this.language = config.talk?.language || TALK_LANGUAGES[0].id;
    this.hindiVoiceName = null;
    // Asynchronous: Chromium fills the voice list after the page loads, so the
    // note is written once now and rewritten when the answer arrives.
    hindiVoice()
      .then((v) => { this.hindiVoiceName = v?.name ?? null; this.#updateLangNote(); })
      .catch(() => {});
    this.avOk = false;
    this.stream = null;

    this.#buildMeter();
    this.#restore();
    this.#renderModes();
    this.#renderChars();
    this.#renderLanguages();
    this.#renderCategories();
    this.#renderCompanies();
    this.#bind();
    this.#watchWarmUp();
    this.#refreshJoin();
  }

  // --- persisted values -----------------------------------------------------
  #restore() {
    const c = this.config;
    $("name").value = c.candidate?.name ?? "";
    $("resume").value = c.candidate?.resume_text ?? "";
    $("topic").value = c.talk?.topic ?? "";
    $("sttModel").value = c.stt?.model ?? "base";
    this.#showKey(c);

    const found = this.data.companies.find((x) => x.id === this.companyId);
    if (found) this.category = found.category;
  }

  #save(patch) {
    this.config = null;   // stale after a write; nothing reads it afterwards
    return window.agent.config.set(patch);
  }

  // --- mode ----------------------------------------------------------------
  /**
   * Interview, or a plain conversation. Everything below step 1 is shared —
   * same mic, same key, same warm-up — so the switch only changes what the
   * first card asks for.
   */
  #renderModes() {
    $("modes").replaceChildren(
      ...MODES.map((m) => {
        const b = document.createElement("button");
        b.className = "mode" + (m.id === this.mode ? " on" : "");
        b.innerHTML =
          `<span class="modeIcon">${m.icon}</span>` +
          `<span class="modeText"><b>${m.title}</b><small>${m.blurb}</small></span>`;
        b.onclick = () => {
          this.mode = m.id;
          this.#renderModes();
          this.#persist();
          this.#refreshJoin();
        };
        return b;
      })
    );
    this.#applyMode();
  }

  #applyMode() {
    document.getElementById("setup").dataset.mode = this.mode;
    $("step1Title").textContent =
      this.mode === "talk" ? "Who to talk to" : "Company and role";
    $("join").textContent = this.mode === "talk" ? "Start talking" : "Join interview";
  }

  // --- characters (talk mode) ----------------------------------------------
  #renderChars() {
    $("chars").replaceChildren(
      ...IDENTITIES.map((c, i) => {
        const b = document.createElement("button");
        b.className = "char" + (c.id === this.characterId ? " on" : "");
        b.style.setProperty("--i", i);
        b.dataset.id = c.id;
        const tags = (c.good_for ?? []).map((g) => `<i>${g}</i>`).join("");
        b.innerHTML =
          `<span class="charTop"><b>${c.name}</b><small>${c.role}</small></span>` +
          `<span class="charVibe">${c.vibe}</span>` +
          `<span class="charTags">${tags}</span>`;
        b.onclick = () => {
          this.characterId = c.id;
          for (const el of $("chars").children) {
            el.classList.toggle("on", el.dataset.id === c.id);
          }
          this.#persist();
        };
        return b;
      })
    );
  }

  get character() {
    return IDENTITIES.find((c) => c.id === this.characterId) ?? IDENTITIES[0];
  }

  // --- company picking ------------------------------------------------------
  #renderCategories() {
    $("cats").replaceChildren(
      ...CATEGORIES.map((c) => {
        const b = document.createElement("button");
        b.textContent = c.label;
        b.className = c.id === this.category ? "on" : "";
        b.onclick = () => {
          this.category = c.id;
          this.#renderCategories();
          this.#renderCompanies();
        };
        return b;
      })
    );
  }

  /**
   * The company's real mark, or its initials if we have no mark for it.
   *
   * The logo sits on a light tile because these are brand marks drawn for
   * white paper — TCS, Deloitte, Goldman and PwC are all but black, and on the
   * app's own background they would simply not be there.
   */
  #markFor(c) {
    const file = this.data.logos?.[c.id];
    if (file) {
      return `<span class="mark"><img src="/assets/logos/${file}" alt="" ` +
             `onerror="this.parentNode.classList.add('failed')"></span>`;
    }
    const initials = c.name.replace(/[^A-Za-z ]/g, "").split(/\s+/)
      .filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    return `<span class="mono" style="--h:${hueOf(c.id)}">${initials}</span>`;
  }

  #renderLanguages() {
    $("langs").replaceChildren(
      ...TALK_LANGUAGES.map((l, i) => {
        const b = document.createElement("button");
        b.className = "lang" + (l.id === this.language ? " on" : "");
        b.style.setProperty("--i", i);
        b.dataset.id = l.id;
        b.innerHTML = `<b>${l.label}</b><small>${l.blurb}</small>`;
        b.onclick = () => {
          this.language = l.id;
          // Only toggle the class: re-rendering would replay every entrance
          // animation in the row on each click.
          for (const el of $("langs").children) {
            el.classList.toggle("on", el.dataset.id === l.id);
          }
          this.#updateLangNote();
          this.#persist();
        };
        return b;
      })
    );
    this.#updateLangNote();
  }

  #updateLangNote() {
    const el = $("langNote");
    if (el) el.textContent = langNote(this.language, this.hindiVoiceName);
  }

  #renderCompanies() {
    const list = this.data.companies.filter((c) => c.category === this.category);
    $("companies").replaceChildren(
      ...list.map((c, i) => {
        const b = document.createElement("button");
        b.className = "co" + (c.id === this.companyId ? " on" : "");
        // --i staggers the entrance animation, so switching category deals the
        // cards out instead of swapping the whole grid in one frame.
        b.style.setProperty("--i", i);
        b.dataset.id = c.id;
        const bars = Array.from({ length: 5 },
          (_, n) => `<i class="${n < c.difficulty ? "f" : ""}"></i>`).join("");
        b.innerHTML =
          this.#markFor(c) +
          `<span class="coText"><b>${c.name}</b><span class="diff">${bars}</span></span>`;
        b.title = `${c.name} — difficulty ${c.difficulty}/5`;
        b.onclick = () => this.#pick(c.id);
        return b;
      })
    );
    if (!list.some((c) => c.id === this.companyId) && list[0]) this.#pick(list[0].id);
    else this.#renderRounds();
  }

  #pick(id) {
    this.companyId = id;
    // Not #renderCompanies(): rebuilding the grid replays every card's entrance
    // animation, so every click would flash the whole list. Only the selection
    // changed, so only the selection is touched.
    for (const el of $("companies").children) {
      el.classList.toggle("on", el.dataset.id === id);
    }
    this.#renderRounds();
  }

  get company() {
    return this.data.companies.find((c) => c.id === this.companyId);
  }

  /**
   * The role tracks a company actually hires into, with pay.
   *
   * This is not decoration: at TCS, Ninja and Prime are different interviews at
   * a different bar, and the number is the clearest way to say which one you are
   * walking into. The band goes to the panel prompt too.
   */
  #renderRoles() {
    const co = this.company;
    const roles = co?.roles ?? [];
    if (!roles.some((r) => r.title === this.roleTitle)) this.roleTitle = roles[0]?.title ?? null;

    $("roles").replaceChildren(
      ...roles.map((r, i) => {
        const b = document.createElement("button");
        b.className = "role" + (r.title === this.roleTitle ? " on" : "");
        b.style.setProperty("--i", i);
        b.dataset.title = r.title;
        b.innerHTML =
          `<span class="roleTop"><b>${r.title}</b><span class="ctc">${money(r.ctc)}</span></span>` +
          (r.note ? `<span class="roleNote">${r.note}</span>` : "");
        b.onclick = () => {
          this.roleTitle = r.title;
          for (const el of $("roles").children) {
            el.classList.toggle("on", el.dataset.title === r.title);
          }
          this.#persist();
        };
        return b;
      })
    );
    $("salaryNote").textContent = this.data.salary_note ?? "";
  }

  get role() {
    return this.company?.roles?.find((r) => r.title === this.roleTitle) ?? this.company?.roles?.[0];
  }

  #renderRounds() {
    const co = this.company;
    if (!co) return;
    this.#renderRoles();

    // Rounds marked `simulated: false` are online tests taken on a coding
    // platform — there is no panel to sit in front of, so they are not offered.
    const rounds = co.rounds.filter((r) => r.simulated !== false);
    $("round").replaceChildren(
      ...rounds.map((r) => {
        const o = document.createElement("option");
        o.value = r.id;
        o.textContent = `${r.name} · ${r.minutes} min`;
        return o;
      })
    );
    const saved = this.config?.interview?.roundId;
    if (saved && rounds.some((r) => r.id === saved)) $("round").value = saved;

    $("coNote").textContent = co.signature_behaviour || co.panel_style || "";
    this.#syncSteps();
  }

  // --- key, a/v, warm-up ----------------------------------------------------
  #setResumeState(cls, text) {
    $("resumeDot").className = "dot " + cls;
    $("resumeText").textContent = text;
  }

  /**
   * Loads a resume from a file instead of the clipboard.
   *
   * The heavy lifting is in the main process: it holds the key that a scan or a
   * photo needs reading with, and the renderer only ever sees the path and the
   * text that comes back.
   */
  async #uploadResume() {
    const picked = await window.agent.pickResume();
    if (!picked) return;

    const existing = $("resume").value.trim();
    // Overwriting something the candidate typed themselves is not ours to do
    // silently.
    if (existing && !window.confirm(
      "Replace what is already in the resume box with the contents of " + picked.name + "?"
    )) return;

    const btn = $("pickResume");
    btn.disabled = true;
    this.#setResumeState("work", `reading ${picked.name}…`);
    try {
      const out = await window.agent.readResume(
        picked.path, (text) => this.#setResumeState("work", text));
      $("resume").value = out.text;
      this.#persist();
      this.#setResumeState("ok", `${out.name} — ${out.how}`);
    } catch (e) {
      this.#setResumeState("bad", cleanError(e));
    } finally {
      btn.disabled = false;
    }
  }

  #setKeyState(cls, text) {
    $(`dot_${KEY_BOX}`).className = "dot " + cls;
    $(`text_${KEY_BOX}`).textContent = text;
  }

  /**
   * What the saved key turned out to be, in one line under the box.
   *
   * Worth the line: the candidate pasted a string of characters and never said
   * whose it was, so the app saying "Groq — llama-3.1-8b-instant" back to them
   * is the only confirmation that it understood.
   */
  #showKey(config) {
    const c = config ?? this.config ?? {};
    const a = c.active;
    this.#setKeyState(a ? "ok" : "", a ? "key saved" : "no key set");

    const who = $(`who_${KEY_BOX}`);
    who.replaceChildren();
    if (!a) return;

    const model = a.model ?? a.turn?.[0];
    who.append(`Using ${a.name ?? a.id}${model ? ` — ${model}` : ""}`);
    if (a.turn?.length > 1) who.append(`, falling back to ${a.turn.slice(1).join(", ")}`);
    if (a.note) who.append(` (saved, but it would not answer just now: ${a.note})`);

    // Other keys already on this machine. One click to switch rather than
    // pasting a key the app has had all along.
    const others = (c.providers ?? []).filter((id) => c.hasKey?.[id] && id !== a.id);
    if (!others.length) return;
    who.append(document.createElement("br"), "Also saved: ");
    others.forEach((id, i) => {
      if (i) who.append(" · ");
      const b = document.createElement("button");
      b.className = "linky";
      b.textContent = c.providerNames?.[id] ?? id;
      b.onclick = () => this.#useProvider(id);
      who.append(b);
    });
  }

  /** Switches to a key already saved. No network: nothing needs re-checking. */
  async #useProvider(id) {
    this.#setKeyState("work", "switching…");
    try {
      this.config = await window.agent.config.setActiveProvider(id);
      this.#showKey(this.config);
    } catch (e) {
      this.#setKeyState("bad", "could not switch");
      $(`err_${KEY_BOX}`).textContent = cleanError(e);
    }
    this.#refreshJoin();
  }

  /**
   * Saves one key without being told whose it is.
   *
   * The work happens in the main process — detect.cjs matches the key's shape
   * against every provider it knows, offers it to each candidate until one
   * accepts, then reads that key's own model list. All this screen does is
   * relay what it is doing, because an ambiguous key (everybody issues `sk-…`)
   * can take a few seconds and silence reads as a hang.
   */
  async #saveKey() {
    const input = $(`key_${KEY_BOX}`);
    const key = input.value.trim();
    $(`err_${KEY_BOX}`).textContent = "";
    if (!key) return this.#setKeyState("bad", "the key is empty");

    const btn = $(`save_${KEY_BOX}`);
    btn.disabled = true;
    this.#setKeyState("work", "working out whose key this is…");
    try {
      const { config } = await window.agent.config.saveKey(
        key, (text) => this.#setKeyState("work", text));
      this.config = config;
      this.#showKey(config);
      input.value = "";
    } catch (e) {
      this.#setKeyState("bad", "did not work");
      $(`err_${KEY_BOX}`).textContent = cleanError(e);
    } finally {
      btn.disabled = false;
    }
    this.#refreshJoin();
  }

  async #testAv() {
    $("avDot").className = "dot work";
    $("avText").textContent = "asking for permission…";
    try {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      $("selftest").srcObject = this.stream;

      // A live level meter is the only honest mic test: permission can be
      // granted while the wrong device is selected and silence is all you get.
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(this.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      let peak = 0;

      const tick = () => {
        if (!this.stream?.active) return;
        analyser.getByteTimeDomainData(buf);
        let max = 0;
        for (const v of buf) max = Math.max(max, Math.abs(v - 128) / 128);
        peak = Math.max(peak, max);
        this.#drawMeter(max);
        if (peak > 0.04 && !this.avOk) {
          this.avOk = true;
          $("avDot").className = "dot ok";
          $("avText").textContent = "mic and camera are fine";
          $("avNote").textContent = "Picking up sound.";
          this.#refreshJoin();
        }
        requestAnimationFrame(tick);
      };
      tick();

      $("avDot").className = "dot work";
      $("avText").textContent = "now say something";
    } catch (e) {
      $("avDot").className = "dot bad";
      $("avText").textContent = "not found";
      $("avNote").textContent = e.message || String(e);
    }
  }

  #buildMeter() {
    $("micLevel").replaceChildren(
      ...Array.from({ length: METER_SEGMENTS }, () => document.createElement("i"))
    );
  }

  /** @param {number} level 0-1 peak amplitude */
  #drawMeter(level) {
    const lit = Math.round(Math.min(1, level * 2.6) * METER_SEGMENTS);
    const segs = $("micLevel").children;
    for (let i = 0; i < segs.length; i++) {
      // The top fifth turns amber: loud enough that clipping is the next thing
      // to happen, which is worth seeing before the interview rather than after.
      segs[i].className = i < lit ? (i >= METER_SEGMENTS - 3 ? "lit hot" : "lit") : "";
    }
  }

  #watchWarmUp() {
    const tick = () => {
      const s = this.speech;
      const pct = Math.round((s.progress || 0) * 100);
      $("ttsBar").style.width = (s.state === "ready" ? 100 : pct) + "%";
      $("ttsBarWrap").classList.toggle("busy", s.state !== "ready" && s.state !== "failed");

      if (s.state === "ready") {
        $("ttsDot").className = "dot ok";
        $("ttsText").textContent = "the interview room is ready";
      } else if (s.state === "failed") {
        $("ttsDot").className = "dot bad";
        $("ttsText").textContent = "voice engine failed to load — " + (s.error?.message ?? "");
      } else {
        $("ttsDot").className = "dot work";
        $("ttsText").textContent = pct ? `getting ready… ${pct}%` : "getting ready…";
        requestAnimationFrame(tick);
      }
      this.#refreshJoin();
    };
    tick();
  }

  // --- gating ---------------------------------------------------------------
  #blockers() {
    const out = [];
    if ($(`dot_${KEY_BOX}`).className !== "dot ok") out.push("API key");
    if (this.mode === "interview" && !this.role) out.push("role");
    if (!this.avOk) out.push("mic test");
    if (this.speech.state !== "ready") out.push("interview room");
    return out;
  }

  /**
   * Ticks each card off as its step is satisfied, and turns the footer ring.
   * The gate itself has not changed — this only makes the state visible, so the
   * candidate can see what is still missing without reading the sentence.
   */
  #syncSteps() {
    const done = {
      step1: this.mode === "talk" ? !!this.character : !!(this.company && this.role),
      step2: $("name").value.trim().length > 0,
      step3: $(`dot_${KEY_BOX}`).className === "dot ok",
      step4: this.avOk,
      step5: this.speech.state === "ready",
    };
    let n = 0;
    for (const [id, ok] of Object.entries(done)) {
      $(id)?.classList.toggle("done", ok);
      if (ok) n++;
    }
    const ring = $("readyRing");
    const total = Object.keys(done).length;
    ring.style.setProperty("--p", Math.round((n / total) * 100));
    ring.dataset.label = `${n}/${total}`;
    ring.classList.toggle("full", n === total);
  }

  #refreshJoin() {
    const left = this.#blockers();
    $("join").disabled = left.length > 0;
    $("joinNote").textContent = left.length ? `Still needed: ${left.join(", ")}` : "All set.";
    this.#syncSteps();
  }

  #bind() {
    $(`save_${KEY_BOX}`).onclick = () => this.#saveKey();
    $(`key_${KEY_BOX}`).onkeydown = (e) => { if (e.key === "Enter") this.#saveKey(); };
    $("testAv").onclick = () => this.#testAv();
    $("pickResume").onclick = () => this.#uploadResume();

    for (const id of ["name", "resume", "topic", "sttModel", "round"]) {
      $(id).onchange = () => this.#persist();
    }
    // Step 2 ticks over as soon as a name is typed, not on blur.
    $("name").oninput = () => this.#syncSteps();

    $("join").onclick = () => {
      this.#persist();
      const candidate = {
        name: $("name").value.trim(),
        resume_text: $("resume").value.trim(),
      };

      if (this.mode === "talk") {
        return this.onJoin({
          mode: "talk",
          character: this.character,
          language: this.language,
          hindiVoice: this.hindiVoiceName,
          topic: $("topic").value.trim(),
          // No resume in Talk mode: the field is hidden there, and sending it
          // anyway would be the app using something the candidate cannot see.
          candidate: { name: candidate.name },
          stream: this.stream,
        });
      }

      const co = this.company;
      const role = this.role;
      this.onJoin({
        mode: "interview",
        company: co,
        role: role?.title ?? "Software Engineer",
        // The pay band calibrates how hard the panel is; see renderBrief.
        roleCtc: role?.ctc ?? null,
        round: co.rounds.find((r) => r.id === $("round").value) ?? co.rounds[0],
        candidate,
        stream: this.stream,
      });
    };
  }

  #persist() {
    return window.agent.config.set({
      mode: this.mode,
      candidate: { name: $("name").value.trim(), resume_text: $("resume").value.trim() },
      interview: { companyId: this.companyId, role: this.roleTitle, roundId: $("round").value },
      talk: {
        characterId: this.characterId,
        language: this.language,
        topic: $("topic").value.trim(),
      },
      stt: { model: $("sttModel").value },
    });
  }
}

export { VOICES };
