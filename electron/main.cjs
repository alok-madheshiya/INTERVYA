// --- started as plain Node? relaunch as a real Electron app ---------------
// electron.exe checks ELECTRON_RUN_AS_NODE at startup and, if it is set, boots
// as a bare Node runtime: no browser, no windows, and require("electron")
// returns the path to the binary instead of the API. That variable is set
// system-wide on this machine, so anything that launches electron.exe directly
// — a desktop shortcut, Explorer, another tool — inherits it and the app dies
// on the first app.* call.
//
// Rather than making every launcher remember to clear it, fix it here once:
// re-exec ourselves with the variable removed. Deleting beats blanking, because
// Electron tests whether the variable exists, not what it contains.
const electronApi = require("electron");
if (typeof electronApi === "string") {
  const { spawnSync } = require("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const appDir = require("node:path").join(__dirname, "..");
  const r = spawnSync(electronApi, [appDir, ...process.argv.slice(2)], {
    env,
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

const { app, BrowserWindow, Menu, session, ipcMain, shell, dialog } = electronApi;
const path = require("node:path");
const fsp = require("node:fs/promises");
const { startServer } = require("./server.cjs");
const store = require("./services/store.cjs");
const gemini = require("./services/gemini.cjs");
const llm = require("./services/llm.cjs");
const detect = require("./services/detect.cjs");
const report = require("./services/report.cjs");
const resume = require("./services/resume.cjs");
const zoom = require("./services/zoom.cjs");

const here = __dirname;
const ROOT = path.join(here, "..");

// --- GPU / WebGPU ---------------------------------------------------------
// Kokoro TTS and Whisper both want WebGPU. On Intel Iris Xe this needs the
// unsafe-webgpu switch plus Vulkan; without them onnxruntime silently falls
// back to WASM, which is ~4x slower.
app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.commandLine.appendSwitch("enable-features", "Vulkan,WebGPU");
// Avoids audio glitches when several AudioContexts run at once.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// Launched from the shortcut there is no console, so a main-process crash would
// otherwise be a window that never appears and no explanation anywhere. Write it
// down and say so, instead of vanishing.
const CRASH_LOG = () => path.join(app.getPath("userData"), "crash.log");

function reportCrash(where, err) {
  const text = `[${new Date().toISOString()}] ${where}
${err?.stack || err}

`;
  console.error(text);
  try {
    require("node:fs").appendFileSync(CRASH_LOG(), text);
  } catch { /* nothing useful to do if even the log fails */ }
  if (app.isReady()) {
    dialog.showErrorBox("Intervya has crashed", `${err?.message || err}

${CRASH_LOG()}`);
  }
}

process.on("uncaughtException", (err) => reportCrash("uncaughtException", err));
process.on("unhandledRejection", (err) => reportCrash("unhandledRejection", err));

/**
 * Notices when the interface loads but never actually starts.
 *
 * This exists because of a real failure that took a whole build cycle to find.
 * The installer shipped without three's addons (see scripts/onNodeModuleFile.cjs),
 * so one module in the graph 404'd and *no* renderer JavaScript ran. The intro
 * splash is plain HTML and CSS, so it drew itself anyway and sat there frozen —
 * no error dialog, no log, not even the click-to-skip handler, because that is
 * installed by the script that never ran. On this machine it was findable. On a
 * friend's laptop it would have been "it doesn't work" and nothing more.
 *
 * `did-finish-load` fires for a page whose scripts all failed, so it proves
 * nothing on its own. Only the renderer can say it got as far as drawing a
 * screen, and this waits for it to say so.
 */
function watchForBoot(win) {
  setTimeout(() => {
    if (booted || win.isDestroyed()) return;
    reportCrash("renderer never finished booting", new Error(
      "The window opened but the interface never started. This usually means a " +
      "file is missing or damaged in the installation — reinstalling should fix it."
    ));
  }, 40000);
}

const isSpike = !app.isPackaged && process.argv.includes("--spike");
const isAutorun = process.argv.includes("--autorun");

/**
 * Whether the developer-facing hatches are open at all.
 *
 * All of them — DevTools, the request log, the Phase 0 spike screen — are
 * useful here and are somebody else's way in on a machine that is not mine.
 * A packaged copy is by definition on someone else's laptop, so the switch is
 * `app.isPackaged` rather than an environment variable: an environment
 * variable is exactly the thing being defended against.
 */
const DEV = !app.isPackaged;


let ORIGIN = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#101014",
    show: false,
    autoHideMenuBar: true,
    title: isSpike ? "Intervya — Phase 0 Spike" : "Intervya",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require() for the services bridge
      webgl: true,
    },
  });

  // Opens maximised. The setup form is five cards deep and the call screen puts
  // four avatars in a grid — both are cramped at the restore size, which is
  // kept only so that un-maximising lands somewhere sensible.
  win.once("ready-to-show", () => {
    win.maximize();
    win.show();
  });

  // Ctrl +/-/0 resize the whole interface. The mapping lives in zoom.cjs so it
  // can be tested against real key events; see the note there about why this
  // is not left to Chromium's own accelerators.
  const setZoom = (level) => {
    win.webContents.setZoomLevel(level);
    store.update({ window: { zoom: level } });
  };

  win.webContents.on("before-input-event", (event, input) => {
    const next = zoom.zoomFor(input, win.webContents.getZoomLevel());
    if (next === null) return;
    setZoom(next);
    event.preventDefault();
  });

  // Ctrl+wheel, the other half of what people expect from a zoom control.
  win.webContents.on("zoom-changed", (_e, direction) => {
    setZoom(zoom.zoomForWheel(direction, win.webContents.getZoomLevel()));
  });

  // Restore the last size on load, not on create: a zoom level set before the
  // page exists is discarded when the first navigation commits.
  win.webContents.on("did-finish-load", () => {
    const saved = Number(store.publicConfig().window?.zoom ?? 0);
    if (saved) win.webContents.setZoomLevel(saved);
    watchForBoot(win);
  });

  // External links open in the real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL(
    isSpike
      ? `${ORIGIN}/spike/index.html` + (isAutorun ? "?autorun" : "")
      : `${ORIGIN}/src/index.html`
  );

  if (DEV && (isSpike || process.env.INTERVIEW_DEVTOOLS)) {
    win.webContents.openDevTools({ mode: "right" });
    // Mirror renderer console into the terminal so a headless spike run is
    // still readable without clicking through DevTools.
    win.webContents.on("console-message", (e) => {
      const level = ["log", "warn", "error"][e.level] || "log";
      console.log(`[renderer:${level}] ${e.message}`);
    });
    win.webContents.on("did-fail-load", (_e, code, desc, url) => {
      console.error(`[load-fail] ${code} ${desc} ${url}`);
    });
  }
  return win;
}

