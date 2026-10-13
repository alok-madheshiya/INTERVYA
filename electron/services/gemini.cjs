// Gemini: one streamed generation, and everything that can go transiently wrong
// on its free tier. Main process only, so the API key never reaches the
// renderer.
//
// This file knows nothing about interviews. What to say and in what order is
// llm.cjs's job, which builds one prompt and offers it to whichever provider
// will answer — see that file for why a second provider exists at all.
//
// Free tier (no credit card): create a key at https://aistudio.google.com/apikey
// Roughly 10 requests/min and 1500/day — one interview costs about 40 requests,
// so the daily quota is far more than a person can actually sit through. The
// per-minute limit is the one that bites, hence the 429 handling below.
const { GoogleGenAI, ThinkingLevel } = require("@google/genai");
const { createSplitter } = require("./prompt.cjs");
const { withRetry, friendlyError, classify, isDailyQuota } = require("./retry.cjs");

// Conversational turns are short and must land fast — latency IS realism here.
// The report is one long call at the end where quality matters and nobody is
// waiting mid-sentence, so it gets the stronger model and real thinking budget.
const TURN_MODEL = "gemini-3.6-flash";
const REPORT_MODEL = "gemini-3.8-flash";

// If a key's tier doesn't carry the preferred model, or its quota is spent,
// walk down rather than dying. Every entry here was checked against this key
// with a real generateContent call on 2026-09-06 — models.list() is not the
// answer: it still names gemini-2.5-flash, which answers "no longer available
// to new users" with a 404, and that 404 is what a candidate saw at the end of
// the old chain.
//
// The two `-latest` aliases are deliberate insurance: Google keeps them
// pointing at something live, so the chain cannot rot into another 404 the way
// this one did. The lite tiers come last — they are a weaker interviewer, but a
// weaker interviewer is worth a great deal more than a stopped one, and their
// free quota is separate from the flash models above.
const FALLBACKS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.7-flash",
  "gemini-flash-latest",
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
];

let ai = null;
let aiKey = null;

/**
 * Models whose *daily* free quota is spent, and when that stops being true.
 *
 * Without this, every remaining turn of the interview re-asked the same dead
 * model first and waited for the same refusal before walking down the list —
 * a round trip per model per turn, paid over and over for information the app
 * already had. The free-tier day rolls over at midnight Pacific.
 *
 * A per-minute quota is deliberately *not* remembered: that one clears while
 * the candidate is still answering, and skipping the better model for an hour
 * to save a second would be a bad trade.
 */
const dailyOut = new Map();   // model -> epoch ms when it is worth trying again

/**
 * Models this key cannot use at all — retired, or not in its tier. Unlike a
 * quota this never comes back, so it is remembered without an expiry.
 */
const gone = new Set();

/** Midnight in Los Angeles, in epoch ms — where Google's free tier day ends. */
function nextQuotaReset(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric",
    second: "numeric", hourCycle: "h23",
  }).formatToParts(new Date(now));
  const at = (t) => Number(parts.find((p) => p.type === t).value);
  const sinceMidnight = (at("hour") * 3600 + at("minute") * 60 + at("second")) * 1000;
  return now + (86400000 - sinceMidnight);
}

function markDailyOut(model) {
  dailyOut.set(model, nextQuotaReset());
}

function isOutForToday(model) {
  if (gone.has(model)) return true;
  const until = dailyOut.get(model);
  if (!until) return false;
  if (Date.now() >= until) { dailyOut.delete(model); return false; }
  return true;
}

function client(apiKey) {
  if (!ai || aiKey !== apiKey) {
    ai = new GoogleGenAI({ apiKey });
    aiKey = apiKey;
    // A new key has its own quotas and its own tier; what the old one could not
    // reach means nothing here.
    dailyOut.clear();
    gone.clear();
  }
  return ai;
}

