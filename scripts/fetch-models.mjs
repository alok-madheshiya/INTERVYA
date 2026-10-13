// Downloads the TTS + STT weights once, so the app starts from disk.
//
// Why: HeadTTS's connect() was taking 118-144 s on every launch, re-downloading
// Kokoro each time instead of reading a cache. A desktop app cannot open with a
// two-minute blank screen, and the whole point of local models is that the
// interview keeps working with no network.
//
//   npm run fetch-models
//
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "models");

// transformers.js resolves a local model as {localModelPath}/{repo}/{file},
// so the directory layout has to mirror the HuggingFace repo exactly.
const REPOS = [
  {
    repo: "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped",
    // fp32 measured fastest on Iris Xe (fp16 1.4x slower, q8 9.6x) — see the
    // dtype sweep in the Phase 0 spike. Only that variant is worth the disk.
    keep: (f) =>
      !f.startsWith("onnx/") ||
      /model\.onnx$|model_fp32\.onnx/.test(f),
  },
  {
    repo: "onnx-community/whisper-base.en",
    keep: (f) =>
      !f.startsWith("onnx/") ||
      /encoder_model\.onnx$|decoder_model_merged_q4\.onnx$|_data$/.test(f),
  },
];

// Kokoro's voice packs are fetched separately by HeadTTS from this repo.
const VOICES = ["hm_omega", "hm_psi", "hf_alpha", "hf_beta"];
const VOICE_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";

const HF = "https://huggingface.co";
// huggingface.co resets connections constantly on this network — often enough
// that a whole run can end with files quietly listed as MISS. hf-mirror serves
// the same repos byte for byte and stays up when the origin will not.
const MIRRORS = [HF, "https://hf-mirror.com"];

// The small JSON files decide whether the app works offline, and they fail in
// the least obvious way: transformers.js falls back to the network for a file
// it cannot find locally, so a missing one looks like nothing at all until the
// network is down — and then it surfaces as "Cannot read properties of null
// (reading 'feature_extractor')" in the middle of an interview. That is exactly
// how whisper-base.en shipped without its preprocessor_config.json.
const REQUIRED = [
  "onnx-community/whisper-base.en/preprocessor_config.json",
  "onnx-community/whisper-base.en/config.json",
  "onnx-community/whisper-base.en/tokenizer.json",
  "onnx-community/whisper-base.en/generation_config.json",
  "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/config.json",
  "onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/tokenizer.json",
];
const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// HuggingFace resets connections often enough on this network that a single
// attempt fails routinely on the larger files. Already-downloaded files are
// skipped, so re-running the script is a safe way to finish a partial fetch.
async function withRetry(label, fn, tries = 5) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const why = e?.cause?.code || e?.message;
      if (i < tries) {
        const wait = Math.min(2 ** i, 20);
        console.log(`  retry ${label} (${why}) — again in ${wait}s [${i}/${tries - 1}]`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
  }
  throw last;
}

async function download(url, dest) {
  if (await exists(dest)) {
    console.log(`  skip  ${path.relative(OUT, dest)} (already here)`);
    return 0;
  }
  const name = path.basename(dest);
  const buf = await withRetry(name, async () => {
    let last;
    for (const host of MIRRORS) {
      try {
        const res = await fetch(url.replace(HF, host));
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (e) { last = e; }
    }
    throw last;
  });
  await mkdir(path.dirname(dest), { recursive: true });
  // Write to a temp name first: a connection reset mid-write would otherwise
  // leave a truncated file that the "already here" check happily skips forever.
  const tmp = dest + ".part";
  await writeFile(tmp, buf);
  const { rename } = await import("node:fs/promises");
  await rename(tmp, dest);
  console.log(`  got   ${path.relative(OUT, dest)}  ${mb(buf.length)}`);
  return buf.length;
}

let total = 0;
const missing = [];

for (const { repo, keep } of REPOS) {
  console.log(`\n${repo}`);
  const files = await withRetry("listing", async () => {
    const r = await fetch(`${HF}/api/models/${repo}/tree/main?recursive=1`);
    if (!r.ok) throw new Error(`repo listing failed: ${r.status}`);
    return (await r.json()).filter((e) => e.type === "file").map((e) => e.path);
  });

  for (const f of files.filter(keep)) {
    try {
      total += await download(`${HF}/${repo}/resolve/main/${f}`, path.join(OUT, repo, f));
    } catch (e) {
      // Keep going: one unlucky file shouldn't abandon the other 300 MB.
      missing.push(`${repo}/${f}`);
      console.log(`  MISS  ${f} — ${e?.cause?.code || e.message}`);
    }
  }
}

console.log(`\n${VOICE_REPO} (voices)`);
for (const v of VOICES) {
  try {
    total += await download(
      `${HF}/${VOICE_REPO}/resolve/main/voices/${v}.bin`,
      path.join(OUT, "voices", `${v}.bin`)
    );
  } catch (e) {
    missing.push(`voices/${v}.bin`);
    console.log(`  MISS  ${v}.bin — ${e?.cause?.code || e.message}`);
  }
}

console.log(`\nTotal fetched: ${mb(total)} into models/`);

// Being told which file is missing is the whole point: without this the run
// ends looking successful and the gap only shows up mid-interview.
const absent = [];
for (const f of REQUIRED) {
  if (!(await exists(path.join(OUT, f)))) absent.push(f);
}
if (absent.length) {
  console.log("\nStill missing — the app will fall back to the network for these,");
  console.log("and fail with a confusing error whenever it cannot reach it:");
  for (const f of absent) console.log("  " + f);
  console.log("\nRun this script again; it only fetches what is not already here.");
  process.exitCode = 1;
} else {
  console.log("The app now loads from disk every time — no internet needed.");
}
