// node electron/services/report.test.cjs
//
// Only the deterministic half is tested — the model's judgement is not
// unit-testable, but the numbers it is handed must be right, because the report
// is explicitly told to trust them rather than re-count.
const assert = require("node:assert");
const { speechStats } = require("./report.cjs");

let pass = 0, fail = 0;
const test = (n, fn) => {
  try { fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

const session = (answers, minutes = 6) => ({
  elapsedMs: minutes * 60000,
  history: answers.flatMap((a) => [
    { role: "assistant", content: "Question?<<<META>>>{}" },
    { role: "user", content: a },
  ]),
});

console.log("\nspeech stats");

test("counts answers, ignoring silent turns", () => {
  const s = speechStats(session(["one two three", "(said nothing)", "four five"]));
  assert.strictEqual(s.answers, 2);
  assert.strictEqual(s.silent_turns, 1);
});

test("counts fillers including Hinglish ones", () => {
  const s = speechStats(session(["Um basically matlab I did it, you know"]));
  assert.strictEqual(s.filler_breakdown.um, 1);
  assert.strictEqual(s.filler_breakdown.basically, 1);
  assert.strictEqual(s.filler_breakdown.matlab, 1);
  assert.strictEqual(s.filler_breakdown["you know"], 1);
  assert.strictEqual(s.filler_total, 4);
});

test("filler matching is word-bounded, not substring", () => {
  // "likely" contains "like"; "actually" must not also count as "actual".
  const s = speechStats(session(["That is likely the umbrella policy"]));
  assert.strictEqual(s.filler_total, 0, JSON.stringify(s.filler_breakdown));
});

test("answer lengths and pace", () => {
  const s = speechStats(session(["a b c d e f g h i j", "k l"], 2));
  assert.strictEqual(s.total_words, 12);
  assert.strictEqual(s.longest_answer_words, 10);
  assert.strictEqual(s.shortest_answer_words, 2);
  assert.strictEqual(s.avg_answer_words, 6);
  assert.strictEqual(s.words_per_minute, 6);
});

test("fillers per 100 words is the comparable figure", () => {
  const words = Array(100).fill("word").join(" ");
  const s = speechStats(session([words + " um um um"]));
  assert.strictEqual(s.fillers_per_100_words, 2.9);
});

test("an interview where nobody spoke does not divide by zero", () => {
  const s = speechStats(session(["(said nothing)"]));
  assert.strictEqual(s.answers, 0);
  assert.strictEqual(s.avg_answer_words, 0);
  assert.strictEqual(s.fillers_per_100_words, 0);
  assert.ok(Number.isFinite(s.words_per_minute));
});

test("a zero-length session still reports finite numbers", () => {
  const s = speechStats({ elapsedMs: 0, history: [] });
  assert.ok(Number.isFinite(s.words_per_minute));
  assert.strictEqual(s.duration_minutes, 0);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
