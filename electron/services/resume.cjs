// Turns a resume file into plain text for the panel to grill the candidate on.
//
// Two paths, because resumes arrive in two very different shapes:
//
//   * A PDF exported from Word or Overleaf carries a real text layer. Reading
//     it locally takes about 400 ms, costs nothing, and works offline.
//   * A photo of a printed resume, or a PDF that is really a scan, has no text
//     in it at all. That goes to whichever model the candidate's key reaches,
//     which reads layout far better than a bundled OCR engine would — and saves
//     shipping one. Not every provider can look at a file, and a PDF is a
//     higher bar than a photo; chatapi.readFile refuses with something useful to
//     do about it rather than guessing at pixels it cannot see.
//
// The choice is made by looking at what the local pass actually returned, not
// by trusting the file extension.
const fs = require("node:fs");
const path = require("node:path");
const { GoogleGenAI } = require("@google/genai");
const { withRetry, friendlyError } = require("./retry.cjs");
const providers = require("./providers.cjs");
const chatapi = require("./chatapi.cjs");

const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const TEXT_EXTS = [".txt", ".md"];

/** What the file dialog offers, and what the error message can promise. */
const ACCEPTED = [".pdf", ...Object.keys(IMAGE_TYPES), ...TEXT_EXTS];

// These APIs take about 20 MB in a request and base64 inflates a file by a
// third, so this is the largest file that still fits with room to spare.
const MAX_BYTES = 10 * 1024 * 1024;

// Below this, a PDF's "text layer" is really just a stray label or two on a
// scanned page — page numbers, a header — and the real content is pixels.
// A one-page resume with a genuine text layer runs to several hundred
// characters; the fixture used in the tests is 552.
const MIN_TEXT_CHARS = 120;

const OCR_PROMPT =
  "Transcribe this resume to plain text, exactly as written.\n" +
  "Keep the section headings and the bullet structure. Keep names, companies, " +
  "dates, marks and technology names verbatim.\n" +
  "Do not summarise it, do not reformat it into prose, do not add any " +
  "commentary of your own, and never invent a detail that is not visible.\n" +
  "If some part is genuinely unreadable, write [unreadable] in its place.";

const OCR_MODEL = "gemini-3.6-flash";

/**
 * Collapses the whitespace pdf.js leaves behind.
 *
 * Text extraction emits one item per run of glyphs, so joining them gives runs
 * of double spaces and a blank line for every visual gap. The panel prompt is
 * charged by the token, and none of that carries meaning.
 */
