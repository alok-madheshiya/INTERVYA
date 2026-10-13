const { contextBridge, ipcRenderer } = require("electron");

/**
 * One streamed generation over IPC.
 *
 * Every call gets its own id and its own listeners: chunks from two overlapping
 * turns would otherwise be spoken as one sentence. Both the interview panel and
 * Talk mode use this — they differ in the channel, not in the plumbing.
 */
function streamed(channel, payload, onChunk, onStatus) {
  const turnId = crypto.randomUUID();
  const onText = (_e, msg) => { if (msg.turnId === turnId) onChunk?.(msg.chunk); };
  const onWait = (_e, msg) => { if (msg.turnId === turnId) onStatus?.(msg.text); };
  ipcRenderer.on("turn:chunk", onText);
  ipcRenderer.on("turn:status", onWait);
  return ipcRenderer
    .invoke(channel, { ...payload, turnId })
    .finally(() => {
      ipcRenderer.removeListener("turn:chunk", onText);
      ipcRenderer.removeListener("turn:status", onWait);
    });
}

// The only surface the renderer gets. Note there is no way to read the API key
// from here — the page can set one and ask whether one exists, but the key
// itself never crosses this boundary.
contextBridge.exposeInMainWorld("agent", {
  paths: () => ipcRenderer.invoke("app:paths"),

  config: {
    get: () => ipcRenderer.invoke("config:get"),
    set: (patch) => ipcRenderer.invoke("config:set", patch),
    setGeminiKey: (key) => ipcRenderer.invoke("config:setGeminiKey", key),

    /**
     * One API key, provider unknown.
     *
     * The main process works out whose it is, which models it can reach and
     * whether it generates, then saves it — see detect.cjs. `onStatus` fires
     * while it walks the candidates, because a key whose shape is ambiguous can
     * take a few seconds and silence reads as a hang.
     *
     * Resolves with { detected, config }.
     */
    saveKey: (key, onStatus) => {
      const listener = (_e, msg) => onStatus?.(msg.text);
      if (onStatus) ipcRenderer.on("key:status", listener);
      return ipcRenderer
        .invoke("config:saveKey", { key })
        .finally(() => ipcRenderer.removeListener("key:status", listener));
    },

    /** Switches to another key already on this machine. */
    setActiveProvider: (provider) => ipcRenderer.invoke("config:setActiveProvider", provider),

    /** Deletes one provider's saved key. */
    forgetProvider: (provider) => ipcRenderer.invoke("config:forgetProvider", provider),
    /** Saves a key for one provider — see llm.cjs for the list. */
    setProviderKey: (provider, key) =>
      ipcRenderer.invoke("config:setProviderKey", { provider, key }),
    /** Checks a key against its own provider before it is saved. */
    verifyProviderKey: (provider, key) =>
      ipcRenderer.invoke("config:verifyProviderKey", { provider, key }),
    verifyKey: () => ipcRenderer.invoke("config:verifyKey"),
    listModels: () => ipcRenderer.invoke("config:listModels"),
  },

  /**
   * Builds the report. `onStatus` fires when the call has to wait out an
   * overloaded model, so the screen can say so instead of sitting blank.
   */
  generateReport: (session, onStatus) => {
    const listener = (_e, msg) => onStatus?.(msg.text);
    if (onStatus) ipcRenderer.on("report:status", listener);
    return ipcRenderer
      .invoke("report:generate", { session })
      .finally(() => ipcRenderer.removeListener("report:status", listener));
  },

  /** Renders the given HTML to a PDF the user picks a location for. */
  exportPdf: (html, suggestedName) =>
    ipcRenderer.invoke("report:pdf", { html, suggestedName }),

  /**
   * The resume file. Picking and reading are separate calls: the dialog should
   * open the instant the button is pressed, and the reading that follows can
   * take seconds — a scan or a photo goes to Gemini — so it reports progress.
   *
   * Only the path crosses this boundary. The file is read in the main process,
   * which is also where the key lives for the OCR path.
   */
  pickResume: () => ipcRenderer.invoke("resume:pick"),

  readResume: (filePath, onStatus) => {
    const listener = (_e, msg) => onStatus?.(msg.text);
    if (onStatus) ipcRenderer.on("resume:status", listener);
    return ipcRenderer
      .invoke("resume:extract", { filePath })
      .finally(() => ipcRenderer.removeListener("resume:status", listener));
  },

  sessions: {
    list: () => ipcRenderer.invoke("sessions:list"),
    get: (id) => ipcRenderer.invoke("sessions:get", id),
    add: (s) => ipcRenderer.invoke("sessions:add", s),
  },

  /**
   * Runs one panel turn. `onChunk` fires with spoken text as it streams, so the
   * first sentence can go to TTS before the model has finished writing.
   * Resolves with { spoken, meta, model }.
   */
  runTurn: ({ session, answerText, onChunk, onStatus }) =>
    streamed("turn:run", { session, answerText }, onChunk, onStatus),

  /** Talk mode's equivalent — same streaming contract, different prompt. */
  runChat: ({ chat, userText, onChunk, onStatus }) =>
    streamed("chat:run", { chat, userText }, onChunk, onStatus),

  /**
   * Tells the main process the interface actually came up.
   *
   * One-way and unanswered on purpose: it is a heartbeat, not a request, and
   * nothing should be able to fail because of it.
   */
  booted: () => ipcRenderer.send("app:booted"),
});
