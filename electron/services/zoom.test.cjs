// node electron/services/zoom.test.cjs
//
// The key names here are not guesses: they were read off real Electron
// before-input-event payloads, which report `=` for the unshifted "+" key
// (code "Equal") and `-` for minus (code "Minus").
const assert = require("node:assert");
const { zoomFor, zoomForWheel, STEP, MIN, MAX } = require("./zoom.cjs");

let pass = 0, fail = 0;
const test = (n, fn) => {
  try { fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

const key = (k, over = {}) =>
  ({ type: "keyDown", key: k, control: true, meta: false, ...over });

console.log("zoomFor");

test("Ctrl+= steps up — that is what the unshifted + key reports", () => {
  assert.strictEqual(zoomFor(key("="), 0), STEP);
});

test("Ctrl+Shift++ steps up too, since that is the same physical key", () => {
  assert.strictEqual(zoomFor(key("+", { shift: true }), 0), STEP);
});

test("the numpad's own +/- work", () => {
  assert.strictEqual(zoomFor(key("Add"), 0), STEP);
  assert.strictEqual(zoomFor(key("Subtract"), 1), 1 - STEP);
});

test("Ctrl+- steps down", () => {
  assert.strictEqual(zoomFor(key("-"), 1), 1 - STEP);
});

test("Ctrl+0 resets to the default, wherever it was", () => {
  assert.strictEqual(zoomFor(key("0"), 3.5), 0);
  assert.strictEqual(zoomFor(key("0"), -2), 0);
});

test("Cmd works as well as Ctrl", () => {
  assert.strictEqual(zoomFor(key("=", { control: false, meta: true }), 0), STEP);
});

// Everything below must return null, or the handler would call preventDefault
// on a key the page needed.
test("a bare = is not a zoom key — it is someone typing", () => {
  assert.strictEqual(zoomFor(key("=", { control: false }), 0), null);
});

test("Ctrl+A is left alone, so select-all still works in the resume box", () => {
  assert.strictEqual(zoomFor(key("a"), 0), null);
});

test("key-up is ignored, so one press is one step", () => {
  assert.strictEqual(zoomFor(key("=", { type: "keyUp" }), 0), null);
});

console.log("\nlimits");

test("zooming in stops at the point the call grid stops fitting", () => {
  assert.strictEqual(zoomFor(key("="), MAX), MAX);
  assert.strictEqual(zoomFor(key("="), MAX - 0.25), MAX);
});

test("zooming out stops before the text becomes unreadable", () => {
  assert.strictEqual(zoomFor(key("-"), MIN), MIN);
});

console.log("\nzoomForWheel");

test("Ctrl+wheel moves by the same step as the keys", () => {
  assert.strictEqual(zoomForWheel("in", 0), STEP);
  assert.strictEqual(zoomForWheel("out", 0), -STEP);
});

test("the wheel is clamped like the keys are", () => {
  assert.strictEqual(zoomForWheel("in", MAX), MAX);
  assert.strictEqual(zoomForWheel("out", MIN), MIN);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
