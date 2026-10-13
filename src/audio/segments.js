// When to hand a stretch of an answer to Whisper before the answer is over.
//
// Kept separate from stt.js because the decision is pure arithmetic and the
// thing it lives inside is an audio callback wired to a live microphone, which
// no test can hold still.
//
// The reason any of this exists, measured on this machine with a real spoken
// answer (Windows SAPI, whisper-base.en on WebGPU):
//
//   a 40 s answer, transcribed whole when they stop   4600 ms of waiting
//   the same 40 s as four 10 s stretches              5845 ms of work, but
//                                                     1415 ms of waiting
//
// Cutting it up is *more* total work — Whisper pads every clip to thirty
// seconds, so four clips cost four encoder passes instead of one — but three
// of those four passes happen while the candidate is still talking and the GPU
// is otherwise idle. Only the last stretch is still outstanding when they stop,
// and that is the only part they experience as a wait.

/** A stretch shorter than this is not worth an encoder pass of its own. */
export const MIN_SEGMENT_MS = 6000;

/** Speech, not just noise, that a stretch must contain before it is sent. */
export const MIN_SEGMENT_SPEECH_MS = 1500;

/**
 * Quiet that marks a place to cut. Deliberately well under `silenceMs` (1800 ms,
 * which ends the whole turn): the cut has to land inside a natural pause the
 * candidate takes mid-answer, not at the end of the answer.
 */
export const SEGMENT_PAUSE_MS = 700;

/**
 * Should the audio captured since the last cut go to Whisper now?
 *
 * All three conditions matter. Without the pause, cuts land mid-word. Without
 * the length, a run of short breaths turns one answer into fifteen encoder
 * passes and the GPU never catches up. Without the speech floor, Whisper is
 * handed something that is nearly all silence — and a Whisper given silence
 * does not return nothing, it invents ("Thank you.", "you"), which then lands
 * in the transcript as words the candidate never said.
 *
 * @param {object} s
 * @param {number} s.pendingMs        audio captured since the last cut
 * @param {number} s.pendingSpeechMs  how much of that was above the speech floor
 * @param {number} s.quietMs          quiet so far, right now
 */
export function shouldFlush({ pendingMs, pendingSpeechMs, quietMs }) {
  return quietMs >= SEGMENT_PAUSE_MS &&
         pendingMs >= MIN_SEGMENT_MS &&
         pendingSpeechMs >= MIN_SEGMENT_SPEECH_MS;
}

/**
 * Is the last stretch worth transcribing at all?
 *
 * When a cut fires at 700 ms of quiet and the turn then ends at 1800 ms, what
 * is left is a second of silence. Sending it invites exactly the invented words
 * described above, at the one position in the transcript — the end — where they
 * read as the candidate's final thought.
 */
export function tailIsWorthReading({ pendingMs, pendingSpeechMs }) {
  return pendingMs > 0 && pendingSpeechMs >= 400;
}

/**
 * Joins the stretches back into one answer.
 *
 * Whisper punctuates each stretch as if it were a whole utterance, so the seams
 * already end in a full stop more often than not; blanks are dropped rather
 * than left as double spaces.
 */
export function joinSegments(parts) {
  return parts
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
