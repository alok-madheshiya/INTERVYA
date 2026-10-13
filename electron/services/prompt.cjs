// Provider-agnostic prompt construction and response parsing.
//
// The panel prompt, the session brief and the spoken/META splitter are the same
// whichever model runs behind them, so they live here and each provider module
// (gemini.cjs, ...) only owns the API call itself.
const fs = require("node:fs");
const path = require("node:path");

const DELIM = "<<<META>>>";

const ROOT = path.join(__dirname, "..", "..");
let CORE = null;
const core = () => (CORE ??= fs.readFileSync(path.join(ROOT, "prompts", "core.md"), "utf8"));

let CHAT = null;
const chatCore = () => (CHAT ??= fs.readFileSync(path.join(ROOT, "prompts", "chat.md"), "utf8"));

/**
 * Talk mode's brief: one character, no panel, no scoring.
 *
 * Same caching rule as renderBrief — nothing volatile in here, or every turn
 * becomes a full-price request.
 */
// What each Talk-mode language asks of the model.
//
// The hard constraint behind all three: the voice engine has an English
// grapheme-to-phoneme module and no Hindi one, so Devanagari would come out
// silent. Hindi therefore has to be written in Roman letters — which is how it
// is typed in India anyway, and it speaks correctly through the English G2P.
const CHAT_LANGUAGES = {
  english: [
    `Speak English throughout. Plain, clear Indian English.`,
    `Do not slip into Hindi words, even the ones that come naturally — they have`,
    `asked for English so they can practise it.`,
  ],
  hinglish: [
    `Speak Indian English with natural Hinglish mixed in, the way an Indian`,
    `engineer actually talks: *achha*, *theek hai*, *dekho*, *matlab*, *ek minute*.`,
    `Do not overdo it, and never translate yourself.`,
    `Write the Hindi words in Roman letters, never in Devanagari.`,
  ],
  // Hindi appears twice because which script to write in depends on which
  // voice will read it aloud, and that is decided per machine:
  //
  //   hindi_deva  — Windows has a Hindi voice. It reads Devanagari natively and
  //                 sounds Hindi; Roman letters would be read as English.
  //   hindi_latin — no Hindi voice, so Kokoro speaks it through an English
  //                 phoneme module. Devanagari would be silent there.
  //
  // Sending the wrong one of these produces either silence or gibberish, so it
  // is not a preference.
  hindi_deva: [
    `Speak Hindi throughout, written in DEVANAGARI: आप कैसे हो, not "aap kaise ho".`,
    `A real Hindi voice is reading this aloud and expects Devanagari — Roman`,
    `letters would be pronounced as English and come out as nonsense.`,
    `Keep technical terms in Latin script, the way everyone writes them: array,`,
    `pointer, interview, package, system design.`,
  ],
  hindi_latin: [
    `Speak Hindi throughout — but write it in ROMAN letters, never in Devanagari.`,
    `So: "aap kaise ho", not "आप कैसे हो". This is not a style preference: the`,
    `voice reading this aloud has no Hindi module and would say nothing at all.`,
    `Keep technical terms in English, the way everyone says them: array, pointer,`,
    `interview, package, system design. Translating those would sound absurd.`,
  ],
};

/**
 * The language lines for a conversation.
 *
 * `script` only means anything for Hindi, and it is chosen by whether the
 * machine has a Hindi voice — see systemVoice.js.
 */
function languageLines(language, script) {
  if (language === "hindi") {
    return CHAT_LANGUAGES[script === "deva" ? "hindi_deva" : "hindi_latin"];
  }
  return CHAT_LANGUAGES[language] ?? CHAT_LANGUAGES.hinglish;
}

