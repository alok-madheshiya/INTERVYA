// The report. This is the part the whole app exists for — the interview is
// practice, but nobody learns from being rejected without being told why.
//
// The `rewrites` section leads, deliberately. Scores tell you that you did
// badly; seeing your own sentence quoted back with the answer you should have
// given is the thing that changes what you say next time.

import { cleanError } from "../util/errors.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const VERDICT_CLASS = { Selected: "ok", Waitlisted: "warn", Rejected: "bad" };

const COMPETENCY_LABELS = {
  technical_depth: "Technical depth",
  problem_solving: "Problem solving",
  communication: "Communication",
  structure: "Structure",
  confidence: "Confidence",
  honesty: "Honesty",
};

function bar(score, max = 10) {
  const pct = Math.round((score / max) * 100);
  const tone = pct >= 70 ? "ok" : pct >= 45 ? "warn" : "bad";
  return `<div class="scorebar"><i class="${tone}" style="width:${pct}%"></i></div>`;
}

function renderStats(st) {
  // Thresholds are the ones a panel actually notices, not arbitrary bands.
  const flag = (v, warn, bad) => (v >= bad ? "bad" : v >= warn ? "warn" : "ok");
  const rows = [
    ["Time speaking", `${st.duration_minutes} min`, ""],
    ["Answers given", st.answers, ""],
    ["Average answer", `${st.avg_answer_words} words`,
      st.avg_answer_words < 25 ? "warn" : st.avg_answer_words > 220 ? "warn" : "ok"],
    ["Shortest answer", `${st.shortest_answer_words} words`,
      st.shortest_answer_words < 8 ? "warn" : "ok"],
    ["Speaking pace", `${st.words_per_minute} wpm`,
      st.words_per_minute > 190 || st.words_per_minute < 90 ? "warn" : "ok"],
    ["Filler words", `${st.filler_total} (${st.fillers_per_100_words} per 100 words)`,
      flag(st.fillers_per_100_words, 2.5, 5)],
    ["Went silent", `${st.silent_turns} time(s)`, st.silent_turns ? "warn" : "ok"],
  ];
  const breakdown = Object.entries(st.filler_breakdown ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `<span class="chip">${esc(w)} × ${n}</span>`)
    .join("");

  return `
    <div class="card">
      <h2>Aapne kaise bola</h2>
      <table class="stats">
        ${rows.map(([k, v, tone]) =>
          `<tr><td>${k}</td><td class="${tone}">${esc(v)}</td></tr>`).join("")}
      </table>
      ${breakdown ? `<div class="chips">${breakdown}</div>` : ""}
      <div class="sub" style="margin-top:8px">
        These are counted straight off the transcript, not estimated by the model.
      </div>
    </div>`;
}

