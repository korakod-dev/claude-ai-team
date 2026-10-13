/**
 * stellar/comet.js - Pure motion maths for the comets (dispatch, result and failure). No DOM, no THREE.
 * A comet flies along a segment A -> B, optionally lifted into an arc, and leaves a fading tail behind it.
 * Times are simulated seconds. Positions are written into plain { x, y, z } objects, so scene.js can reuse them.
 */

const COMET_FADE_IN = 0.12;   // fraction of the flight used to fade in
const COMET_FADE_OUT = 0.25;  // fraction of the flight used to fade out

/** Clamp a number to 0..1. */
function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Progress along the path, 0..1. A normal comet eases in and out (quad). A pulled comet (failure) starts slowly
 * and accelerates into the black hole (power curve).
 */
export function cometProgress(elapsed, duration, pull = false) {
  const t = duration > 0 ? clamp01(elapsed / duration) : 1;
  if (pull) return Math.pow(t, 2.2);
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Opacity 0..1: fades in at the start and out at the end. 0 before the start and after the flight. */
export function cometEnvelope(elapsed, duration) {
  if (!(duration > 0) || elapsed < 0 || elapsed >= duration) return 0;
  const t = elapsed / duration;
  return Math.min(1, t / COMET_FADE_IN) * Math.min(1, (1 - t) / COMET_FADE_OUT);
}

/**
 * Point on the path at progress s (0..1): the straight segment a -> b, lifted by lift * sin(pi * s) so the
 * comet arcs over the orbit lanes. Writes into `out` and returns it.
 */
export function cometPoint(a, b, s, lift, out) {
  out.x = a.x + (b.x - a.x) * s;
  out.y = a.y + (b.y - a.y) * s + lift * Math.sin(Math.PI * s);
  out.z = a.z + (b.z - a.z) * s;
  return out;
}

/**
 * Fill the tail samples behind a head at progress headS. samples is an array of { s, alpha } objects
 * (reused by the caller). Index 0 is the head, the last index is the oldest tail point.
 *   s      path progress of that tail point (clamped to 0..1)
 *   alpha  0..1 brightness: 1 at the head, falling to 0 at the tail end; 0 when the point is before the start
 */
export function fillTail(headS, length, samples) {
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const f = n > 1 ? i / (n - 1) : 0;   // 0 = head, 1 = oldest tail point
    const raw = headS - f * length;
    samples[i].s = clamp01(raw);
    samples[i].alpha = raw <= 0 ? 0 : Math.pow(1 - f, 2);
  }
  return samples;
}
