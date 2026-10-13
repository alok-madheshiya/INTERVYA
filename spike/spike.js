import { TalkingHead } from "talkinghead";
import { HeadTTS } from "headtts";
import { correctTranscript } from "/src/audio/hotwords.js";

const NM = "/node_modules";

// --- The panel -----------------------------------------------------------
//
// Ready Player Me was the obvious avatar source, and the original plan leaned on
// it to mint unlimited varied interviewers. It is gone: models.readyplayer.me
// returns NXDOMAIN from the authoritative AWS nameservers themselves, so no DNS
// change, resolver or VPN brings it back. See scripts/inspect-avatars.mjs.
//
// What survives is a small fixed set of GLBs vendored into public GitHub repos.
// raw.githubusercontent.com is reachable, so those are the supply now.
//
// Avatars are fetched browser-first (the renderer's DNS works where Node's is
// flaky - HuggingFace showed 2/3 in main-process diagnostics while the browser
// pulled hundreds of MB from it), then via the main-process proxy, which caches
// to disk for offline runs. A file dropped in assets/avatars/<id>.glb always wins.

const GH = "https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars";

// Kokoro's Hindi voice packs read English with a natural Indian accent, which is
// what an Indian interview panel should sound like. hm_* are male, hf_* female,
// and each panelist gets a distinct one so they are told apart by ear as well as
// by the speaking ring.
const VOICES = { M: ["hm_omega", "hm_psi"], F: ["hf_alpha", "hf_beta"] };

// Names follow the avatar, not the other way round. Only five avatars in the
// whole reachable set load in TalkingHead (see scripts/inspect-avatars.mjs) and
// exactly one of them reads as male, so the panel is one man and three women —
// a mismatched name is far more jarring than an unbalanced panel.
const PANEL = [
  { id: "int1", name: "Daniel Cole", title: "Engineering Manager", body: "M",
    voice: "hm_omega", sources: [`${GH}/avatarsdk.glb`] },
  { id: "int2", name: "Meenakshi Rao", title: "HR Business Partner", body: "F",
    voice: "hf_alpha", sources: [`${GH}/brunette.glb`] },
  { id: "int3", name: "Sneha Kulkarni", title: "SDE II", body: "F",
    voice: "hf_beta", sources: [`${GH}/mpfb.glb`] },
  { id: "int4", name: "Ananya Desai", title: "Senior Technical Lead", body: "F",
    voice: "hf_alpha", sources: [`${GH}/avaturn.glb`] },
];

const proxied = (u) => "/_asset?url=" + encodeURIComponent(u);
const localFor = (id) => `/assets/avatars/${id}.glb`;
const fileOf = (u) => u.split("/").pop().split("?")[0];

/**
 * Browser-first, then main-process proxy. Returns a URL the GLTFLoader can use.
 * A hand-placed file in assets/avatars/ always wins, so a blocked network is
 * never a dead end.
 */
async function resolveAvatar(member, note) {
  const local = await fetch(localFor(member.id), { method: "HEAD" }).catch(() => null);
  if (local?.ok) return { url: localFor(member.id), source: "local file", via: "disk" };

  const failures = [];
  for (const remote of member.sources) {
    // 1. Straight from the renderer. Uses the browser's own DNS + CORS.
    const direct = await fetch(remote, { mode: "cors" }).catch((e) => ({ ok: false, _e: e.message }));
    if (direct.ok) {
      const blob = await direct.blob();
      return {
        url: URL.createObjectURL(blob),
        source: fileOf(remote), via: "browser", bytes: blob.size,
      };
    }
    // 2. Through the main process (no CORS at all, and it caches to disk).
    const viaProxy = await fetch(proxied(remote)).catch((e) => ({ ok: false, _e: e.message }));
    if (viaProxy.ok) {
      return {
        url: proxied(remote), source: fileOf(remote), via: "proxy",
        bytes: +(viaProxy.headers?.get("content-length") || 0),
      };
    }
    failures.push(fileOf(remote));
    note?.(`  ${fileOf(remote)} nahi mila, agla try...`);
  }
  throw new Error(`${member.name}: koi source nahi mila (${failures.join(", ")})`);
}

