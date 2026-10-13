// Listening: mic capture, silence detection, Whisper transcription.
//
// Electron cannot use webkitSpeechRecognition — the Google Speech key only ships
// in real Chrome builds — so this is Whisper running locally via transformers.js
// on WebGPU (measured RTF 0.57, i.e. faster than real time).
//
// The design point is that transcription starts while the candidate is still
// talking. Waiting until they stop and then spending three seconds transcribing
// puts a dead pause in every single turn — measured at 4.6 s for a forty-second
// answer, which is most of the silence between a candidate finishing and the
// panel replying. See segments.js for the numbers and for where the cuts go.

import { correctTranscript } from "./hotwords.js";
import { shouldFlush, tailIsWorthReading, joinSegments } from "./segments.js";

const SAMPLE_RATE = 16000;

/** Concatenates the captured blocks into the one buffer Whisper wants. */
function flatten(blocks) {
  const total = blocks.reduce((n, c) => n + c.length, 0);
  const pcm = new Float32Array(total);
  let off = 0;
  for (const c of blocks) { pcm.set(c, off); off += c.length; }
  return pcm;
}

export class Listener {
  #worker = null;
  #pending = new Map();
  #seq = 0;

  #ctx = null;
  #node = null;
  #source = null;
  #chunks = [];        // captured but not yet handed to Whisper

  /** Stretches already being transcribed, in the order they were spoken. */
  #segments = [];
  #spokenSamples = 0;  // everything captured this turn, for the reported length

  #endTurn = null;

  /** Set by start(); read by the UI for the live level meter. */
  level = 0;
  listening = false;

  /**
   * @param {object} opts
   * @param {string} [opts.model="base"]  "base" | "small" | "multi"
   * @param {string} [opts.language]      forced language for "multi", e.g. "hi".
   *   Leave unset for the .en models, which reject it.
   * @param {string[]} [opts.hotwords]    names/tech Whisper reliably mangles
   * @param {number} [opts.silenceMs=1800]  quiet time that ends an answer
   * @param {number} [opts.minSpeechMs=700] ignore a cough or a chair creak
   */
  constructor(opts = {}) {
    this.model = opts.model ?? "base";
    this.language = opts.language ?? null;
    this.hotwords = opts.hotwords ?? [];
    this.silenceMs = opts.silenceMs ?? 1800;
    this.minSpeechMs = opts.minSpeechMs ?? 700;
    this.maxAnswerMs = opts.maxAnswerMs ?? 180000;
  }

  #call(msg, transfer = []) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Loads the model. Costs seconds on first call, so do it before the call. */
  async warmUp() {
    if (this.#worker) return this.info;

    this.#worker = new Worker("/src/workers/whisper.worker.js", { type: "module" });
    this.#worker.onmessage = (e) => {
      const { id, ok, error, ...rest } = e.data;
      const p = this.#pending.get(id);
      if (!p) return;
      this.#pending.delete(id);
      ok ? p.resolve(rest) : p.reject(new Error(error));
    };
    this.#worker.onerror = (e) => {
      e.preventDefault?.();
      const err = new Error(e.message || "whisper worker failed to start");
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
    };

