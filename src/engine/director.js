// The interview loop: who speaks, what they remember, and what gets written
// down about the candidate.
//
// One model call per turn. The reply arrives as spoken text followed by a
// <<<META>>> JSON block; the text streams to TTS as it lands, the META never
// gets spoken and becomes the panel's private notes — which is what makes the
// end-of-interview report specific instead of generic advice.

/** Arcs pick how the panel behaves. Same company twice must not feel alike. */
export const ARCS = [
  { id: "warm_then_cold", description: "Opens friendly, then cools and hardens turn by turn." },
  { id: "stress_from_start", description: "Pressure from the first question. No warm-up at all." },
  { id: "one_hostile_panelist", description: "One panelist is unconvinced from the start and doubts every answer." },
  { id: "friendly_but_deep", description: "The tone stays calm throughout, but each question digs a layer deeper." },
  { id: "rushed_panel", description: "The panel is short of time — they interrupt and move on quickly." },
  { id: "silent_evaluator", description: "One panelist stays almost silent, then fires the hardest question of the round." },
];

const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

/**
 * Failures that clear with time rather than with a code change. gemini.cjs has
 * already waited these out and walked every fallback model by the time one
 * reaches here, so the only thing left worth doing is asking the candidate.
 *
 * Anything that does not match is a real fault — but it is no longer a reason
 * to end the interview, only a reason to word the prompt differently. See
 * #turnOrAsk.
 */
const RECOVERABLE = /limit|quota|429|503|busy|overload|nothing at all/i;

/** Returned by a turn the candidate chose to abandon rather than wait out. */
const GAVE_UP = Symbol("gave up");

