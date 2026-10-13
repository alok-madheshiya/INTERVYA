// Config and session history on disk, plus the API key.
//
// One key is live at a time — whichever was pasted last — and `activeProvider`
// says whose it is. Earlier keys are kept rather than overwritten, so pasting
// last week's Gemini key back in does not mean fetching it again from Google.
//
// The key is encrypted with Electron's safeStorage (DPAPI on Windows) and only
// ever decrypted inside the main process — the renderer can ask "is a key set?"
// but can never read it, so a bug or an injected script in the page cannot leak
// it. Everything else is plain JSON, because it is not secret and being able to
// open the file and read it is worth more than obscurity.
const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");
const providers = require("./providers.cjs");

let FILE = null;
let cache = null;

const DEFAULTS = {
  version: 1,
  candidate: { name: "", resume_text: "" },
  interview: { companyId: "tcs", role: "", roundId: null, difficulty: null },
  stt: { model: "base" },
  tts: { provider: "kokoro", elevenLabsKey: null },
  window: { zoom: 0 },   // Ctrl +/- level, so the size survives a restart
  sessions: [],          // finished interviews, newest first
  geminiKeyEnc: null,    // base64 of the safeStorage blob — Gemini, kept for
                         // config files written before other providers existed
  providerKeysEnc: {},   // provider id -> base64 safeStorage blob
  activeProvider: null,  // whose key the app is currently running on
  providerInfo: {},      // provider id -> what detect.cjs worked out about it
};

/**
 * Providers the app can talk to. The list itself lives in providers.cjs,
 * which is also what the key-detection walk reads.
 */
const PROVIDERS = providers.IDS;

function file() {
  if (!FILE) FILE = path.join(app.getPath("userData"), "config.json");
  return FILE;
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    cache = { ...DEFAULTS, ...raw };
  } catch {
    cache = { ...DEFAULTS };
  }
  cache.providerKeysEnc = { ...(cache.providerKeysEnc ?? {}) };
  cache.providerInfo = { ...(cache.providerInfo ?? {}) };
  // A config written before this file knew about more than one provider. The
  // key is moved rather than copied on write, but read tolerates either — a
  // half-migrated file must not lose somebody's key.
  if (cache.geminiKeyEnc && !cache.providerKeysEnc.gemini) {
    cache.providerKeysEnc.gemini = cache.geminiKeyEnc;
  }
  // A config written before a key could belong to anyone but Google. Whatever
  // key is in there is the one the app has been running on.
  if (!cache.activeProvider) {
    cache.activeProvider =
      Object.keys(cache.providerKeysEnc).find((id) => PROVIDERS.includes(id)) ?? null;
  }
  return cache;
}

function save() {
  const tmp = file() + ".tmp";
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  // Write-then-rename: a crash mid-write would otherwise leave a truncated
  // config that throws on next launch and loses every past session.
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, file());
}

