// node src/audio/systemVoice.test.mjs
//
// The transliteration here never reaches the screen or the speaker: it exists
// only so TalkingHead can pick mouth shapes for Devanagari, which its English
// lipsync module drops on the floor. So the bar is not "correct romanisation",
// it is "the lips open on vowels and close on m/b/p, roughly in time".
//
// The one rule worth getting right is the inherent vowel: every Devanagari
// consonant carries an "a" unless a vowel sign or a halant says otherwise, and
// Hindi drops that "a" at the end of a word. Miss the first and the text comes
// out as a wall of consonants with no mouth movement; miss the second and every
// other word ends on a phantom open mouth.
import assert from "node:assert";
import { devaToLatin, hasDevanagari, pickVoice } from "./systemVoice.js";

let pass = 0, fail = 0;
const test = (n, fn) => {
  try { fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

console.log("devaToLatin");

test("a consonant carries its inherent vowel", () => {
  assert.strictEqual(devaToLatin("कम"), "kam");      // ka + ma, final a dropped
  assert.strictEqual(devaToLatin("नमस्ते"), "namaste");
});

test("a halant kills the inherent vowel", () => {
  // Without this, "namaste" would come out as "namasate".
  assert.ok(!devaToLatin("नमस्ते").includes("sat"));
});

test("a vowel sign replaces the inherent vowel rather than adding to it", () => {
  assert.strictEqual(devaToLatin("की"), "kee");
  assert.strictEqual(devaToLatin("तुम"), "tum");
});

test("the word-final inherent vowel is dropped", () => {
  assert.strictEqual(devaToLatin("आप"), "aap");       // not "aapa"
  assert.strictEqual(devaToLatin("डर"), "dar");       // not "dara"
});

test("it is dropped at a space and at punctuation too, not only at the very end", () => {
  assert.strictEqual(devaToLatin("आप कैसे हो"), "aap kaise ho");
  assert.ok(devaToLatin("तुम समझ गए?").startsWith("tum samajh"));
});

test("nukta consonants are read as one letter, not two", () => {
  assert.strictEqual(devaToLatin("ज़रूरत"), "zaroorat");
});

test("Latin passes through, because Hindi speech is full of English terms", () => {
  assert.strictEqual(devaToLatin("यह बिलकुल normal है"), "yah bilakul normal hai");
});

test("plain English is left completely alone", () => {
  assert.strictEqual(devaToLatin("system design interview"), "system design interview");
});

test("empty and null do not throw", () => {
  assert.strictEqual(devaToLatin(""), "");
  assert.strictEqual(devaToLatin(null), "");
});

console.log("\nhasDevanagari");

test("tells the two scripts apart", () => {
  assert.ok(hasDevanagari("आप कैसे हो"));
  assert.ok(!hasDevanagari("aap kaise ho"));
  assert.ok(hasDevanagari("array का matlab क्या है"));   // mixed counts as Devanagari
});

console.log("\npickVoice");

const VOICES = [
  { name: "Microsoft David - English (United States)", lang: "en-US", localService: true },
  { name: "Microsoft Ravi - English (India)", lang: "en-IN", localService: true },
  { name: "Cloud Hindi", lang: "hi-IN", localService: false },
  { name: "Microsoft Swara - Hindi (India)", lang: "hi-IN", localService: true },
];

test("finds the Hindi voice among the English ones", () => {
  assert.strictEqual(pickVoice(VOICES, "hi").name, "Microsoft Swara - Hindi (India)");
});

test("prefers a local voice — a remote one needs the network mid-sentence", () => {
  assert.ok(pickVoice(VOICES, "hi").localService);
});

test("takes a remote voice rather than none at all", () => {
  const remoteOnly = VOICES.filter((v) => !v.localService);
  assert.strictEqual(pickVoice(remoteOnly, "hi").name, "Cloud Hindi");
});

test("en-IN is not mistaken for Hindi — this machine has Ravi and no Hindi", () => {
  const noHindi = VOICES.filter((v) => v.lang.startsWith("en"));
  assert.strictEqual(pickVoice(noHindi, "hi"), null);
});

test("an empty or missing list is null, not a crash", () => {
  assert.strictEqual(pickVoice([], "hi"), null);
  assert.strictEqual(pickVoice(undefined, "hi"), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