/** Deterministic PRNG so a seed reproduces a session exactly. */
function rngFrom(seed) {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds the panel for one session: 3-4 personas from the company's pool, with
 * at least one hard marker, and a randomised arc.
 */
export function buildSession({ company, role, round, candidate, personas, seed }) {
  seed ??= Math.random().toString(36).slice(2, 10);
  const rnd = rngFrom(seed);

  const pool = personas.filter((p) => (company.persona_pool ?? []).includes(p.id));
  const source = pool.length >= 3 ? pool : personas;

  const roster = [];
  const taken = new Set();
  const size = 3 + (rnd() > 0.5 ? 1 : 0);
  while (roster.length < size && taken.size < source.length) {
    const p = pick(source, rnd);
    if (taken.has(p.id)) continue;
    taken.add(p.id);
    roster.push(p);
  }
  // A panel where nobody is hard to please is not an interview.
  if (!roster.some((p) => p.harshness >= 2)) {
    const tough = source.find((p) => p.harshness >= 2 && !taken.has(p.id));
    if (tough) roster[roster.length - 1] = tough;
  }

  return {
    id: `${company.id}-${Date.now()}`,
    company, role, round, candidate,
    roster,
    arc: pick(ARCS, rnd),
    seed,
    startedAt: Date.now(),
    elapsedMs: 0,
    history: [],
    memory: {
      turnCount: 0,
      askedFingerprints: [],
      claims: [],
      weakSpots: [],
      spokenBy: {},        // panelist id -> how many questions they have asked
      recentSpeakers: [],  // last few, oldest first
    },
    ledger: [],   // one entry per answer: the panel's private assessment
  };
}

export class Director {
  /**
   * @param {object} deps
   * @param {object} deps.session   from buildSession()
   * @param {object} deps.panel     PanelGrid
   * @param {object} deps.speech    Speech
   * @param {object} deps.listener  Listener
   * @param {object} deps.ui        callbacks into the call screen
   */
  constructor({ session, panel, speech, listener, ui }) {
    this.session = session;
    this.panel = panel;
    this.speech = speech;
    this.listener = listener;
    this.ui = ui ?? {};
    this.running = false;
    this.stopped = false;
  }

  /** Resolver for a pending "wait or quit?" prompt, so stop() can release it. */
  #resumeStall = null;

  #voiceFor(personaId) {
    const t = this.panel.tiles.get(personaId);
    return t?.member.voice ?? "hf_alpha";
  }

  /**
   * Decides who actually speaks.
   *
   * The prompt asks for rotation and the state block names whoever is hogging
   * the round, but a model left to itself still drifts back to one voice — so
   * this is enforced here as well. If the same panelist has taken the last three
   * turns, the turn is handed to whoever has spoken least.
   */
  #resolveSpeaker(requested) {
    const s = this.session;
    const roster = s.roster;
    let id = requested;
    if (!id || !this.panel.tiles.has(id)) id = roster[0].id;

    const recent = s.memory.recentSpeakers;
    const hogging =
      recent.length >= 3 && recent.slice(-3).every((x) => x === id);

    if (hogging) {
      const counts = s.memory.spokenBy;
      const quietest = roster
        .filter((p) => p.id !== id)
        .sort((a, b) => (counts[a.id] ?? 0) - (counts[b.id] ?? 0))[0];
      if (quietest) {
        console.log(`[director] ${id} has taken 3 turns — handing over to ${quietest.id}`);
        return quietest.id;
      }
    }
    return id;
  }

  /** Records the panel's private notes from one META block. */
  #absorb(meta, answerText) {
    if (!meta) return;
    const s = this.session;
    const p = meta.private ?? {};

    if (p.topic_fingerprint && !s.memory.askedFingerprints.includes(p.topic_fingerprint)) {
      s.memory.askedFingerprints.push(p.topic_fingerprint);
    }
    if (p.claim_logged) s.memory.claims.push(p.claim_logged);
    for (const f of p.red_flags ?? []) {
      if (!s.memory.weakSpots.includes(f)) s.memory.weakSpots.push(f);
    }

    s.ledger.push({
      at: Date.now(),
      speaker: meta.speaker_id,
      action: meta.action,
      answer: answerText ?? null,
      ...p,
    });
  }

  /** Runs one exchange: panel speaks, candidate answers, transcript comes back. */
  async #turn(answerText) {
    const s = this.session;
    s.elapsedMs = Date.now() - s.startedAt;

    // Who is about to talk is only known once META arrives, so the thinking
    // pose goes on whoever spoke last — which is also what a real panel does.
    const lastSpeaker = s.ledger.at(-1)?.speaker ?? s.roster[0].id;
    this.panel.setThinking(lastSpeaker, true);
    this.ui.onStatus?.("the panel is thinking…");

    let spokenSoFar = "";
    let started = false;
    let speakerId = null;
    let speaking = null;

    const result = await window.agent.runTurn({
      session: {
        company: s.company, role: s.role, roleCtc: s.roleCtc, round: s.round,
        roster: s.roster, arc: s.arc, seed: s.seed, candidate: s.candidate,
        elapsedMs: s.elapsedMs, history: s.history, memory: s.memory,
      },
      answerText,
      // A retry threw away whatever the abandoned attempt had streamed, so the
      // caption must start over — otherwise two half-questions get glued together.
      onStatus: (text) => {
        spokenSoFar = "";
        this.ui.onStatus?.(text);
      },
      onChunk: (chunk) => {
        spokenSoFar += chunk;
        if (!started) {
          started = true;
          this.panel.setThinking(lastSpeaker, false);
          this.ui.onStatus?.("");
        }
        this.ui.onPanelText?.(spokenSoFar);
      },
    });

    this.panel.setThinking(lastSpeaker, false);
    speakerId = this.#resolveSpeaker(result.meta?.speaker_id);

    // Keep the model's own words — META included — as the panel's memory of
    // what it already decided about this candidate.
    s.history.push({ role: "assistant", content: result.raw });
    this.#absorb(result.meta, answerText);
    s.memory.turnCount++;

    s.memory.spokenBy[speakerId] = (s.memory.spokenBy[speakerId] ?? 0) + 1;
    s.memory.recentSpeakers.push(speakerId);
    if (s.memory.recentSpeakers.length > 4) s.memory.recentSpeakers.shift();

    for (const r of result.meta?.reactions ?? []) this.panel.react(r.id, r.cue);

    // Build the first sentence during the pause rather than after it. The
    // pause is deliberate — a panel that lets a bad answer hang is doing
    // something real — but there is no reason for the synthesis to queue up
    // behind it as well.
    this.speech.prime?.(this.#voiceFor(speakerId), result.spoken);

    const pause = Math.min(2500, result.meta?.delivery?.pause_before_ms ?? 0);
    if (pause) await new Promise((r) => setTimeout(r, pause));

    // Speak sentence by sentence: the first one plays while the rest are still
    // being synthesised, which is the difference between a one-second gap and six.
    this.panel.setSpeaking(speakerId);
    this.ui.onSpeaker?.(this.panel.tiles.get(speakerId)?.member, result.spoken);
    const head = this.panel.tiles.get(speakerId)?.head;
    if (head) {
      // A voice that fails is not an interview that fails. The line is already
      // on screen in the caption, so a synthesis error costs this one question
      // its audio and nothing else — where letting it throw used to end the
      // session and jump straight to the report.
      try {
        speaking = this.speech.speak(head, this.#voiceFor(speakerId), result.spoken, {
          cancelled: () => this.stopped,
        });
        await speaking;
      } catch (e) {
        console.warn("[director] the panel lost its voice for one line:", e?.message ?? e);
        this.ui.onVoiceLost?.(e);
      }
    }
    this.panel.setSpeaking(null);

    return result.meta;
  }

  /**
   * Runs one turn; if it fails, hands the decision to the candidate rather than
   * guessing a wait or killing the interview.
   *
   * Both kinds of failure end up here, and both are survivable:
   *
   *   a quota or a 503 — gemini.cjs has already waited and walked every model,
   *     so the only thing left is to ask whether they have the patience.
   *   anything else — a bug, a dropped worker, a reply the splitter could not
   *     read. These used to end the interview outright, which is how a session
   *     "crashed and went straight to the report". One bad turn is not a reason
   *     to throw away a half-finished interview; the candidate gets the same
   *     two buttons, worded honestly, and Try again costs them one question.
   *
   * The distinction survives in `recoverable`, which is what the caption uses
   * to decide between "wait a moment" and "something went wrong" — telling
   * someone to wait out a null-pointer would be a lie.
   */
  async #turnOrAsk(answerText) {
    for (;;) {
      try {
        return await this.#turn(answerText);
      } catch (e) {
        if (this.stopped) return GAVE_UP;
        const recoverable = RECOVERABLE.test(e?.message ?? "");
        if (recoverable) console.warn("[director] turn stalled:", e.message);
        else console.error("[director] turn failed:", e);
        const again = await this.#askToWait(e, recoverable);
        if (!again || this.stopped) return GAVE_UP;
      }
    }
  }

  /**
   * Shows the candidate why the panel stopped and lets them choose. Resolves
   * true to try the same turn again, false to end the interview and go to the
   * report — which is also what Leave does, via stop().
   */
  #askToWait(err, recoverable = true) {
    if (!this.ui.onStalled) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.#resumeStall = resolve;
      this.ui.onStalled(err, {
        recoverable,
        retry: () => { this.#resumeStall = null; resolve(true); },
        end: () => { this.#resumeStall = null; resolve(false); },
      });
    });
  }

  /** The interview. Runs until the panel wraps up or stop() is called. */
  async run(stream) {
    this.running = true;
    const s = this.session;
    try {
      await this.#loop(stream);
    } catch (e) {
      // Surface it. A silent panel with no explanation is the worst possible
      // failure here — the candidate cannot tell a broken app from a hostile one.
      console.error("[director] interview stopped:", e);
      this.ui.onError?.(e);
    }
    this.running = false;
    this.ui.onFinished?.(this.session);
    return this.session;
  }

  async #loop(stream) {
    const s = this.session;

    // Opening line: answerText null tells the panel the candidate just joined.
    let meta = await this.#turnOrAsk(null);
    if (meta === GAVE_UP) return;

    while (this.running && !this.stopped) {
      if (meta?.action === "end_interview" || meta?.action === "wrap_round") break;
      if (s.memory.turnCount > 40) break;   // hard stop; something has gone wrong

      this.ui.onStatus?.("your turn — go ahead");
      this.ui.onListening?.(true);
      this.panel.setSpeaking("self");

      let heard;
      try {
        heard = await this.listener.listen(stream, {
          onLevel: (v) => this.ui.onLevel?.(v),
        });
      } catch (e) {
        // The mic or the Whisper worker gave out. Same rule as a failed turn:
        // ask, do not end. Retrying re-opens the mic on the same question.
        if (this.stopped) return;
        console.error("[director] listening failed:", e);
        this.panel.setSpeaking(null);
        this.ui.onListening?.(false);
        if (!(await this.#askToWait(e, false)) || this.stopped) return;
        continue;
      }

      this.panel.setSpeaking(null);
      this.ui.onListening?.(false);

      // Record the answer before checking for an early exit: a partial answer
      // is still evidence, and the report is built entirely from the transcript.
      this.ui.onAnswer?.(heard);
      s.history.push({ role: "user", content: heard.text || "(said nothing)" });

      if (this.stopped) break;

      meta = await this.#turnOrAsk(heard.text);
      if (meta === GAVE_UP) return;
    }
  }

  /**
   * Ends the interview from anywhere in the loop.
   *
   * `stopped` is checked between turns and inside speak(), and stopping the
   * listener resolves a turn that is waiting on the mic. Both are needed: Leave
   * pressed while the panel is talking hits the first path, pressed while
   * listening hits the second.
   */
  stop() {
    this.stopped = true;
    this.running = false;
    try { this.listener.stop(); } catch { /* not listening */ }
    try { this.speech.cancel?.(); } catch { /* nothing playing */ }
    // Leave pressed while the interview is stalled on a quota prompt: release
    // that promise too, or nothing ever resolves and the report never runs.
    this.#resumeStall?.(false);
    this.#resumeStall = null;
  }
}