function tidy(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strips the markdown a model adds whatever the prompt says.
 *
 * Asked for plain text it still returns `**Alok Madheshiya**` and `* ` bullets,
 * and that syntax would travel into the textarea and on into the panel prompt.
 * Doing it here is deterministic; asking the model a second time is not.
 *
 * Bullets survive as "- " because the list structure is real information about
 * how the resume is laid out — only the noise goes.
 */
function stripMarkdown(text) {
  return String(text ?? "")
    .replace(/\*\*(.+?)\*\*/gs, "$1")     // **bold**
    .replace(/__(.+?)__/gs, "$1")           // __bold__
    .replace(/^#{1,6}\s+/gm, "")            // # heading
    .replace(/^\s*[*+]\s+/gm, "- ")        // * bullet -> - bullet
    .replace(/^\s*```.*$/gm, "");           // stray fences
}

/** Whether the local pass found enough to be worth using. */
function hasUsableText(text) {
  return tidy(text).length >= MIN_TEXT_CHARS;
}

/** Reads a PDF's text layer. Returns "" for a scan, rather than throwing. */
async function pdfText(filePath) {
  // pdf.js ships as ESM; this file is CommonJS, so it has to be imported.
  // The legacy build is the one that runs outside a browser.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(filePath));
  // Keep the loading task around: destroy() lives on it, not on the document.
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    // Nothing here needs eval, and this file came from outside the app.
    isEvalSupported: false,
  });
  const doc = await task.promise;

  // Read the count before destroy(): the document is unusable afterwards.
  const count = doc.numPages;
  const pages = [];
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str).join(" "));
    page.cleanup();
  }
  await task.destroy();
  return { text: tidy(pages.join("\n\n")), pages: count };
}

/**
 * Reads a file a model has to look at: a photo, or a PDF that is a scan.
 *
 * Google's own SDK for a Gemini key, plain HTTP for everyone else — the same
 * split as the interview itself, for the same reason.
 */
async function viaModel(filePath, mimeType, { apiKey, provider, models, onStatus }) {
  const spec = provider ?? providers.byId("gemini");
  if (!apiKey) {
    throw new Error(
      "This file has no text in it, so it has to be read by a model — " +
      "set your API key first, or paste the resume text in by hand."
    );
  }

  const buf = fs.readFileSync(filePath);
  let raw;

  if (spec.wire === "gemini") {
    const ai = new GoogleGenAI({ apiKey });
    onStatus?.("Reading the file…");
    const res = await withRetry(
      () => ai.models.generateContent({
        model: models?.[0] ?? OCR_MODEL,
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType, data: buf.toString("base64") } },
            { text: OCR_PROMPT },
          ],
        }],
        config: { maxOutputTokens: 4096, temperature: 0 },
      }),
      { onWait: ({ message, ms }) => onStatus?.(`${message} ${Math.ceil(ms / 1000)}s`) }
    );
    raw = res.text ?? "";
  } else {
    raw = await chatapi.readFile({
      provider: spec, apiKey, mimeType, base64: buf.toString("base64"),
      prompt: OCR_PROMPT, model: models?.[0], models, onStatus,
    });
  }

  const text = tidy(stripMarkdown(raw));
  if (!text) throw new Error("Nothing readable came back from that file.");
  return text;
}

/**
 * Pulls the text out of a resume file.
 *
 * @param {string} filePath
 * @param {object} opts
 * @param {string} [opts.apiKey]   the active provider's key
 * @param {object} [opts.provider] its providers.cjs entry; Gemini if absent
 * @param {string[]} [opts.models] the model chain this key can reach
 * @param {function} [opts.onStatus]
 * @returns {Promise<{text: string, how: string}>} `how` is shown to the
 *   candidate, so they know whether the words came off the file or out of a
 *   model that may have misread something.
 */
async function extract(filePath, { apiKey, provider, models, onStatus } = {}) {
  const who = (provider ?? providers.byId("gemini")).name;
  const via = { apiKey, provider, models, onStatus };
  const ext = path.extname(filePath).toLowerCase();

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error("That file could not be opened.");
  }
  if (stat.size === 0) throw new Error("That file is empty.");
  if (stat.size > MAX_BYTES) {
    throw new Error(
      `That file is ${(stat.size / 1024 / 1024).toFixed(1)} MB. ` +
      `The limit is ${MAX_BYTES / 1024 / 1024} MB — export it smaller, or paste the text in.`
    );
  }

  try {
    if (TEXT_EXTS.includes(ext)) {
      const text = tidy(fs.readFileSync(filePath, "utf8"));
      if (!text) throw new Error("That file has no text in it.");
      return { text, how: "read from the file" };
    }

    if (ext === ".pdf") {
      onStatus?.("Reading the PDF…");
      const { text, pages } = await pdfText(filePath);
      if (hasUsableText(text)) {
        return { text, how: `read from the PDF (${pages} page${pages === 1 ? "" : "s"})` };
      }
      // No usable text layer: this is a scan, so it has to be looked at.
      onStatus?.(`No text in that PDF — it looks scanned. Asking ${who} to read it…`);
      return {
        text: await viaModel(filePath, "application/pdf", via),
        how: `scanned PDF, read by ${who} — check it`,
      };
    }

    if (IMAGE_TYPES[ext]) {
      onStatus?.("Reading the photo…");
      return {
        text: await viaModel(filePath, IMAGE_TYPES[ext], via),
        how: `photo, read by ${who} — check it`,
      };
    }
  } catch (err) {
    // A Gemini failure arrives as a raw ApiError; everything else — chatapi's
    // errors included — is already a sentence written for the candidate.
    throw /^(ApiError|GoogleGenerativeAI)/.test(String(err?.name || err))
      ? friendlyError(err, who) : err;
  }

  throw new Error(`${ext || "That file type"} is not supported. Use a PDF, a photo, or a .txt file.`);
}

module.exports = {
  extract, tidy, stripMarkdown, hasUsableText, ACCEPTED, MAX_BYTES, MIN_TEXT_CHARS,
};
