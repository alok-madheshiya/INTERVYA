// node electron/services/detect.test.cjs
//
// "Here is my API key" — and the app works out the rest.
//
// The walk itself is what matters here, because every way it can go wrong
// lands on the candidate as the same sentence: "that key did not work". It has
// to try the right providers in the right order, tell a refused key apart from
// a spent one, and never throw away a key that is genuinely fine.
//
// The clients are swapped out below, so nothing here touches the network.
const assert = require("node:assert");
const detect = require("./detect.cjs");
const gemini = require("./gemini.cjs");
const chatapi = require("./chatapi.cjs");

let pass = 0, fail = 0;
const test = async (n, fn) => {
  try { await fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

const real = {
  list: chatapi.listModels, gen: chatapi.generate, probe: chatapi.probe,
  gList: gemini.listModels, gVerify: gemini.verifyKey,
};

/**
 * Stands in for every provider at once.
 *
 * `listing` says what each provider's /models does — an array to return, or an
 * Error to throw — and `generate` says what the confirming call does. Anything
 * not named refuses the key, which is what a provider does with somebody
 * else's key.
 */
function fake({ listing = {}, generate, calls = [] } = {}) {
  const answer = (id) => {
    calls.push(id);
    const v = listing[id];
    if (v instanceof Error) throw v;
    if (!v) throw new Error("401 refused this key.");
    return v;
  };
  chatapi.listModels = async ({ provider }) => answer(provider.id);
  // Only OpenRouter and Hugging Face reach this, and for them it is the call
  // that decides, not the listing.
  chatapi.probe = async ({ provider }) => answer(provider.id);
  gemini.listModels = async () => answer("gemini").map((id) => ({ id, label: id }));
  chatapi.generate = generate ?? (async ({ model }) => ({ text: "ok", model }));
  gemini.verifyKey = async () => {
    if (generate) return generate({ model: "gemini-3.6-flash" });
    return { ok: true, text: "ok", model: "gemini-3.6-flash" };
  };
  return calls;
}

const restore = () => {
  chatapi.listModels = real.list;
  chatapi.generate = real.gen;
  chatapi.probe = real.probe;
  gemini.listModels = real.gList;
  gemini.verifyKey = real.gVerify;
};

const GROQ_KEY = "gsk_" + "a".repeat(30);
const AMBIGUOUS = "sk-" + "0123456789abcdef".repeat(2);   // DeepSeek or OpenAI

(async () => {
  console.log("\nworking out whose key it is");

  await test("a key with a prefix of its own is recognised without a search", async () => {
    const calls = fake({ listing: { groq: ["llama-3.1-8b-instant"] } });
    const found = await detect.detect(GROQ_KEY);
    assert.strictEqual(found.provider, "groq");
    assert.strictEqual(found.name, "Groq");
    // One provider asked, not fourteen.
    assert.deepStrictEqual(calls, ["groq"]);
    restore();
  });

  await test("a Gemini key goes through Google's own client", async () => {
    const calls = fake({ listing: { gemini: ["gemini-3.6-flash", "gemini-embedding-001"] } });
    const found = await detect.detect("AIzaSy" + "a".repeat(30));
    assert.strictEqual(found.provider, "gemini");
    assert.strictEqual(found.model, "gemini-3.6-flash");
    assert.deepStrictEqual(calls, ["gemini"]);
    restore();
  });

  await test("an ambiguous key is offered round until somebody takes it", async () => {
    // sk- then 32 hex could be DeepSeek or OpenAI. DeepSeek is asked first
    // because its shape is the narrower one; it refuses, and the walk goes on
    // rather than reporting a working key as invalid.
    const calls = fake({ listing: { openai: ["gpt-4o-mini"] } });
    const found = await detect.detect(AMBIGUOUS);
    assert.strictEqual(found.provider, "openai");
    assert.deepStrictEqual(calls, ["deepseek", "openai"]);
    restore();
  });

  await test("the screen is told who is being tried, but only during a real search", async () => {
    // With one candidate this would flash past and read like a guess the app
    // is unsure of.
    const seen = [];
    fake({ listing: { groq: ["llama-3.1-8b-instant"] } });
    await detect.detect(GROQ_KEY, { onStatus: (t) => seen.push(t) });
    assert.ok(!seen.some((t) => /^Trying /.test(t)), seen.join(" | "));

    fake({ listing: { openai: ["gpt-4o-mini"] } });
    await detect.detect(AMBIGUOUS, { onStatus: (t) => seen.push(t) });
    assert.ok(seen.some((t) => /^Trying DeepSeek/.test(t)), seen.join(" | "));
    restore();
  });

  await test("a provider whose model list is public is identified some other way", async () => {
    // OpenRouter and Hugging Face both serve /models to anybody. Identifying a
    // key by its listing there would stop the walk on the wrong provider and
    // then fail at the first interview question, so an endpoint that actually
    // needs the key is asked instead — here, that it was asked at all is the
    // whole point.
    const calls = [];
    fake({ listing: { openrouter: ["openai/gpt-4o-mini"] }, calls });
    const found = await detect.detect("sk-or-v1-" + "a".repeat(40));
    assert.strictEqual(found.provider, "openrouter");
    // Once for the key check, once for the listing that follows it.
    assert.deepStrictEqual(calls, ["openrouter", "openrouter"]);
    restore();
  });

  await test("a provider that authenticates but has nothing to talk to is passed over", async () => {
    const calls = fake({
      listing: { deepseek: ["text-embedding-3-large"], openai: ["gpt-4o-mini"] },
    });
    const found = await detect.detect(AMBIGUOUS);
    assert.strictEqual(found.provider, "openai");
    assert.deepStrictEqual(calls, ["deepseek", "openai"]);
    restore();
  });

  console.log("\nwhat comes back");

  await test("the key's own model chain is what gets saved, not a name from this repo", async () => {
    fake({ listing: { groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] } });
    const found = await detect.detect(GROQ_KEY);
    assert.strictEqual(found.turn[0], "llama-3.1-8b-instant");
    assert.strictEqual(found.report[0], "llama-3.3-70b-versatile");
    assert.strictEqual(found.modelCount, 2);
    assert.ok(found.detectedAt);
    restore();
  });

  await test("a provider with hundreds of models does not put all of them in config", async () => {
    const many = Array.from({ length: 300 }, (_, i) => `model-${i}-mini`);
    fake({ listing: { groq: many } });
    const found = await detect.detect(GROQ_KEY);
    assert.ok(found.turn.length <= 6, found.turn.length);
    assert.ok(found.report.length <= 4, found.report.length);
    restore();
  });

  await test("the model the confirming call actually used is the one reported", async () => {
    // The chain's first choice can be out of quota, in which case chatapi has
    // already moved on and the screen should say where it landed.
    fake({
      listing: { groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
      generate: async () => ({ text: "ok", model: "llama-3.3-70b-versatile" }),
    });
    const found = await detect.detect(GROQ_KEY);
    assert.strictEqual(found.model, "llama-3.3-70b-versatile");
    restore();
  });

  console.log("\nkeys that are fine but not working right now");

  await test("a key that is out of free quota today is still saved, with a note", async () => {
    // It is the right key for the right provider and it will work tomorrow.
    // Telling somebody their key is invalid because a quota is spent would be
    // the worst possible answer here.
    fake({
      listing: { groq: ["llama-3.1-8b-instant"] },
      generate: async () => { throw new Error("429 per day quota from Groq."); },
    });
    const found = await detect.detect(GROQ_KEY);
    assert.strictEqual(found.provider, "groq");
    assert.match(found.note, /429/);
    restore();
  });

  await test("a key the provider itself refuses is not saved", async () => {
    fake({
      listing: { groq: ["llama-3.1-8b-instant"] },
      generate: async () => { throw new Error("401 Groq refused this key."); },
    });
    await assert.rejects(detect.detect(GROQ_KEY), /401/);
    restore();
  });

  console.log("\nwhen nobody takes it");

  await test("a key nobody recognises says who was asked", async () => {
    // Otherwise the candidate has no idea whether the key is wrong, the app is
    // broken, or their provider is simply not supported.
    fake({ listing: {} });
    await assert.rejects(detect.detect(AMBIGUOUS), /No provider recognised that key/);
    await assert.rejects(detect.detect(AMBIGUOUS), /DeepSeek, OpenAI/);
    restore();
  });

  await test("a single-candidate failure keeps the provider's own words", async () => {
    fake({ listing: { groq: new Error("Groq returned HTTP 500.") } });
    await assert.rejects(detect.detect(GROQ_KEY), /HTTP 500/);
    restore();
  });

  await test("no internet stops the walk instead of asking fourteen times", async () => {
    const calls = fake({ listing: { deepseek: new Error("fetch failed") } });
    await assert.rejects(detect.detect(AMBIGUOUS), /No internet connection/);
    assert.deepStrictEqual(calls, ["deepseek"]);
    restore();
  });

  await test("an empty box is an empty box, not a search", async () => {
    const calls = fake({});
    await assert.rejects(detect.detect("  "), /No key given/);
    assert.deepStrictEqual(calls, []);
    restore();
  });

  console.log("\ntelling the two kinds of failure apart");

  await test("a refusal is the key being wrong for this provider", () => {
    assert.strictEqual(detect.isRefusal(new Error("401 refused")), true);
    assert.strictEqual(detect.isRefusal(new Error("API key not valid")), true);
    assert.strictEqual(detect.isRefusal(new Error("503 overloaded")), false);
  });

  await test("a network failure is nothing to do with the key", () => {
    assert.strictEqual(detect.isOffline(new Error("fetch failed")), true);
    assert.strictEqual(detect.isOffline(new Error("getaddrinfo ENOTFOUND api.x.ai")), true);
    assert.strictEqual(detect.isOffline(new Error("401 refused")), false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