app.whenReady().then(async () => {
  const server = await startServer({
    root: ROOT,
    cacheDir: path.join(app.getPath("userData"), "asset-cache"),
    // Spike runs always log, so a missing model file is visible immediately.
    logRequests: DEV && (isSpike || !!process.env.INTERVIEW_LOG_REQUESTS),
  });
  ORIGIN = server.origin;
  console.log(`[server] ${ORIGIN}`);


  // Mic + camera must be granted without a prompt or the interview stalls
  // at the lobby. Everything else is denied.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "media" || permission === "audioCapture" || permission === "videoCapture");
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    permission === "media" || permission === "audioCapture" || permission === "videoCapture"
  );

  // Edit-only menu in a packaged build. Not `setApplicationMenu(null)`:
  // Electron's default menu is also where "Toggle Developer Tools" and its
  // Ctrl+Shift+I accelerator live, but stripping the menu outright is the kind
  // of tidying that quietly breaks Ctrl+V — and the two things a first-time
  // user pastes here are their API key and their resume. Keep the edit roles,
  // drop everything else, and hide the bar.
  if (!DEV) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }]));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Renderer asks for absolute paths into node_modules / assets so it can build
// import URLs that work in both dev and a packaged asar.
// --- IPC ------------------------------------------------------------------
// The renderer never sees the API key. It asks for a turn, and the main
// process supplies the key on its way to whichever API it belongs to.
const withActive = (fn) => async (...args) => {
  const active = store.getActive();
  if (!active) throw new Error("No API key is set. Add one in the setup screen.");
  return fn(active, ...args);
};

