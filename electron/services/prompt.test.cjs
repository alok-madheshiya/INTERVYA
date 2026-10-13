// node electron/services/prompt.test.cjs
//
// The splitter is the one piece where a bug is both silent and embarrassing:
// if the delimiter leaks through, the avatar reads raw JSON aloud mid-interview.
const assert = require("node:assert");
const {
  createSplitter, parseMeta, DELIM, renderChatBrief, CHAT_LANGUAGES,
} = require("./prompt.cjs");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  ok   " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); }
}

/** Feeds `text` through the splitter in fixed-size chunks. */
function run(text, chunkSize) {
  const spoken = [];
  const s = createSplitter((t) => spoken.push(t));
  for (let i = 0; i < text.length; i += chunkSize) s.push(text.slice(i, i + chunkSize));
  const out = s.end();
  return { ...out, streamed: spoken.join("") };
}

const META = { speaker_id: "p_amazon_sde2", action: "cross_question", private: { scores: { clarity: 2 } } };
const SPOKEN = "So you said the array is sorted. What happens if it isn't?";
const FULL = SPOKEN + "\n" + DELIM + "\n" + JSON.stringify(META);

console.log("\nsplitter");

// The delimiter is 10 chars, so chunk sizes on either side of that are the
// interesting ones — 1 and 3 split it across several pushes.
for (const size of [1, 3, 7, 10, 11, 40, 5000]) {
  test(`chunk size ${size}: spoken text is clean`, () => {
    const { streamed, spoken } = run(FULL, size);
    assert.ok(!streamed.includes("<<<"), "delimiter leaked into streamed text: " + JSON.stringify(streamed.slice(-30)));
    assert.ok(!streamed.includes("speaker_id"), "META leaked into streamed text");
    assert.strictEqual(spoken, SPOKEN);
  });

  test(`chunk size ${size}: streamed matches spoken`, () => {
    const { streamed, spoken } = run(FULL, size);
    assert.strictEqual(streamed.trim(), spoken, "what was spoken aloud differs from the final spoken text");
  });

  test(`chunk size ${size}: meta parses`, () => {
    const { meta } = run(FULL, size);
    assert.deepStrictEqual(meta, META);
  });
}

test("no delimiter at all: everything is spoken, meta is null", () => {
  const { streamed, spoken, meta } = run("Just a question, nothing else.", 4);
  assert.strictEqual(spoken, "Just a question, nothing else.");
  assert.strictEqual(streamed, "Just a question, nothing else.");
  assert.strictEqual(meta, null);
});

test("delimiter arrives with nothing after it", () => {
  const { spoken, meta } = run("Hello." + DELIM, 3);
  assert.strictEqual(spoken, "Hello.");
  assert.strictEqual(meta, null);
});

test("text shorter than the delimiter still gets spoken", () => {
  const { streamed, spoken } = run("Hi.", 1);
  assert.strictEqual(spoken, "Hi.");
  assert.strictEqual(streamed, "Hi.");
});

console.log("\nparseMeta");

test("plain json", () => {
  assert.deepStrictEqual(parseMeta('{"action":"ask"}'), { action: "ask" });
});

test("fenced json", () => {
  assert.deepStrictEqual(parseMeta('```json\n{"action":"ask"}\n```'), { action: "ask" });
});

test("json with trailing prose", () => {
  assert.deepStrictEqual(parseMeta('{"action":"ask"}\n\nHope that helps.'), { action: "ask" });
});

test("unparseable returns null rather than throwing", () => {
  assert.strictEqual(parseMeta("not json at all"), null);
});

console.log("\nTalk-mode language");

// HeadTTS ships an English and a Finnish phoneme module and nothing else, so
// Devanagari output would be silent — the avatar would move its mouth over no
// audio at all. Every language therefore has to insist on Roman letters, and
// Hindi most of all, since that is the one a model writes in Devanagari by
// default.
const CHAR = { name: "Ananya", role: "SDE II", vibe: "friendly", good_for: ["DSA"] };
const brief = (language, script) =>
  renderChatBrief({ character: CHAR, topic: "", candidate: { name: "Alok" }, language, script });

test("without a Hindi voice, Hindi is told to stay in Roman letters", () => {
  // Kokoro speaks it through an English phoneme module, which drops Devanagari
  // entirely — the avatar would mouth a silent sentence.
  for (const id of ["hindi_latin", "hinglish"]) {
    assert.match(CHAT_LANGUAGES[id].join(" "), /Roman letters/i, id + " does not say it");
  }
});

test("with a Hindi voice, Hindi is told to write Devanagari instead", () => {
  // A Windows hi-IN voice reads Devanagari natively and would pronounce Roman
  // letters as English, so the rule inverts.
  assert.match(CHAT_LANGUAGES.hindi_deva.join(" "), /DEVANAGARI/);
  assert.doesNotMatch(CHAT_LANGUAGES.hindi_deva.join(" "), /write it in ROMAN/i);
});

test("the script follows the voice, not the language", () => {
  assert.match(brief("hindi", "deva"), /written in DEVANAGARI/);
  assert.match(brief("hindi", "latin"), /ROMAN letters/);
});

test("an unknown script falls back to Roman — the one that always makes a sound", () => {
  // Silence is the worse failure: romanised Hindi in an English accent is at
  // least audible, where Devanagari through Kokoro is nothing at all.
  assert.match(brief("hindi", undefined), /ROMAN letters/);
  assert.match(brief("hindi", "klingon"), /ROMAN letters/);
});

test("no language is left without an instruction of its own", () => {
  for (const id of Object.keys(CHAT_LANGUAGES)) {
    assert.ok(CHAT_LANGUAGES[id].join(" ").length > 60, id + " has no real instruction");
  }
});

test("both Hindi variants say why, not just what — an unexplained rule gets dropped", () => {
  assert.match(CHAT_LANGUAGES.hindi_latin.join(" "), /no Hindi module and would say nothing/i);
  assert.match(CHAT_LANGUAGES.hindi_deva.join(" "), /would be pronounced as English/i);
});

test("English is told not to drift into Hindi", () => {
  assert.match(CHAT_LANGUAGES.english.join(" "), /not slip into Hindi/i);
});

test("both Hindi variants keep technical terms in Latin script", () => {
  assert.match(CHAT_LANGUAGES.hindi_latin.join(" "), /technical terms in English/i);
  assert.match(CHAT_LANGUAGES.hindi_deva.join(" "), /technical terms in Latin script/i);
});

test("the brief carries the chosen language, not the default", () => {
  assert.match(brief("english"), /Speak English throughout/);
  assert.match(brief("hindi", "latin"), /Speak Hindi throughout/);
  assert.match(brief("hinglish"), /natural Hinglish/);
});

test("an unknown or missing language falls back to Hinglish rather than to nothing", () => {
  assert.match(brief(undefined), /natural Hinglish/);
  assert.match(brief("klingon"), /natural Hinglish/);
});

test("the model is told to stay put if the candidate switches language mid-conversation", () => {
  assert.match(brief("english"), /stay in this one/i);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
