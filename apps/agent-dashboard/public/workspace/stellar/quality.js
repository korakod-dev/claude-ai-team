/**
 * stellar/quality.js - Quality presets and pixel-ratio rules of the Stellar Universe scene (scene.js).
 *
 * Pure module: no DOM, no THREE. Shared by scene.js and test/stellar-quality.test.js.
 *
 * Rule that the presets must keep: the effective pixel ratio never decreases going up the levels
 * (low <= medium <= high <= ultra), for every device pixel ratio. test/stellar-quality.test.js checks it.
 */

// Global limits of the renderer pixel ratio (applied after the preset's pixelScale).
export const MIN_PIXEL_RATIO = 0.5;
export const MAX_PIXEL_RATIO = 2;   // device pixel ratio cap (4K = 3840x2160 at 2x on a 1920x1080 stage)

// Device pixel ratio cap of the lower presets (low, medium) and of high.
// Equal caps keep the order: with the cap, a preset's ratio is cap * pixelScale, and the scales rise from low to high.
const MID_PIXEL_CAP = 1.5;

// Presets, from lowest to highest quality.
//   pixelScale      multiplies the capped devicePixelRatio to get the renderer pixel ratio
//   maxPixelRatio   cap on devicePixelRatio for this preset (low, medium, high = 1.5; ultra = MAX_PIXEL_RATIO)
//   bloomStrength   UnrealBloomPass strength (0 = bloom pass disabled)
//   cinematic       chromatic aberration, film grain and vignette on/off
//   particleScale   share of the particles drawn (stars, dust, comet tails)
export const QUALITY_PRESETS = [
  { name: 'low',    pixelScale: 0.6, maxPixelRatio: MID_PIXEL_CAP,   bloomStrength: 0,    cinematic: false, particleScale: 0.4 },
  { name: 'medium', pixelScale: 0.8, maxPixelRatio: MID_PIXEL_CAP,   bloomStrength: 0.45, cinematic: false, particleScale: 0.7 },
  { name: 'high',   pixelScale: 1.0, maxPixelRatio: MID_PIXEL_CAP,   bloomStrength: 0.6,  cinematic: true,  particleScale: 0.85 },
  { name: 'ultra',  pixelScale: 1.0, maxPixelRatio: MAX_PIXEL_RATIO, bloomStrength: 0.7,  cinematic: true,  particleScale: 1.0 },
];

/** Clamp a number into [lo, hi]. */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Renderer pixel ratio of a preset at a given device pixel ratio:
 * min(devicePixelRatio, preset.maxPixelRatio) * preset.pixelScale, clamped to [MIN_PIXEL_RATIO, MAX_PIXEL_RATIO].
 * A missing or invalid devicePixelRatio (0, NaN, undefined) counts as 1, as `window.devicePixelRatio || 1` did before.
 */
export function effectivePixelRatio(preset, devicePixelRatio) {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const base = Math.min(dpr, preset.maxPixelRatio);
  return clamp(base * preset.pixelScale, MIN_PIXEL_RATIO, MAX_PIXEL_RATIO);
}

/**
 * Remembers the last pixel ratio that was applied, and calls onApply only when the ratio really changes.
 * setPixelRatio() and setSize() reset the canvas backing store even for the same value, so a repeated value must be a no-op.
 * apply(pr) returns true when onApply ran, false when the ratio was the same as the last one.
 * value is the last applied ratio (0 = never applied).
 */
export function createPixelRatioApplier(onApply) {
  let applied = 0;
  return {
    apply(pr) {
      if (pr === applied) return false;   // same ratio: nothing to do
      applied = pr;
      onApply(pr);
      return true;
    },
    get value() {
      return applied;
    },
  };
}