/** Config with the encrypted key stripped — safe to hand the renderer. */
function publicConfig() {
  const { geminiKeyEnc, providerKeysEnc, tts, ...rest } = load();
  // Which providers have a key, never the keys themselves.
  const hasKey = {};
  for (const id of PROVIDERS) hasKey[id] = !!providerKeysEnc[id];
  const active = rest.activeProvider;
  return {
    ...rest,
    tts: { ...tts, elevenLabsKey: undefined, hasElevenLabsKey: !!tts.elevenLabsKey },
    hasGeminiKey: hasKey.gemini,
    hasKey,
    // Whether there is a key at all, whoever it belongs to — this is what the
    // setup screen gates "Join" on now, rather than Gemini specifically.
    hasAnyKey: PROVIDERS.some((id) => hasKey[id]),
    // What the screen says out loud: "running on Groq (llama-3.1-8b-instant)".
    // The name is filled in from the registry as well as from providerInfo,
    // because a config migrated from the Gemini-only days has a key and no
    // notes about it, and "Using gemini" reads like a bug.
    active: active && hasKey[active]
      ? {
        id: active,
        name: providers.byId(active)?.name ?? active,
        ...(rest.providerInfo[active] ?? {}),
      }
      : null,
    providers: PROVIDERS,
    // id -> display name, so the renderer can label a provider it has no
    // detection notes for.
    providerNames: Object.fromEntries(providers.PROVIDERS.map((p) => [p.id, p.name])),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
}

/** Shallow-merges a patch into config. Never accepts key fields. */
function update(patch) {
  const c = load();
  for (const [k, v] of Object.entries(patch)) {
    // Own setters. A patch must never be able to write a key field, whatever
    // the renderer sends.
    if (k === "geminiKeyEnc" || k === "providerKeysEnc" || k === "sessions" ||
        k === "providerInfo" || k === "activeProvider") continue;
    c[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...c[k], ...v } : v;
  }
  save();
  return publicConfig();
}

/**
 * Saves one provider's key, and makes it the one the app runs on.
 *
 * `info` is what detect.cjs worked out — the provider's name and the model
 * chain this key can actually reach. It is stored next to the key rather than
 * recomputed at launch, because it costs an HTTP round trip and does not
 * change between one interview and the next.
 */
function setProviderKey(id, key, info) {
  if (!PROVIDERS.includes(id)) throw new Error(`Unknown provider: ${id}`);
  const c = load();
  if (!key) {
    delete c.providerKeysEnc[id];
    delete c.providerInfo[id];
    if (c.activeProvider === id) {
      // Fall back to any other key on the machine rather than leaving the app
      // pointed at a provider it can no longer reach.
      c.activeProvider = Object.keys(c.providerKeysEnc)[0] ?? null;
    }
  } else if (safeStorage.isEncryptionAvailable()) {
    c.providerKeysEnc[id] = safeStorage.encryptString(key).toString("base64");
  } else {
    // No OS keystore (rare on Windows, common on bare Linux). Refuse rather than
    // silently writing the key in clear text where the user expects encryption.
    throw new Error("Encrypted storage is not available on this machine — the key cannot be saved.");
  }
  if (key) {
    if (info) c.providerInfo[id] = info;
    c.activeProvider = id;
  }
  // The old single-key field is where a pre-existing config keeps Gemini's key.
  // Kept in step so that downgrading, or a second copy of the app reading the
  // same file, does not appear to have lost it.
  if (id === "gemini") c.geminiKeyEnc = c.providerKeysEnc.gemini ?? null;
  save();
  return publicConfig();
}

/** Switches between keys already on the machine. No network, no re-checking. */
function setActiveProvider(id) {
  const c = load();
  if (id !== null && !c.providerKeysEnc[id]) {
    throw new Error(`No key is saved for ${id}.`);
  }
  c.activeProvider = id;
  save();
  return publicConfig();
}

/**
 * The provider the app is running on, with its key. Main process only.
 *
 * Returns null rather than throwing when there is no key: the callers all have
 * something better to say about that than this file does.
 */
function getActive() {
  const c = load();
  const id = c.activeProvider;
  if (!id) return null;
  const key = getProviderKey(id);
  if (!key) return null;
  return { id, key, spec: providers.byId(id), info: c.providerInfo[id] ?? {} };
}

/** Main-process only. Never expose this over IPC. */
function getProviderKey(id) {
  const enc = load().providerKeysEnc[id];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    // Happens if the OS user profile changed; treat as "no key" so the app
    // prompts again instead of failing every request with a confusing error.
    return null;
  }
}

const setGeminiKey = (key) => setProviderKey("gemini", key);
const getGeminiKey = () => getProviderKey("gemini");

function addSession(session) {
  const c = load();
  c.sessions.unshift({ ...session, savedAt: new Date().toISOString() });
  c.sessions = c.sessions.slice(0, 100);
  save();
  return c.sessions.length;
}

const listSessions = () =>
  load().sessions.map(({ report, ...meta }) => ({ ...meta, hasReport: !!report }));

const getSession = (id) => load().sessions.find((s) => s.id === id) ?? null;

module.exports = {
  publicConfig, update, setGeminiKey, getGeminiKey,
  setProviderKey, getProviderKey, setActiveProvider, getActive, PROVIDERS,
  addSession, listSessions, getSession, DEFAULTS,
};
