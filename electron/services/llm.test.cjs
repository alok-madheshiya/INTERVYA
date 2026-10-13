// node electron/services/llm.test.cjs
//
// The layer that builds the interview's prompt and hands it to a provider.
//
// This file used to test a chain of two. The second provider (Mistral) never
// worked — its key authenticated, listed models and showed an unspent monthly
// allowance, and every completion came back 429 — so it was removed, and with
// it the machinery for choosing between providers. What is left is the part
// that still decides something: a missing key must say so plainly rather than
// failing somewhere deeper with a stranger message.
const assert = require("node:assert");
const llm = require("./llm.cjs");

let pass = 0, fail = 0;
const test = async (n, fn) => {
  try { await fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

(async () => {
  console.log("\nwho gets asked");

  await test("the provider with a key is the one used", () => {
    assert.deepStrictEqual(llm.usable({ gemini: "k" }).map((p) => p.id), ["gemini"]);
  });

  await test("no key is nothing to ask", () => {
    assert.strictEqual(llm.usable({}).length, 0);
  });

  await test("with no key it says so, rather than failing obscurely later", async () => {
    await assert.rejects(
      llm.stream({ contents: [], systemInstruction: "" }, {}, () => {}),
      /No API key is set/);
  });

  await test("the answer says which provider gave it", async () => {
    // Carried through so a transcript can be read back later and understood.
    const real = llm.PROVIDERS[0].mod;
    llm.PROVIDERS[0].mod = {
      TURN_MODEL: "g",
      streamOnce: async () => ({ spoken: "Go on.", meta: null, raw: "Go on.", model: "g" }),
    };
    try {
      const out = await llm.stream({ contents: [], systemInstruction: "" }, { gemini: "k" });
      assert.strictEqual(out.provider, "gemini");
      assert.strictEqual(out.spoken, "Go on.");
    } finally {
      llm.PROVIDERS[0].mod = real;
    }
  });

  await test("verifying a provider nobody has heard of is an error, not a crash", () => {
    assert.throws(() => llm.verifyKey("nope", "k"), /Unknown provider/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
