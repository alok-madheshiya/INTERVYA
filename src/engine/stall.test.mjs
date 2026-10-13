// node src/engine/stall.test.mjs
//
// What happens when something goes wrong mid-interview.
//
// This used to end the session: the loop waited a blind thirty seconds, tried
// once more, and if that failed the interview was over. On the free tier a
// quota window is routine, so a real half-finished interview was being thrown
// away by a wait that was too short to help. Now the candidate is asked, and
// the only thing that must never happen is a prompt nobody can escape.
//
// Later, the same argument was extended to faults that are not quota at all.
// A dropped worker or an unparseable reply also used to end the interview and
// send the candidate straight to the report — from their side, the app simply
// crashed. One question is a cheap thing to lose; a transcript is not. So every
// failure now asks, and only the wording distinguishes them.
import assert from "node:assert";
import { Director } from "./director.js";

let pass = 0, fail = 0;
const test = async (n, fn) => {
  try { await fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

const QUOTA = "Hit Gemini's free rate limit (10 requests a minute). Wait a moment.";

const roster = [
  { id: "a", name: "A", title: "SDE", voice: "hf_alpha" },
  { id: "b", name: "B", title: "SDE", voice: "hf_beta" },
];

/** Just enough of the call screen for the loop to run headless. */
function harness({ replies, stalls }) {
  const tiles = new Map(roster.map((m) => [m.id, { member: m, head: null, el: null }]));
  const session = {
    company: { name: "X", difficulty: 3 }, role: "SDE", round: { name: "R", type: "dsa" },
    candidate: { name: "Alok" }, roster, arc: { id: "a" }, seed: "s",
    startedAt: Date.now(), elapsedMs: 0, history: [],
    memory: { turnCount: 0, askedFingerprints: [], claims: [], weakSpots: [], spokenBy: {}, recentSpeakers: [] },
    ledger: [],
  };

  let call = 0;
  globalThis.window = {
    agent: {
      runTurn: async () => {
        const r = replies[Math.min(call++, replies.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };

  const asked = [];
  const d = new Director({
    session,
    panel: { tiles, setThinking() {}, setSpeaking() {}, react() {} },
    speech: { speak: async () => {}, cancel() {} },
    listener: { listen: async () => ({ text: "answer" }), stop() {} },
    ui: {
      onStalled: (err, acts) => { asked.push(err.message); stalls(acts, d); },
      onFinished: () => {},
    },
  });
  return { d, session, asked, calls: () => call };
}

const reply = (spoken) => ({ spoken, raw: spoken, meta: { speaker_id: "a", action: "ask" } });

console.log("\nwhen Gemini refuses mid-interview");

await test("a quota failure asks the candidate instead of ending the interview", async () => {
  const h = harness({
    replies: [reply("Q1"), new Error(QUOTA), reply("Q2"), reply("done")],
    stalls: (acts) => acts.retry(),
  });
  // Third reply carries end_interview so the loop terminates.
  await h.d.run(null).then(() => {}).catch(() => {});
  assert.deepStrictEqual(h.asked, [QUOTA], "candidate was not asked");
  assert.ok(h.session.history.some((m) => m.content === "Q2"),
    "the retried turn never made it into the transcript");
});

await test("choosing to end still produces a session to report on", async () => {
  const h = harness({
    replies: [reply("Q1"), new Error(QUOTA)],
    stalls: (acts) => acts.end(),
  });
  let finished = null;
  h.d.ui.onFinished = (s) => { finished = s; };
  await h.d.run(null);
  assert.ok(finished, "onFinished never fired — the report screen would never open");
  assert.ok(finished.history.length > 0, "transcript was lost");
});

await test("Leave releases a pending prompt rather than hanging forever", async () => {
  const h = harness({
    replies: [reply("Q1"), new Error(QUOTA)],
    // Nobody clicks anything; Leave is pressed instead.
    stalls: (_acts, d) => setTimeout(() => d.stop(), 5),
  });
  const done = await Promise.race([
    h.d.run(null).then(() => "finished"),
    new Promise((r) => setTimeout(() => r("hung"), 2000)),
  ]);
  assert.strictEqual(done, "finished");
});

await test("a real bug asks too — it does not end the interview by itself", async () => {
  const h = harness({
    replies: [new Error("Cannot read properties of undefined"), reply("Q1")],
    stalls: (acts) => acts.retry(),
  });
  await h.d.run(null);
  assert.deepStrictEqual(h.asked, ["Cannot read properties of undefined"],
    "a bug ended the interview instead of asking");
  assert.ok(h.session.history.some((m) => m.content === "Q1"),
    "Try again did not actually re-run the turn");
});

await test("a bug is not dressed up as something to wait out", async () => {
  // The two failures survive the same way but must not read the same way:
  // "trying again in a moment" about a null pointer is a lie, and the person
  // reading it is deciding whether to sit through a wait that will never end.
  const kinds = [];
  const h = harness({
    replies: [new Error("Cannot read properties of undefined"),
              new Error(QUOTA), reply("Q1")],
    stalls: (acts) => { kinds.push(acts.recoverable); acts.retry(); },
  });
  await h.d.run(null);
  assert.deepStrictEqual(kinds, [false, true]);
});

await test("a panelist losing their voice costs one line, not the interview", async () => {
  // Synthesis runs on the GPU next to four avatars; it does fail. The words are
  // already in the caption by then, so there is nothing to gain by stopping.
  const h = harness({ replies: [reply("Q1"), reply("Q2")], stalls: (acts) => acts.end() });
  h.d.panel.tiles.get("a").head = {};
  h.d.speech.speak = async () => { throw new Error("WebGPU device lost"); };
  let lost = 0;
  h.d.ui.onVoiceLost = () => { lost++; };
  h.d.session.memory.turnCount = 40;   // one turn, then out
  await h.d.run(null);
  assert.strictEqual(lost, 1, "the failure never reached the UI");
  assert.deepStrictEqual(h.asked, [], "a mute panelist was treated as a stalled interview");
});

await test("the mic giving out asks rather than ending the session", async () => {
  const h = harness({ replies: [reply("Q1"), reply("Q2")], stalls: (acts) => acts.end() });
  h.d.listener.listen = async () => { throw new Error("whisper worker failed to start"); };
  let finished = null;
  h.d.ui.onFinished = (s) => { finished = s; };
  await h.d.run(null);
  assert.deepStrictEqual(h.asked, ["whisper worker failed to start"]);
  assert.ok(finished, "the report screen would never have opened");
});

await test("the prompt repeats while the failure persists, not just once", async () => {
  let clicks = 0;
  const h = harness({
    replies: [new Error(QUOTA), new Error(QUOTA), reply("Q1")],
    stalls: (acts) => { clicks++; clicks < 3 ? acts.retry() : acts.end(); },
  });
  await h.d.run(null);
  assert.strictEqual(h.asked.length, 2, "gave up after a single prompt");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
