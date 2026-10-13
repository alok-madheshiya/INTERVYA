// Everyone who is not Gemini.
//
// gemini.cjs talks to Google through Google's SDK. This file is the same job
// done over plain HTTP for the other thirteen providers in providers.cjs, and
// it exposes exactly the interface gemini.cjs does — streamOnce, verifyKey,
// listModels — so llm.cjs can hand a prompt to either without knowing which.
//
// Two wire formats cover all of them:
//
//   openai     POST /chat/completions, messages[], SSE deltas. OpenAI, Groq,
//              Mistral, DeepSeek, xAI, OpenRouter, Cerebras, Together,
//              Fireworks, NVIDIA, Perplexity, Hugging Face.
//   anthropic  POST /messages, system held apart from messages[], typed SSE
//              events.
//
// The prompt arrives in Gemini's shape ({ systemInstruction, contents:[{role,
// parts}] }) because that is what prompt.cjs builds and there is no sense in
// rewriting the interview to suit the newer arrival. Converting it here costs
// twenty lines; converting it everywhere else would cost the app.
//
// No SDKs: `fetch` is built in, and @anthropic-ai/sdk plus eleven more
// dependencies to send one POST would be a worse trade than this file.
const { createSplitter } = require("./prompt.cjs");
const { withRetry, friendlyError, classify, isDailyQuota } = require("./retry.cjs");

const dedupe = (xs) => [...new Set(xs.filter(Boolean))];

/** Nothing here waits forever. A turn that takes this long has already failed. */
const TIMEOUT_MS = 120000;

/**
 * Models whose daily allowance is spent, as `provider:model` -> epoch ms.
 *
 * Same reasoning as gemini.cjs: without it, every remaining turn re-asks the
 * same dead model first and pays a round trip for information the app already
 * had. Per-minute limits are deliberately not remembered — those clear while
 * the candidate is still answering.
 */
const dailyOut = new Map();

/** Models this key cannot use at all. Unlike a quota, this never comes back. */
const gone = new Set();

/** Midnight UTC, which is when most of these providers roll their day over. */
function nextDay(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function markDailyOut(key) {
  dailyOut.set(key, nextDay());
}

function isOutForToday(key) {
  if (gone.has(key)) return true;
  const until = dailyOut.get(key);
  if (!until) return false;
  if (Date.now() >= until) { dailyOut.delete(key); return false; }
  return true;
}

/** Forgotten when the key changes: a new key has its own tier and its own quotas. */
function forget() {
  dailyOut.clear();
  gone.clear();
}

function headers(spec, apiKey) {
  if (spec.wire === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    // OpenRouter asks for these and rate-limits anonymous-looking traffic
    // harder. Harmless everywhere else.
    "http-referer": "https://github.com/alokmadheshiya/intervya",
    "x-title": "Intervya",
  };
}

/**
 * One HTTP failure, rewritten so retry.cjs can classify it.
 *
 * That module reads status codes out of the message text — it was written for
 * Gemini's SDK, which stringifies its errors that way — so this keeps the code
 * in the message rather than inventing a second error vocabulary nobody reads.
 * The two corrections that matter:
 *
 *   * a spent *balance* (OpenAI's insufficient_quota, anyone's "add credit")
 *     is not a rate limit, and must not be retried for 52 seconds and then
 *     reported as one. The 429 is dropped from the text on purpose.
 *   * a per-*day* limit is worded so isDailyQuota() recognises it, which is
 *     what stops the model being re-asked for the rest of the session.
 */
function wireError(status, body, spec, retryAfter) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  const short = text.length > 400 ? text.slice(0, 400) + "…" : text;
  const name = spec.name;

  if (status === 429 && /insufficient_quota|billing|add credit|no credit|payment|balance/i.test(text)) {
    // The provider's own words are kept, with one edit: retry.cjs classifies on
    // the word "quota" appearing anywhere in the message, and OpenAI's body for
    // this case says "insufficient_quota" — which would put a key with no money
    // on it through 52 seconds of countdown and then blame a rate limit.
    return new Error(
      `${name} has no credit left on this key. Add billing, or use a key from a ` +
      `provider with a free tier. (${short.replace(/quota/gi, "allowance")})`);
  }
  if (status === 429) {
    const perDay = /per ?day|daily|\bTPD\b|\bRPD\b|tokens per day|requests per day/i.test(text);
    // retry.cjs reads the server's own number out of this shape, so it is
    // worth speaking Google's dialect of "wait this long".
    const delay = retryAfter ? `"retryDelay":"${retryAfter}s"` : "";
    return new Error(`429 ${perDay ? "per day quota" : "rate limit"} from ${name}. ${delay} ${short}`);
  }
  // 529 is Anthropic's "overloaded"; the rest are ordinary gateway weather.
  if (status === 503 || status === 502 || status === 504 || status === 529) {
    return new Error(`503 ${name} is overloaded (HTTP ${status}). ${short}`);
  }
  if (status === 401 || status === 403) {
    return new Error(`401 ${name} refused this key. ${short}`);
  }
  if (status === 404 ||
      (status === 400 && /model|not found|does not exist|not support|decommission/i.test(text))) {
    return new Error(`404 that model is not available on this key. ${short}`);
  }
  return new Error(`${name} returned HTTP ${status}. ${short}`);
}

