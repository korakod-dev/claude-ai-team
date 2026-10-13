'use strict';
/**
 * reduced-motion-live.test.js - prefers-reduced-motion is followed LIVE (a matchMedia "change" event), not read once.
 *   1. scene.js: the REAL applyReducedMotion() and watchReducedMotion() run in a vm with a fake MediaQueryList and a fake fx:
 *      the "change" event flips REDUCED_MOTION / TIME_SCALE and calls fx.setReducedMotion; the old addListener fallback works.
 *   2. stellar/effects.js: the REAL createEffects() (real THREE, a stubbed canvas): setReducedMotion(true) stops the running beams
 *      and bursts and refuses new ones, setReducedMotion(false) draws again.
 *   3. source checks: scene.js reads the query once at start, registers the listener in the init path, and does not keep a
 *      frozen `const REDUCED_MOTION`.
 * No browser, no WebGL, no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const code = fs.readFileSync(path.join(WORKSPACE_DIR, 'scene.js'), 'utf8');

/** Pull one top-level function out of scene.js. */
function fnSource(name) {
  const m = code.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`));
  assert.ok(m, `${name} found in scene.js`);
  return m[0];
}

/** A fake MediaQueryList: addEventListener (or only addListener) and a trigger for the "change" event. */
function fakeQuery(initial, { legacy = false } = {}) {
  const listeners = [];
  const q = { matches: initial };
  if (legacy) q.addListener = (fn) => listeners.push(fn);
  else q.addEventListener = (type, fn) => { assert.equal(type, 'change'); listeners.push(fn); };
  q.fire = (matches) => { q.matches = matches; listeners.forEach((fn) => fn({ matches })); };
  q.listenerCount = () => listeners.length;
  return q;
}

/** Run the real scene.js functions with a fake query and a fake fx; returns accessors for the live values. */
function sceneHarness(query, { withFx = true } = {}) {
  const calls = [];
  const fx = withFx ? { setReducedMotion: (v) => calls.push(v) } : null;
  const src = `
    let REDUCED_MOTION = reducedMotionQuery.matches;
    let TIME_SCALE = REDUCED_MOTION ? 0.35 : 1;
    const fx = ${withFx ? '__fx' : 'null'};
    ${fnSource('applyReducedMotion')}
    ${fnSource('watchReducedMotion')}
    watchReducedMotion();
    ({ get reduced() { return REDUCED_MOTION; }, get timeScale() { return TIME_SCALE; } });
  `;
  const live = vm.runInNewContext(src, { reducedMotionQuery: query, __fx: fx });
  return { live, calls };
}

test('scene: a matchMedia "change" event switches reduced motion on and off live', () => {
  const q = fakeQuery(false);
  const { live, calls } = sceneHarness(q);
  assert.equal(q.listenerCount(), 1, 'one change listener is registered');
  assert.equal(live.reduced, false);
  assert.equal(live.timeScale, 1);

  q.fire(true);
  assert.equal(live.reduced, true, 'reduced motion is on after the change');
  assert.equal(live.timeScale, 0.35, 'animations slow down');
  assert.deepEqual(calls, [true], 'the effects are told (beams and bursts off)');

  q.fire(false);
  assert.equal(live.reduced, false);
  assert.equal(live.timeScale, 1);
  assert.deepEqual(calls, [true, false], 'and told again when it goes back');
});

test('scene: starts reduced when the OS already asks for it, and the old addListener API still works', () => {
  const q = fakeQuery(true, { legacy: true });
  const { live, calls } = sceneHarness(q);
  assert.equal(q.listenerCount(), 1, 'addListener fallback used');
  assert.equal(live.reduced, true);
  assert.equal(live.timeScale, 0.35);
  q.fire(false);
  assert.equal(live.reduced, false);
  assert.deepEqual(calls, [false]);
});

test('scene: a change before the effects exist (fx is null) does not throw and still flips the values', () => {
  const q = fakeQuery(false);
  const { live } = sceneHarness(q, { withFx: false });
  assert.doesNotThrow(() => q.fire(true));
  assert.equal(live.reduced, true);
});

test('scene.js source: the query is read once at start, followed by a listener, and REDUCED_MOTION is no frozen const', () => {
  assert.match(code, /const reducedMotionQuery = window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\);/);
  assert.match(code, /let REDUCED_MOTION = reducedMotionQuery\.matches;/);
  assert.equal(/const REDUCED_MOTION\b/.test(code), false, 'REDUCED_MOTION must be mutable');
  assert.equal(/const TIME_SCALE\b/.test(code), false, 'TIME_SCALE must be mutable');
  assert.match(code, /\bwatchReducedMotion\(\);/, 'the listener is registered in the init path');
  assert.match(code, /createEffects\(\{ parent: world, register: registerParticles, reducedMotion: REDUCED_MOTION \}\)/, 'effects start with the current value');
});

// ---------- the real effects module ----------

/** Minimal canvas stub: enough for beamTexture() and dotTexture() in stellar/effects.js. */
function stubDocument() {
  const ctx = {
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {},
  };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
}

test('effects: setReducedMotion(true) stops running beams and bursts and refuses new ones; (false) draws again', async () => {
  stubDocument();
  try {
    const THREE = await import(pathToFileURL(path.join(WORKSPACE_DIR, 'vendor', 'three', 'three.module.min.js')).href);
    const { createEffects } = await import(pathToFileURL(path.join(WORKSPACE_DIR, 'stellar', 'effects.js')).href);
    const parent = new THREE.Group();
    const fx = createEffects({ parent, reducedMotion: false });
    const anchor = new THREE.Object3D();
    parent.add(anchor);

    assert.equal(fx.beam(anchor, 1, 1, 0xffffff, 0), true, 'a beam is drawn');
    assert.equal(fx.burst(anchor, 1, 2, 0x00ff00), true, 'a burst is drawn');
    assert.deepEqual(fx.stats(), { beams: 1, bursts: 1 });

    fx.setReducedMotion(true);
    assert.deepEqual(fx.stats(), { beams: 0, bursts: 0 }, 'running effects stop at once');
    assert.equal(fx.beam(anchor, 1, 1, 0xffffff, 1), false, 'new beams are refused');
    assert.equal(fx.burst(anchor, 1, 2, 0x00ff00), false, 'new bursts are refused');
    assert.deepEqual(fx.stats(), { beams: 0, bursts: 0 });

    fx.setReducedMotion(false);
    assert.equal(fx.beam(anchor, 1, 1, 0xffffff, 2), true, 'beams are drawn again');
    assert.equal(fx.stats().beams, 1);

    // Created with reduced motion on: nothing draws until it is switched off
    const fx2 = createEffects({ parent, reducedMotion: true });
    assert.equal(fx2.beam(anchor, 1, 1, 0xffffff, 0), false);
    fx2.setReducedMotion(false);
    assert.equal(fx2.beam(anchor, 1, 1, 0xffffff, 0), true);

    fx.dispose();
    fx2.dispose();
  } finally {
    delete globalThis.document;
  }
});
