// Builds the post-interview report.
//
// Two halves, deliberately kept apart:
//
//   - Anything countable is computed here, in code. Filler words, pace, answer
//     length and silences are arithmetic, and asking a model to count is slower,
//     costs tokens and gets it wrong.
//   - Everything requiring judgement goes to the model with the transcript AND
//     the panel's private ledger — the scores and evidence lines recorded during
//     the interview. Without the ledger the report drifts into generic advice.
//
// Which model depends on whose key the candidate pasted. Gemini can be handed
// the schema below and will obey it; the other providers get the same schema
// written into the prompt as JSON Schema and are asked for a JSON object. The
// second route is looser, so the answer is parsed leniently — see parseJson.

const fs = require("node:fs");
const path = require("node:path");
const { GoogleGenAI, ThinkingLevel, Type } = require("@google/genai");
const { withRetry, classify, friendlyError, isDailyQuota } = require("./retry.cjs");
const providers = require("./providers.cjs");
const chatapi = require("./chatapi.cjs");

const REPORT_MODEL = "gemini-3.8-flash";
// If the strongest model is overloaded, a weaker report beats no report at all —
// the interview is already over and the transcript is not coming back.
const REPORT_MODELS = [REPORT_MODEL, "gemini-3.6-flash", "gemini-3.5-flash"];
const ROOT = path.join(__dirname, "..", "..");

let PROMPT = null;
const prompt = () => (PROMPT ??= fs.readFileSync(path.join(ROOT, "prompts", "report.md"), "utf8"));

const FILLERS = [
  "um", "uh", "erm", "hmm", "like", "basically", "actually", "literally",
  "you know", "i mean", "sort of", "kind of", "matlab", "yaani", "waise",
];

/**
 * Countable facts about how the candidate spoke. Deterministic on purpose —
 * these are the numbers the model is told not to guess at.
 */
function speechStats(session) {
  const answers = session.history
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .filter((t) => t && t !== "(said nothing)");

  const joined = answers.join(" ").toLowerCase();
  const words = joined.split(/\s+/).filter(Boolean);

  const fillerCounts = {};
  let fillerTotal = 0;
  for (const f of FILLERS) {
    const n = (joined.match(new RegExp(`\\b${f}\\b`, "g")) || []).length;
    if (n) { fillerCounts[f] = n; fillerTotal += n; }
  }

  const lengths = answers.map((a) => a.split(/\s+/).filter(Boolean).length);
  const minutes = Math.max(1, session.elapsedMs / 60000);

  return {
    answers: answers.length,
    total_words: words.length,
    avg_answer_words: lengths.length ? Math.round(words.length / lengths.length) : 0,
    shortest_answer_words: lengths.length ? Math.min(...lengths) : 0,
    longest_answer_words: lengths.length ? Math.max(...lengths) : 0,
    words_per_minute: Math.round(words.length / minutes),
    filler_total: fillerTotal,
    // Under ~2 per 100 words reads as fluent; past ~5 it is the first thing a
    // panel notices.
    fillers_per_100_words: words.length ? +(fillerTotal / words.length * 100).toFixed(1) : 0,
    filler_breakdown: fillerCounts,
    silent_turns: session.history.filter((m) => m.content === "(said nothing)").length,
    duration_minutes: +(session.elapsedMs / 60000).toFixed(1),
  };
}

const S = Type;
const competency = {
  type: S.OBJECT,
  properties: {
    score: { type: S.INTEGER, description: "0-10, what the transcript supports" },
    evidence: { type: S.STRING, description: "What in this interview showed it" },
  },
  required: ["score", "evidence"],
};