/** POST or GET, with the timeout and the error shape both already handled. */
async function call(spec, apiKey, path, { body, signal, method } = {}) {
  const url = /^https?:/.test(path) ? path : spec.base.replace(/\/$/, "") + path;
  const timer = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(url, {
    method: method ?? (body ? "POST" : "GET"),
    headers: headers(spec, apiKey),
    body: body ? JSON.stringify(body) : undefined,
    // Either the caller giving up or the clock running out ends the request.
    signal: signal ? AbortSignal.any([signal, timer]) : timer,
  }).catch((err) => {
    // A timeout arrives as an AbortError, which reads as "the user cancelled"
    // unless it is renamed here.
    if (err?.name === "TimeoutError" || (err?.name === "AbortError" && !signal?.aborted)) {
      throw new Error(`503 ${spec.name} did not answer within ${TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw wireError(res.status, text, spec, res.headers.get("retry-after"));
  }
  return res;
}

const json = async (spec, apiKey, path, opts) =>
  (await call(spec, apiKey, path, opts)).json();

// --- the prompt, in each provider's shape ---------------------------------

/** Gemini's parts[] to one string. Nothing in this app puts anything but text there. */
const flatten = (c) => (c.parts ?? []).map((p) => p.text ?? "").join("");

/**
 * Consecutive same-role turns merged into one.
 *
 * Anthropic rejects two user messages in a row outright, and the others
 * silently treat them as separate turns, which is not what the transcript
 * means. Merging is the reading that is right for both.
 */
function collapse(messages) {
  const out = [];
  for (const m of messages) {
    if (!m.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content;
    else out.push({ ...m });
  }
  return out;
}

function toMessages(contents) {
  return collapse((contents ?? []).map((c) => ({
    role: c.role === "model" ? "assistant" : "user",
    content: flatten(c),
  })));
}

/** The body for one generation, streamed or not. */
function chatBody(spec, { model, systemInstruction, contents, temperature, maxOutputTokens,
                          stream, jsonMode, messages }) {
  const msgs = messages ?? toMessages(contents);

  if (spec.wire === "anthropic") {
    // Anthropic insists the conversation starts with the candidate, which it
    // always does here — but a trimmed history could begin on a panel line.
    while (msgs.length && msgs[0].role === "assistant") msgs.shift();
    return {
      model,
      system: systemInstruction || undefined,
      messages: msgs.length ? msgs : [{ role: "user", content: "Hello." }],
      max_tokens: maxOutputTokens ?? 1200,
      temperature,
      stream: !!stream,
    };
  }

  const body = {
    model,
    messages: systemInstruction
      ? [{ role: "system", content: systemInstruction }, ...msgs]
      : msgs,
    temperature,
    stream: !!stream,
  };
  // OpenAI's newer models 400 on max_tokens and want max_completion_tokens;
  // every other provider on this wire only knows the old name.
  if (maxOutputTokens) body[spec.maxTokensField ?? "max_tokens"] = maxOutputTokens;
  if (jsonMode) body.response_format = { type: "json_object" };
  return body;
}

// --- streaming ------------------------------------------------------------

/**
 * Server-sent events, as text. Both wire formats speak SSE; they disagree only
 * about what the JSON inside each event means.
 */
async function* events(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Events are separated by a blank line; a chunk boundary can fall anywhere,
    // so whatever is left after the last one stays in the buffer.
    let at;
    while ((at = buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = buf.slice(0, at);
      buf = buf.slice(at).replace(/^\r?\n\r?\n/, "");
      const data = raw.split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      try { yield JSON.parse(data); } catch { /* a keep-alive or a comment */ }
    }
  }
}

/** The text out of one event, for whichever wire format produced it. */
function deltaText(spec, ev) {
  if (spec.wire === "anthropic") {
    if (ev.type === "content_block_delta") return ev.delta?.text ?? "";
    if (ev.type === "error") throw new Error(ev.error?.message || "stream error");
    return "";
  }
  const choice = ev.choices?.[0];
  // Some providers report mid-stream failures as a choice-less error object.
  if (!choice && ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error));
  return choice?.delta?.content ?? "";
}

/**
 * One streamed generation, with the same model walk gemini.cjs does.
 *
 * Every limit worth walking for — a tier that lacks the model, a spent daily
 * allowance, an overloaded model — is per model on every provider here, so a
 * lighter model very often answers when the preferred one refuses. Auth and
 * network failures are account-wide and surface immediately.
 *
 * @returns {Promise<{spoken:string, meta:object|null, raw:string, model:string}>}
 */
async function streamOnce({ provider: spec, apiKey, systemInstruction, contents, onText, onStatus,
                            model, models, temperature, maxOutputTokens, signal }) {
  const chain = dedupe([model, ...(models ?? []), ...(spec.defaults?.turn ?? [])]);
  const live = chain.filter((m) => !isOutForToday(`${spec.id}:${m}`));
  // Never skip every option: if the whole list is spent, ask anyway so the
  // candidate gets a real error rather than silence, and so a reset is noticed.
  const candidates = live.length ? live : chain;
  let lastErr = null;
  let quotaErr = null;

  for (const m of candidates) {
    try {
      return await withRetry(async () => {
        const split = createSplitter(onText);
        const res = await call(spec, apiKey, spec.wire === "anthropic" ? "/messages" : "/chat/completions", {
          body: chatBody(spec, {
            model: m, systemInstruction, contents, temperature, maxOutputTokens, stream: true,
          }),
          signal,
        });
        for await (const ev of events(res)) {
          const t = deltaText(spec, ev);
          if (t) split.push(t);
        }
        const { spoken, meta, raw } = split.end();
        // An empty stream is a hiccup, not a verdict — retry.cjs knows this
        // wording and waits a moment rather than ending the interview.
        if (!spoken && !meta) throw new Error(`${spec.name} returned an empty response.`);
        return { spoken, meta, raw, model: m };
      }, {
        onWait: ({ message, ms }) => {
          console.warn(`[${spec.id}] ${message} (${ms}ms)`);
          onStatus?.(message);
        },
      });
    } catch (err) {
      lastErr = err;
      const s = String(err?.message || err);
      const kind = classify(err)?.kind;
      const missing = /\b404\b/.test(s);
      const modelSpecific = missing || kind === "busy" || kind === "quota" ||
                            kind === "empty" || isDailyQuota(err);
      if (!modelSpecific) throw friendlyError(err, spec.name);
      if (isDailyQuota(err)) { markDailyOut(`${spec.id}:${m}`); quotaErr ??= err; }
      if (missing) gone.add(`${spec.id}:${m}`);
      const why = isDailyQuota(err) ? "daily quota spent"
        : missing ? "not on this key"
        : kind ?? "unavailable";
      console.warn(`[${spec.id}] ${m} skipped (${why}), trying next`);
      onStatus?.("Switching to a different model…");
    }
  }
  throw friendlyError(quotaErr ?? lastErr, spec.name);
}

/** The text of one non-streamed reply. */
function replyText(spec, data) {
  if (spec.wire === "anthropic") {
    return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * One generation with no streaming — the report, and the key check.
 *
 * `jsonMode` is best-effort by design. Most of this wire supports
 * response_format, several providers accept the field and ignore it, and a few
 * 400 on it; all three are fine, because the schema is in the prompt as well
 * and the answer is parsed leniently either way.
 */
async function generate({ provider: spec, apiKey, systemInstruction, contents, messages,
                          model, models, temperature, maxOutputTokens, jsonMode, onStatus, signal }) {
  const chain = dedupe([model, ...(models ?? []), ...(spec.defaults?.report ?? [])]);
  const candidates = chain.filter((m) => !isOutForToday(`${spec.id}:${m}`));
  let lastErr = null;

  for (const m of (candidates.length ? candidates : chain)) {
    for (const withJson of jsonMode ? [true, false] : [false]) {
      try {
        const data = await withRetry(
          () => json(spec, apiKey, spec.wire === "anthropic" ? "/messages" : "/chat/completions", {
            body: chatBody(spec, {
              model: m, systemInstruction, contents, messages, temperature,
              maxOutputTokens, jsonMode: withJson,
            }),
            signal,
          }),
          { onWait: ({ message, ms }) => { console.warn(`[${spec.id}] ${message} (${ms}ms)`); onStatus?.(message); } }
        );
        const text = replyText(spec, data);
        if (!text) throw new Error(`${spec.name} returned an empty response.`);
        return { text, model: m };
      } catch (err) {
        lastErr = err;
        const s = String(err?.message || err);
        // The provider took the request but not the response_format field.
        // Worth one retry without it before writing the model off.
        if (withJson && /response_format|json_object|json_schema/i.test(s)) continue;
        const kind = classify(err)?.kind;
        if (!(/\b404\b/.test(s) || kind === "busy" || kind === "quota" || kind === "empty" ||
              isDailyQuota(err))) {
          throw friendlyError(err, spec.name);
        }
        if (isDailyQuota(err)) markDailyOut(`${spec.id}:${m}`);
        if (/\b404\b/.test(s)) gone.add(`${spec.id}:${m}`);
        console.warn(`[${spec.id}] ${m} unavailable, trying next`);
        onStatus?.("Trying a different model…");
        break;
      }
    }
  }
  throw friendlyError(lastErr, spec.name);
}

/**
 * The cheapest call that proves the key belongs to this provider.
 *
 * Usually the model listing, which answers both questions at once. Two
 * providers need something else: OpenRouter and Hugging Face serve /models to
 * anybody, so a listing there would accept a key they have never seen and the
 * walk would stop on the wrong provider.
 */
async function probe({ provider: spec, apiKey }) {
  const path = typeof spec.probe === "object" ? spec.probe.url : (spec.probe ?? "/models");
  return json(spec, apiKey, path);
}

/** Model ids this key can reach. Empty for a provider that does not list them. */
async function listModels({ provider: spec, apiKey }) {
  if (spec.probe === null) return [];
  const data = await json(spec, apiKey, "/models");
  const rows = data.data ?? data.models ?? [];
  return rows.map((m) => m.id ?? m.name ?? m.model).filter(Boolean);
}

/**
 * Proves a key works. Cheapest call that does so, which is usually a listing
 * rather than a generation — detect.cjs leans on that, since it may have to
 * ask several providers before one says yes.
 */
async function verifyKey(apiKey, spec, { models } = {}) {
  if (spec.probe !== null) {
    const path = typeof spec.probe === "object" ? spec.probe.url : (spec.probe ?? "/models");
    await json(spec, apiKey, path);
    const chain = models ?? spec.defaults?.turn ?? [];
    return { ok: true, text: "", model: chain[0] ?? null, provider: spec.id };
  }
  // No listing endpoint: one token is the smallest proof available.
  const out = await generate({
    provider: spec, apiKey,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    model: (models ?? spec.defaults?.turn ?? [])[0],
    maxOutputTokens: 16,
  });
  return { ok: true, text: out.text.trim(), model: out.model, provider: spec.id };
}

// --- vision ---------------------------------------------------------------

/**
 * Reads a file the model has to look at — a photo of a resume, or a PDF that is
 * really a scan.
 *
 * `spec.vision` says what the provider will accept: "file" for anything
 * including PDFs, "image" for photos only, missing for a text-only provider.
 * A PDF sent to a vision-but-not-documents provider would come back as
 * confident nonsense, so it is refused here instead.
 */
async function readFile({ provider: spec, apiKey, mimeType, base64, prompt, model, models, onStatus }) {
  const isPdf = mimeType === "application/pdf";
  if (!spec.vision || (isPdf && spec.vision !== "file")) {
    throw new Error(
      `${spec.name} cannot read ${isPdf ? "a scanned PDF" : "an image"}. ` +
      "Paste the resume text in by hand, or use a Google Gemini or Anthropic key.");
  }
  onStatus?.("Reading the file…");

  const content = spec.wire === "anthropic"
    ? [
      isPdf
        ? { type: "document", source: { type: "base64", media_type: mimeType, data: base64 } }
        : { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
      { type: "text", text: prompt },
    ]
    : [
      { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
      { type: "text", text: prompt },
    ];

  const out = await generate({
    provider: spec, apiKey, model, models,
    messages: [{ role: "user", content }],
    maxOutputTokens: 4096, temperature: 0, onStatus,
  });
  return out.text;
}

module.exports = {
  streamOnce, generate, listModels, probe, verifyKey, readFile, forget,
  // exported for the tests
  toMessages, collapse, chatBody, wireError, deltaText, events, replyText,
  nextDay, markDailyOut, isOutForToday, _dailyOut: dailyOut, _gone: gone,
};