/** Builds a Meet-style tile and returns its TalkingHead instance. */
async function mountMember(member, note) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.id = "tile-" + member.id;
  tile.innerHTML =
    `<div class="head"></div>` +
    `<div class="name">${member.name} · ${member.title}</div>` +
    `<div class="badge">…</div>`;
  document.getElementById("grid").appendChild(tile);

  const avatar = await resolveAvatar(member, note);
  const head = new TalkingHead(tile.querySelector(".head"), {
    ttsEndpoint: null,            // we drive audio ourselves via speakAudio()
    lipsyncModules: ["en"],
    cameraView: "upper",
    avatarMood: "neutral",
    modelPixelRatio: window.devicePixelRatio || 1,
  });
  await head.showAvatar({
    url: avatar.url, body: member.body, avatarMood: "neutral", lipsyncLang: "en",
  });

  // Morph targets are spread across several meshes (head, teeth, eyes), and
  // which mesh holds the visemes differs per exporter — reading only morphs[0]
  // reports 0 visemes for avatars that actually have all 15.
  const names = new Set();
  for (const m of head.morphs || []) {
    for (const k of Object.keys(m.morphTargetDictionary || {})) names.add(k);
  }
  const visemes = [...names].filter((k) => k.startsWith("viseme_"));
  tile.querySelector(".badge").textContent =
    `${member.body} · ${visemes.length} visemes · ${avatar.via}`;

  return { member, head, tile, avatar, visemes: visemes.length };
}

// Boot probe: proves the importmap resolved both libraries before any test runs.
console.log("[spike] boot ok - TalkingHead=" + typeof TalkingHead +
            " HeadTTS=" + typeof HeadTTS +
            " webgpu=" + ("gpu" in navigator) +
            " secureContext=" + window.isSecureContext);

const results = { 1: null, 2: null, 3: null };
let diagRan = false;
const panel = [];
let tts = null;

// --- tiny UI helpers ------------------------------------------------------
const card = (n) => document.getElementById("t" + n);
const setState = (n, s) => { card(n).querySelector(".dot").className = "dot " + s; };
const log = (n, msg, cls = "") => {
  const el = card(n).querySelector(".metrics");
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = msg + "\n";
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
};
const clear = (n) => { card(n).querySelector(".metrics").textContent = ""; };
const ms = (t) => Math.round(t) + "ms";

function verdict() {
  const done = Object.values(results).filter((r) => r !== null);
  if (!done.length) return;
  const passed = done.filter((r) => r === true).length;
  const el = document.getElementById("verdict");
  if (done.length === 3 && passed === 3) {
    el.innerHTML = "<b>Gate PASS.</b> Teeno capabilities kaam kar rahi hain — Phase 1 shuru kar sakte hain.";
  } else if (done.length === 3) {
    el.innerHTML = "<b>Gate FAIL.</b> " + passed + "/3 pass. Fail wale test ka fallback lagana padega.";
  } else {
    el.innerHTML = passed + "/" + done.length + " pass, " + (3 - done.length) + " baaki.";
  }
}

