// node electron/services/retry.test.cjs
//
// A 503 from Gemini ended a whole interview and then killed the report that was
// supposed to salvage it. These tests pin down the difference between "wait, the
// server is busy" and "stop, something is actually wrong" — getting that wrong
// in either direction is expensive: retrying an auth failure just delays the
// message, and surfacing a 503 throws away the session.
const assert = require("node:assert");
const { classify, isTransient, withRetry, friendlyError } = require("./retry.cjs");

let pass = 0, fail = 0;
const test = async (n, fn) => {
  try { await fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

// The exact shape the app actually received.
const REAL_503 = new Error(
  'ApiError: {"error":{"code":503,"message":"This model is currently experiencing high demand.' +
  ' Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'
);

(async () => {
  console.log("\nclassifying failures");

  await test("the real 503 the app hit is treated as busy, not as quota", () => {
    assert.strictEqual(classify(REAL_503).kind, "busy");
  });

  await test("a free-tier rate limit is quota, and waits longer than a busy signal", () => {
    const quota = classify(new Error('{"code":429,"status":"RESOURCE_EXHAUSTED"}'));
    assert.strictEqual(quota.kind, "quota");
    assert.ok(quota.waits[0] > classify(REAL_503).waits[0]);
  });

  await test("a bad key is never retried — waiting cannot fix it", () => {
    assert.strictEqual(isTransient(new Error("API key not valid. Please pass a valid API key.")), false);
  });

  await test("a missing model is never retried — the caller walks to the next one", () => {
    assert.strictEqual(isTransient(new Error("404 models/gemini-9-flash is not found")), false);
  });

  console.log("\nwithRetry");

  await test("returns the first success without waiting", async () => {
    let calls = 0;
    const out = await withRetry(async () => { calls++; return "done"; });
    assert.strictEqual(out, "done");
    assert.strictEqual(calls, 1);
  });

  await test("recovers when a busy server clears on the next attempt", async () => {
    let calls = 0;
    const waits = [];
    const out = await withRetry(
      async () => { if (++calls === 1) throw REAL_503; return "report"; },
      { onWait: (i) => waits.push(i), waits: [1] }
    );
    assert.strictEqual(out, "report");
    assert.strictEqual(calls, 2);
    // How many times the countdown ticks is not the contract, and pinning it to
    // exactly one made this test fail whenever the machine was busy: Windows'
    // Date.now() moves in ~15 ms steps, so a 1 ms wait can still look unfinished
    // after sleeping through it and tick a second time. What matters is that the
    // wait was narrated at all.
    assert.ok(waits.length >= 1);
    assert.strictEqual(waits[0].kind, "busy");
    // Something must be shown; a silent pause is indistinguishable from a hang.
    assert.ok(waits[0].message.length > 0);
  });

  await test("gives up after the last wait instead of retrying forever", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw REAL_503; }, { waits: [1, 1, 1] }),
      /503/
    );
    assert.strictEqual(calls, 4);
  });

  await test("the shipped busy schedule is short enough to sit through", () => {
    const total = classify(REAL_503).waits.reduce((a, b) => a + b, 0);
    assert.ok(total <= 25000, `${total}ms of waiting mid-interview is too long`);
  });

  await test("a non-transient failure surfaces immediately", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw new Error("API_KEY_INVALID"); }),
      /API_KEY_INVALID/
    );
    assert.strictEqual(calls, 1);
  });

  await test("giveUp stops a retry that would repeat a side effect", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls++; throw REAL_503; }, { giveUp: () => true }),
      /503/
    );
    assert.strictEqual(calls, 1);
  });

  console.log("\nfriendlyError");

  await test("the raw ApiError JSON never reaches the candidate", () => {
    const m = friendlyError(REAL_503).message;
    assert.ok(!m.includes('{"error"'), "raw JSON leaked: " + m);
    assert.match(m, /overloaded|busy/i);
  });

  await test("a bad key says to fix the key, not to wait", () => {
    assert.match(friendlyError(new Error("API_KEY_INVALID")).message, /key/i);
  });

  await test("an unrecognised error is passed through rather than swallowed", () => {
    const e = new Error("something specific broke");
    assert.strictEqual(friendlyError(e), e);
  });

  console.log("\na stream that carried no text");

  // This one reached the interview loop as a fatal error and ended the session:
  // from the candidate's side the app crashed and jumped to the report. It is
  // the cheapest failure there is to survive — ask the same question again.
  const EMPTY = new Error("Gemini returned an empty response.");

  await test("an empty reply is transient, and waits far less than a quota", () => {
    assert.strictEqual(classify(EMPTY).kind, "empty");
    assert.ok(classify(EMPTY).waits[0] < classify(new Error("429 quota")).waits[0]);
  });

  await test("it retries rather than surfacing on the first blank", async () => {
    let calls = 0;
    const out = await withRetry(async () => {
      if (++calls === 1) throw EMPTY;
      return "the second attempt spoke";
    }, { waits: [1] });
    assert.strictEqual(out, "the second attempt spoke");
    assert.strictEqual(calls, 2);
  });

  await test("it says what happened rather than showing the raw sentence", () => {
    assert.match(friendlyError(EMPTY).message, /nothing at all/i);
  });

  console.log("\nnaming the right provider");

  // Once a second provider existed, every one of these still said "Gemini" —
  // so a rejected Mistral key told the candidate to go and re-enter their
  // Gemini key, which was never the problem. The name is a parameter now.
  await test("a second provider's failure is not reported as Gemini's", () => {
    // These all said "Gemini" unconditionally until a second provider was
    // tried, and a rejected key for it came back as "That Gemini API key is not
    // valid" — sending someone to re-enter a key that was never the problem.
    // The provider that was tried has since been dropped; the parameter stays,
    // because getting this wrong is silent and sends people the wrong way.
    for (const e of [REAL_503, new Error("429 quota"), EMPTY, new Error("fetch failed")]) {
      const msg = friendlyError(e, "Someone Else").message;
      assert.match(msg, /Someone Else/, msg);
      assert.doesNotMatch(msg, /Gemini/, msg);
    }
  });

  await test("Gemini stays the default, so nothing else had to change", () => {
    assert.match(friendlyError(REAL_503).message, /Gemini/);
  });

  await test("a refused key keeps the provider's own words", () => {
    // "Invalid key" and "this workspace has no API access" are the same status
    // code and need entirely different things done about them. Throwing the
    // body away left the candidate with no way to tell which they had.
    const raw = "API key not valid (403): workspace has no Plateforme subscription";
    assert.match(friendlyError(new Error(raw), "Someone Else").message, /Plateforme subscription/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
