// "Here is my API key." — and nothing else.
//
// The setup screen used to have one box labelled "Gemini key", which is a fine
// thing to ask for right up until somebody has a Groq key, or an OpenAI key, or
// the free OpenRouter key their senior gave them. Asking them to first work out
// which of fourteen boxes is theirs is work the app can do itself: the key says
// who issued it.
//
// Two stages, in this order on purpose:
//
//   1. Shape. `gsk_` is Groq and nothing else; `AIza` is Google and nothing
//      else. Most keys are identified before a single byte leaves the machine.
//   2. Ask. Where the shape is ambiguous — everyone issues `sk-...` — the key
//      is offered to each candidate in turn and the first one that accepts it
//      wins. One cheap GET each, and a key that looks like nothing at all gets
//      the whole list rather than a refusal.
//
// Then the models: whatever the key can actually reach is read off the
// provider's own listing and matched against this app's preferences, so the
// answer is "gpt-5-mini, and gpt-4.1-mini behind it" rather than a model name
// hardcoded here that may be retired by the time anyone pastes a key.
const providers = require("./providers.cjs");
const gemini = require("./gemini.cjs");
const chatapi = require("./chatapi.cjs");

/**
 * Asks one provider "is this key yours?", and gets its model list on the way.
 *
 * The two are usually the same call — a listing needs the key, so a listing
 * that works settles both. Two providers break that: OpenRouter and Hugging
 * Face serve /models to anybody at all, so identifying a key by its listing
 * there would stop the walk on the wrong provider and then fail at the first
 * interview question. Those two name an endpoint that does need the key, and
 * it is asked first.
 *
 * @returns {Promise<string[]>} model ids, or [] for a provider that lists none
 */
async function identify(spec, key) {
  if (spec.wire === "gemini") return (await gemini.listModels(key)).map((m) => m.id);
  // No listing endpoint at all (Perplexity). Whose key it is gets settled by
  // the confirming generation below instead.
  if (spec.probe === null) return [];
  if (spec.probe && spec.probe !== "/models") {
    await chatapi.probe({ provider: spec, apiKey: key });
    // The listing is a bonus here, not the proof, so losing it is not fatal:
    // pickModels falls back to the names compiled in.
    return chatapi.listModels({ provider: spec, apiKey: key }).catch(() => []);
  }
  return chatapi.listModels({ provider: spec, apiKey: key });
}

/** One token, to prove the key generates and not merely authenticates. */
async function confirm(spec, key, chain) {
  if (spec.wire === "gemini") {
    const res = await gemini.verifyKey(key);
    return { text: res.text, model: res.model };
  }
  const out = await chatapi.generate({
    provider: spec, apiKey: key,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    model: chain[0], models: chain, maxOutputTokens: 16,
  });
  return { text: out.text.trim(), model: out.model };
}

/** The key is wrong for this provider — as opposed to something else going wrong. */
const isRefusal = (err) =>
  /\b401\b|\b403\b|API key not valid|API_KEY_INVALID|invalid.?api.?key|unauthor|authentication/i
    .test(String(err?.message || err));

/** Nothing about this key is the problem; stop the walk rather than asking thirteen more times. */
const isOffline = (err) =>
  /fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|network|getaddrinfo/i
    .test(String(err?.message || err));

/**
 * Works out whose key this is, what it can reach, and whether it generates.
 *
 * @param {string} key
 * @param {{onStatus?: (text:string) => void}} [opts]
 * @returns {Promise<object>} what store.setProviderKey wants as its `info`
 */
async function detect(key, { onStatus } = {}) {
  const k = String(key ?? "").trim();
  if (!k) throw new Error("No key given.");

  const list = providers.candidates(k);
  const refused = [];

  for (const spec of list) {
    // Only worth saying when there is actually a search going on — with one
    // candidate this flashes past and reads like a guess the app is unsure of.
    if (list.length > 1) onStatus?.(`Trying ${spec.name}…`);
    try {
      const available = await identify(spec, k);
      const chains = providers.pickModels(spec, available);
      if (!chains.turn.length) {
        refused.push(`${spec.name}: the key works but has no usable chat model`);
        continue;
      }

      // Identified. From here a failure is about this key's quota or balance,
      // not about whose key it is, so it is reported rather than walked past.
      onStatus?.(`${spec.name} — checking the key…`);
      let model = chains.turn[0];
      let note = "";
      try {
        const ok = await confirm(spec, k, chains.turn);
        model = ok.model ?? model;
      } catch (err) {
        if (isRefusal(err)) throw err;
        // Authenticated, then refused to generate: out of quota, overloaded, or
        // out of credit. The key is still the right key and still worth saving —
        // telling someone their working key is invalid because today's free
        // quota is spent would be the worst possible answer here.
        note = String(err?.message || err);
        console.warn(`[detect] ${spec.id} authenticated but did not generate: ${note}`);
      }

      return {
        provider: spec.id,
        name: spec.name,
        model,
        note,
        // Capped: OpenRouter lists hundreds, and this goes in a config file
        // that a person might reasonably want to read.
        turn: chains.turn.slice(0, 6),
        report: chains.report.slice(0, 4),
        modelCount: available.length,
        vision: spec.vision ?? null,
        detectedAt: new Date().toISOString(),
      };
    } catch (err) {
      if (isOffline(err)) {
        throw new Error("No internet connection — the key cannot be checked.");
      }
      if (isRefusal(err) || list.length > 1) {
        refused.push(`${spec.name}: ${String(err?.message || err).slice(0, 120)}`);
        continue;
      }
      // One candidate, and it failed for some reason other than the key being
      // wrong. Its own words are more useful than anything written here.
      throw err;
    }
  }

  throw new Error(
    "No provider recognised that key. Checked: " +
    list.map((p) => p.name).join(", ") + ".\n" + refused.join("\n"));
}

module.exports = { detect, isRefusal, isOffline };