// --- Test 0: what can this machine actually reach? ------------------------
// "fetch failed" from Node tells you nothing. This asks the main process to hit
// every host the app depends on and report the real errno for each.
async function test0() {
  clear(0); setState(0, "run");
  try {
    const r = await fetch("/_diag");
    const report = await r.json();
    let bad = 0, flaky = 0;
    for (const [host, v] of Object.entries(report)) {
      if (v.ok && !v.flaky) {
        log(0, "OK    " + host + "  HTTP " + v.status + "  " + v.tries);
      } else if (v.ok) {
        flaky++;
        log(0, "FLAKY " + host + "  " + v.tries + " succeeded", "warn");
        log(0, "        " + (v.code || "") + " " + (v.detail || v.error), "warn");
      } else {
        bad++;
        log(0, "DOWN  " + host + "  " + v.tries, "err");
        log(0, "        " + (v.code || "") + " " + (v.detail || v.error), "err");
      }
    }
    if (flaky) {
      log(0, "");
      log(0, "FLAKY = kabhi chalta kabhi nahi. Download fail ho to dobara try karo.", "warn");
    }
    if (bad) {
      log(0, "");
      log(0, bad + " host(s) reachable nahi hain. Ye network/DNS/firewall ka issue hai,", "warn");
      log(0, "app ka nahi. Neeche wale tests inhi pe depend karte hain.", "warn");
    }
    setState(0, bad ? "fail" : "pass");
    diagRan = true;
  } catch (e) {
    log(0, "FAIL: " + e.message, "err");
    setState(0, "fail");
  }
}

// --- Test 1: the panel ----------------------------------------------------
async function test1() {
  clear(1); setState(1, "run");
  document.getElementById("grid").innerHTML = "";
  panel.length = 0;
  const t0 = performance.now();
  try {
    for (const member of PANEL) {
      try {
        const m = await mountMember(member, (t) => log(1, t, "warn"));
        panel.push(m);
        log(1, `${m.member.name.padEnd(15)} ${m.member.body}  ${m.avatar.source} ` +
               `(${m.visemes} visemes, via ${m.avatar.via})`,
            m.visemes >= 14 ? "" : "warn");
      } catch (e) {
        // Keep going: one broken avatar shouldn't hide the state of the others.
        log(1, `${member.name.padEnd(15)} FAILED - ${e.message}`, "err");
      }
    }
    if (!panel.length) throw new Error("Ek bhi avatar load nahi hua");
    log(1, `${panel.length} avatars loaded in ${ms(performance.now() - t0)}`);

    // The number that decides whether a 4-tile panel is affordable at all.
    let frames = 0;
    const stop = performance.now() + 3000;
    await new Promise((res) => {
      (function tick() {
        frames++;
        performance.now() < stop ? requestAnimationFrame(tick) : res();
      })();
    });
    const fps = frames / 3;
    log(1, `Sustained FPS with ${panel.length} avatars: ${fps.toFixed(1)}`,
        fps < 24 ? "warn" : "");
    if (fps < 24) log(1, "-> idle tiles ko throttle karna padega (planned).", "warn");

    const lipsyncable = panel.filter((m) => m.visemes >= 14);
    log(1, `Lip-sync capable: ${lipsyncable.length}/${panel.length}`,
        lipsyncable.length ? "" : "err");
    if (!lipsyncable.length) throw new Error("Kisi avatar me Oculus visemes nahi mile");

    setState(1, "pass"); results[1] = true;
    document.querySelector('[data-run="2"]').disabled = false;
  } catch (e) {
    log(1, "FAIL: " + e.message, "err");
    if (!diagRan) log(1, "-> Pehle Test 0 (network diagnostics) chalao.", "warn");
    console.error(e);
    setState(1, "fail"); results[1] = false;
  }
  verdict();
}

// --- Test 2: TTS + lip-sync ----------------------------------------------
//
// Also a benchmark.
//
// An earlier run appeared to show synthesis at 11-22x realtime, which would have
// made the panel unusable. That was a measurement bug (one t0 reused across
// sentence parts) plus warm-up being charged to the first sample. Real figures
// are 0.69-0.77x realtime, and pausing the renderers buys only 1.1x — the GPU
// contention theory was wrong, so idle-tile throttling is not needed.
//
// What remains worth measuring is quantisation: HeadTTS defaults to fp32 on
// WebGPU, and a narrower dtype may run meaningfully faster on integrated
// graphics for the same audio.