/**
 * Every provider key the machine has, decrypted here and nowhere else, plus
 * which one is live and what each was found to be able to reach.
 *
 * Built fresh per request rather than cached: a key added mid-session should
 * take effect on the next turn, not on the next launch.
 */
function providerKeys() {
  const keys = {};
  for (const id of store.PROVIDERS) {
    const k = store.getProviderKey(id);
    if (k) keys[id] = k;
  }
  const cfg = store.publicConfig();
  return { keys, active: cfg.activeProvider, info: cfg.providerInfo ?? {} };
}

// Sent once by the renderer when it has data on screen. See watchForBoot.
let booted = false;
ipcMain.on("app:booted", () => { booted = true; });

ipcMain.handle("config:get", () => store.publicConfig());
ipcMain.handle("config:set", (_e, patch) => store.update(patch));
ipcMain.handle("config:setGeminiKey", (_e, key) => store.setGeminiKey(key));
ipcMain.handle("config:setProviderKey", (_e, { provider, key }) =>
  store.setProviderKey(provider, key));
// Verified against the provider the key is for: checking a key against the
// wrong provider's endpoint reports it as invalid, which is the least useful
// thing you can tell somebody about a key that works.
ipcMain.handle("config:verifyProviderKey", async (_e, { provider, key }) => {
  if (!key) throw new Error("No key given.");
  return llm.verifyKey(provider, key);
});

/**
 * The whole of what the setup screen does with a key now: work out whose it is,
 * find out which models it can reach, prove it generates, and save it.
 *
 * One call rather than detect-then-save, so that a key is never left half
 * accepted — recognised on screen but not on disk, or the other way round.
 */
ipcMain.handle("config:saveKey", async (event, { key }) => {
  const wc = event.sender;
  const found = await detect.detect(key, {
    onStatus: (text) => { if (!wc?.isDestroyed()) wc.send("key:status", { text }); },
  });
  const { provider, ...info } = found;
  return { detected: found, config: store.setProviderKey(provider, key, info) };
});

ipcMain.handle("config:setActiveProvider", (_e, provider) => store.setActiveProvider(provider));
ipcMain.handle("config:forgetProvider", (_e, provider) => store.setProviderKey(provider, null));

ipcMain.handle("config:verifyKey", withActive(({ id, key }) => llm.verifyKey(id, key)));
// Gemini is the only provider whose listing this is wired to, and the only one
// where it is interesting: the others' listings were already read when the key
// was saved, and live in config under providerInfo.
ipcMain.handle("config:listModels", withActive(({ id, key }) =>
  id === "gemini" ? gemini.listModels(key) : []));

ipcMain.handle("sessions:list", () => store.listSessions());
ipcMain.handle("sessions:get", (_e, id) => store.getSession(id));
ipcMain.handle("sessions:add", (_e, s) => store.addSession(s));

// One panel turn. Spoken text is streamed back as it arrives so the renderer can
// start speaking the first sentence before the model has finished the rest.
ipcMain.handle("turn:run", async (event, payload) => {
  const { keys, active, info } = providerKeys();
  const { session, answerText, turnId } = payload;
  const wc = event.sender;
  return llm.runTurn({
    keys, active, info,
    session,
    answerText,
    onText: (chunk) => {
      if (!wc?.isDestroyed()) wc.send("turn:chunk", { turnId, chunk });
    },
    // Why the panel has gone quiet — a silent wait is indistinguishable from a
    // hang, and Gemini's 503s are common enough to need saying out loud.
    onStatus: (text) => {
      if (!wc?.isDestroyed()) wc.send("turn:status", { turnId, text });
    },
  });
});

// Talk mode. Same key, same retry ladder, different prompt: one character and a
// conversation instead of a panel and a scoreboard.
ipcMain.handle("chat:run", async (event, { chat, userText, turnId }) => {
  const wc = event.sender;
  return llm.runChat({
    ...providerKeys(),
    chat,
    userText,
    onText: (chunk) => { if (!wc?.isDestroyed()) wc.send("turn:chunk", { turnId, chunk }); },
    onStatus: (text) => { if (!wc?.isDestroyed()) wc.send("turn:status", { turnId, text }); },
  });
});