function renderChatBrief({ character, topic, candidate, language, script }) {
  const FENCE = "```";
  const L = [];
  L.push(`# You are ${character.name}`);
  L.push(``);
  L.push(`**Who you are:** ${character.role}`);
  L.push(`**How you come across:** ${character.vibe}`);
  if (character.good_for?.length) {
    L.push(`**What people usually come to you for:** ${character.good_for.join(", ")}`);
  }
  L.push(``);
  L.push(`## Who you are talking to`);
  L.push(``);
  L.push(candidate?.name
    ? `${candidate.name}, a B.Tech CSE student in India preparing for placements.`
    : `A B.Tech CSE student in India preparing for placements.`);

  if (topic?.trim()) {
    L.push(``);
    L.push(`They said they want to talk about:`);
    L.push(``);
    L.push(`> ${topic.trim().slice(0, 800).replace(/\n+/g, " ")}`);
    L.push(``);
    L.push(`Open on that. You do not have to stay on it if the conversation moves.`);
  } else {
    L.push(``);
    L.push(`They did not say what they want to talk about. Open by asking — briefly,`);
    L.push(`the way you would if they had just joined your call.`);
  }

  if (candidate?.resume_text) {
    L.push(``);
    L.push(`## What they have worked on`);
    L.push(``);
    L.push(FENCE);
    L.push(candidate.resume_text.slice(0, 4000));
    L.push(FENCE);
    L.push(``);
    L.push(`Use this when it is relevant. Do not recite it back at them.`);
  }
  L.push(``);
  L.push(`## Language`);
  L.push(``);
  L.push(...languageLines(language, script));
  L.push(``);
  L.push(`If they write or speak to you in a different language, stay in this one`);
  L.push(`anyway — it is what they chose to practise.`);

  return L.join("\n");
}


/**
 * Renders the per-session brief. Must be deterministic — Gemini's implicit
 * caching keys on a stable prefix, so a timestamp or a re-ordered key in here
 * quietly turns every turn into a full-price request.
 */
function renderBrief(session) {
  const { company, round, roster, arc, seed, candidate } = session;
  const L = [];

  L.push(`# This interview`);
  L.push(``);
  L.push(`**Company:** ${company.name} (${company.category}, difficulty ${company.difficulty}/5)`);
  // The pay band is the bar. A 3.36 LPA trainee track and an 11 LPA one at the
  // same company are different interviews, and saying so is what stops every
  // company being graded as though it were a product company.
  const ctc = session.roleCtc;
  const band = ctc ? (ctc[0] === ctc[1] ? `${ctc[0]}` : `${ctc[0]}-${ctc[1]}`) : null;
  L.push(`**Role:** ${session.role}` +
    (band ? ` — approx ${band} LPA. Calibrate the bar to this level.` : ""));
  L.push(`**Panel style:** ${company.panel_style}`);
  if (company.signature_behaviour) L.push(`**This company's signature:** ${company.signature_behaviour}`);
  if (company.notes) L.push(`**Context:** ${company.notes}`);
  L.push(``);

  L.push(`## The panel`);
  L.push(``);
  for (const p of roster) {
    L.push(`### ${p.id} — ${p.name}, ${p.title}`);
    L.push(`- Harshness: ${p.harshness}/3`);
    L.push(`- Knows best: ${p.speciality.join(", ")}`);
    L.push(`- Cannot stand: ${p.pet_peeve}`);
    if (p.tic) L.push(`- Verbal tic: "${p.tic}"`);
    L.push(`- Manner: ${p.style}`);
    L.push(``);
  }
  L.push(`${roster[0].name} (${roster[0].id}) is running this round. The others cut in when something touches their speciality, or when they disagree.`);
  L.push(``);

  L.push(`## This round`);
  L.push(``);
  L.push(`**${round.name}** — about ${round.minutes} minutes.`);
  if (round.focus?.length) L.push(`Cover: ${round.focus.join(", ")}`);
  if (round.must_do?.length) {
    L.push(``);
    L.push(`Round rules:`);
    for (const m of round.must_do) L.push(`- ${m}`);
  }
  L.push(``);

  L.push(`## Arc for this session`);
  L.push(``);
  L.push(`**${arc.id}** — ${arc.description}`);
  L.push(``);
  L.push(`Variation seed: \`${seed}\`. Two interviews with the same company must not`);
  L.push(`feel alike. Use this seed to pick different openings, different topics within`);
  L.push(`the round's focus areas, and a different order of attack than an obvious one.`);
  L.push(``);

  if (candidate?.resume_text) {
    L.push(`## The candidate's resume`);
    L.push(``);
    L.push("```");
    L.push(candidate.resume_text.slice(0, 6000));
    L.push("```");
    L.push(``);
    L.push(`Grill what is actually written here. Vague bullets are the best attack surface.`);
  } else {
    L.push(`## The candidate`);
    L.push(``);
    L.push(`No resume was provided. Ask them to describe their projects, then hold them to whatever they say.`);
  }

  return L.join("\n");
}

/**
 * Volatile per-turn state. Goes in the user message, never in `system`.
 */
