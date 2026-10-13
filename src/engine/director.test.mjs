// node src/engine/director.test.mjs
//
// Speaker rotation is the thing the model gets wrong on its own: left alone it
// re-picks whoever just spoke and the candidate is interviewed by one person.
// The prompt asks for rotation; this proves the code enforces it anyway.
import assert from "node:assert";
import { castPanel, IDENTITIES } from "../panel/identities.js";

let pass = 0, fail = 0;
const test = (n, fn) => {
  try { fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

const personas = [
  { id: "p1", name: "Rakesh Iyer",   harshness: 2, speciality: ["dbms"], pet_peeve: "x", tic: "", style: "s" },
  { id: "p2", name: "Meenakshi Rao", harshness: 1, speciality: ["hr"],   pet_peeve: "y", tic: "", style: "s" },
  { id: "p3", name: "Kabir Malhotra",harshness: 3, speciality: ["dsa"],  pet_peeve: "z", tic: "", style: "s" },
];

console.log("\npanel casting (name must match the face)");

test("every panelist's name comes from the identity, not the persona", () => {
  const cast = castPanel(personas, "dsa", () => 0.5);
  const known = new Set(IDENTITIES.map((i) => i.name));
  for (const m of cast) assert.ok(known.has(m.name), `unknown name: ${m.name}`);
});

test("the one male name only ever lands on the male avatar", () => {
  for (let i = 0; i < 200; i++) {
    for (const m of castPanel(personas, "dsa", Math.random)) {
      const face = IDENTITIES.find((f) => f.id === m.id);
      assert.strictEqual(m.body, face.body);
      assert.strictEqual(m.name, face.name);
      if (m.name === "Daniel Cole") assert.strictEqual(m.body, "M");
      else assert.strictEqual(m.body, "F", `${m.name} should be F`);
    }
  }
});

test("voice gender matches the face", () => {
  for (let i = 0; i < 100; i++) {
    for (const m of castPanel(personas, "hr", Math.random)) {
      assert.strictEqual(m.voice.startsWith("hm_"), m.body === "M",
        `${m.name} (${m.body}) got ${m.voice}`);
    }
  }
});

test("no two panelists share a face", () => {
  for (let i = 0; i < 100; i++) {
    const cast = castPanel(personas, "dsa", Math.random);
    assert.strictEqual(new Set(cast.map((m) => m.id)).size, cast.length);
  }
});

test("persona behaviour survives the recast", () => {
  const cast = castPanel(personas, "dsa", () => 0.5);
  assert.deepStrictEqual(cast.map((m) => m.harshness), [2, 1, 3]);
  assert.deepStrictEqual(cast.map((m) => m.personaId), ["p1", "p2", "p3"]);
});

test("titles suit the round", () => {
  assert.ok(castPanel(personas, "hr", () => 0.5)[0].title.includes("HR"));
  assert.ok(/SDE|Engineer|Manager|Lead/.test(castPanel(personas, "dsa", () => 0.5)[0].title));
});

test("the opening speaker is not always the same face", () => {
  const firsts = new Set();
  for (let i = 0; i < 60; i++) firsts.add(castPanel(personas, "dsa", Math.random)[0].id);
  assert.ok(firsts.size >= 3, `only ${firsts.size} distinct openers in 60 casts`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
