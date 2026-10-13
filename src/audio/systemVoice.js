// Speech through the operating system's own voices, used for Hindi.
//
// Why this exists at all: Kokoro ships Hindi voice packs, but HeadTTS only has
// an English and a Finnish grapheme-to-phoneme module. So Hindi text — however
// it is spelled — comes out as English phonemes wearing a Hindi voice, which
// is the "English accent" the candidate heard. There is no Hindi G2P to plug
// in, so the sound has to come from somewhere that already has one: Windows.
//
// A Windows Hindi speech pack installs Microsoft Swara and Madhur (hi-IN), and
// Chromium exposes them through speechSynthesis. Those read Devanagari
// natively and sound like Hindi, because they are Hindi.
//
// The cost is lip-sync: speechSynthesis hands back no audio buffer and no
// phoneme timings, so the mouth is driven from estimated word timings instead
// of measured ones. TalkingHead derives the visemes itself when none are
// given, and the estimate re-calibrates against each sentence it has actually
// spoken, so it converges within a turn or two.

import { sentences } from "./sentences.js";

let voicesPromise = null;

/**
 * The system voice list, once it exists.
 *
 * Chromium populates this asynchronously and returns an empty array until it
 * has: reading it once at startup is the classic way to conclude, wrongly,
 * that a machine has no voices at all.
 */
export function systemVoices() {
  if (voicesPromise) return voicesPromise;

  voicesPromise = new Promise((resolve) => {
    const read = () => {
      const v = window.speechSynthesis?.getVoices?.() ?? [];
      if (!v.length) return false;
      resolve(v);
      return true;
    };
    if (read()) return;
    window.speechSynthesis?.addEventListener?.("voiceschanged", read, { once: true });
    // Never hang the setup screen on a list that may legitimately be empty.
    setTimeout(() => resolve(window.speechSynthesis?.getVoices?.() ?? []), 3000);
  });
  return voicesPromise;
}

/**
 * Picks the best system voice for a language tag.
 *
 * Exported separately from the async lookup so it can be tested against a
 * fixed voice list rather than whatever this machine happens to have.
 */
export function pickVoice(voices, prefix) {
  const tag = new RegExp(`^${prefix}(-|_|$)`, "i");
  const matches = (voices ?? []).filter((v) => tag.test(v.lang || ""));
  if (!matches.length) return null;
  // A local voice keeps the app offline and starts instantly; a remote one
  // needs the network mid-sentence.
  return matches.find((v) => v.localService) ?? matches[0];
}

/** The Hindi voice this machine has, or null if the pack is not installed. */
export async function hindiVoice() {
  return pickVoice(await systemVoices(), "hi");
}

// --- lip-sync ------------------------------------------------------------
// TalkingHead has lipsync modules for English, German, Finnish, French and
// Lithuanian — none for Hindi, and its English one drops Devanagari entirely,
// which would leave the mouth shut for the whole sentence. So Devanagari is
// transliterated to rough Latin purely to generate mouth shapes. It never
// reaches the voice or the screen, and it only has to be close enough that the
// lips open on vowels and close on labials.

const CONSONANTS = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v", "ळ": "l",
  "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f",
};

const VOWELS = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo",
  "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऋ": "ri", "ऑ": "o",
};

const MATRAS = {
  "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ृ": "ri", "ॉ": "o",
};

const SIGNS = { "ं": "n", "ँ": "n", "ः": "h" };
const HALANT = "्";
const NUKTA = "़";

