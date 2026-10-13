// node src/audio/hotwords.test.mjs
import assert from "node:assert";
import { correctTranscript, similarity } from "./hotwords.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
};

const NAME = "Alok Madheshiya";

console.log("\nanchored name correction");

// Both of these are real Whisper output from the spike runs.
test("'Alupma Deja' after 'myself'", () => {
  const r = correctTranscript("Hi everyone, myself Alupma Deja, how are you doing?", [NAME]);
  assert.ok(r.text.includes(NAME), r.text);
  assert.ok(r.text.includes(NAME + ","), "comma should survive: " + r.text);
});

test("'Alupadisha' after 'Myself'", () => {
  const r = correctTranscript("Hi everyone, how are you? Myself Alupadisha.", [NAME]);
  assert.ok(r.text.includes(NAME), r.text);
  assert.strictEqual(r.fixes[0].via, "anchored");
});

test("'my name is' anchor", () => {
  const r = correctTranscript("So my name is Aalok Madhesia and I am from Ghaziabad.", [NAME]);
  assert.ok(r.text.includes(NAME), r.text);
});

test("already correct is left alone", () => {
  const t = "Myself Alok Madheshiya, final year CSE.";
  const r = correctTranscript(t, [NAME]);
  assert.strictEqual(r.text, t);
  assert.strictEqual(r.fixes.length, 0);
});

console.log("\nfree-position correction");

test("tech term close enough is fixed", () => {
  const r = correctTranscript("I built it with React and Node JS and Socket IO.", ["Socket.io"]);
  assert.ok(r.text.includes("Socket.io"), r.text);
});

test("unrelated words are NOT rewritten", () => {
  const t = "I really enjoyed working on the backend part.";
  const r = correctTranscript(t, [NAME, "MongoDB"]);
  assert.strictEqual(r.text, t, "should not touch unrelated text: " + r.text);
  assert.strictEqual(r.fixes.length, 0);
});

test("a loose match without an anchor is rejected", () => {
  // "a look at the shear" is nowhere near the name, but shares letters.
  const t = "Take a look at the shear volume of data.";
  const r = correctTranscript(t, [NAME]);
  assert.strictEqual(r.text, t, r.text);
});

console.log("\nedge cases");

test("empty hotword list is a no-op", () => {
  const t = "Anything at all.";
  assert.strictEqual(correctTranscript(t, []).text, t);
});

test("empty transcript does not throw", () => {
  assert.strictEqual(correctTranscript("", [NAME]).text, "");
});

test("similarity is symmetric and bounded", () => {
  assert.strictEqual(similarity("abc", "abc"), 1);
  assert.strictEqual(similarity("abc", "xyz"), 0);
  assert.ok(Math.abs(similarity("Alok", "Alolk") - similarity("Alolk", "Alok")) < 1e-9);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
