// Fixes the proper nouns Whisper reliably mangles.
//
// Whisper is trained on general English speech and butchers Indian names:
// "Alok Madheshiya" comes back as "Alupadisha" or "Alupma Deja". That matters
// here because the interview report quotes the candidate verbatim, and a report
// that misspells their own name reads as broken.
//
// We know the terms in advance — the name from setup, the tech and project
// names from the resume — so this is a constrained correction problem, not open
// transcription. Two strategies, deliberately different in aggressiveness:
//
//   1. Anchored: right after "myself" / "my name is" / "I am", whatever follows
//      is almost certainly the name, so a loose threshold is safe there.
//   2. Free: everywhere else, only replace on a strong match, because a false
//      correction is worse than leaving the original word alone.

const ANCHORS = [
  "myself", "my name is", "i am", "i'm", "this is", "name is", "call me",
];

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Levenshtein distance, iterative with a single row of state. */
function distance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** 0..1, where 1 is identical. Compares letters only, case-insensitively. */
export function similarity(a, b) {
  const x = norm(a), y = norm(b);
  if (!x && !y) return 1;
  const longest = Math.max(x.length, y.length);
  return longest ? 1 - distance(x, y) / longest : 0;
}

/**
 * @param {string} text        raw transcript
 * @param {string[]} hotwords  known terms: candidate name, project + tech names
 * @param {object} [opts]
 * @param {number} [opts.anchored=0.34]  threshold right after a name anchor
 * @param {number} [opts.free=0.72]      threshold everywhere else
 * @returns {{text: string, fixes: {from: string, to: string, via: string}[]}}
 */
export function correctTranscript(text, hotwords = [], opts = {}) {
  const anchoredMin = opts.anchored ?? 0.34;
  const freeMin = opts.free ?? 0.72;
  const terms = hotwords.map((h) => h.trim()).filter(Boolean);
  if (!terms.length || !text) return { text, fixes: [] };

  const fixes = [];
  let words = text.split(/(\s+)/); // keep whitespace so spacing survives

  // Index of each real word within `words` (skipping the whitespace entries).
  const idx = [];
  words.forEach((w, i) => { if (w.trim()) idx.push(i); });

  const wordAt = (n) => words[idx[n]] ?? "";
  const setSpan = (from, to, replacement) => {
    words[idx[from]] = replacement;
    for (let n = from + 1; n <= to; n++) {
      words[idx[n]] = "";
      words[idx[n] - 1] = ""; // the whitespace before it
    }
  };

  const anchorHitAt = (n) => {
    // Look back up to three words for a phrase like "my name is".
    for (const a of ANCHORS) {
      const parts = a.split(" ");
      if (n - parts.length < 0) continue;
      const seen = [];
      for (let k = parts.length; k >= 1; k--) seen.push(wordAt(n - k));
      if (norm(seen.join("")) === norm(parts.join(""))) return true;
    }
    return false;
  };

  for (const term of terms) {
    const span = term.trim().split(/\s+/).length;
    let best = null;

    // Compare each candidate window against the term. Windows a little shorter
    // and longer than the term matter: Whisper merges and splits words freely.
    for (let n = 0; n < idx.length; n++) {
      for (let len = Math.max(1, span - 1); len <= span + 1; len++) {
        if (n + len > idx.length) continue;
        const heard = [];
        for (let k = 0; k < len; k++) heard.push(wordAt(n + k));
        const phrase = heard.join(" ");
        if (!norm(phrase)) continue;

        const anchored = anchorHitAt(n);
        const score = similarity(phrase, term);
        const min = anchored ? anchoredMin : freeMin;
        // Already written exactly as the term (bar trailing punctuation): stop,
        // there is nothing to fix. Note this compares the raw text, not the
        // normalised score - "Socket IO" scores 1.0 against "Socket.io" because
        // normalisation strips the dot and space, but it still needs rewriting.
        if (phrase.replace(/[^\w]+$/, "") === term) { best = null; n = idx.length; break; }
        if (score >= min && (!best || score > best.score)) {
          best = { n, len, phrase, score, via: anchored ? "anchored" : "fuzzy" };
        }
      }
    }

    if (best) {
      // Keep whatever punctuation closed the original span, so replacing
      // "Alupma Deja," doesn't silently delete the comma.
      const tail = (wordAt(best.n + best.len - 1).match(/[^\w]+$/) || [""])[0];
      setSpan(best.n, best.n + best.len - 1, term + tail);
      fixes.push({ from: best.phrase, to: term + tail, via: best.via });
    }
  }

  return { text: words.join("").replace(/\s{2,}/g, " ").trim(), fixes };
}
