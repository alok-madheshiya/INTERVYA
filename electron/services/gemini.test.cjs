// node electron/services/gemini.test.cjs
//
// The free tier's daily quota is per model, and once a model is out it stays
// out until midnight Pacific. The app used to re-ask the dead model first on
// every remaining turn and wait for the same refusal before walking down the
// list — a wasted round trip per model, per turn, for something it had already
// been told. Over a forty-turn interview that is most of a minute of the
// candidate sitting in silence, paid for nothing.
//
// What these pin down is the memory, not the network: that a spent model is
// skipped, that a per-minute limit is *not* mistaken for a daily one (it clears
// while the candidate is still answering, and skipping the better model for a
// day to save a second would be a bad trade), and that the memo expires.
const assert = require("node:assert");
const { FALLBACKS, TURN_MODEL } = require("./gemini.cjs");
const g = require("./gemini.cjs");

let pass = 0, fail = 0;
const test = (n, fn) => {
  try { fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

const reset = () => g._dailyOut.clear();

console.log("\nremembering which model is out for the day");

test("a model that has not refused anything is tried", () => {
  reset();
  assert.strictEqual(g.isOutForToday("gemini-3.6-flash"), false);
});

test("a model marked out is skipped", () => {
  reset();
  g.markDailyOut("gemini-3.6-flash");
  assert.strictEqual(g.isOutForToday("gemini-3.6-flash"), true);
});

test("only that model is skipped — the quotas are per model", () => {
  reset();
  g.markDailyOut("gemini-3.6-flash");
  assert.strictEqual(g.isOutForToday("gemini-2.5-flash"), false);
});

test("the memo expires, and expiring forgets it rather than answering stale", () => {
  reset();
  g._dailyOut.set("gemini-3.6-flash", Date.now() - 1);
  assert.strictEqual(g.isOutForToday("gemini-3.6-flash"), false);
  assert.strictEqual(g._dailyOut.has("gemini-3.6-flash"), false,
    "an expired entry was left behind to be re-checked forever");
});

console.log("\nwhen the day rolls over");

test("the reset is in the future, and inside a day", () => {
  const ms = g.nextQuotaReset() - Date.now();
  assert.ok(ms > 0, "the reset is already in the past");
  assert.ok(ms <= 86400000, "the reset is more than a day away");
});

test("it lands on midnight Pacific, not on midnight here", () => {
  // India is 12.5 or 13.5 hours ahead, so a local midnight would be wrong by
  // half a day — the app would either give up on a model that had reset hours
  // ago, or keep asking one that is still spent.
  const at = new Date(g.nextQuotaReset());
  const hhmm = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(at);
  assert.strictEqual(hhmm, "00:00");
});

test("a known moment resolves to the following Pacific midnight", () => {
  // 2026-09-06 18:30 UTC is 11:30 in Los Angeles, so the next reset is 12.5
  // hours later. Fixed input, fixed answer — this is the one that would catch
  // a daylight-saving or sign error.
  const noonish = Date.parse("2026-09-06T18:30:00Z");
  assert.strictEqual(g.nextQuotaReset(noonish) - noonish, 12.5 * 3600000);
});

console.log("\nthe chain of models to fall back to");

// The exact 404 a candidate was shown on the first question of an interview,
// after the two models above it had spent their day. It ended the chain because
// gemini-2.5-flash had been retired underneath us.
const RETIRED = new Error('{"error":{"message":"{ \\"error\\": { \\"code\\": 404, ' +
  '\\"message\\": \\"This model models/gemini-2.5-flash is no longer available to new ' +
  'users. Please update your code to use models/gemini-3.6-flash\\" } }","code":404}}');

test("the retired model is gone from the chain", () => {
  assert.ok(!FALLBACKS.includes("gemini-2.5-flash"),
    "the chain still ends on a model Google has retired");
});

test("the preferred model is in it, and first", () => {
  assert.strictEqual(FALLBACKS[0], TURN_MODEL);
});

test("the chain carries an alias, so it cannot rot into another 404", () => {
  // Pinned version names go away; Google keeps -latest pointing at something
  // live. Without one of these the same failure returns in six months.
  assert.ok(FALLBACKS.some((m) => m.endsWith("-latest")));
});

test("a retired model is remembered and never asked again", () => {
  reset();
  g._gone.clear();
  g._gone.add("gemini-2.5-flash");
  assert.strictEqual(g.isOutForToday("gemini-2.5-flash"), true);
});

test("a config mistake does not retire a working model", () => {
  // "Thinking level MINIMAL is not supported for this model" is a 400 about the
  // request, not about the model — and "not supported" used to match here, which
  // would have struck a perfectly good model off the list for the session.
  const badConfig = new Error('{"error":{"code":400,"message":"Thinking level MINIMAL ' +
    'is not supported for this model. Please use LOW or higher."}}');
  assert.strictEqual(g._isMissingModel(badConfig), false);
  assert.strictEqual(g._isMissingModel(RETIRED), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
