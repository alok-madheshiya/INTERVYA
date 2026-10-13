// Downloads each candidate avatar and reports what its rig can actually do.
//
// Guessing from filenames wasted a lot of time: "avatarsdk.glb" is male but has
// no Oculus visemes, "vroid.glb" is meshopt-compressed and won't load at all.
// This reads the GLB's own morph-target names so the panel roster is built from
// facts instead of assumptions.
//
//   node scripts/inspect-avatars.mjs
//
const GH = "https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars";
const VISAGE = "https://raw.githubusercontent.com/readyplayerme/visage/main/public";

const FILES = [
  `${GH}/brunette.glb`, `${GH}/brunette-t.glb`, `${GH}/mpfb.glb`,
  `${GH}/avaturn.glb`, `${GH}/avatarsdk.glb`, `${GH}/vroid.glb`,
  `${VISAGE}/half-body.glb`,
];

/** Reads the JSON chunk out of a GLB container. */
function glbJson(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
  let off = 12;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) return JSON.parse(buf.subarray(off + 8, off + 8 + len).toString("utf8"));
    off += 12 + len - 4;
  }
  throw new Error("no JSON chunk");
}

for (const url of FILES) {
  const file = url.split("/").pop();
  process.stdout.write(file.padEnd(17));
  try {
    const res = await fetch(url);
    if (!res.ok) { console.log(`HTTP ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const gltf = glbJson(buf);

    const names = new Set();
    for (const mesh of gltf.meshes || []) {
      for (const n of mesh.extras?.targetNames || []) names.add(n);
    }
    const all = [...names];
    const visemes = all.filter((n) => n.startsWith("viseme_"));
    const arkit = all.filter((n) => /^(jawOpen|mouth|browInnerUp|eyeBlink|cheek|noseSneer|tongue)/.test(n));
    const compressed = (gltf.extensionsUsed || []).filter((e) => /draco|meshopt|EXT_meshopt/i.test(e));
    // TalkingHead demands an "Armature" root node (opt.modelRoot) and poses a
    // Mixamo-style skeleton under it. Missing either and showAvatar throws
    // "Avatar object Armature not found" - Hips alone is not enough.
    const nodes = new Set((gltf.nodes || []).map((n) => n.name));
    const rig = [nodes.has("Armature") ? "Armature" : "NO-Armature",
                 nodes.has("Hips") ? "Hips" : "NO-Hips"].join("+");

    console.log(
      `${String(Math.round(buf.length / 1024)).padStart(6)} KB  ` +
      `visemes:${String(visemes.length).padStart(2)}  arkit:${String(arkit.length).padStart(3)}  ` +
      `morphs:${String(all.length).padStart(3)}  ${rig.padEnd(18)}` +
      (compressed.length ? `  COMPRESSED(${compressed.join(",")})` : "")
    );
  } catch (e) {
    console.log("ERROR " + e.message);
  }
}
