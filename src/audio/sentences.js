// Sentence splitting, kept dependency-free so it can be unit tested outside a
// browser — tts.js imports the TTS engine through an import map that only
// exists in the renderer.
//
// This drives when the panel starts talking: synthesis runs at RTF ~0.62, so a
// whole 10-second reply takes ~6 seconds to generate, but its first sentence
// takes under a second. Speaking per sentence is what removes the dead air.

/** Splits on sentence ends, keeping the punctuation with its sentence. */
export function sentences(text) {
  return String(text ?? "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
