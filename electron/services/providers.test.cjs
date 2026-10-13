// node electron/services/providers.test.cjs
//
// The two judgement calls behind "paste any API key": working out whose key it
// is from its shape, and working out which of that key's models to use.
//
// Both are guesses, and both have a specific way of being wrong that matters.
// Guessing the provider wrong tells somebody their working key is invalid.
// Guessing the model wrong picks an embedding model as the interviewer.
const assert = require("node:assert");
const p = require("./providers.cjs");

let pass = 0, fail = 0;
const test = (n, fn) => {
  try { fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

const ids = (key) => p.candidates(key).map((x) => x.id);

console.log("\nwhose key is this");

test("a prefix nobody else uses settles it outright", () => {
  assert.deepStrictEqual(ids("gsk_" + "a".repeat(30)), ["groq"]);
  assert.deepStrictEqual(ids("AIzaSy" + "a".repeat(30)), ["gemini"]);
  assert.deepStrictEqual(ids("xai-" + "a".repeat(30)), ["xai"]);
  assert.deepStrictEqual(ids("pplx-" + "a".repeat(30)), ["perplexity"]);
});

test("a certain key needs no network at all", () => {
  assert.strictEqual(p.isCertain("gsk_" + "a".repeat(30)), true);
  assert.strictEqual(p.isCertain("sk-" + "a".repeat(40)), true);  // only OpenAI's catch-all
});

test("sk-ant- is Anthropic first, whatever else matches as well", () => {
  // OpenAI's catch-all also matches this, and must not be asked first: it
  // would answer 401 and the walk would be one wasted round trip longer.
  assert.strictEqual(ids("sk-ant-api03-" + "a".repeat(40))[0], "anthropic");
});

test("the narrower of two overlapping shapes is tried first", () => {
  // sk- then 32 hex is DeepSeek; sk- then anything is OpenAI. Both match, and
  // the specific one has to come first or DeepSeek is never reached.
  assert.deepStrictEqual(ids("sk-" + "0123456789abcdef".repeat(2)), ["deepseek", "openai"]);
});

test("a key shaped like nothing we know gets offered to everybody", () => {
  // The alternative is refusing a perfectly good key from a provider added
  // after this code was written, which is the one failure worth avoiding here.
  assert.deepStrictEqual(p.candidates("qwerty-12345"), p.PROVIDERS);
});

test("no key is nobody, rather than everybody", () => {
  assert.deepStrictEqual(p.candidates(""), []);
  assert.deepStrictEqual(p.candidates(null), []);
  assert.deepStrictEqual(p.candidates("   "), []);
});

test("whitespace round a pasted key does not change who it belongs to", () => {
  assert.deepStrictEqual(ids("  gsk_" + "a".repeat(30) + "\n"), ["groq"]);
});

console.log("\nwhich of this key's models");

test("the app's preference wins when the key can reach it", () => {
  const got = p.pickModels(p.byId("groq"), [
    "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "whisper-large-v3",
  ]);
  assert.strictEqual(got.turn[0], "llama-3.1-8b-instant");   // fast, for a turn
  assert.strictEqual(got.report[0], "llama-3.3-70b-versatile");
});

test("models that cannot hold a conversation are never picked", () => {
  const got = p.pickModels(p.byId("openai"), [
    "text-embedding-3-large", "whisper-1", "dall-e-3", "tts-1", "gpt-4o-mini",
  ]);
  assert.deepStrictEqual(got.turn, ["gpt-4o-mini"]);
  // Even as a last resort: an embedding model cannot be interviewed with.
  assert.ok(!got.report.some((m) => /embedding|whisper|dall-e|tts/.test(m)), got.report.join());
});

test("a key with nothing to talk to gets nothing, rather than a hopeful guess", () => {
  // Not the same as a key that listed nothing at all. This one has real
  // contents and no chat model in them, so naming one anyway would send the
  // candidate into an interview that 404s on the first question — detect.cjs
  // reads the empty chain as "not this provider" and keeps looking.
  const got = p.pickModels(p.byId("openai"), ["text-embedding-3-large", "whisper-1"]);
  assert.deepStrictEqual(got.turn, []);
  assert.deepStrictEqual(got.report, []);
});

test("a model list we have never heard of is ranked by name instead of refused", () => {
  // The point of reading the live list: a provider renaming everything costs
  // nothing, because "mini" and "large" still mean what they mean.
  const got = p.pickModels(p.byId("openai"), ["frobnicate-large", "frobnicate-mini"]);
  assert.strictEqual(got.turn[0], "frobnicate-mini");
  assert.strictEqual(got.report[0], "frobnicate-large");
});

test("a provider that lists nothing falls back to the names compiled in", () => {
  // Perplexity has no /models endpoint, so its hints are all there is.
  assert.deepStrictEqual(p.pickModels(p.byId("perplexity"), []).turn, ["sonar", "sonar-pro"]);
});

test("either chain ends with the other, so neither can run out", () => {
  // A spent daily quota walks the chain. Running out of turn models mid-
  // interview must land on the report model rather than on nothing.
  const got = p.pickModels(p.byId("groq"), ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]);
  assert.deepStrictEqual([...got.turn].sort(), [...got.report].sort());
  assert.notStrictEqual(got.turn[0], got.report[0]);
});

test("nothing is listed twice in a chain", () => {
  const got = p.pickModels(p.byId("deepseek"), ["deepseek-chat"]);
  assert.deepStrictEqual(got.turn, [...new Set(got.turn)]);
});

console.log("\nthe registry itself");

test("every provider is one the adapters can actually reach", () => {
  for (const spec of p.PROVIDERS) {
    assert.ok(["gemini", "openai", "anthropic"].includes(spec.wire), `${spec.id}: ${spec.wire}`);
    // Gemini goes through Google's SDK, which knows its own URL.
    if (spec.wire !== "gemini") assert.ok(/^https:\/\//.test(spec.base), `${spec.id} has no base`);
    assert.ok(spec.defaults?.turn?.length, `${spec.id} has no turn model`);
    assert.ok(spec.defaults?.report?.length, `${spec.id} has no report model`);
    assert.ok(spec.name && spec.where !== undefined, `${spec.id} is not presentable`);
  }
});

test("ids are unique, because config keys by them", () => {
  assert.strictEqual(new Set(p.IDS).size, p.IDS.length);
});

test("looking up a provider nobody has heard of is null, not a throw", () => {
  assert.strictEqual(p.byId("nope"), null);
  assert.strictEqual(p.byId("gemini").name, "Google Gemini");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