/** Devanagari to approximate Latin, for viseme generation only. */
export function devaToLatin(text) {
  const src = String(text ?? "");
  let out = "";
  // Where the last inherent "a" was written. Hindi drops it at the end of a
  // word — "आप" is *aap*, not *aapa* — and leaving it in adds a phantom open
  // mouth to the end of every other word.
  let inherentAt = -1;
  const dropFinalSchwa = () => {
    if (inherentAt === out.length - 1) out = out.slice(0, -1);
    inherentAt = -1;
  };

  for (let i = 0; i < src.length; i++) {
    let ch = src[i];

    // Nukta forms are two code points as often as one.
    if (src[i + 1] === NUKTA && CONSONANTS[ch + NUKTA]) {
      ch = ch + NUKTA;
      i++;
    }

    if (CONSONANTS[ch]) {
      out += CONSONANTS[ch];
      const next = src[i + 1];
      // A consonant carries an inherent "a" unless a vowel sign or a halant
      // says otherwise. Getting this wrong is what makes transliterated Hindi
      // read as a wall of consonants.
      if (next !== HALANT && !MATRAS[next]) {
        out += "a";
        inherentAt = out.length - 1;
      } else if (next === HALANT) i++;
      continue;
    }
    if (MATRAS[ch]) { out += MATRAS[ch]; inherentAt = -1; continue; }
    if (VOWELS[ch]) { out += VOWELS[ch]; inherentAt = -1; continue; }
    if (SIGNS[ch]) { out += SIGNS[ch]; inherentAt = -1; continue; }
    if (ch === HALANT || ch === NUKTA) continue;
    // Latin, digits, punctuation and spaces pass through untouched — Hindi
    // speech is full of English technical terms.
    if (/\s|[.,!?;:]/.test(ch)) dropFinalSchwa();
    else inherentAt = -1;
    out += ch;
  }
  dropFinalSchwa();
  return out;
}

/** True if the string contains any Devanagari at all. */
export function hasDevanagari(text) {
  return /[ऀ-ॿ]/.test(String(text ?? ""));
}

/**
 * Speaks through a system voice, moving the avatar's mouth alongside it.
 *
 * Deliberately mirrors the shape of Speech#speak in tts.js — same arguments,
 * same cancellation, same per-sentence callback — so the call and talk screens
 * can hold either one without caring which.
 */
export class SystemSpeech {
  // Measured at about 1.8 words/sec for a Windows English voice at rate 1,
  // including the pause it leaves at the end of a sentence. Hindi will differ,
  // so this is only a starting point — see the calibration in #sentence.
  #wordsPerSec = 2;
  #spoken = 0;
  #cancelled = false;

  constructor(voice) {
    this.voice = voice;
    this.state = "ready";   // matches Speech, whose warm-up the setup screen gates on
    this.progress = null;
    this.error = null;
  }

  /** Nothing to warm up: the voice is already on the machine. */
  async warmUp() { return { model: this.voice?.name ?? "system", device: "os" }; }
  async primeFillers() {}

  cancel() {
    this.#cancelled = true;
    window.speechSynthesis?.cancel();
    queueMicrotask(() => { this.#cancelled = false; });
  }

  async speak(head, _voice, text, opts = {}) {
    const parts = sentences(text);
    for (let i = 0; i < parts.length; i++) {
      if (this.#cancelled || opts.cancelled?.()) return;
      opts.onSentence?.(i);
      await this.#sentence(head, parts[i]);
    }
  }

  #sentence(head, text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) {
        u.voice = this.voice;
        u.lang = this.voice.lang;
      }

      const words = text.split(/\s+/).filter(Boolean);
      let started = 0;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (started && words.length) {
          const actual = words.length / ((performance.now() - started) / 1000);
          // Ignore nonsense — a cancelled utterance ends instantly and would
          // otherwise poison the estimate for the rest of the conversation.
          if (actual > 0.5 && actual < 8) {
            // The starting value is a guess and the first real measurement is
            // evidence, so let it nearly replace the guess; after that, smooth,
            // because one long word should not swing the whole conversation.
            const w = this.#spoken === 0 ? 0.85 : 0.35;
            this.#wordsPerSec = this.#wordsPerSec * (1 - w) + actual * w;
            this.#spoken++;
          }
        }
        resolve();
      };

      u.onstart = () => {
        started = performance.now();
        if (!head || !words.length) return;
        const per = 1000 / this.#wordsPerSec;
        // No audio and no visemes: TalkingHead generates the mouth shapes from
        // the words themselves, which is why only timings are needed here.
        head.speakAudio({
          words: words.map((w) => (hasDevanagari(w) ? devaToLatin(w) : w)),
          wtimes: words.map((_, k) => k * per),
          wdurations: words.map(() => per * 0.9),
        });
      };
      u.onend = finish;
      u.onerror = finish;

      window.speechSynthesis.speak(u);
      // Some Windows builds never fire onend for a long utterance. Without a
      // backstop the conversation would simply stop, so cap the wait at a
      // generous multiple of the expected length.
      setTimeout(finish, 4000 + (words.length / this.#wordsPerSec) * 2000);
    });
  }
}
