// Speech for the panel: Kokoro via HeadTTS, WebGPU, weights from disk.
//
// Two measured facts shape this file (Phase 0 spike):
//
//   1. Building the WebGPU session costs 86-121 s, one time. WASM starts in 28 s
//      but then synthesises 8x slower (RTF 5.11), which is unusable mid-answer.
//      So: keep WebGPU, and start warming up the instant the app opens, while
//      the candidate is still filling in the setup screen.
//
//   2. Synthesis runs at RTF ~0.62 — faster than real time — but a 10 s answer
//      still means 6 s of silence before the first word. That is fixed by
//      speaking sentence by sentence instead of waiting for the whole reply.

import { HeadTTS } from "headtts";
import { sentences } from "./sentences.js";

const MODELS = "/models";
const VOICES = { M: ["hm_omega", "hm_psi"], F: ["hf_alpha", "hf_beta"] };

export class Speech {
  #tts = null;
  #voice = null;
  #ready = null;
  #cache = new Map();     // `${voice}::${text}` -> synthesised payload
  #inflight = new Map();  // the same key -> a synthesis already running
  #cancelled = false;

  /** Progress 0..1 while warming up, or null once ready. */
  progress = 0;
  state = "cold";       // cold | warming | ready | failed
  error = null;

  constructor(audioCtx, voices) {
    this.audioCtx = audioCtx;
    this.voices = voices;
  }

  /**
   * Starts building the WebGPU session. Safe to call repeatedly — later calls
   * join the first one rather than starting a second, very expensive, build.
   */
  warmUp() {
    if (this.#ready) return this.#ready;
    this.state = "warming";

    this.#ready = (async () => {
      this.#tts = new HeadTTS({
        endpoints: ["webgpu", "wasm"],
        transformersModule: "/vendor/transformers.local.js",
        dictionaryURL: "/node_modules/@met4citizen/headtts/dictionaries",
        voiceURL: `${MODELS}/voices`,
        audioCtx: this.audioCtx,
        voices: this.voices,
        defaultVoice: this.voices[0],
        defaultLanguage: "en-us",
        defaultAudioEncoding: "wav",
        // HeadTTS asks for a q4 export on the wasm endpoint by default, and the
        // only Kokoro weights mirrored into models/ are fp32 — the variant the
        // Phase 0 sweep measured fastest here. So the wasm fallback 404'd
        // locally, went to HuggingFace for it, and on a network that resets as
        // often as this one that surfaced as "Failed to start Module Web
        // Worker" with no clue attached, on the one screen that gates Join.
        dtypeWasm: "fp32",
        // We do our own sentence splitting so each one can be spoken the moment
        // it is ready, rather than waiting for the whole reply.
        splitSentences: false,
      });

      await this.#tts.connect(null, (ev) => {
        if (ev.lengthComputable && ev.total) this.progress = ev.loaded / ev.total;
      });

      // The very first inference pays graph compilation. Spend it here, during
      // setup, rather than on the interviewer's opening line.
      await this.#synth(this.voices[0], "Good morning.");

      this.state = "ready";
      this.progress = 1;
    })().catch((e) => {
      this.state = "failed";
      this.error = e;
      this.#ready = null;   // let a retry rebuild
      throw e;
    });

    return this.#ready;
  }

  #synth(voice, text) {
    return new Promise((resolve, reject) => {
      const go = () =>
        this.#tts.synthesize({ input: text }, (msg) => {
          const d = msg?.data;
          if (d?.audio) resolve(d);
        }, reject);

      // setup() is per-request state in HeadTTS, so the voice has to be switched
      // before each call rather than once at connect time.
      if (voice === this.#voice) return go();
      this.#tts
        .setup({ voice, language: "en-us", audioEncoding: "wav" })
        .then(() => { this.#voice = voice; go(); })
        .catch(reject);
    });
  }

  /**
   * Synthesises one line, using the cache when possible.
   * Short stock phrases ("Hmm.", "Okay.", "Achha.") recur constantly, and
   * re-synthesising them costs a beat of silence every single time.
   */
  async say(voice, text) {
    const key = `${voice}::${text}`;
    if (this.#cache.has(key)) return this.#cache.get(key);
    // Started early by prime(), and by now probably finished. Taken out of the
    // map as it is consumed, which is also what keeps prime()'s entries from
    // piling up over an interview.
    const running = this.#inflight.get(key);
    if (running) { this.#inflight.delete(key); return running; }

    const job = this.#synth(voice, text);
    this.#inflight.set(key, job);
    try {
      const out = await job;
      if (text.length <= 40) this.#cache.set(key, out);   // only cache stock lines
      return out;
    } finally {
      this.#inflight.delete(key);
    }
  }

  /**
   * Starts synthesising the first sentence of a reply without waiting for it.
   *
   * The panel pauses before it speaks — up to two and a half seconds, chosen by
   * the model, and a real weapon after a weak answer. That pause used to be
   * dead time followed by the synthesis wait, one after the other. Now the
   * first sentence is built during it, so by the time the pause is over the
   * voice is usually ready and the reply starts on the beat.
   *
   * Deliberately silent about failures: this is speculative work, and if it
   * breaks, say() will run into the same error at the point where there is
   * somebody to tell.
   */
  prime(voice, text) {
    const first = sentences(text)[0];
    if (!first) return;
    const key = `${voice}::${first}`;
    if (this.#cache.has(key) || this.#inflight.has(key)) return;
    const job = this.#synth(voice, first);
    this.#inflight.set(key, job);
    job.then(
      (out) => { if (first.length <= 40) this.#cache.set(key, out); },
      () => { this.#inflight.delete(key); }
    );
  }

  /**
   * Speaks `text` through `head`, one sentence at a time.
   *
   * The first sentence starts playing while the rest are still being generated,
   * which is what turns a 6-second silence into roughly one second.
   *
   * @param {object} head       a TalkingHead instance
   * @param {string} voice      Kokoro voice id
   * @param {string} text       what to say
   * @param {object} [opts]
   * @param {() => boolean} [opts.cancelled]  return true to stop mid-way
   * @param {(i: number) => void} [opts.onSentence]
   */
  async speak(head, voice, text, opts = {}) {
    const parts = sentences(text);
    if (!parts.length) return;

    // Kick off the first synthesis before anything else, then keep exactly one
    // sentence in flight ahead of the one being spoken.
    let next = this.say(voice, parts[0]);

    for (let i = 0; i < parts.length; i++) {
      if (this.#cancelled || opts.cancelled?.()) return;

      const d = await next;
      next = i + 1 < parts.length ? this.say(voice, parts[i + 1]) : null;

      opts.onSentence?.(i);
      head.speakAudio({
        audio: d.audio,
        words: d.words, wtimes: d.wtimes, wdurations: d.wdurations,
        visemes: d.visemes, vtimes: d.vtimes, vdurations: d.vdurations,
      });

      await new Promise((r) => setTimeout(r, d.audio.duration * 1000));
    }
  }

  /** Stops whatever is being said. Used when the candidate leaves the call. */
  cancel() {
    this.#cancelled = true;
    queueMicrotask(() => { this.#cancelled = false; });
  }

  /** Pre-renders the panel's stock acknowledgements so they play instantly. */
  async primeFillers(voices, fillers = ["Hmm.", "Okay.", "Right.", "Achha.", "Mm-hm."]) {
    for (const v of voices) {
      for (const f of fillers) {
        try { await this.say(v, f); } catch { /* not worth failing setup over */ }
      }
    }
  }
}

export { VOICES, sentences };
