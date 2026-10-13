// node electron/services/resume.test.cjs
//
// A resume arrives as a PDF or as a photo of one, and those need completely
// different handling: one is read here in about half a second, the other costs
// a Gemini call. Getting that branch wrong either burns free quota on a file
// that needed none, or hands the panel a page number and nothing else.
//
// The fixture in test/fixtures is a real one-page PDF with a real text layer,
// so the local path is exercised for real rather than mocked.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  extract, tidy, stripMarkdown, hasUsableText, ACCEPTED, MAX_BYTES, MIN_TEXT_CHARS,
} = require("./resume.cjs");

let pass = 0, fail = 0;
const test = async (n, fn) => {
  try { await fn(); pass++; console.log("  ok   " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + "\n       " + e.message); }
};

const FIXTURE = path.join(__dirname, "..", "..", "test", "fixtures", "resume.pdf");
const tmp = (name, data) => {
  const p = path.join(os.tmpdir(), `resume-test-${process.pid}-${name}`);
  fs.writeFileSync(p, data);
  return p;
};

(async () => {
  console.log("tidy");

  await test("collapses the runs of spaces pdf.js leaves between glyph runs", () => {
    assert.strictEqual(tidy("Alok    Madheshiya   B.Tech"), "Alok Madheshiya B.Tech");
  });

  await test("a page break becomes one blank line, not four", () => {
    assert.strictEqual(tidy("PROJECTS\n\n\n\n\nSKILLS"), "PROJECTS\n\nSKILLS");
  });

  await test("survives null without throwing", () => {
    assert.strictEqual(tidy(null), "");
  });

  console.log("\nstripMarkdown");

  // Gemini returns markdown however plainly the prompt asks for text, and that
  // syntax would travel into the panel prompt as if the candidate wrote it.
  await test("bold markers go, the words stay", () => {
    assert.strictEqual(stripMarkdown("**Alok Madheshiya**"), "Alok Madheshiya");
    assert.strictEqual(stripMarkdown("__Alok__"), "Alok");
  });

  await test("heading hashes go", () => {
    assert.strictEqual(stripMarkdown("## SKILLS"), "SKILLS");
  });

  await test("bullets survive as bullets — the list structure is real information", () => {
    assert.strictEqual(stripMarkdown("* Intervya\n* Gift Claimer"),
                       "- Intervya\n- Gift Claimer");
  });

  await test("a lone asterisk mid-sentence is left alone", () => {
    assert.strictEqual(stripMarkdown("C* and 3*4 matrices"), "C* and 3*4 matrices");
  });

  console.log("\nthe scan/text-layer branch");

  await test("a real resume's worth of text counts as usable", () => {
    assert.ok(hasUsableText("x".repeat(MIN_TEXT_CHARS)));
  });

  await test("a scanned page's stray header does not", () => {
    // What a scan's "text layer" actually holds: a page number and a footer.
    assert.ok(!hasUsableText("Page 1 of 2\nConfidential"));
  });

  console.log("\nextract");

  await test("reads a PDF's text layer locally, without a key", async () => {
    const out = await extract(FIXTURE, {});   // no apiKey on purpose
    assert.match(out.how, /read from the PDF/);
    assert.match(out.text, /Alok Madheshiya/);
    assert.match(out.text, /Operating Systems/);
    assert.ok(out.text.length > 300, "got only " + out.text.length + " chars");
  });

  await test("a missing file is a sentence, not a stack trace", async () => {
    await assert.rejects(() => extract("no-such-file.pdf", {}),
      (e) => !/ENOENT/.test(e.message) && /could not be opened/i.test(e.message));
  });

  await test("an unsupported type names the types that do work", async () => {
    const p = tmp("thing.docx", "not really a docx");
    await assert.rejects(() => extract(p, {}), /PDF, a photo, or a \.txt/);
    fs.unlinkSync(p);
  });

  await test("an empty file says so rather than returning nothing", async () => {
    const p = tmp("empty.txt", "");
    await assert.rejects(() => extract(p, {}), /empty/i);
    fs.unlinkSync(p);
  });

  await test("an oversized file is refused before it is read into memory", async () => {
    const p = tmp("huge.png", Buffer.alloc(MAX_BYTES + 1024));
    await assert.rejects(() => extract(p, {}), /limit is 10 MB/);
    fs.unlinkSync(p);
  });

  await test("a plain text file needs no key and no model", async () => {
    const p = tmp("cv.txt", "Alok Madheshiya\nB.Tech CSE\nProjects: Intervya");
    const out = await extract(p, {});
    assert.match(out.text, /Intervya/);
    assert.strictEqual(out.how, "read from the file");
    fs.unlinkSync(p);
  });

  // The OCR path costs a real request, so it is not exercised here — but the
  // guard in front of it is, because hitting it with no key is the common case
  // for someone who has not set one up yet.
  await test("a photo with no key explains itself instead of failing at the API", async () => {
    const p = tmp("photo.png", Buffer.alloc(2048, 7));
    await assert.rejects(() => extract(p, {}), /set your Gemini key|paste the resume/i);
    fs.unlinkSync(p);
  });

  await test("the dialog's filter list and the code agree on what is accepted", () => {
    for (const ext of [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".txt"]) {
      assert.ok(ACCEPTED.includes(ext), ext + " missing from ACCEPTED");
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