    this.info = await this.#call({ type: "load", model: this.model });
    return this.info;
  }

  /**
   * Opens the mic and starts listening for one answer.
   * Resolves with the transcript once the candidate has been quiet for
   * `silenceMs`, or when stop() is called.
   *
   * @param {MediaStream} stream
   * @param {object} [handlers]
   * @param {(v:number)=>void} [handlers.onLevel]
   * @param {()=>void} [handlers.onSpeechStart] fires the moment they begin
   */
  listen(stream, handlers = {}) {
    this.listening = true;
    this.#chunks = [];
    this.#segments = [];
    this.#spokenSamples = 0;

    this.#ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    // Autoplay policy can hand back a suspended context; if it stays suspended
    // no audio callback ever runs and the turn silently never ends.
    if (this.#ctx.state === "suspended") this.#ctx.resume().catch(() => {});
    this.#source = this.#ctx.createMediaStreamSource(stream);
    this.#node = this.#ctx.createScriptProcessor(4096, 1, 1);

    let speaking = false;
    let speechMs = 0;
    let quietMs = 0;
    // The same two counters again, but reset at every cut: they describe the
    // stretch waiting to be sent, not the answer as a whole.
    this.pendingMs = 0;
    this.pendingSpeechMs = 0;
    const done = new Promise((r) => { this.#endTurn = r; });

    this.#node.onaudioprocess = (e) => {
      if (!this.listening) return;
      const buf = e.inputBuffer.getChannelData(0);
      this.#chunks.push(new Float32Array(buf));
      this.#spokenSamples += buf.length;

      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      this.level = peak;
      handlers.onLevel?.(peak);

      const ms = (buf.length / SAMPLE_RATE) * 1000;
      this.pendingMs += ms;
      // A fixed threshold is crude but predictable; an adaptive noise floor
      // drifts during long silences and starts clipping quiet speakers.
      if (peak > 0.035) {
        if (!speaking && speechMs > this.minSpeechMs) {
          speaking = true;
          handlers.onSpeechStart?.();
        }
        speechMs += ms;
        this.pendingSpeechMs += ms;
        quietMs = 0;
      } else if (speaking) {
        quietMs += ms;
        if (quietMs >= this.silenceMs) { this.#endTurn?.(); return; }
        // Mid-answer pause: send what has been said so far, so that when they
        // do stop there is only a few seconds left to transcribe rather than
        // the whole answer. Whisper runs in its own worker on a GPU that is
        // doing nothing while somebody talks.
        if (shouldFlush({
          pendingMs: this.pendingMs,
          pendingSpeechMs: this.pendingSpeechMs,
          quietMs,
        })) this.#flush();
      }
    };

    // Hard ceiling on one answer. Without it, a muted mic or a VAD that never
    // trips leaves the interview frozen with the panel waiting forever.
    const cap = setTimeout(() => {
      console.warn("[stt] max answer length reached — ending turn");
      this.#endTurn?.();
    }, this.maxAnswerMs);

    this.#source.connect(this.#node);
    // ScriptProcessor only fires while connected to a destination. A zero-gain
    // node keeps it running without feeding the mic back into the speakers.
    const mute = this.#ctx.createGain();
    mute.gain.value = 0;
    this.#node.connect(mute);
    mute.connect(this.#ctx.destination);

    return done.then(() => {
      clearTimeout(cap);
      this.#endTurn = null;
      return this.finish();
    });
  }

  /**
   * Ends the current turn early — the candidate pressed "done", or left.
   * Must resolve the pending listen() promise: simply flipping `listening` off
   * silences the audio callback, and then nothing is left to resolve it.
   */
  stop() {
    this.listening = false;
    this.#endTurn?.();
    this.#endTurn = null;
  }

  /**
   * Hands everything captured since the last cut to Whisper, without waiting
   * for it. The promise is kept in order; finish() collects them all.
   */
  #flush() {
    if (!this.#chunks.length) return;
    const pcm = flatten(this.#chunks);
    this.#chunks = [];
    this.pendingMs = 0;
    this.pendingSpeechMs = 0;

    this.#segments.push(
      this.#call(
        { type: "transcribe", model: this.model, language: this.language, pcm, beams: 2 },
        [pcm.buffer]
      )
        .then((out) => out.text || "")
        // One lost stretch is a gap in the middle of an answer. Losing the whole
        // answer because of it would be worse, so it is logged and skipped.
        .catch((e) => { console.warn("[stt] a stretch failed to transcribe:", e.message); return ""; })
    );
  }

  /** Tears the graph down and transcribes whatever is still outstanding. */
  async finish() {
    this.listening = false;
    try {
      this.#node?.disconnect();
      this.#source?.disconnect();
      await this.#ctx?.close();
    } catch { /* already closed */ }

    // The tail is usually a second or two of silence — the turn ends at 1800 ms
    // of quiet, and the last cut fired at 700 ms of it. Whisper handed silence
    // does not return nothing, it invents a line, and it would land at the end
    // of the transcript where it reads as the candidate's closing sentence.
    const tail = this.#chunks.length && tailIsWorthReading({
      pendingMs: this.pendingMs, pendingSpeechMs: this.pendingSpeechMs,
    });
    if (tail) this.#flush();
    this.#chunks = [];

    if (!this.#segments.length) return { text: "", raw: "", fixes: [], seconds: 0 };

    const parts = await Promise.all(this.#segments);
    this.#segments = [];
    const raw = joinSegments(parts);

    // Whisper mangles Indian proper nouns; we already know the candidate's name
    // and their resume's tech terms, so those get repaired deterministically.
    const fixed = correctTranscript(raw, this.hotwords);
    return {
      text: fixed.text, raw, fixes: fixed.fixes,
      seconds: this.#spokenSamples / SAMPLE_RATE,
    };
  }

  dispose() {
    this.stop();
    this.#worker?.terminate();
    this.#worker = null;
  }
}

/**
 * Pulls likely-mangled proper nouns out of a resume: capitalised words and
 * things with dots or digits (React, Node.js, MongoDB, Socket.io, HTML5).
 * Feeding these to the corrector is what stops "Socket IO" and "Mongo DB".
 */
export function hotwordsFrom(name, resumeText = "") {
  const out = new Set();
  if (name) out.add(name.trim());

  for (const m of resumeText.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[.+#][A-Za-z0-9]+)*\b/g)) {
    const w = m[0];
    if (w.length >= 3 && w.length <= 24) out.add(w);
  }
  return [...out].slice(0, 40);   // keep the scan cheap
}
