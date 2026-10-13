// What the panel is asked, as opposed to how the asking is done.
//
// Underneath are two API clients — gemini.cjs for Google's SDK, chatapi.cjs for
// the thirteen other providers over plain HTTP — and they differ only in which
// POST they make. This file is the layer above both: it builds the interview's
// prompt out of prompt.cjs and hands it to whichever provider's key the
// candidate pasted. That split is worth keeping whatever the provider list does
// next: what to say and which HTTP call to make change for separate reasons.
//
// The app ran on Gemini alone for most of its life, and the history is worth
// keeping because it is why the plumbing looks like this. Mistral was tried on
// 2026-09-07 and abandoned — its key authenticated, listed eight models and
// showed an unspent $10 allowance, and every completion came back 429. Cerebras
// wanted a verified payment method; Groq's free tier capped at 200k tokens a
// day, less than one interview. None of that is a reason to hardcode one
// provider: it is a reason to let the candidate bring whichever key they can
// actually get, and to walk a model chain within it. Both now happen — see
// detect.cjs for how a pasted key finds its own provider.
const {
  core, chatCore, renderBrief, renderChatBrief, renderState,
} = require("./prompt.cjs");
const providers = require("./providers.cjs");
const gemini = require("./gemini.cjs");
const chatapi = require("./chatapi.cjs");

/**
 * Every provider, paired with the client that can talk to it.
 *
 * Gemini keeps its own module because Google's SDK handles streaming, retries
 * and inline files for us, and rewriting that against raw HTTP would be work
 * with nothing to show for it.
 */
const PROVIDERS = providers.PROVIDERS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  spec,
  mod: spec.wire === "gemini" ? gemini : chatapi,
}));

/**
 * The providers that have a key, the active one first. Without one there is
 * nothing to ask.
 *
 * More than one can be saved at a time — a candidate who has both a Gemini and
 * a Groq key keeps both — so this is an order of preference, not a list of one.
 */
function usable(keys, active) {
  const have = PROVIDERS.filter((p) => keys?.[p.id]);
  if (!active) return have;
  return [...have.filter((p) => p.id === active), ...have.filter((p) => p.id !== active)];
}

/**
 * Runs one generation.
 *
 * @param {object} req  everything the provider's streamOnce needs, minus the key
 * @param {object} keys provider id -> API key
 * @param {function} [onStatus]
 * @param {{active?: string, info?: object}} [opts]
 *        `active` is whose key to prefer; `info` is what detect.cjs worked out
 *        about each key, which is where the model chain comes from.
 */
async function stream(req, keys, onStatus, { active, info } = {}) {
  const [p] = usable(keys, active);
  if (!p) throw new Error("No API key is set. Add one in the setup screen.");
  const chain = info?.[p.id]?.turn ?? p.spec.defaults?.turn ?? [];
  const out = await p.mod.streamOnce({
    ...req,
    apiKey: keys[p.id],
    onStatus,
    provider: p.spec,
    // The chain was read off this key's own model listing when it was saved.
    // p.mod.TURN_MODEL is Gemini's compiled-in default, and the last resort.
    model: req.model ?? chain[0] ?? p.mod.TURN_MODEL,
    models: chain,
  });
  return { ...out, provider: p.id };
}

/** One panel turn. Spoken text streams through `onText`; META never does. */
async function runTurn({ keys, active, info, session, answerText, onText, onStatus, signal }) {
  return stream({
    onText, signal,
    // Stable prefix first (core rules, then this session's brief) so a
    // provider's implicit prompt cache can hit on every turn after the first.
    systemInstruction: core() + "\n\n---\n\n" + renderBrief(session),
    contents: [
      ...session.history.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      { role: "user", parts: [{ text: renderState(session, answerText) }] },
    ],
    maxOutputTokens: 1200,
    // Sampling variety on top of the structural variation (arc + seed) that
    // core.md already asks for. Both matter: temperature alone gives you the
    // same interview with different words.
    temperature: 1.0,
  }, keys, onStatus, { active, info });
}

/**
 * Talk mode: one character, free conversation, no panel and no META block.
 *
 * `history` is the whole conversation so far — Talk has no ledger and no
 * memory object, so the transcript is the only state there is.
 */
async function runChat({ keys, active, info, chat, userText, onText, onStatus, signal }) {
  return stream({
    onText, signal,
    systemInstruction: chatCore() + "\n\n---\n\n" + renderChatBrief(chat),
    contents: [
      ...chat.history.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      {
        role: "user",
        parts: [{
          text: userText === null
            ? "(They have just joined the call. Say hello and open the conversation.)"
            : (userText.trim() || "(They said nothing — silence on the line.)"),
        }],
      },
    ],
    // Shorter than an interview turn on purpose: this is a conversation, and
    // the prompt's hardest rule to keep is "say less".
    maxOutputTokens: 700,
    temperature: 1.0,
  }, keys, onStatus, { active, info });
}

/**
 * Proves a key works, against the provider it belongs to.
 *
 * Kept for the case where the provider is already known. When it is not — a
 * freshly pasted key — detect.cjs is the entry point, and it calls this file's
 * clients itself.
 */
function verifyKey(id, apiKey) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p.mod.verifyKey(apiKey, p.spec);
}

module.exports = { runTurn, runChat, verifyKey, PROVIDERS, stream, usable };
