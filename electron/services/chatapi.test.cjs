// node electron/services/chatapi.test.cjs
//
// The adapter that lets thirteen providers answer a prompt written for Gemini.
//
// Nothing here touches the network. What is worth testing is the translation
// either side of it: the interview's prompt into each wire format, and each
// provider's HTTP failures back into the three transient kinds retry.cjs knows
// how to wait out. Both have an expensive way of being wrong — a dropped
// system prompt makes the panel forget who it is, and a misread 429 either
// ends an interview that would have survived or sits on a timer for a key that
// has simply run out of money.
const assert = require("node:assert");
const c = require("./chatapi.cjs");
const providers = require("./providers.cjs");
const { classify, isDailyQuota, retryAfterMs } = require("./retry.cjs");

let pass = 0, fail = 0;
const test = async (n, fn) => {
  try { await fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

const openai = providers.byId("openai");
const anthropic = providers.byId("anthropic");
const groq = providers.byId("groq");

const said = (role, text) => ({ role, parts: [{ text }] });

(async () => {
  console.log("\nthe prompt, in someone else's shape");

  await test("Gemini's model/user roles become assistant/user", () => {
    assert.deepStrictEqual(
      c.toMessages([said("user", "hi"), said("model", "and you?"), said("user", "fine")]),
      [{ role: "user", content: "hi" },
       { role: "assistant", content: "and you?" },
       { role: "user", content: "fine" }]);
  });

  await test("two turns from the same side become one", () => {
    // Anthropic rejects consecutive user messages outright, and the others
    // treat them as separate turns, which is not what the transcript means.
    assert.deepStrictEqual(
      c.collapse([{ role: "user", content: "a" }, { role: "user", content: "b" }]),
      [{ role: "user", content: "a\n\nb" }]);
  });

  await test("an empty turn is dropped rather than sent as a blank message", () => {
    assert.deepStrictEqual(c.toMessages([said("user", ""), said("user", "real")]),
      [{ role: "user", content: "real" }]);
  });

  await test("on the OpenAI wire the system prompt is the first message", () => {
    const b = c.chatBody(openai, {
      model: "m", systemInstruction: "you are a panel", contents: [said("user", "hi")],
    });
    assert.deepStrictEqual(b.messages[0], { role: "system", content: "you are a panel" });
    assert.strictEqual(b.messages[1].content, "hi");
  });

  await test("on the Anthropic wire it is held apart from the messages", () => {
    const b = c.chatBody(anthropic, {
      model: "m", systemInstruction: "you are a panel", contents: [said("user", "hi")],
      maxOutputTokens: 100,
    });
    assert.strictEqual(b.system, "you are a panel");
    assert.deepStrictEqual(b.messages, [{ role: "user", content: "hi" }]);
    // Anthropic requires it, and a missing max_tokens is a 400, not a default.
    assert.strictEqual(b.max_tokens, 100);
  });

  await test("a history that begins mid-answer still starts with the candidate", () => {
    // Anthropic will not take a conversation that opens on the assistant.
    const b = c.chatBody(anthropic, {
      model: "m", contents: [said("model", "...so tell me"), said("user", "ok")],
    });
    assert.strictEqual(b.messages[0].role, "user");
  });

  await test("OpenAI's newer token field is used where it is the only one accepted", () => {
    // These models 400 on max_tokens outright; every other provider on this
    // wire only knows the old name.
    assert.strictEqual(
      c.chatBody(openai, { model: "m", contents: [], maxOutputTokens: 50 }).max_completion_tokens, 50);
    assert.strictEqual(
      c.chatBody(groq, { model: "m", contents: [], maxOutputTokens: 50 }).max_tokens, 50);
  });

  await test("JSON mode is asked for only when the report asks for it", () => {
    assert.strictEqual(c.chatBody(groq, { model: "m", contents: [] }).response_format, undefined);
    assert.deepStrictEqual(
      c.chatBody(groq, { model: "m", contents: [], jsonMode: true }).response_format,
      { type: "json_object" });
  });

  console.log("\nHTTP failures, as retry.cjs reads them");

  await test("an ordinary 429 is a rate limit to wait out", () => {
    const err = c.wireError(429, '{"error":{"message":"rate limit reached"}}', groq);
    assert.strictEqual(classify(err)?.kind, "quota");
    assert.strictEqual(isDailyQuota(err), false);
  });

  await test("a spent balance is not a rate limit and must not be waited on", () => {
    // 52 seconds of countdown followed by "hit the rate limit" is the wrong
    // answer to a key with no credit on it, twice over.
    const err = c.wireError(429, '{"error":{"code":"insufficient_quota"}}', openai);
    assert.strictEqual(classify(err), null);
    assert.match(err.message, /no credit left/i);
    assert.ok(!/\b429\b/.test(err.message), err.message);
  });

  await test("a per-day limit is worded so the model gets written off for today", () => {
    const err = c.wireError(429, "Rate limit reached: tokens per day (TPD)", groq);
    assert.strictEqual(isDailyQuota(err), true);
  });

  await test("the server's own retry delay survives the rewrite", () => {
    // Guessing 21 seconds when the server has already said 37 just burns an
    // attempt on the same refusal.
    const err = c.wireError(429, "slow down", groq, "37");
    assert.strictEqual(retryAfterMs(err), 37000);
  });

  await test("Anthropic's 529 is the same weather as everyone else's 503", () => {
    assert.strictEqual(classify(c.wireError(529, "overloaded_error", anthropic))?.kind, "busy");
    assert.strictEqual(classify(c.wireError(502, "bad gateway", groq))?.kind, "busy");
  });

  await test("a refused key is reported, never retried", () => {
    const err = c.wireError(401, "invalid api key", groq);
    assert.strictEqual(classify(err), null);
    assert.match(err.message, /\b401\b/);
  });

  await test("a 400 about the model reads as a missing model, so the chain walks on", () => {
    // Several providers answer a retired model with 400 rather than 404, and
    // that must not end the interview when a lighter model would answer.
    assert.match(c.wireError(400, "The model `x` does not exist", groq).message, /\b404\b/);
    // A 400 about anything else is a real error and must not be mistaken for one.
    assert.ok(!/\b404\b/.test(c.wireError(400, "temperature must be <= 2", groq).message));
  });

  await test("a body long enough to bury the message is cut, not dropped", () => {
    const err = c.wireError(400, "x".repeat(5000), groq);
    assert.ok(err.message.length < 600, err.message.length);
    assert.match(err.message, /HTTP 400/);
  });

  console.log("\nreading the stream");

  /** One SSE response, built out of whatever chunk boundaries we like. */
  const sse = (chunks) => ({
    body: {
      getReader() {
        let i = 0;
        return {
          read: async () => i < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
            : { done: true },
        };
      },
    },
  });

  const drain = async (res) => {
    const out = [];
    for await (const ev of c.events(res)) out.push(ev);
    return out;
  };

  await test("an event split across two network chunks is still one event", () => {
    // The whole reason the buffer exists: a chunk boundary can fall anywhere,
    // including inside the JSON.
    return drain(sse(['data: {"a":', '1}\n\n'])).then((evs) => {
      assert.deepStrictEqual(evs, [{ a: 1 }]);
    });
  });

  await test("keep-alives, comments and [DONE] are not events", async () => {
    const evs = await drain(sse([': ping\n\n', 'data: [DONE]\n\n', 'data: {"b":2}\n\n']));
    assert.deepStrictEqual(evs, [{ b: 2 }]);
  });

  await test("text is pulled out of whichever wire format produced it", () => {
    assert.strictEqual(
      c.deltaText(openai, { choices: [{ delta: { content: "so," } }] }), "so,");
    assert.strictEqual(
      c.deltaText(anthropic, { type: "content_block_delta", delta: { text: "so," } }), "so,");
    // Anthropic's other event types carry no text and must not read as the end.
    assert.strictEqual(c.deltaText(anthropic, { type: "message_start" }), "");
  });

  await test("a failure announced mid-stream is thrown, not read as silence", () => {
    // Otherwise it arrives as an empty answer, which retry.cjs waits out and
    // retries — three times, for an error that was already explained.
    assert.throws(() => c.deltaText(openai, { error: { message: "upstream died" } }), /upstream died/);
    assert.throws(() => c.deltaText(anthropic, { type: "error", error: { message: "overloaded" } }),
      /overloaded/);
  });

  console.log("\nwhat is remembered between turns");

  await test("a model out of daily quota is skipped until the day turns over", () => {
    c.markDailyOut("groq:m1");
    assert.strictEqual(c.isOutForToday("groq:m1"), true);
    assert.strictEqual(c.isOutForToday("groq:m2"), false);
    // Per provider, not per model name: the same model on another key has its
    // own quota.
    assert.strictEqual(c.isOutForToday("xai:m1"), false);
  });

  await test("the note expires rather than outliving the quota", () => {
    c._dailyOut.set("groq:m3", Date.now() - 1);
    assert.strictEqual(c.isOutForToday("groq:m3"), false);
    assert.strictEqual(c._dailyOut.has("groq:m3"), false);
  });

  await test("a new key starts with none of the old one's limits", () => {
    // Quotas and tiers belong to the key. What the last one could not reach
    // means nothing here.
    c.markDailyOut("groq:m4");
    c._gone.add("groq:m5");
    c.forget();
    assert.strictEqual(c.isOutForToday("groq:m4"), false);
    assert.strictEqual(c.isOutForToday("groq:m5"), false);
  });

  await test("a text-only provider says what to do instead of guessing at a photo", async () => {
    await assert.rejects(
      c.readFile({ provider: providers.byId("deepseek"), apiKey: "k",
                   mimeType: "image/png", base64: "", prompt: "read it" }),
      /cannot read an image/);
  });

  await test("a provider that reads photos but not PDFs is not handed a scan", async () => {
    // It would come back as confident nonsense, which is worse than a refusal
    // the candidate can act on.
    await assert.rejects(
      c.readFile({ provider: providers.byId("groq"), apiKey: "k",
                   mimeType: "application/pdf", base64: "", prompt: "read it" }),
      /cannot read a scanned PDF/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
