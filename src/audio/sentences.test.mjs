// node src/audio/tts.test.mjs
// Only the pure helper is tested here; the rest needs a browser + WebGPU.
import assert from "node:assert";
import { sentences } from "./sentences.js";

let pass = 0, fail = 0;
const test = (n, fn) => {
  try { fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

console.log("\nsentence splitting (drives when speech starts)");

test("splits on sentence ends, keeping punctuation", () => {
  assert.deepStrictEqual(
    sentences("So, tell me about your project. What did you build? Be specific!"),
    ["So, tell me about your project.", "What did you build?", "Be specific!"]
  );
});

test("a single sentence stays one part", () => {
  assert.deepStrictEqual(sentences("Tell me about yourself."), ["Tell me about yourself."]);
});

test("no trailing punctuation still yields one part", () => {
  assert.deepStrictEqual(sentences("Okay so what next"), ["Okay so what next"]);
});

test("empty and whitespace produce nothing to speak", () => {
  assert.deepStrictEqual(sentences(""), []);
  assert.deepStrictEqual(sentences("   \n  "), []);
});

test("stock fillers stay single parts", () => {
  for (const f of ["Hmm.", "Okay.", "Achha.", "Mm-hm."]) {
    assert.deepStrictEqual(sentences(f), [f]);
  }
});

test("newlines between sentences are handled", () => {
  assert.deepStrictEqual(sentences("First one.\nSecond one."), ["First one.", "Second one."]);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
