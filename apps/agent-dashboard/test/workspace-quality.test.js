'use strict';
/**
 * workspace-quality.test.js - Static checks for the quality settings of the 3D workspace scene (public/workspace/scene.js).
 *
 * No browser is needed. These tests pin the settings the adaptive governor and the 4K resolution rely on:
 *   - QUALITY_LEVEL constant at the top, the presets live in stellar/quality.js (behaviour: test/stellar-quality.test.js)
 *   - scene.js applies the pixel ratio from effectivePixelRatio() through the applier (skips the same ratio)
 *   - the sky dome is drawn at half resolution by SkyPass (stellar/sky-pass.js) and upscaled
 *   - governor thresholds (2 s window, step down below 50 FPS, step up at 57+ after two stable windows)
 *   - particle budget (at most 6000 points at the top level)
 *   - every imported module exists on disk, and no image or HDR texture file is referenced (procedural only)
 * The real GPU behaviour (4K output, FPS, governor steps) is NOT covered here. It was checked in headless Chrome.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const code = fs.readFileSync(path.join(WORKSPACE_DIR, 'scene.js'), 'utf8');

/** Read a numeric `const NAME = 123;` from scene.js. */
function constNumber(name) {
  const m = code.match(new RegExp(`^const ${name} = (\\d+);`, 'm'));
  assert.ok(m, `scene.js declares const ${name}`);
  return Number(m[1]);
}

test('quality: QUALITY_LEVEL is declared at the top; scene.js imports the presets from stellar/quality.js', () => {
  assert.match(code, /^const QUALITY_LEVEL = 'auto';/m);
  assert.match(code, /import \{ QUALITY_PRESETS, effectivePixelRatio, createPixelRatioApplier \} from '\.\/stellar\/quality\.js';/);
});

test('quality: the pixel ratio is set only through the applier, which sets renderer and composer together', () => {
  assert.equal(constNumber('MSAA_SAMPLES'), 4);
  assert.match(code, /pixelRatioApplier\.apply\(effectivePixelRatio\(preset, window\.devicePixelRatio\)\);/);
  assert.match(code, /renderer\.setPixelRatio\(pr\);\s*composer\.setPixelRatio\(pr\);/);
});

test('sky: the sky dome is drawn by SkyPass at SKY_SCALE 0.5 before the scene pass, and the scene pass does not clear', () => {
  assert.match(code, /^const SKY_SCALE = 0\.5;/m);
  assert.match(code, /import \{ SkyPass \} from '\.\/stellar\/sky-pass\.js';/);
  const skyAt = code.indexOf('composer.addPass(skyPass);');
  const sceneAt = code.indexOf('composer.addPass(scenePass);');
  assert.ok(skyAt > 0 && sceneAt > skyAt, 'SkyPass is added before the scene pass');
  assert.match(code, /scenePass\.clear = false;/);
  // The dome lives in its own scene, so the scene pass does not draw it a second time
  const backdrop = fs.readFileSync(path.join(WORKSPACE_DIR, 'stellar', 'backdrop.js'), 'utf8');
  assert.match(backdrop, /const skyScene = new THREE\.Scene\(\);/);
  assert.equal(/group\.add\(sky\)/.test(backdrop), false, 'sky dome is not in the main group');
});

test('governor: 2 s window, step down below 50 FPS, step up at 57+ FPS after two stable windows', () => {
  assert.match(code, /windowSeconds: 2,/);
  assert.match(code, /minFps: 50,/);
  assert.match(code, /stableFps: 57,/);
  assert.match(code, /stableWindows: 2,/);
  assert.match(code, /const AUTO_START_LEVEL = 2;/);
});

test('particles: the top level stays under 6000 points (stars + dust + up to 8 comet tails)', () => {
  const beamBudget = 8 * constNumber('BEAM_PARTICLES');
  const total = constNumber('STAR_COUNT') + constNumber('DUST_COUNT') + beamBudget;
  assert.ok(total <= 6000, `particle budget ${total} <= 6000`);
});

test('particles: STAR_COUNT and DUST_COUNT in scene.js match the counts in stellar/backdrop.js', () => {
  const backdrop = fs.readFileSync(path.join(WORKSPACE_DIR, 'stellar', 'backdrop.js'), 'utf8');
  const layers = [...backdrop.matchAll(/count: (\d+),/g)].map((m) => Number(m[1]));
  assert.equal(layers.length, 3, 'three star layers');
  assert.equal(layers.reduce((a, b) => a + b, 0), constNumber('STAR_COUNT'), 'STAR_COUNT is the sum of the layers');
  const dust = backdrop.match(/export const DUST_COUNT = (\d+);/);
  assert.ok(dust, 'backdrop.js declares DUST_COUNT');
  assert.equal(Number(dust[1]), constNumber('DUST_COUNT'), 'DUST_COUNT matches');
});

test('imports: every module scene.js imports exists in public/workspace (no CDN, no missing file)', () => {
  const specs = [...code.matchAll(/^import [^'"]* from '(\.\/[^']+)';/gm)].map((m) => m[1]);
  assert.ok(specs.length >= 5, 'scene.js imports Three.js and its addons');
  for (const spec of specs) {
    assert.ok(fs.existsSync(path.join(WORKSPACE_DIR, spec)), `${spec} exists`);
  }
});

test('procedural only: scene.js references no image, HDR or texture file', () => {
  assert.equal(/\.(jpe?g|png|webp|gif|hdr|exr|ktx2?|basis)['"]/i.test(code), false);
});

test('post: bloom, output and cinematic passes are wired in that order, and the cinematic pass follows the preset', () => {
  const bloom = code.indexOf('composer.addPass(bloomPass)');
  const output = code.indexOf('composer.addPass(new OutputPass())');
  const cinematic = code.indexOf('composer.addPass(cinematicPass)');
  assert.ok(bloom > 0 && output > bloom && cinematic > output, 'RenderPass -> bloom -> OutputPass -> cinematic');
  assert.match(code, /if \(cinematicPass\) cinematicPass\.enabled = preset\.cinematic;/);
});