function renderState(session, answerText) {
  const L = [];
  const asked = session.memory.askedFingerprints;
  const claims = session.memory.claims;

  L.push(`<panel_state>`);
  L.push(`elapsed_minutes: ${Math.round(session.elapsedMs / 60000)}`);
  L.push(`round_minutes: ${session.round.minutes}`);
  L.push(`questions_asked_this_round: ${session.memory.turnCount}`);

  // Left to itself the model re-picks whoever spoke last, and the candidate ends
  // up interviewed by one person. Naming the imbalance fixes it far more
  // reliably than asking for "variety" in the system prompt.
  const spoken = session.memory.spokenBy ?? {};
  const recent = session.memory.recentSpeakers ?? [];
  if (session.roster?.length) {
    L.push(`questions_asked_by:`);
    for (const p of session.roster) {
      L.push(`  ${p.id} (${p.name}): ${spoken[p.id] ?? 0}`);
    }
    if (recent.length) L.push(`last_speakers_oldest_first: ${recent.join(" -> ")}`);

    const streak = recent.length && recent.every((x) => x === recent[0]) ? recent.length : 0;
    if (streak >= 2) {
      L.push(`RULE: ${recent[0]} has asked the last ${streak} questions. ` +
             `A DIFFERENT panelist speaks this time.`);
    }
    const silent = session.roster.filter((p) => !(spoken[p.id] > 0));
    if (silent.length && session.memory.turnCount >= 3) {
      L.push(`OVERDUE (has not spoken yet): ${silent.map((p) => p.id).join(", ")}`);
    }
  }

  if (asked.length) {
    L.push(`already_covered_DO_NOT_REPEAT:`);
    for (const f of asked) L.push(`  - ${f}`);
  }
  if (claims.length) {
    L.push(`candidate_claims_you_may_check:`);
    for (const c of claims) L.push(`  - ${c}`);
  }
  if (session.memory.weakSpots.length) {
    L.push(`unresolved_weak_spots:`);
    for (const w of session.memory.weakSpots) L.push(`  - ${w}`);
  }
  L.push(`</panel_state>`);
  L.push(``);

  if (answerText === null) {
    L.push(`The candidate has just joined the call. Open the round.`);
  } else if (!answerText.trim()) {
    L.push(`The candidate said nothing — silence. React the way a real panel would.`);
  } else {
    L.push(`<candidate_answer>`);
    L.push(answerText.trim());
    L.push(`</candidate_answer>`);
  }
  return L.join("\n");
}

// --- spoken/meta splitter -------------------------------------------------
/**
 * Splits a streamed response into the spoken half and the META half.
 *
 * The delimiter can arrive split across chunk boundaries, so the splitter holds
 * back the last DELIM.length characters before emitting: without that, a chunk
 * ending in "<<<MET" would be spoken aloud.
 */
function createSplitter(onText) {
  let full = "";
  let emitted = 0;
  let hit = false;

  return {
    push(delta) {
      full += delta;
      if (hit) return;

      const at = full.indexOf(DELIM);
      if (at !== -1) {
        hit = true;
        if (at > emitted) onText?.(full.slice(emitted, at));
        emitted = at;
        return;
      }
      const safe = Math.max(0, full.length - DELIM.length);
      if (safe > emitted) {
        onText?.(full.slice(emitted, safe));
        emitted = safe;
      }
    },

    /** Flushes any held-back tail and returns { spoken, meta, raw }. */
    end() {
      const at = full.indexOf(DELIM);
      if (at === -1 && full.length > emitted) {
        onText?.(full.slice(emitted));
        emitted = full.length;
      }
      const spoken = (at === -1 ? full : full.slice(0, at)).trim();
      return { spoken, meta: at === -1 ? null : parseMeta(full.slice(at + DELIM.length)), raw: full };
    },
  };
}

/** Tolerates the model wrapping its JSON in a code fence or adding stray prose. */
function parseMeta(raw) {
  const json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(json);
  } catch {
    const s = json.indexOf("{"), e = json.lastIndexOf("}");
    if (s !== -1 && e > s) {
      try { return JSON.parse(json.slice(s, e + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}


module.exports = {
  core, chatCore, renderBrief, renderChatBrief, renderState,
  CHAT_LANGUAGES, languageLines,
  createSplitter, parseMeta, DELIM,
};
