// node src/audio/segments.test.mjs
//
// The rules that decide where an answer gets cut up for Whisper.
//
// Getting these wrong is not a performance problem, it is a transcript problem:
// cut too eagerly and the GPU spends the whole answer re-encoding two-second
// scraps; cut on silence and Whisper writes down words nobody said, which then
// reach the panel as something the candidate claimed.
import assert from "node:assert";
import {
  shouldFlush, tailIsWorthReading, joinSegments,
  MIN_SEGMENT_MS, SEGMENT_PAUSE_MS,
} from "./segments.js";

let pass = 0, fail = 0;
const test = (n, fn) => {
  try { fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

/** A healthy stretch: ten seconds, eight of them speech. */
const full = { pendingMs: 10000, pendingSpeechMs: 8000, quietMs: SEGMENT_PAUSE_MS };

console.log("\nwhere to cut");

test("a real pause after a real stretch is a cut", () => {
  assert.strictEqual(shouldFlush(full), true);
});

test("mid-word is never a cut, however much has been said", () => {
  // The whole point of waiting for quiet: a cut inside a word gives Whisper
  // half a word twice, and it guesses at both halves.
  assert.strictEqual(shouldFlush({ ...full, quietMs: 0 }), false);
  assert.strictEqual(shouldFlush({ ...full, quietMs: SEGMENT_PAUSE_MS - 1 }), false);
});

test("a short stretch waits — an encoder pass costs the same at any length", () => {
  // Whisper pads everything to thirty seconds, so a two-second clip is as
  // expensive as a twenty-second one. Cutting at every breath would mean the
  // GPU never catches up with the person talking.
  assert.strictEqual(shouldFlush({ ...full, pendingMs: MIN_SEGMENT_MS - 1 }), false);
});

test("a long quiet stretch with barely any speech in it is not sent", () => {
  // Someone thinking with the mic open. There is nothing in it to transcribe,
  // and Whisper does not answer silence with silence.
  assert.strictEqual(shouldFlush({ ...full, pendingSpeechMs: 300 }), false);
});

test("a hesitant speaker still gets cut, as long as they said something", () => {
  assert.strictEqual(
    shouldFlush({ pendingMs: 20000, pendingSpeechMs: 2000, quietMs: 900 }), true);
});

console.log("\nthe last stretch");

test("silence left over after the last cut is not transcribed", () => {
  // The turn ends at 1800 ms of quiet and the last cut fired at 700 ms, so what
  // is left is a second of nothing. Whisper given nothing writes "Thank you."
  // — at the end of the transcript, where it reads as the closing sentence.
  assert.strictEqual(tailIsWorthReading({ pendingMs: 1100, pendingSpeechMs: 0 }), false);
});

test("a genuine last sentence is transcribed", () => {
  assert.strictEqual(tailIsWorthReading({ pendingMs: 4000, pendingSpeechMs: 3000 }), true);
});

test("nothing captured at all is nothing to read", () => {
  assert.strictEqual(tailIsWorthReading({ pendingMs: 0, pendingSpeechMs: 0 }), false);
});

console.log("\nputting the answer back together");

test("the stretches join in order, as one answer", () => {
  assert.strictEqual(
    joinSegments(["I built a MERN app.", "The hard part was real time sync."]),
    "I built a MERN app. The hard part was real time sync.");
});

test("a stretch that failed leaves a gap, not a double space", () => {
  assert.strictEqual(joinSegments(["One.", "", "  ", "Two."]), "One. Two.");
});

test("Whisper's leading and trailing spaces do not survive", () => {
  assert.strictEqual(joinSegments([" One. ", " Two. "]), "One. Two.");
});

test("nothing at all is an empty answer, not a crash", () => {
  assert.strictEqual(joinSegments([]), "");
  assert.strictEqual(joinSegments([null, undefined]), "");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