/** Lists the models this key can actually reach, for the settings screen. */
async function listModels(apiKey) {
  const out = [];
  for await (const m of await client(apiKey).models.list()) {
    const actions = m.supportedActions ?? m.supportedGenerationMethods ?? [];
    if (!actions.length || actions.includes("generateContent")) {
      out.push({ id: (m.name || "").replace(/^models\//, ""), label: m.displayName || m.name });
    }
  }
  return out;
}

/** Cheapest possible call that proves a key works. */
async function verifyKey(apiKey) {
  const res = await client(apiKey).models.generateContent({
    model: TURN_MODEL,
    contents: "Reply with the single word: ok",
    config: { maxOutputTokens: 16, thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
  });
  return { ok: true, text: (res.text || "").trim(), model: TURN_MODEL };
}

function isMissingModel(err) {
  const s = String(err?.message || err);
  // A 400 is never this. Gemini says "Thinking level MINIMAL is not supported
  // for this model" with a 400, and that phrase used to match here — which
  // would have retired a perfectly good model over a config mistake.
  if (/\b400\b/.test(s)) return false;
  return /\b404\b/.test(s) || /not found|not supported|no longer available|NOT_FOUND/i.test(s);
}

/**
 * One streamed generation, with everything that can go transiently wrong on the
 * free tier already handled: waits out 503s and per-minute quotas, then walks
 * down the model list, because those limits are per model.
 *
 * The prompt is built by llm.cjs and handed in whole — the interview panel and
 * Talk mode differ only in what they put here, never in how a busy server
 * should be survived.
 *
 * @returns {Promise<{spoken: string, meta: object|null, raw: string, model: string}>}
 */
async function streamOnce({ apiKey, systemInstruction, contents, onText, onStatus,
                            model = TURN_MODEL, temperature, maxOutputTokens, signal }) {
  const ai = client(apiKey);
  const all = [model, ...FALLBACKS.filter((m) => m !== model)];
  // Skip whatever is known to be out until tomorrow — but never skip every
  // option: if the whole list is spent, ask anyway so the candidate gets a real
  // error rather than a silent nothing, and so a reset is noticed.
  const live = all.filter((m) => !isOutForToday(m));
  const candidates = live.length ? live : all;
  let lastErr = null;
  // Kept apart from lastErr on purpose. Walking the chain ends on whatever the
  // weakest model said, and that is the least useful thing to repeat: a 404
  // from a retired model tells the candidate nothing, where "today's quota is
  // gone" tells them exactly what happened and when it comes back.
  let quotaErr = null;

  for (const m of candidates) {
    try {
      // Retrying mid-stream is safe because `onText` only drives the on-screen
      // caption; nothing reaches the speakers until this resolves and the caller
      // hands the finished text to TTS. The caption from an abandoned attempt is
      // discarded by the renderer when onStatus fires.
      return await withRetry(
        async () => {
          const split = createSplitter(onText);
          const stream = await ai.models.generateContentStream({
            model: m,
            contents,
            config: {
              systemInstruction,
              maxOutputTokens,
              temperature,
              topP: 0.95,
              // A spoken reply is a short judgement call, not a reasoning
              // problem, and every extra second of thinking is dead air.
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              abortSignal: signal,
            },
          });

          for await (const chunk of stream) {
            const t = chunk.text;
            if (t) split.push(t);
          }

          const { spoken, meta, raw } = split.end();
          // An empty stream is a hiccup, not a verdict — it happens when the
          // reply is cut off before the first token. It used to escape as a
          // fatal error and end the interview, which is the most expensive
          // possible response to a blank one.
          if (!spoken && !meta) throw new Error("Gemini returned an empty response.");
          return { spoken, meta, raw, model: m };
        },
        {
          onWait: ({ message, ms }) => {
            console.warn(`[gemini] ${message} (${ms}ms)`);
            onStatus?.(message);
          },
        }
      );
    } catch (err) {
      lastErr = err;
      // Walk the list for anything specific to this model: the key's tier not
      // carrying it, the model being overloaded, or its quota being spent. All
      // three are per-model on the free tier — the limits are
      // GenerateRequestsPerMinute*PerModel* — so a lighter model very often
      // answers when the preferred one refuses.
      //
      // Auth and network failures are account-wide and surface immediately
      // rather than being tried three more times.
      const kind = classify(err)?.kind;
      // "empty" joins the list because a model that returns nothing twice in a
      // row is having a bad minute, and a different one usually answers.
      const modelSpecific = isMissingModel(err) || kind === "busy" || kind === "quota" ||
                            kind === "empty" || isDailyQuota(err);
      if (!modelSpecific) throw friendlyError(err);
      if (isDailyQuota(err)) { markDailyOut(m); quotaErr ??= err; }
      // Retired, or not in this key's tier. It will not come back on its own.
      if (isMissingModel(err)) gone.add(m);
      // classify() returns null for a daily quota on purpose — it is not
      // something to wait out — so the label has to be worked out here rather
      // than defaulted to 404, which is what made a spent day read as a
      // retired model in the log.
      const why = isDailyQuota(err) ? "daily quota spent"
        : isMissingModel(err) ? "retired or not in this tier"
        : kind ?? "unavailable";
      console.warn(`[gemini] ${m} skipped (${why}), trying next`);
      onStatus?.("Switching to a different model…");
    }
  }
  throw friendlyError(quotaErr ?? lastErr);
}

module.exports = {
  streamOnce, listModels, verifyKey, TURN_MODEL, REPORT_MODEL, FALLBACKS,
  // exported for the tests
  nextQuotaReset, markDailyOut, isOutForToday,
  _dailyOut: dailyOut, _gone: gone, _isMissingModel: isMissingModel,
};
