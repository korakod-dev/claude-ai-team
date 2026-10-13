'use strict';
/**
 * stellar-quality.test.js - Quality presets and pixel-ratio rules of the Stellar Universe scene
 * (public/workspace/stellar/quality.js):
 *   - the effective pixel ratio of each preset at DPR 1, 1.5, 2 and 3 (expected values written out)
 *   - monotonic: low <= medium <= high <= ultra for every device pixel ratio in a dense sweep
 *   - the pixel ratio stays inside the global limits [MIN_PIXEL_RATIO, MAX_PIXEL_RATIO]
 *   - the applier calls its callback only when the ratio really changes (same ratio = no resize)
 * Pure functions, no DOM, no THREE. Runs in Node through import() (stellar/package.json is "type": "module").
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const QUALITY_FILE = path.join(__dirname, '..', 'public', 'workspace', 'stellar', 'quality.js');

/** Load the quality module (ES module) once per test file. */
async function loadQuality() {
  return import(pathToFileURL(QUALITY_FILE).href);
}

/** Effective pixel ratios of the four presets at one device pixel ratio, lowest level first. */
function ratiosAt(q, dpr) {
  return q.QUALITY_PRESETS.map((preset) => q.effectivePixelRatio(preset, dpr));
}

test('presets: four levels from low to ultra', async () => {
  const q = await loadQuality();
  assert.deepEqual(q.QUALITY_PRESETS.map((p) => p.name), ['low', 'medium', 'high', 'ultra']);
});

test('effective pixel ratio at DPR 1, 1.5, 2 and 3 matches the expected values', async () => {
  const q = await loadQuality();
  // [low, medium, high, ultra] per device pixel ratio
  const expected = new Map([
    [1,   [0.6, 0.8, 1.0, 1.0]],
    [1.5, [0.9, 1.2, 1.5, 1.5]],
    [2,   [0.9, 1.2, 1.5, 2.0]],
    [3,   [0.9, 1.2, 1.5, 2.0]],
  ]);
  for (const [dpr, values] of expected) {
    const got = ratiosAt(q, dpr);
    values.forEach((want, i) => {
      assert.ok(Math.abs(got[i] - want) < 1e-9, `DPR ${dpr}: ${q.QUALITY_PRESETS[i].name} is ${got[i]}, want ${want}`);
    });
  }
});

test('monotonic: low <= medium <= high <= ultra at DPR 1, 1.5, 2 and 3', async () => {
  const q = await loadQuality();
  for (const dpr of [1, 1.5, 2, 3]) {
    const [low, medium, high, ultra] = ratiosAt(q, dpr);
    assert.ok(low <= medium, `DPR ${dpr}: low ${low} <= medium ${medium}`);
    assert.ok(medium <= high, `DPR ${dpr}: medium ${medium} <= high ${high}`);
    assert.ok(high <= ultra, `DPR ${dpr}: high ${high} <= ultra ${ultra}`);
  }
});

test('monotonic: the order holds for every device pixel ratio from 0.25 to 4 in steps of 0.05', async () => {
  const q = await loadQuality();
  for (let dpr = 0.25; dpr <= 4.0001; dpr += 0.05) {
    const ratios = ratiosAt(q, dpr);
    for (let i = 1; i < ratios.length; i += 1) {
      assert.ok(ratios[i - 1] <= ratios[i], `DPR ${dpr.toFixed(2)}: ${q.QUALITY_PRESETS[i - 1].name} ${ratios[i - 1]} <= ${q.QUALITY_PRESETS[i].name} ${ratios[i]}`);
    }
  }
});

test('limits: every ratio is inside [MIN_PIXEL_RATIO, MAX_PIXEL_RATIO]; a missing DPR counts as 1', async () => {
  const q = await loadQuality();
  assert.equal(q.MIN_PIXEL_RATIO, 0.5);
  assert.equal(q.MAX_PIXEL_RATIO, 2);
  for (let dpr = 0.1; dpr <= 6; dpr += 0.1) {
    for (const r of ratiosAt(q, dpr)) {
      assert.ok(r >= q.MIN_PIXEL_RATIO && r <= q.MAX_PIXEL_RATIO, `DPR ${dpr.toFixed(1)}: ${r} inside the limits`);
    }
  }
  // 0, NaN and undefined are treated as 1 (the old `window.devicePixelRatio || 1`)
  for (const bad of [0, NaN, undefined]) {
    assert.deepEqual(ratiosAt(q, bad), ratiosAt(q, 1), `DPR ${String(bad)} counts as 1`);
  }
});

test('applier: onApply runs on the first value and on every real change', async () => {
  const q = await loadQuality();
  const calls = [];
  const applier = q.createPixelRatioApplier((pr) => calls.push(pr));
  assert.equal(applier.value, 0, 'nothing applied yet');
  assert.equal(applier.apply(1.5), true);
  assert.equal(applier.apply(2), true);
  assert.deepEqual(calls, [1.5, 2]);
  assert.equal(applier.value, 2, 'value is the last applied ratio');
});

test('applier: the same ratio is skipped (no callback, no canvas reset)', async () => {
  const q = await loadQuality();
  const calls = [];
  const applier = q.createPixelRatioApplier((pr) => calls.push(pr));
  applier.apply(1.5);
  assert.equal(applier.apply(1.5), false, 'repeated value reports nothing applied');
  assert.equal(applier.apply(1.5), false);
  assert.deepEqual(calls, [1.5], 'onApply ran once for the repeated value');
  assert.equal(applier.apply(1.2), true, 'a different value runs again');
  assert.deepEqual(calls, [1.5, 1.2]);
});

test('applier: high <-> ultra on a 1x screen keeps the same ratio, so the second apply is skipped', async () => {
  const q = await loadQuality();
  const calls = [];
  const applier = q.createPixelRatioApplier((pr) => calls.push(pr));
  const [, , high, ultra] = q.QUALITY_PRESETS;
  applier.apply(q.effectivePixelRatio(high, 1));
  applier.apply(q.effectivePixelRatio(ultra, 1));
  assert.deepEqual(calls, [1], 'one resize for the two levels at DPR 1');
});
