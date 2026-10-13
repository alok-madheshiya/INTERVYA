// Which services this app can talk to, and how to tell them apart from a key.
//
// The setup screen asks for one API key and does not ask whose it is. That is
// the whole point of this file: a key's shape says who issued it (`gsk_` is
// Groq, `sk-ant-` is Anthropic, `AIza` is Google), and where the shape is
// ambiguous — half the industry issues `sk-...` — the key is simply offered to
// each candidate in turn until one of them says yes. See detect.cjs for that
// walk; this file only knows the facts it needs.
//
// Model names are deliberately NOT the authority here. Every list under
// `defaults` is a preference, matched against the models the key can actually
// reach (GET /models at detection time). A provider renaming or retiring a
// model therefore costs nothing — the hint stops matching and the next one, or
// the generic heuristic below, picks something live. This app has already been
// bitten once by a hardcoded model id going 404 mid-interview (see gemini.cjs),
// and that is not a mistake worth making thirteen more times.
//
// There are three wire formats in total. `openai` covers twelve of the fourteen
// providers here, because everyone copied /v1/chat/completions.

/**
 * Model ids that exist but cannot hold a conversation — embeddings, speech,
 * image generation, safety classifiers. Picking one of these as the
 * interviewer would be a very confusing failure, and they are common in a
 * /models listing.
 */
const NOT_CHAT =
  /embed|moderation|rerank|ranker|whisper|tts|speech|transcrib|realtime|image|dall-?e|imagen|flux|stable-?(diffusion|video)|sora|veo|kling|guard|safety|bge|clip|ocr|upscal/i;

/** Small-and-fast first: a panel turn is a short judgement call, and latency IS realism. */
const SMALL = [/mini/i, /flash/i, /haiku/i, /instant/i, /lite/i, /small/i, /\b(7|8|9)b\b/i, /nano/i, /turbo/i];

/** The opposite end, for the one long call at the end that nobody waits through. */
const BIG = [/opus/i, /sonnet/i, /\bpro\b/i, /large/i, /\b(70|72|120|235|405)b\b/i, /reasoner/i, /thinking/i];

