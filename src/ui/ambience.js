// The parts of the interface that respond to the person using it, plus the
// opening.
//
// Everything here is deliberately CSS-driven: JavaScript writes a custom
// property or builds some markup once, and the compositor does the painting.
// Nothing runs per frame, so none of it competes with the avatars or with
// Whisper for the main thread.

/** What falls behind the app: the material the candidate is preparing for. */
const TOPICS = [
  "dbms", "normalization", "3NF", "binary search", "O(n log n)", "deadlock",
  "paging", "hashmap", "recursion", "segment tree", "dijkstra", "mutex",
  "B-tree", "DFS", "BFS", "ACID", "index", "trigger", "inner join", "REST",
  "pointer", "malloc", "OSI", "TCP", "handshake", "cache", "heap", "stack",
  "quicksort", "trie", "semaphore", "thrashing", "SQL", "polymorphism",
  "virtual memory", "linked list", "two pointer", "sliding window", "LRU",
];

/** Names and role tracks, which are highlighted so the field is not uniform. */
const NAMES = [
  "TCS", "Infosys", "Wipro", "Amazon", "Microsoft", "Google", "Accenture",
  "Cognizant", "Adobe", "Flipkart", "Zomato", "Razorpay", "Deloitte",
  "SDE-1", "Ninja", "Prime", "Digital", "GenC", "system design",
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

let backdropWatched = false;

/**
 * Fills the backdrop with columns of falling text.
 *
 * Each column holds its word list twice. The CSS animation runs the column
 * from -50% to 0 of its own height, so the wrap at the end of a cycle lands on
 * identical text and never shows a seam.
 */
export function buildBackdrop(host = document.querySelector(".bgColsIn")) {
  if (!host) return;

  // The column count comes from the window width and the line count from its
  // height, so a resize has to rebuild or the field grows gaps.
  if (!backdropWatched) {
    backdropWatched = true;
    let t = 0;
    window.addEventListener("resize", () => {
      clearTimeout(t);
      t = setTimeout(() => buildBackdrop(host), 250);
    });
  }

  const cols = Math.min(18, Math.max(6, Math.round(window.innerWidth / 108)));
  // 11px text at line-height 2.15 is ~23.7px a line; a half has to cover the
  // viewport on its own or the seam becomes visible as a gap.
  const lines = Math.ceil(window.innerHeight / 23.7) + 3;

  let html = "";
  for (let c = 0; c < cols; c++) {
    let half = "";
    for (let r = 0; r < lines; r++) {
      const hot = Math.random() < 0.18;
      const word = hot ? pick(NAMES) : pick(TOPICS);
      half += (hot ? "<em>" + word + "</em>" : word) + "\n";
    }
    const secs = (26 + Math.random() * 34).toFixed(1);
    const lead = (Math.random() * 30).toFixed(1);
    html += `<span style="animation-duration:${secs}s;animation-delay:-${lead}s">` +
            half + half + "</span>";
  }
  host.innerHTML = html;
}

/** Where the pointer is, as a percentage, so CSS can follow it. */
export function trackPointer(root = document.documentElement) {
  let pending = false;
  let x = 50, y = 40;

  const write = () => {
    pending = false;
    root.style.setProperty("--mx", x + "%");
    root.style.setProperty("--my", y + "%");
  };

  window.addEventListener("pointermove", (e) => {
    x = (e.clientX / window.innerWidth) * 100;
    y = (e.clientY / window.innerHeight) * 100;
    // Coalesce to one write per frame: pointermove fires far more often than
    // the screen refreshes, and each write invalidates style on the whole tree.
    if (!pending) { pending = true; requestAnimationFrame(write); }
  }, { passive: true });
}

/**
 * Cards light up where the cursor is over them.
 *
 * Delegated from the document rather than bound per card, because the company
 * grid, the role tracks and the character list all rebuild themselves as the
 * form is used — per-element listeners would leak with every re-render.
 */
export function trackCardGlow(selector = ".card, .co, .role, .char, .mode") {
  document.addEventListener("pointermove", (e) => {
    const el = e.target.closest?.(selector);
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--gx", ((e.clientX - r.left) / r.width) * 100 + "%");
    el.style.setProperty("--gy", ((e.clientY - r.top) / r.height) * 100 + "%");
  }, { passive: true });
}

// Upper case because this one is a wordmark, not a sentence: it is decoded
// glyph by glyph in monospace, and mixed case reads as text mid-render
// rather than as a name arriving. Prose spellings elsewhere use "Intervya".
const NAME = "INTERVYA";
const CMD = "panel.connect()";
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+<>/";

/** Types `text` into `el` one character at a time. Returns a stop function. */
function type(el, text, step = 40) {
  let i = 0;
  const id = setInterval(() => {
    el.textContent = text.slice(0, ++i);
    if (i >= text.length) clearInterval(id);
  }, step);
  return () => { clearInterval(id); el.textContent = text; };
}

/**
 * Resolves `text` out of random glyphs, left to right, in `ms` milliseconds.
 *
 * The title is monospace, so every intermediate frame is exactly as wide as
 * the final one and nothing below it moves while this runs.
 */
function decode(el, text, ms = 700) {
  // Driven by the clock rather than by a frame count: setInterval is throttled
  // whenever the window is not focused, and a frame-counted version of this
  // ran nearly twice as long as intended, so the title was still churning when
  // the subtitle faded in underneath it.
  const t0 = performance.now();
  // Each character has its own moment to settle, spread left to right — that
  // reads as decoding, where settling at random just reads as noise.
  const n = Math.max(text.length - 1, 1);
  const settle = text.split("").map((_, i) => 0.18 + 0.72 * (i / n) + Math.random() * 0.14);
  let raf = 0;

  const step = () => {
    const p = (performance.now() - t0) / ms;
    el.textContent = text.split("").map((c, i) =>
      c === " " ? " "
        : p > settle[i] ? c
        : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
    ).join("");
    if (p < 1) raf = requestAnimationFrame(step);
    else el.textContent = text;
  };
  raf = requestAnimationFrame(step);

  return () => { cancelAnimationFrame(raf); el.textContent = text; };
}

/**
 * Plays the opening, then hands the screen over.
 *
 * Nothing waits on this — the TTS warm-up and the config load are already in
 * flight behind it, which is exactly what the three lines of the boot log
 * describe. It is short, and a click or a key skips it.
 *
 * @param {number} ms how long the full sequence runs if nobody skips it
 * @returns {Promise<void>} resolves once the overlay is gone
 */
export function playIntro(ms = 4100) {
  const el = document.getElementById("intro");
  if (!el) return Promise.resolve();

  // The stylesheet hides the overlay for anyone who asked for less motion.
  // Waiting out its duration anyway would be a blank three seconds, which is a
  // worse first impression than the animation they opted out of.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    el.remove();
    return Promise.resolve();
  }

  document.body.classList.add("booting");

  const cmd = document.getElementById("introCmd");
  const caret = document.getElementById("introCaret");
  const name = document.getElementById("introName");
  const term = document.getElementById("introTerm");

  // Each step hands back its own stop function, so a skip can end all of them
  // without any of them needing to know about the others.
  const stops = [];
  const timers = [];
  const at = (delay, fn) => timers.push(setTimeout(fn, delay));

  at(160, () => stops.push(type(cmd, CMD)));
  at(820, () => caret.classList.add("done"));
  at(1780, () => {
    name.classList.add("hit");
    // The log stays on screen but steps back once the name lands, so the eye
    // has somewhere to go.
    term.style.opacity = ".45";
    stops.push(decode(name, NAME));
  });

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      for (const stop of stops) stop();
      window.removeEventListener("pointerdown", finish);
      window.removeEventListener("keydown", finish);
      el.classList.add("gone");
      // The form's entrance animations were held paused so that the reveal is
      // the assembly itself, not something that already ran out of sight.
      document.body.classList.remove("booting");
      setTimeout(() => { el.remove(); resolve(); }, 800);
    };

    timers.push(setTimeout(finish, ms));
    window.addEventListener("pointerdown", finish);
    window.addEventListener("keydown", finish);
  });
}
