// The three ways a provider fails when nothing is actually wrong.
//
// Written against Gemini, and it turned out every provider behaves the same way
// — which is why chatapi.cjs rewrites its HTTP failures into these same words
// rather than classifying them a second time.
//
//   503 UNAVAILABLE — "this model is currently experiencing high demand".
//       Not quota, not the key, not us: Google shedding load. Clears in seconds.
//   429 RESOURCE_EXHAUSTED — a free-tier quota. The per-minute one clears in
//       under a minute; the per-day one does not clear today at all.
//   an empty stream — the reply carried no text. Nothing is wrong with the key
//       or the servers; the same request usually answers on the next attempt.
//
// Both used to end the interview outright, which is the worst possible reading
// of a transient server hiccup. Anything else is a real error and must surface
// immediately rather than being retried into a longer wait.

/**
 * Google puts the answer in the error body: a 429 carries a RetryInfo detail
 * ("retryDelay":"37s") saying exactly how long the window has left. Guessing
 * 21 seconds when the server has already said 37 just burns an attempt on the
 * same refusal.
 */
function retryAfterMs(err) {
  const m = String(err?.message || err).match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
}

/**
 * A per-minute quota clears on its own; a per-day one does not. Telling someone
 * to "wait a moment" when their day is gone is worse than saying nothing.
 */
function isDailyQuota(err) {
  return /PerDay|per day|daily limit/i.test(String(err?.message || err));
}

const KINDS = [
  {
    kind: "busy",
    test: /\b503\b|UNAVAILABLE|overloaded|high demand/i,
    // Short first: a 503 usually clears on the very next attempt.
    waits: [2000, 5000, 12000],
    // No provider name: this is shown mid-countdown, where the only thing
    // being waited on is whichever key the candidate pasted.
    message: "The servers are busy — trying again in:",
  },
  {
    // A stream that carried no text at all. Rare, and it looks nothing like a
    // server error — but it used to reach the interview loop as a fatal fault
    // and end the session, which is a very expensive answer to "say that again".
    kind: "empty",
    test: /returned an empty response/i,
    waits: [1200, 4000],
    message: "The panel lost its thread — trying again in:",
  },
  {
    kind: "quota",
    test: /\b429\b|RESOURCE_EXHAUSTED|quota/i,
    // The free tier's window is a minute, so waiting less is wasted work.
    // Overridden whenever the server states its own retryDelay.
    waits: [21000, 31000],
    message: "Hit the free rate limit — trying again in:",
  },
];

/** @returns {{kind:string, waits:number[], message:string}|null} */
function classify(err) {
  const s = String(err?.message || err);
  const plan = KINDS.find((k) => k.test.test(s));
  if (!plan) return null;
  // A day-long wait is not a retry. The caller should switch models or stop,
  // not sit on a timer until tomorrow.
  if (plan.kind === "quota" && isDailyQuota(err)) return null;
  return plan;
}

const isTransient = (err) => classify(err) !== null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits, ticking once a second so the caller can show the time left. A status
 * line written once and then held for fifty seconds is indistinguishable from a
 * frozen app — which is exactly how it read.
 */
async function countDown(ms, plan, attempt, onWait) {
  const until = Date.now() + ms;
  for (let left = ms; left > 0; left = until - Date.now()) {
    onWait?.({
      kind: plan.kind,
      ms,
      remainingMs: left,
      attempt,
      message: `${plan.message} ${Math.ceil(left / 1000)}s`,
    });
    await sleep(Math.min(1000, left));
  }
}

/**
 * Runs `fn`, retrying only the transient failures above.
 *
 * @param {(attempt:number) => Promise<any>} fn
 * @param {object} [opts]
 * @param {(info:{kind:string,ms:number,remainingMs:number,attempt:number,message:string}) => void} [opts.onWait]
 *        Called once a second during every wait, so the UI can count down.
 *        Silence is indistinguishable from a hang.
 * @param {(err:Error) => boolean} [opts.giveUp]
 *        Extra veto — used where a retry would repeat a side effect.
 * @param {number[]} [opts.waits]
 *        Overrides the schedule above. Only the tests pass this, so that
 *        exhausting the ladder does not mean sitting through real minutes of it.
 */
async function withRetry(fn, { onWait, giveUp, waits } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const plan = classify(err);
      if (!plan) throw err;
      const schedule = waits ?? plan.waits;
      if (attempt >= schedule.length || giveUp?.(err)) throw err;
      // Never wait less than the server asked for.
      const ms = waits ? schedule[attempt] : Math.max(schedule[attempt], retryAfterMs(err));
      await countDown(ms, plan, attempt + 1, onWait);
    }
  }
}

/**
 * Turns a provider's raw error JSON into something a candidate can act on. The
 * raw form ('ApiError: {"error":{"code":503,…}') says nothing about whether to
 * wait, fix a key, or check the wifi.
 *
 * `provider` is the name to blame. It matters more than it looks: this used to
 * say "Gemini" unconditionally, and once a second provider existed, a rejected
 * Mistral key came back as "That Gemini API key is not valid" — sending the
 * candidate to re-enter a key that was never the problem.
 */
function friendlyError(err, provider = "Gemini") {
  const s = String(err?.message || err);
  if (/\b503\b|UNAVAILABLE|overloaded|high demand/i.test(s)) {
    return new Error(`${provider}'s servers are overloaded right now (503). Try again in a moment.`);
  }
  if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test(s)) {
    return new Error(
      isDailyQuota(err)
        ? `Today's free ${provider} quota is used up. It resets tomorrow — or turn on billing to carry on.`
        : `Hit ${provider}'s free rate limit. Wait a moment.`
    );
  }
  if (/\b404\b|NOT_FOUND|no longer available/i.test(s)) {
    return new Error(
      `That ${provider} model is not available on this key any more. The app has ` +
      "switched to another one — press Try again."
    );
  }
  if (/returned an empty response/i.test(s)) {
    return new Error(`${provider} answered with nothing at all. Try that question again.`);
  }
  if (/API key not valid|API_KEY_INVALID|401|403/i.test(s)) {
    // The provider's own words are kept on purpose. "Invalid key" and "this
    // workspace has no API access" arrive as the same status code and need
    // completely different things done about them, and only the body says which.
    return new Error(`${provider} refused this key. ${s}`.trim());
  }
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|network/i.test(s)) {
    return new Error(`No internet connection — ${provider} cannot be reached.`);
  }
  return err instanceof Error ? err : new Error(s);
}

module.exports = {
  withRetry, classify, isTransient, sleep, friendlyError, retryAfterMs, isDailyQuota,
};