/** Synthesises one sentence and returns timing plus the audio payload. */
function synthOnce(text) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    tts.synthesize({ input: text }, (msg) => {
      const d = msg?.data;
      if (!d?.audio) return;
      resolve({ synth: performance.now() - t0, audio: d.audio.duration * 1000, data: d });
    }, reject);
  });
}

const rtf = (r) => r.synth / r.audio;

async function test2() {
  clear(2); setState(2, "run");
  try {
    tts = new HeadTTS({
      endpoints: ["webgpu", "wasm"],
      transformersModule: "/vendor/transformers.local.js",
      dictionaryURL: NM + "/@met4citizen/headtts/dictionaries",
      audioCtx: panel[0]?.head.audioCtx,
      voices: [...new Set(PANEL.map((p) => p.voice))],
      defaultVoice: PANEL[0].voice,
      defaultLanguage: "en-us",
      defaultAudioEncoding: "wav",
      // One sentence per request keeps the timing unambiguous.
      splitSentences: false,
    });

    // Pre-flight: a missing local file is not fatal any more (the wrapper falls
    // back to huggingface.co), but it turns a 3-second start into a 2-minute one,
    // and that is worth naming rather than leaving the user to wonder.
    const NEEDED = [
      "/models/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/config.json",
      "/models/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/tokenizer.json",
      "/models/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/onnx/model.onnx",
      ...[...new Set(PANEL.map((p) => p.voice))].map((v) => `/models/voices/${v}.bin`),
    ];
    const absent = [];
    for (const f of NEEDED) {
      const r = await fetch(f, { method: "HEAD" }).catch(() => null);
      if (!r?.ok) absent.push(f.replace("/models/", ""));
    }
    if (absent.length) {
      log(2, `${absent.length} model file disk pe nahi hai — network se aayegi (slow):`, "warn");
      for (const f of absent) log(2, "  " + f, "warn");
      log(2, "  Fix: npm run fetch-models", "warn");
    } else {
      log(2, "Saare model files disk pe hain — offline load.");
    }

    log(2, "Connecting...");
    const tc = performance.now();
    await tts.connect(null, (ev) => {
      if (ev.lengthComputable && ev.total) {
        log(2, "  " + Math.round((ev.loaded / ev.total) * 100) + "%");
      }
    });
    const connectMs = performance.now() - tc;
    log(2, "Connected in " + ms(connectMs), connectMs > 15000 ? "warn" : "");

    const speakers = panel.filter((m) => m.visemes >= 14);
    if (!speakers.length) throw new Error("Kisi avatar me visemes nahi");

    // Warm-up: the first inference of a session pays for graph compilation and
    // would otherwise be charged to whichever condition ran first.
    await tts.setup({ voice: speakers[0].member.voice, language: "en-us", audioEncoding: "wav" });
    const warm = await synthOnce("Let us begin.");
    log(2, `warm-up  synth ${ms(warm.synth)} / audio ${ms(warm.audio)} -> RTF ${rtf(warm).toFixed(2)}`);

    const LINE = "So, tell me about the project at the top of your resume.";

    // Condition A: every avatar animating, as the panel normally runs.
    await tts.setup({ voice: speakers[0].member.voice, language: "en-us", audioEncoding: "wav" });
    const busy = await synthOnce(LINE);
    log(2, `4 avatars animating   RTF ${rtf(busy).toFixed(2)}  (${ms(busy.synth)} / ${ms(busy.audio)})`,
        rtf(busy) > 1 ? "warn" : "");

    // Condition B: idle renderers paused, GPU left to the inference.
    panel.forEach((m) => m.head.stop());
    const idle = await synthOnce(LINE);
    panel.forEach((m) => m.head.start());
    log(2, `renderers paused      RTF ${rtf(idle).toFixed(2)}  (${ms(idle.synth)} / ${ms(idle.audio)})`,
        rtf(idle) > 1 ? "warn" : "");

    const speedup = busy.synth / idle.synth;
    log(2, `-> pausing renderers is ${speedup.toFixed(1)}x faster`,
        speedup > 1.5 ? "warn" : "");
    if (speedup > 1.5) {
      log(2, "   GPU contention confirmed: idle tiles ko throttle karna hoga.", "warn");
    }

    // Startup, not throughput, is now the open question: connect() takes ~86 s
    // even though every file loads from disk in milliseconds, so the cost is
    // building the WebGPU session for a 310 MB fp32 graph. Shader compilation on
    // integrated graphics is expensive; 12 CPU cores may well beat it. Measured
    // rather than assumed, because the last two guesses here were both wrong.
    log(2, "");
    log(2, "backend startup comparison:");
    log(2, `  webgpu  connect ${ms(connectMs)}  RTF ${rtf(busy).toFixed(2)}`);

    try {
      const t = new HeadTTS({
        endpoints: ["wasm"],                 // force CPU
        transformersModule: "/vendor/transformers.local.js",
        dictionaryURL: NM + "/@met4citizen/headtts/dictionaries",
        audioCtx: panel[0]?.head.audioCtx,
        voices: [speakers[0].member.voice],
        defaultVoice: speakers[0].member.voice,
        defaultLanguage: "en-us",
        defaultAudioEncoding: "wav",
        splitSentences: false,
        voiceURL: "/models/voices",
      });
      const tw = performance.now();
      await t.connect();
      const wasmConnect = performance.now() - tw;
      await t.setup({ voice: speakers[0].member.voice, language: "en-us", audioEncoding: "wav" });

      const prev = tts;
      tts = t;
      await synthOnce("Warm up.");           // discard graph-build cost
      const r = await synthOnce(LINE);
      tts = prev;

      log(2, `  wasm    connect ${ms(wasmConnect)}  RTF ${rtf(r).toFixed(2)}`);
      const faster = connectMs / wasmConnect;
      log(2, faster > 1.3
        ? `  -> wasm ${faster.toFixed(1)}x faster to start (RTF ${(rtf(r) / rtf(busy)).toFixed(1)}x)`
        : `  -> webgpu start is fine, keep it`,
        faster > 1.3 ? "warn" : "");
    } catch (e) {
      log(2, "  wasm nahi chala: " + (e.message || e).slice(0, 80), "warn");
    }

    // Now let each panelist speak in their own voice, so a mismatch between face
    // and voice is immediately audible.
    log(2, "");
    for (const m of speakers) {
      await tts.setup({ voice: m.member.voice, language: "en-us", audioEncoding: "wav" });
      const line = m.member.body === "M"
        ? "So, what did you actually build in that project?"
        : "Okay. And what would you change if you had to do it again?";
      const r = await synthOnce(line);
      log(2, `${m.member.name.padEnd(15)} ${m.member.body} ${m.member.voice}  RTF ${rtf(r).toFixed(2)}`);

      const d = r.data;
      if (!d.visemes?.length) throw new Error(`${m.member.name}: visemes nahi mile`);
      m.tile.classList.add("speaking");
      m.head.speakAudio({
        audio: d.audio,
        words: d.words, wtimes: d.wtimes, wdurations: d.wdurations,
        visemes: d.visemes, vtimes: d.vtimes, vdurations: d.vdurations,
      });
      await new Promise((r2) => setTimeout(r2, r.audio + 500));
      m.tile.classList.remove("speaking");
    }

    setState(2, "pass"); results[2] = true;
  } catch (e) {
    log(2, "FAIL: " + e.message, "err");
    console.error(e);
    setState(2, "fail"); results[2] = false;
  }
  verdict();
}