const PROVIDERS = [
  {
    id: "gemini",
    name: "Google Gemini",
    wire: "gemini",
    where: "aistudio.google.com/apikey",
    free: true,
    // AIzaSy... — Google's API keys are unmistakable, which is why this one
    // never needs the fallback probe.
    keyShape: [/^AIza[\w-]{30,}$/],
    vision: "file",          // images and PDFs, inline
    defaults: {
      turn: ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-flash-latest",
             "gemini-3.5-flash-lite", "gemini-flash-lite-latest"],
      report: ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"],
    },
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    wire: "anthropic",
    base: "https://api.anthropic.com/v1",
    where: "console.anthropic.com/settings/keys",
    keyShape: [/^sk-ant-/],
    probe: "/models",
    vision: "file",          // images, and PDFs as document blocks
    defaults: {
      turn: ["claude-haiku-5-5", "claude-haiku-4-5", "claude-3-5-haiku-latest", "claude-3-haiku"],
      report: ["claude-sonnet-5-5", "claude-sonnet-4-5", "claude-opus-4-1", "claude-3-7-sonnet-latest"],
    },
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    wire: "openai",
    base: "https://openrouter.ai/api/v1",
    where: "openrouter.ai/keys",
    keyShape: [/^sk-or-v1-/],
    // /models is public here, so it proves nothing about a key. /key does.
    probe: "/key",
    vision: "image",
    defaults: {
      turn: ["google/gemini-2.5-flash", "openai/gpt-4o-mini", "anthropic/claude-3.5-haiku",
             "meta-llama/llama-3.3-70b-instruct"],
      report: ["anthropic/claude-sonnet-4.5", "openai/gpt-4o", "google/gemini-2.5-pro"],
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    wire: "openai",
    base: "https://api.openai.com/v1",
    where: "platform.openai.com/api-keys",
    keyShape: [/^sk-proj-/, /^sk-svcacct-/, /^sk-admin-/],
    // Everyone's keys start sk-. This one is the catch-all, so it is tried
    // after every provider with a prefix of its own.
    keyMaybe: [/^sk-[A-Za-z0-9_-]{20,}$/],
    probe: "/models",
    // Newer models reject max_tokens outright and want this instead.
    maxTokensField: "max_completion_tokens",
    vision: "image",
    defaults: {
      turn: ["gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini", "gpt-5-nano"],
      report: ["gpt-5", "gpt-4.1", "gpt-4o"],
    },
  },
  {
    id: "groq",
    name: "Groq",
    wire: "openai",
    base: "https://api.groq.com/openai/v1",
    where: "console.groq.com/keys",
    free: true,
    keyShape: [/^gsk_[A-Za-z0-9]{20,}$/],
    probe: "/models",
    vision: "image",
    defaults: {
      turn: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile", "openai/gpt-oss-20b"],
      report: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "deepseek-r1-distill-llama-70b"],
    },
  },
  {
    id: "mistral",
    name: "Mistral",
    wire: "openai",
    base: "https://api.mistral.ai/v1",
    where: "console.mistral.ai/api-keys",
    // 32 alphanumerics and no prefix at all — indistinguishable from several
    // other providers' keys by eye, hence `keyMaybe`.
    keyMaybe: [/^[A-Za-z0-9]{32}$/],
    probe: "/models",
    vision: "image",
    defaults: {
      turn: ["mistral-small-latest", "open-mistral-nemo", "ministral-8b-latest"],
      report: ["mistral-large-latest", "mistral-medium-latest", "magistral-medium-latest"],
    },
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    wire: "openai",
    base: "https://api.deepseek.com/v1",
    where: "platform.deepseek.com/api_keys",
    // sk- then exactly 32 hex. Narrower than OpenAI's catch-all, so it is
    // listed above it and tried first.
    keyShape: [/^sk-[0-9a-f]{32}$/],
    probe: "/models",
    defaults: {
      turn: ["deepseek-chat"],
      report: ["deepseek-reasoner", "deepseek-chat"],
    },
  },
  {
    id: "xai",
    name: "xAI Grok",
    wire: "openai",
    base: "https://api.x.ai/v1",
    where: "console.x.ai",
    keyShape: [/^xai-[A-Za-z0-9]{20,}$/],
    probe: "/models",
    vision: "image",
    defaults: {
      turn: ["grok-4-fast-non-reasoning", "grok-4-fast", "grok-3-mini", "grok-2-latest"],
      report: ["grok-4", "grok-3", "grok-4-fast"],
    },
  },
  {
    id: "cerebras",
    name: "Cerebras",
    wire: "openai",
    base: "https://api.cerebras.ai/v1",
    where: "cloud.cerebras.ai",
    keyShape: [/^csk-[A-Za-z0-9]{20,}$/],
    probe: "/models",
    defaults: {
      turn: ["llama3.1-8b", "llama-3.3-70b", "qwen-3-32b"],
      report: ["llama-3.3-70b", "qwen-3-235b-a22b-instruct", "llama3.1-8b"],
    },
  },
  {
    id: "together",
    name: "Together AI",
    wire: "openai",
    base: "https://api.together.xyz/v1",
    where: "api.together.ai/settings/api-keys",
    keyShape: [/^tgp_v1_[A-Za-z0-9_-]{20,}$/],
    keyMaybe: [/^[0-9a-f]{64}$/],
    probe: "/models",
    vision: "image",
    defaults: {
      turn: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"],
      report: ["deepseek-ai/DeepSeek-V3", "meta-llama/Llama-3.3-70B-Instruct-Turbo"],
    },
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    wire: "openai",
    base: "https://api.fireworks.ai/inference/v1",
    where: "fireworks.ai/account/api-keys",
    keyShape: [/^fw_[A-Za-z0-9]{20,}$/],
    probe: "/models",
    vision: "image",
    defaults: {
      turn: ["accounts/fireworks/models/llama-v3p1-8b-instruct",
             "accounts/fireworks/models/llama-v3p3-70b-instruct"],
      report: ["accounts/fireworks/models/llama-v3p3-70b-instruct",
               "accounts/fireworks/models/deepseek-v3"],
    },
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    wire: "openai",
    base: "https://integrate.api.nvidia.com/v1",
    where: "build.nvidia.com",
    keyShape: [/^nvapi-[A-Za-z0-9_-]{20,}$/],
    probe: "/models",
    defaults: {
      turn: ["meta/llama-3.1-8b-instruct", "meta/llama-3.3-70b-instruct"],
      report: ["meta/llama-3.3-70b-instruct", "deepseek-ai/deepseek-r1"],
    },
  },
  {
    id: "perplexity",
    name: "Perplexity",
    wire: "openai",
    base: "https://api.perplexity.ai",
    where: "perplexity.ai/settings/api",
    keyShape: [/^pplx-[A-Za-z0-9]{20,}$/],
    // No /models endpoint at all, so detection has to spend one real token.
    probe: null,
    defaults: { turn: ["sonar"], report: ["sonar-pro", "sonar"] },
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    wire: "openai",
    base: "https://router.huggingface.co/v1",
    where: "huggingface.co/settings/tokens",
    free: true,
    keyShape: [/^hf_[A-Za-z0-9]{20,}$/],
    // Its /v1/models is public too; whoami is the endpoint that needs the token.
    probe: { url: "https://huggingface.co/api/whoami-v2" },
    vision: "image",
    defaults: {
      turn: ["meta-llama/Llama-3.1-8B-Instruct", "Qwen/Qwen2.5-7B-Instruct"],
      report: ["meta-llama/Llama-3.3-70B-Instruct", "Qwen/Qwen2.5-72B-Instruct"],
    },
  },
];