// The report is one long call at the end — no streaming, and the only place in
// the app where thinking budget is worth the seconds.
ipcMain.handle("report:generate", async (event, { session }) => {
  const { keys, active, info } = providerKeys();
  if (!Object.keys(keys).length) throw new Error("No API key is set.");
  const wc = event.sender;
  return report.generate({
    keys, active, info,
    session,
    onStatus: (text) => { if (!wc?.isDestroyed()) wc.send("report:status", { text }); },
  });
});

// Report -> PDF. Chromium's own print engine does the rendering, so the PDF
// matches what the candidate saw, and the @media print block in index.html
// flips the palette to light — a dark UI printed as-is is a page of black ink.
// That block also disables every animation: the report's cards fade in from
// opacity 0, and printToPDF captures the page before any of them have started,
// which is why the PDF used to come out with the headline and nothing else.
//
// printToPDF needs a real window, so a hidden one is loaded from a temp file
// (a data: URL cannot hold a long report).

/**
 * The hidden window the report is printed from — created once and kept.
 *
 * Creating one per export and destroying it afterwards wedged the main process
 * on the second export: the first PDF came out, and the next call's loadFile
 * never settled, in either direction, leaving the button on "Making the PDF…"
 * for good. Reusing one window survives four exports in a row (measured), and
 * a hidden, scriptless window is cheap enough to hold on to.
 */
let printer = null;

function printerWindow() {
  if (printer && !printer.isDestroyed()) return printer;
  // No preload, no node, no scripts: this window only ever renders our own
  // static markup, and nothing in a report needs to execute.
  printer = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, contextIsolation: true, nodeIntegration: false },
  });
  return printer;
}

ipcMain.handle("report:pdf", async (event, { html, suggestedName }) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(parent, {
    title: "Save report as PDF",
    defaultPath: path.join(app.getPath("downloads"), suggestedName || "interview-report.pdf"),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return { saved: false };

  const tmp = path.join(app.getPath("temp"), `interview-report-${Date.now()}.html`);
  await fsp.writeFile(tmp, html, "utf8");

  const w = printerWindow();
  try {
    await w.loadFile(tmp);
    const pdf = await w.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      margins: { top: 0.55, bottom: 0.55, left: 0.5, right: 0.5 },  // inches
      displayHeaderFooter: false,
      preferCSSPageSize: true,
    });
    await fsp.writeFile(filePath, pdf);
  } finally {
    fsp.rm(tmp, { force: true }).catch(() => {});
  }

  shell.showItemInFolder(filePath);
  return { saved: true, path: filePath };
});

// --- resume file ----------------------------------------------------------
// Two calls rather than one, so the dialog can open the moment the button is
// pressed and the reading — which can take seconds — reports progress after it.
ipcMain.handle("resume:pick", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(owner, {
    title: "Choose your resume",
    properties: ["openFile"],
    filters: [
      { name: "Resume (PDF, photo or text)", extensions: resume.ACCEPTED.map((e) => e.slice(1)) },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (canceled || !filePaths[0]) return null;
  return { path: filePaths[0], name: path.basename(filePaths[0]) };
});

ipcMain.handle("resume:extract", async (event, { filePath }) => {
  // The key is fetched here rather than passed in: a scanned PDF or a photo
  // has to go to a model, and the renderer must never hold the key to do it.
  const active = store.getActive();
  const out = await resume.extract(filePath, {
    apiKey: active?.key ?? null,
    provider: active?.spec ?? null,
    models: active?.info?.turn ?? null,
    onStatus: (text) => {
      if (!event.sender.isDestroyed()) event.sender.send("resume:status", { text });
    },
  });
  return { ...out, name: path.basename(filePath) };
});

ipcMain.handle("app:paths", () => ({
  origin: ORIGIN,
  root: ROOT,
  nodeModules: path.join(ROOT, "node_modules"),
  assets: path.join(ROOT, "assets"),
  userData: app.getPath("userData"),
}));
