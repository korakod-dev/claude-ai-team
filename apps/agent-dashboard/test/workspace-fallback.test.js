'use strict';
/**
 * workspace-fallback.test.js - Fallback to the list layout of the 3D workspace (public/workspace/scene.js).
 *
 * Bug this guards against: after webglcontextlost the page showed the list layout, but the inline transforms
 * written by updateLabels() (node and label offset) beat the fallback CSS ("transform: none"), and the inline
 * label fade (opacity) hid labels in the list. The fix clears those inline values, resets the label state
 * (eased opacity, fade hysteresis, hover pin), and stops label updates.
 * (Leader lines were removed with the label placement change: labels no longer move, so there is nothing to hide.)
 *
 * scene.js is a browser module, so this test:
 *   - extracts the FALLBACK block (between FALLBACK:BEGIN / END) and runs it in a vm sandbox with fake DOM objects
 *     that carry the positions a running scene would have written
 *   - checks the wiring in scene.js (updateLabels guard, context-lost handler) and the CSS rule for the leaders
 * No browser, no files written, no network. Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const code = fs.readFileSync(path.join(WORKSPACE_DIR, 'scene.js'), 'utf8');
const css = fs.readFileSync(path.join(WORKSPACE_DIR, 'style.css'), 'utf8');

/** Minimal classList: enough for add / remove / toggle / contains. */
function fakeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle: (n, force) => {
      const on = force === undefined ? !set.has(n) : !!force;
      if (on) set.add(n); else set.delete(n);
      return on;
    },
    contains: (n) => set.has(n),
  };
}

/** A node as left by a running scene: inline transforms, a hidden flag and classes set by updateLabels(). */
function sceneBody() {
  return {
    node: {
      hidden: true,                                   // body was behind the camera at the last frame
      style: { transform: 'translate(412.0px, 230.5px)' },
      classList: fakeClassList(['is-occluded', 'is-expanded']),
    },
    info: { style: { transform: 'translate(-20.0px, -48.0px)', opacity: '0.150' } },
  };
}

/** Run the FALLBACK block in a sandbox; returns the sandbox so the test can read its state. */
function loadFallback(bodies) {
  const block = code.match(/\/\/ FALLBACK:BEGIN[\s\S]*?\/\/ FALLBACK:END/);
  assert.ok(block, 'scene.js contains the FALLBACK block');
  const sandbox = {
    bodies,
    labelState: new Map([['appdev', 0.15]]),          // displayed opacity per planet (scene.js)
    labelTargetState: new Map([['appdev', 0.15]]),    // fade hysteresis (scene.js)
    hover: { step: 'appdev', pointer: null },         // hover state (scene.js, stellar/hover.js): hovered planet
    stageEl: { classList: fakeClassList() },
    fallbackEl: { hidden: true },
    window: { workspaceScene: { reset() {} } },
    stopCalls: 0,
    stop() { sandbox.stopCalls += 1; },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(block[0], ctx);
  return { ctx, sandbox };
}

test('fallback: inline label transforms are cleared, so the list layout is not moved by old positions', () => {
  const body = sceneBody();
  const bodies = new Map([['appdev', body]]);
  const { ctx, sandbox } = loadFallback(bodies);

  vm.runInContext('showFallback()', ctx);

  assert.equal(body.node.style.transform, '', 'node: inline transform removed (CSS transform: none applies)');
  assert.equal(body.info.style.transform, '', 'label: inline offset removed');
  assert.equal(body.node.hidden, false, 'node is shown again (it was hidden while behind the camera)');
  assert.equal(body.node.classList.contains('is-occluded'), false, 'occlusion marker removed');
  assert.equal(body.node.classList.contains('is-expanded'), false, 'expanded (hover / focus) marker removed');
  assert.equal(body.info.style.opacity, '', 'inline fade removed (the list shows every label at full opacity)');
  assert.equal(labelStateSize(ctx), 0, 'eased label opacities are forgotten');
  assert.equal(vm.runInContext('labelTargetState', ctx), null, 'fade hysteresis is forgotten');
  assert.equal(sandbox.hover.step, null, 'hover pin is dropped');
  assert.equal(sandbox.stageEl.classList.contains('no-webgl'), true, 'stage gets the no-webgl class');
  assert.equal(sandbox.fallbackEl.hidden, false, 'fallback message is shown');
  assert.equal(sandbox.window.workspaceScene, undefined, 'window.workspaceScene is unset');
});

test('fallback: no leader line code is left in scene.js (labels never move, so no leader)', () => {
  assert.equal(code.includes('node-leader'), false, 'no leader element is created');
  assert.equal(code.includes('.leader'), false, 'no body.leader is read or written');
});

test('fallback: the loop is stopped and label updates are switched off', () => {
  const { ctx, sandbox } = loadFallback(new Map([['appdev', sceneBody()]]));

  vm.runInContext('showFallback()', ctx);

  assert.equal(sandbox.stopCalls, 1, 'stop() called once');
  assert.equal(vm.runInContext('fallbackActive', ctx), true, 'fallbackActive is set');
});

test('fallback: works without a scene (WebGL missing at boot, no bodies bound yet)', () => {
  const { ctx, sandbox } = loadFallback(new Map());

  assert.doesNotThrow(() => vm.runInContext('showFallback()', ctx));
  assert.equal(sandbox.stageEl.classList.contains('no-webgl'), true, 'list layout is shown');
});

test('fallback: bodies whose node was never bound are skipped without an error', () => {
  const unbound = { node: null, info: null };
  const { ctx } = loadFallback(new Map([['qa', unbound]]));

  assert.doesNotThrow(() => vm.runInContext('showFallback()', ctx));
});

test('fallback: scene.js stops label writes in updateLabels() and calls showFallback() on context loss', () => {
  const update = code.match(/function updateLabels\(dt\) \{\n([\s\S]*?)\n  \/\/ Pass 1/);
  assert.ok(update, 'updateLabels() starts with the fallback guard');
  assert.match(update[1], /if \(fallbackActive\) return;/, 'updateLabels() returns early in fallback mode');

  const lost = code.match(/dom\.addEventListener\('webglcontextlost', \(e\) => \{([\s\S]*?)\}\);/);
  assert.ok(lost, 'scene.js has the webglcontextlost handler');
  assert.match(lost[1], /stop\(\);/, 'the loop is stopped on context loss');
  assert.match(lost[1], /showFallback\(\);/, 'the list layout is shown on context loss');
});

test('fallback: style.css shows the detail, badge and message in the list layout (compact only on the 3D stage)', () => {
  assert.match(css, /\.stage\.no-webgl \.node-detail \{ display: block; \}/);
  assert.match(css, /\.stage\.no-webgl \.node \.badge \{ display: inline-block; \}/);
  assert.match(css, /\.stage\.no-webgl \.node-msg:not\(:empty\) \{ display: block; \}/);
});

/** Read the size of the labelState Map inside the sandbox. */
function labelStateSize(ctx) {
  return vm.runInContext('labelState.size', ctx);
}