const byId = (id) => PROVIDERS.find((p) => p.id === id) ?? null;
const IDS = PROVIDERS.map((p) => p.id);

/**
 * Who this key might belong to, best guess first.
 *
 * Strict shapes (a prefix nobody else uses) come before loose ones (`sk-`
 * followed by anything, or 32 bare characters), and a key that looks like
 * nothing at all gets the whole list — someone's key is worth thirteen cheap
 * GETs, and the alternative is telling them their working key is invalid.
 */
function candidates(key) {
  const k = String(key ?? "").trim();
  if (!k) return [];
  const strict = PROVIDERS.filter((p) => (p.keyShape ?? []).some((re) => re.test(k)));
  const loose = PROVIDERS.filter(
    (p) => !strict.includes(p) && (p.keyMaybe ?? []).some((re) => re.test(k)));
  const narrowed = [...strict, ...loose];
  return narrowed.length ? narrowed : [...PROVIDERS];
}

/** Whether the shape alone settles it — exactly one provider could own this key. */
function isCertain(key) {
  return candidates(key).length === 1;
}

/** Orders `live` by the first pattern each id matches; non-matches keep their place at the back. */
function rank(live, patterns) {
  return live
    .map((id, i) => {
      const at = patterns.findIndex((re) => re.test(id));
      return { id, score: at < 0 ? patterns.length : at, i };
    })
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.id);
}

const dedupe = (xs) => [...new Set(xs.filter(Boolean))];

/**
 * Turns "the models this key can reach" into the two chains the app runs on.
 *
 * Both are chains rather than single names for the same reason gemini.cjs
 * walks a list: free tiers run out per model, and a weaker interviewer beats a
 * stopped one.
 *
 * @param {object} spec           a PROVIDERS entry
 * @param {string[]} [available]  model ids from the provider's own listing
 */
function pickModels(spec, available) {
  // "This key listed nothing" and "this key listed nothing we can talk to" are
  // different answers. The first is a provider that has no listing endpoint, or
  // one that was not asked; its compiled-in names are all there is, and they
  // are known-good. The second is a key with real contents — embeddings and
  // speech models, say — and guessing a chat model it has not got would send
  // the candidate into an interview that 404s on the first question.
  const listed = (available ?? []).length > 0;
  const live = (available ?? []).filter((id) => id && !NOT_CHAT.test(id));
  const fromHints = (hints) => dedupe((hints ?? []).map(
    (h) => live.find((id) => id === h) ?? live.find((id) => id.includes(h))));

  let turn = fromHints(spec.defaults?.turn);
  let report = fromHints(spec.defaults?.report);

  // Nothing we have heard of is on this key. Guess by name shape instead of
  // giving up: "mini"/"flash"/"8b" is a fast model whoever made it.
  if (!turn.length) turn = rank(live, SMALL).slice(0, 4);
  if (!report.length) report = rank(live, BIG).slice(0, 4);

  if (!listed) {
    if (!turn.length) turn = [...(spec.defaults?.turn ?? [])];
    if (!report.length) report = [...(spec.defaults?.report ?? [])];
  }

  return {
    turn: dedupe([...turn, ...report]),
    report: dedupe([...report, ...turn]),
  };
}

module.exports = {
  PROVIDERS, IDS, byId, candidates, isCertain, pickModels, rank,
  NOT_CHAT, SMALL, BIG,
};
