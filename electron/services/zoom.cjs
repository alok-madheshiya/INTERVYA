// Ctrl +/-/0 for the whole interface.
//
// This lives in its own module for one reason: which key a "+" actually
// reports is not obvious, and guessing it wrong means a shortcut that silently
// does nothing. Keeping the mapping pure lets it be tested against real
// Electron key events instead of assumed.
//
// The app has no application menu, so Chromium's own zoom accelerators never
// fire and the keys have to be read off the raw input event.

const STEP = 0.5;
// Chromium's own range is wider, but past these the layout stops being usable:
// the call screen's four avatar tiles no longer fit, and the setup form's
// two-column grid collapses.
const MIN = -3;
const MAX = 4;

const clamp = (level) => Math.min(MAX, Math.max(MIN, level));

/**
 * The zoom level a key event should produce, or null if it is not a zoom key.
 *
 * `=` is what the unshifted "+" key reports, and it is the one people actually
 * press; `+` arrives when Shift is held. The numpad reports its own names.
 *
 * @param {{type: string, key: string, control: boolean, meta: boolean}} input
 * @param {number} current the window's zoom level right now
 * @returns {number|null}
 */
function zoomFor(input, current) {
  if (input.type !== "keyDown") return null;
  if (!input.control && !input.meta) return null;

  switch (input.key) {
    case "=":
    case "+":
    case "Add":
      return clamp(current + STEP);
    case "-":
    case "Subtract":
      return clamp(current - STEP);
    case "0":
      return 0;
    default:
      return null;
  }
}

/** The level a Ctrl+wheel notch should produce. */
function zoomForWheel(direction, current) {
  return clamp(current + (direction === "in" ? STEP : -STEP));
}

module.exports = { zoomFor, zoomForWheel, clamp, STEP, MIN, MAX };