const SCHEMA = {
  type: S.OBJECT,
  properties: {
    verdict: { type: S.STRING, enum: ["Selected", "Waitlisted", "Rejected"] },
    overall_score: { type: S.INTEGER, description: "0-100, calibrated to this company's bar" },
    headline: { type: S.STRING, description: "One sentence: what decided the outcome" },
    recruiter_note: { type: S.STRING, description: "The 2-3 lines a real recruiter would file" },
    competencies: {
      type: S.OBJECT,
      properties: {
        technical_depth: competency,
        problem_solving: competency,
        communication: competency,
        structure: competency,
        confidence: competency,
        honesty: competency,
      },
      required: ["technical_depth", "problem_solving", "communication", "structure", "confidence", "honesty"],
    },
    strengths: { type: S.ARRAY, items: { type: S.STRING } },
    red_flags: { type: S.ARRAY, items: { type: S.STRING } },
    rewrites: {
      type: S.ARRAY,
      description: "4-8 answers that cost marks, quoted verbatim and rewritten",
      items: {
        type: S.OBJECT,
        properties: {
          question: { type: S.STRING },
          you_said: { type: S.STRING, description: "Verbatim from the transcript, fillers included" },
          what_went_wrong: { type: S.STRING },
          say_instead: { type: S.STRING, description: "The full replacement answer, ready to use" },
          why_it_works: { type: S.STRING },
        },
        required: ["question", "you_said", "what_went_wrong", "say_instead", "why_it_works"],
      },
    },
    study_plan: {
      type: S.ARRAY,
      description: "Ordered by how much each would have changed THIS interview",
      items: {
        type: S.OBJECT,
        properties: {
          day: { type: S.INTEGER },
          focus: { type: S.STRING },
          why: { type: S.STRING },
        },
        required: ["day", "focus", "why"],
      },
    },
  },
  required: ["verdict", "overall_score", "headline", "recruiter_note",
             "competencies", "strengths", "red_flags", "rewrites", "study_plan"],
};

/** Transcript + the panel's private notes, as the model sees them. */
function renderTranscript(session) {
  const L = [];
  L.push(`# Interview`);
  L.push(`Company: ${session.company.name} (difficulty ${session.company.difficulty}/5)`);
  L.push(`Role: ${session.role}`);
  L.push(`Round: ${session.round.name}`);
  L.push(`Panel: ${session.roster.map((p) => `${p.name} (${p.title})`).join(", ")}`);
  L.push(`Duration: ${(session.elapsedMs / 60000).toFixed(1)} minutes`);
  L.push(``);

  if (session.candidate?.resume_text) {
    L.push(`## What the candidate submitted`);
    L.push("```");
    L.push(session.candidate.resume_text.slice(0, 4000));
    L.push("```");
    L.push(``);
  }

  L.push(`## Transcript`);
  for (const m of session.history) {
    if (m.role === "assistant") {
      // Strip the META block: the spoken half is the transcript, and the notes
      // arrive separately below in a form that is easier to reason over.
      const spoken = m.content.split("<<<META>>>")[0].trim();
      if (spoken) L.push(`\nPANEL: ${spoken}`);
    } else {
      L.push(`\nCANDIDATE: ${m.content}`);
    }
  }
  L.push(``);

  L.push(`## The panel's private notes, recorded during the interview`);
  L.push(`These are what the panel actually thought after each answer. Treat them as fact.`);
  for (const e of session.ledger) {
    const bits = [`- [${e.speaker}] ${e.action}`];
    if (e.topic_fingerprint) bits.push(`topic=${e.topic_fingerprint}`);
    if (e.evidence) bits.push(`evidence="${e.evidence}"`);
    if (e.scores) bits.push(`scores=${JSON.stringify(e.scores)}`);
    if (e.red_flags?.length) bits.push(`red_flags=${JSON.stringify(e.red_flags)}`);
    L.push(bits.join(" "));
  }
  return L.join("\n");
}

/**
 * The same schema, as plain JSON Schema.
 *
 * @google/genai's Type values are uppercase strings ("OBJECT"), which is one
 * lowercase away from the JSON Schema every other provider wants — so the
 * schema is written once, above, and translated here rather than maintained
 * twice and allowed to drift.
 */
function toJsonSchema(node) {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = k === "type" && typeof v === "string" ? v.toLowerCase() : toJsonSchema(v);
  }
  return out;
}

/**
 * JSON out of a reply that was asked for JSON.
 *
 * Gemini's responseSchema guarantees the shape; a provider asked in prose does
 * not, and the three things they actually do are wrap it in ```json fences,
 * precede it with "Here is the report:", or both. None of that is worth losing
 * a finished interview over.
 */