function renderReport(r, st, session) {
  const comp = Object.entries(r.competencies ?? {})
    .map(([k, v]) => `
      <div class="comp">
        <div class="compTop"><span>${COMPETENCY_LABELS[k] ?? k}</span><b>${v.score}/10</b></div>
        ${bar(v.score)}
        <div class="sub">${esc(v.evidence)}</div>
      </div>`).join("");

  const rewrites = (r.rewrites ?? []).map((w, i) => `
    <div class="rewrite">
      <div class="rwHead"><span class="num">${i + 1}</span>${esc(w.question)}</div>
      <div class="rwSaid"><label>What you said</label><q>${esc(w.you_said)}</q></div>
      <div class="rwWrong"><label>What went wrong</label>${esc(w.what_went_wrong)}</div>
      <div class="rwBetter"><label>Say this instead</label>${esc(w.say_instead)}</div>
      <div class="rwWhy"><label>Why it lands better</label>${esc(w.why_it_works)}</div>
    </div>`).join("");

  const list = (items, cls) =>
    items?.length
      ? `<ul class="${cls}">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
      : `<div class="sub">Nothing here.</div>`;

  const plan = (r.study_plan ?? []).map((d) => `
    <div class="planRow">
      <div class="planDay">Day ${d.day}</div>
      <div><b>${esc(d.focus)}</b><div class="sub">${esc(d.why)}</div></div>
    </div>`).join("");

  return `
  <div class="wrap">
    <div class="verdictCard ${VERDICT_CLASS[r.verdict] ?? ""}">
      <div>
        <div class="verdict">${esc(r.verdict)}</div>
        <div class="headline">${esc(r.headline)}</div>
        <div class="sub" style="margin-top:8px">
          ${esc(session.company.name)} · ${esc(session.round.name)} · ${esc(session.role)}
        </div>
      </div>
      <div class="bigScore"><b>${r.overall_score}</b><span>/100</span></div>
    </div>

    <div class="card">
      <h2>Recruiter note</h2>
      <div class="note">${esc(r.recruiter_note)}</div>
    </div>

    <div class="card">
      <h2>The part that matters &mdash; what to say instead</h2>
      ${rewrites || '<div class="sub">No rewrites were produced.</div>'}
    </div>

    <div class="card">
      <h2>Competencies</h2>
      <div class="comps">${comp}</div>
    </div>

    <div class="grid2">
      <div class="card"><h2>What went well</h2>${list(r.strengths, "good")}</div>
      <div class="card"><h2>Red flags</h2>${list(r.red_flags, "bad")}</div>
    </div>

    ${renderStats(st)}

    <div class="card">
      <h2>The next 7 days</h2>
      ${plan || '<div class="sub">No plan was produced.</div>'}
    </div>

    <div class="row reportActions" style="justify-content:center;margin:26px 0 40px">
      <button id="savePdf" class="primary">Download PDF</button>
      <button id="saveReport">HTML export</button>
      <button id="againBtn" class="ghost">Another interview</button>
    </div>
  </div>`;
}

export class ReportScreen {
  constructor(root) { this.root = root; }

  /** Generation takes a while (thinking is on) — say so honestly. */
  async render(session, { onAgain } = {}) {
    this.root.innerHTML = `
      <div class="wrap">
        <h1>Writing the report</h1>
        <div class="sub" id="reportStatus">Reading the panel's notes and the full transcript &mdash; 20-40 seconds.</div>
        <div class="bar" style="max-width:340px"><i style="width:35%"></i></div>
      </div>`;

    let out;
    try {
      // Gemini's 503s are common enough that the wait needs narrating; a frozen
      // progress bar reads as a crash.
      out = await window.agent.generateReport(session, (text) => {
        const el = document.getElementById("reportStatus");
        if (el && text) el.textContent = text;
      });
    } catch (e) {
      this.root.innerHTML = `
        <div class="wrap">
          <h1>The report could not be written</h1>
          <div class="err">${esc(cleanError(e))}</div>
          <div class="row" style="margin-top:16px">
            <button id="retryReport">Try again</button>
            <button id="againBtn">New interview</button>
          </div>
        </div>`;
      document.getElementById("retryReport").onclick = () => this.render(session, { onAgain });
      document.getElementById("againBtn").onclick = () => onAgain?.();
      return;
    }

    const { report, stats } = out;
    this.root.innerHTML = renderReport(report, stats, session);

    // Persist so progress across attempts is visible later.
    window.agent.sessions.add({
      id: session.id,
      company: session.company.name,
      round: session.round.name,
      role: session.role,
      score: report.overall_score,
      verdict: report.verdict,
      durationMin: stats.duration_minutes,
      report, stats,
    }).catch((e) => console.warn("[report] save failed:", e));

    document.getElementById("againBtn").onclick = () => onAgain?.();

    // One document serves both exports. The @media print block in index.html
    // turns it light for the PDF; on screen the HTML file keeps the dark look.
    const stamp = new Date(session.startedAt ?? Date.now())
      .toISOString().slice(0, 10);
    const slug = `${session.company.name}-${session.round.name}-${stamp}`
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const doc = () =>
      `<!doctype html><meta charset="utf-8">` +
      `<title>Interview report — ${esc(session.company.name)}</title>` +
      `<style>${document.querySelector("style").textContent}</style>` +
      `<body><div id="report" class="screen active">${this.root.innerHTML}</div></body>`;

    const pdfBtn = document.getElementById("savePdf");
    pdfBtn.onclick = async () => {
      const label = pdfBtn.textContent;
      pdfBtn.disabled = true;
      pdfBtn.textContent = "Making the PDF…";
      try {
        const res = await window.agent.exportPdf(doc(), `${slug}.pdf`);
        pdfBtn.textContent = res.saved ? "PDF saved ✓" : label;
      } catch (e) {
        console.error("[report] pdf failed:", e);
        pdfBtn.textContent = "PDF failed — " + cleanError(e);
      } finally {
        pdfBtn.disabled = false;
        // Long enough to read, short enough not to look stuck.
        setTimeout(() => { pdfBtn.textContent = label; }, 4000);
      }
    };

    document.getElementById("saveReport").onclick = () => {
      // Downloads are blocked in some embedded contexts, so write it out through
      // a blob URL opened in the default browser instead of an <a download>.
      const url = URL.createObjectURL(new Blob([doc()], { type: "text/html" }));
      window.open(url, "_blank");
    };
  }
}
