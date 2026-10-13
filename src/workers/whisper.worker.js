// Whisper STT in a worker. Electron's webkitSpeechRecognition is a no-op (the
// Google Speech key only ships in real Chrome builds), so this is the only way
// to get speech-to-text in the app at all.
//
// Two things make this work inside a Worker:
//   1. We import the *bundled* transformers (npm run build:vendor). Import maps
//      apply to the document only, so the library's bare "onnxruntime-web/webgpu"
//      import cannot resolve in a worker; bundling removes every bare specifier.
//   2. The import is dynamic. A static top-level import that fails kills the
//      worker before any of our code runs, and the main thread sees only a blank
//      "worker failed to start" with no reason attached.

const TRANSFORMERS = "/vendor/transformers.local.js";
// base.en is fast but mangles Indian proper nouns ("Alok Madheshiya" ->
// "Alupadisha"). small.en is ~3x the weights and markedly better on names and
// accented English; the spike measures both so the choice is made on data.
// Per-model quantisation. small.en's q4 decoder is broken in the published ONNX
// export - it dies with "TransposeDQWeightsForMatMulNBits Missing required
// scale: model.decoder.embed_tokens.weight_merged_0_scale" - so it gets q8.
//
// `multi` is the multilingual build of the same base model, and it is the only
// one that can hear Hindi at all — the .en models will map Hindi sounds onto
// whatever English words come closest. It is not mirrored into models/ by
// `npm run fetch-models`, because it is only needed if someone picks Hindi in
// Talk mode; it downloads on that first use.
const MODELS = {
  base: {
    id: "onnx-community/whisper-base.en",
    dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
  },
  small: {
    id: "onnx-community/whisper-small.en",
    dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
  },
  // small rather than base: base's multilingual Hindi is poor enough that the
  // candidate's answers came back as nonsense, which is the whole complaint
  // this model exists to answer. It is ~3x the weights and slower per second
  // of audio, and worth both in a conversation.
  multi: {
    id: "onnx-community/whisper-small",
    dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
  },
};
let MODEL = MODELS.base.id;

const pipes = new Map();   // model id -> loaded pipeline
let device = null;
let tf = null;

// Anything thrown outside a message handler would otherwise vanish silently.
self.addEventListener("unhandledrejection", (e) => {
  self.postMessage({ ok: false, error: "unhandled: " + (e.reason?.message || e.reason) });
});
self.addEventListener("error", (e) => {
  self.postMessage({ ok: false, error: "worker error: " + (e.message || "unknown") });
});

async function loadLib() {
  if (tf) return tf;
  try {
    tf = await import(TRANSFORMERS);
  } catch (e) {
    throw new Error("transformers.js failed to load (" + TRANSFORMERS + "): " + e.message);
  }
  // allowLocalModels / localModelPath are already set by transformers.local.js.
  // onnxruntime otherwise pulls its .wasm from a jsdelivr CDN at runtime. Serving
  // the copies next to the bundle keeps the whole thing local and offline-able.
  try {
    tf.env.backends.onnx.wasm.wasmPaths = "/vendor/ort/";
  } catch {
    /* older layout - the CDN default still works */
  }
  return tf;
}

async function load(which = "base") {
  const spec = MODELS[which] || MODELS.base;
  MODEL = spec.id;
  if (pipes.has(MODEL)) return { model: MODEL, device };
  const { pipeline } = await loadLib();

  // Try each backend, and if the model's preferred quantisation fails to build a
  // session, drop to a safer one rather than giving up. HuggingFace is flaky on
  // this network, so a "Failed to fetch" here is often worth one more attempt.
  const attempts = [
    { device: "webgpu", dtype: spec.dtype },
    { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "fp32" } },
    { device: "wasm", dtype: spec.dtype },
    { device: "wasm", dtype: undefined },
  ];

  const errors = [];
  for (const a of attempts) {
    try {
      const asr = await pipeline("automatic-speech-recognition", MODEL, {
        device: a.device,
        ...(a.dtype ? { dtype: a.dtype } : {}),
      });
      device = a.device;
      pipes.set(MODEL, asr);
      return { model: MODEL, device };
    } catch (e) {
      const dt = a.dtype ? Object.values(a.dtype).join("/") : "default";
      errors.push(`${a.device}(${dt}): ${e?.message?.slice(0, 90)}`);
      console.warn(`[whisper] ${a.device}/${dt} failed:`, e?.message);
    }
  }
  throw new Error(["Model load fail:", ...errors].join(" | "));
}

self.onmessage = async (e) => {
  const { type } = e.data;
  try {
    if (type === "load") {
      self.postMessage({ ok: true, id: e.data.id, ...(await load(e.data.model)) });
    } else if (type === "transcribe") {
      const info = await load(e.data.model);
      const asr = pipes.get(info.model);
      const out = await asr(e.data.pcm, {
        chunk_length_s: 30,
        stride_length_s: 5,
        // A little beam search buys real accuracy on proper nouns for a small
        // amount of extra compute — worth it when names matter.
        num_beams: e.data.beams ?? 1,
        // Only the multilingual model accepts these; an .en model has no
        // language tokens and throws if you hand it one.
        ...(e.data.language ? { language: e.data.language, task: "transcribe" } : {}),
      });
      self.postMessage({ ok: true, id: e.data.id, text: out?.text ?? "", model: info.model });
    } else {
      self.postMessage({ ok: false, id: e.data.id, error: "unknown message type: " + type });
    }
  } catch (err) {
    self.postMessage({ ok: false, id: e.data.id, error: err?.message || String(err) });
  }
};