function parseJson(text) {
  const t = String(text ?? "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const from = t.indexOf("{");
    const to = t.lastIndexOf("}");
    if (from === -1 || to <= from) throw new Error("The report came back as unreadable JSON — try again.");
    try {
      return JSON.parse(t.slice(from, to + 1));
    } catch {
      throw new Error("The report came back as unreadable JSON — try again.");
    }
  }
}

/** Gemini's route: the schema is enforced by the API, not asked for in words. */
async function viaGemini(apiKey, contents, models, onStatus) {
  const ai = new GoogleGenAI({ apiKey });
  let lastErr = null;
  // The report is one big call at the end of a long session, which is exactly
  // when a 503 hurts most — the transcript only exists in memory. So: wait out
  // the busy signal, then walk down to a lighter model if it is still busy.
  for (const model of models) {
    try {
      const res = await withRetry(
        () => ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: prompt(),
            responseMimeType: "application/json",
            responseSchema: SCHEMA,
            maxOutputTokens: 16000,
            // Unlike a panel turn, nobody is waiting mid-sentence here — this is the
            // one call in the app where thinking is worth the seconds.
            thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
            temperature: 0.4,
          },
        }),
        { onWait: ({ message, ms }) => { console.warn(`[report] ${message} (${ms}ms)`); onStatus?.(message); } }
      );
      if (res?.text) return res.text;
      lastErr = new Error("Gemini returned an empty response.");
    } catch (err) {
      lastErr = err;
      const kind = classify(err)?.kind;
      // Busy after the waits, quota spent, or the tier lacks the model — all
      // three are per-model, so a different model is the one thing left that
      // might work, and a weaker report beats none.
      if (kind === "busy" || kind === "quota" || isDailyQuota(err) ||
          /404|NOT_FOUND|not found|not supported/i.test(String(err?.message || err))) {
        console.warn(`[report] ${model} not available, trying next`);
        onStatus?.("Trying a different model for the report…");
        continue;
      }
      throw friendlyError(err);
    }
  }
  console.error("[report] every model failed:", lastErr);
  throw new Error(
    "Every model on this key is busy or out of free quota. The interview is saved — " +
    "press 'Try again' in a moment."
  );
}

/**
 * Everyone else: the schema goes in the prompt.
 *
 * response_format is requested too, where the provider has it, but the schema
 * text is what actually does the work — several providers accept the field and
 * ignore it, and one or two reject the request outright for having it (which
 * chatapi.generate retries without).
 */
async function viaChat(spec, apiKey, contents, models, onStatus) {
  const schema = JSON.stringify(toJsonSchema(SCHEMA), null, 1);
  const out = await chatapi.generate({
    provider: spec, apiKey, models, model: models[0],
    systemInstruction: [
      prompt(),
      "---",
      "# Output format",
      "Reply with ONE JSON object and nothing else — no prose before or after it, " +
      "no markdown fences. It must match this JSON Schema exactly, including every " +
      "required field:",
      schema,
    ].join("\n\n"),
    contents: [{ role: "user", parts: [{ text: contents }] }],
    maxOutputTokens: 16000,
    temperature: 0.4,
    jsonMode: true,
    onStatus,
  });
  return out.text;
}

/**
 * @param {object} args
 * @param {object} [args.keys]    provider id -> key, as main.cjs holds them
 * @param {string} [args.active]  whose key to use; the only one, if not given
 * @param {object} [args.info]    detect.cjs's notes, where the model chain lives
 * @param {string} [args.apiKey]  a bare Gemini key, as older callers pass it
 * @returns {Promise<{report: object, stats: object}>}
 */
async function generate({ apiKey, keys, active, info, session, onStatus }) {
  // Called with a single Gemini key by older code and with the whole set by
  // main.cjs; both mean the same thing here.
  const all = keys ?? (apiKey ? { gemini: apiKey } : {});
  const id = active && all[active] ? active : Object.keys(all)[0];
  if (!id) throw new Error("No API key is set.");
  const spec = providers.byId(id);
  if (!spec) throw new Error(`Unknown provider: ${id}`);

  const stats = speechStats(session);

  const contents = [
    renderTranscript(session),
    ``,
    `## Measured speech statistics`,
    `Already counted from the transcript — use these numbers, do not re-count or estimate:`,
    "```json",
    JSON.stringify(stats, null, 2),
    "```",
  ].join("\n");

  // Whatever this key was found to be able to reach, strongest first. The
  // compiled-in list is the fallback for a config written before keys carried
  // their own model chain.
  const models = info?.[id]?.report?.length
    ? info[id].report
    : (spec.wire === "gemini" ? REPORT_MODELS : spec.defaults?.report ?? []);

  const text = spec.wire === "gemini"
    ? await viaGemini(all[id], contents, models, onStatus)
    : await viaChat(spec, all[id], contents, models, onStatus);

  return { report: parseJson(text), stats };
}

module.exports = { generate, speechStats, parseJson, toJsonSchema, SCHEMA, REPORT_MODEL, REPORT_MODELS };
