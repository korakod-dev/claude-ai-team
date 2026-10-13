'use strict';
/**
 * stellar-hover.test.js - Hover state of the Stellar Universe scene (public/workspace/stellar/hover.js):
 *   - pointermove stores the position; the frame takes it once (takeHoverPointer)
 *   - pointerleave clears the pending pointer and the pinned planet
 *   - pointerdown clears them too (a drag is not a hover)
 *   - after the returned unbind function runs, the events no longer clear the state
 * Uses a plain EventTarget in place of the canvas. No DOM, no THREE.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const HOVER_FILE = path.join(__dirname, '..', 'public', 'workspace', 'stellar', 'hover.js');

/** Load the hover module (ES module) once per test file. */
async function loadHover() {
  return import(pathToFileURL(HOVER_FILE).href);
}

/** A pointer event with client coordinates (Node has no PointerEvent; the handlers only read clientX/clientY). */
function pointerEvent(type, clientX = 0, clientY = 0) {
  const event = new Event(type);
  Object.assign(event, { clientX, clientY });
  return event;
}

test('pointermove stores the position; takeHoverPointer returns it once', async () => {
  const h = await loadHover();
  const state = h.createHoverState();
  assert.deepEqual(state, { step: null, pointer: null }, 'nothing pinned, nothing pending at start');

  h.setHoverPointer(state, 120, 80);
  h.setHoverPointer(state, 130, 90);   // a burst: only the latest position is kept
  assert.deepEqual(h.takeHoverPointer(state), { clientX: 130, clientY: 90 });
  assert.equal(h.takeHoverPointer(state), null, 'taken once: the next frame has nothing to pick');
});

test('pointerleave clears the pending pointer and the pinned planet', async () => {
  const h = await loadHover();
  const canvas = new EventTarget();
  const state = h.createHoverState();
  h.bindHoverClear(canvas, state);

  state.step = 'appdev';
  h.setHoverPointer(state, 200, 150);
  canvas.dispatchEvent(pointerEvent('pointerleave'));

  assert.equal(state.pointer, null, 'pending pointer dropped');
  assert.equal(state.step, null, 'pinned planet released');
  assert.equal(h.takeHoverPointer(state), null, 'the next frame does not pick a stale position');
});

test('pointerdown clears the pending pointer and the pinned planet', async () => {
  const h = await loadHover();
  const canvas = new EventTarget();
  const state = h.createHoverState();
  h.bindHoverClear(canvas, state);

  state.step = 'qa';
  h.setHoverPointer(state, 40, 40);
  canvas.dispatchEvent(pointerEvent('pointerdown', 40, 40));

  assert.equal(state.pointer, null, 'pending pointer dropped at the press');
  assert.equal(state.step, null, 'hover detail released at the press');
});

test('pointermove alone does not clear the hover (only leave and press do)', async () => {
  const h = await loadHover();
  const canvas = new EventTarget();
  const state = h.createHoverState();
  h.bindHoverClear(canvas, state);

  state.step = 'study';
  canvas.dispatchEvent(pointerEvent('pointermove', 10, 10));
  assert.equal(state.step, 'study', 'the pin stays until the frame pick replaces it');
});

test('unbind: after the returned function runs, leave and press no longer clear the state', async () => {
  const h = await loadHover();
  const canvas = new EventTarget();
  const state = h.createHoverState();
  const unbind = h.bindHoverClear(canvas, state);
  unbind();

  state.step = 'portfolio';
  h.setHoverPointer(state, 1, 2);
  canvas.dispatchEvent(pointerEvent('pointerleave'));
  canvas.dispatchEvent(pointerEvent('pointerdown'));
  assert.equal(state.step, 'portfolio');
  assert.deepEqual(state.pointer, { clientX: 1, clientY: 2 });
});