// --- Test 3: Whisper ------------------------------------------------------
async function test3() {
  clear(3); setState(3, "run");
  let worker = null;
  try {
    log(3, "Mic maang rahe hain...");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    log(3, "Mic mil gaya. Whisper worker boot ho raha hai...");

    worker = new Worker("/spike/whisper.worker.js", { type: "module" });
    const call = (msg, transfer = []) =>
      new Promise((res, rej) => {
        worker.onmessage = (e) => (e.data.ok ? res(e.data) : rej(new Error(e.data.error)));
        // A module-load failure inside a worker surfaces here with an empty
        // message, so stitch together whatever the event does carry.
        worker.onerror = (e) => {
          e.preventDefault?.();
          const where = e.filename ? ` at ${e.filename}:${e.lineno}` : "";
          rej(new Error((e.message || "worker failed to start") + where));
        };
        worker.onmessageerror = () => rej(new Error("worker message could not be deserialised"));
        worker.postMessage(msg, transfer);
      });

    const modelChoice = document.getElementById("sttModel").value;
    const myName = document.getElementById("sttName").value.trim();

    const tl = performance.now();
    const loaded = await call({ type: "load", model: modelChoice });
    log(3, "Model \"" + loaded.model + "\" ready in " + ms(performance.now() - tl) +
           " on " + loaded.device, loaded.device === "wasm" ? "warn" : "");

    // Record 6s of mono 16k audio.
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc); proc.connect(ctx.destination);

    log(3, "MIC ON - ABHI BOLO, 6 seconds (English me, jaise interview me bologe)");
    for (let s = 6; s > 0; s--) {
      await new Promise((r) => setTimeout(r, 1000));
      log(3, "  " + (s - 1) + "...");
    }

    proc.disconnect(); src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { pcm.set(c, off); off += c.length; }
    const audioSec = total / 16000;
    log(3, "Captured " + audioSec.toFixed(1) + "s (" + total + " samples). Transcribing...");

    const t0 = performance.now();
    const out = await call(
      { type: "transcribe", pcm, model: modelChoice, beams: 2 },
      [pcm.buffer]
    );
    const took = performance.now() - t0;

    log(3, "Transcribed in " + ms(took) + " -> RTF " + (took / 1000 / audioSec).toFixed(2),
        took / 1000 / audioSec > 1 ? "warn" : "");
    const raw = (out.text || "").trim();
    log(3, "RAW : \"" + raw + "\"");
    if (!raw) throw new Error("Khaali transcript - mic ya model issue");

    // Whisper mangles Indian proper nouns. We know the name up front, so it gets
    // repaired deterministically rather than hoping a bigger model gets it right.
    if (myName) {
      const fixed = correctTranscript(raw, [myName]);
      if (fixed.fixes.length) {
        log(3, "FIXED: \"" + fixed.text + "\"");
        for (const f of fixed.fixes) {
          log(3, `       "${f.from}" -> "${f.to}" (${f.via})`);
        }
      } else if (raw.toLowerCase().includes(myName.toLowerCase())) {
        log(3, "Naam pehli baar me hi sahi aaya.");
      } else {
        log(3, "Naam transcript me nahi mila (shayad bola hi nahi).", "warn");
      }
    }

    setState(3, "pass"); results[3] = true;
  } catch (e) {
    log(3, "FAIL: " + e.message, "err");
    if (!diagRan) log(3, "-> Pehle Test 0 (network diagnostics) chalao.", "warn");
    console.error(e);
    setState(3, "fail"); results[3] = false;
  } finally {
    worker?.terminate();
  }
  verdict();
}

const tests = { 0: test0, 1: test1, 2: test2, 3: test3 };
document.querySelectorAll("[data-run]").forEach((b) => {
  b.addEventListener("click", async () => {
    b.disabled = true;
    await tests[b.dataset.run]();
    b.disabled = false;
  });
});

// --autorun runs the two unattended tests back to back. Test 3 still needs a
// human to speak into the mic, so it stays manual.
if (new URLSearchParams(location.search).has("autorun")) {
  (async () => {
    await test1();
    if (results[1]) await test2();
    console.log("[spike] autorun done: t1=" + results[1] + " t2=" + results[2]);
  })();
}
