'use strict';
/**
 * stellar-comet.test.js - Pure motion maths of the comets (public/workspace/stellar/comet.js):
 *   progress (ease in-out for dispatch / result, accelerating for failure), fade envelope,
 *   point on the arc, and the fading tail samples.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadComet() {
  return import(pathToFileURL(path.join(__dirname, '..', 'public', 'workspace', 'stellar', 'comet.js')).href);
}

test('progress: 0 at the start, 1 at the end, clamped outside the flight', async () => {
  const c = await loadComet();
  assert.equal(c.cometProgress(-1, 2), 0);
  assert.equal(c.cometProgress(0, 2), 0);
  assert.equal(c.cometProgress(2, 2), 1);
  assert.equal(c.cometProgress(9, 2), 1);
  assert.equal(c.cometProgress(1, 0), 1, 'zero duration is finished, not NaN');
});

test('progress: dispatch and result ease in and out (slow start and end, half way at the middle)', async () => {
  const c = await loadComet();
  assert.ok(c.cometProgress(0.1, 2) < 0.1 * 0.5, 'slow start');
  assert.ok(c.cometProgress(1.9, 2) > 0.9, 'slow end is near 1');
  assert.ok(Math.abs(c.cometProgress(1, 2) - 0.5) < 1e-9, 'half way at the middle');
});

test('progress: a pulled comet (failure) accelerates into the black hole, so it is slower in the first half', async () => {
  const c = await loadComet();
  const normal = c.cometProgress(1, 2, false);
  const pulled = c.cometProgress(1, 2, true);
  assert.ok(pulled < normal, 'pulled comets are behind at the middle');
  assert.equal(c.cometProgress(2, 2, true), 1, 'pulled comets still arrive');
  // Monotonic
  let prev = -1;
  for (let t = 0; t <= 2.0001; t += 0.05) {
    const p = c.cometProgress(t, 2, true);
    assert.ok(p >= prev, 'progress never goes back');
    prev = p;
  }
});

test('envelope: 0 outside the flight, fades in and out, full in the middle', async () => {
  const c = await loadComet();
  assert.equal(c.cometEnvelope(-0.1, 2), 0);
  assert.equal(c.cometEnvelope(2, 2), 0);
  assert.equal(c.cometEnvelope(0, 0), 0, 'no duration, no comet');
  assert.equal(c.cometEnvelope(1, 2), 1);
  assert.ok(c.cometEnvelope(0.01, 2) < 1, 'fading in at the start');
  assert.ok(c.cometEnvelope(1.95, 2) < 1, 'fading out at the end');
});

test('point: the segment endpoints are exact and the arc lifts the middle by lift', async () => {
  const c = await loadComet();
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 10, y: 0, z: -4 };
  const out = { x: 0, y: 0, z: 0 };
  c.cometPoint(a, b, 0, 1, out);
  assert.deepEqual([out.x, out.y, out.z], [0, 0, 0]);
  c.cometPoint(a, b, 1, 1, out);
  assert.ok(Math.abs(out.x - 10) < 1e-9 && Math.abs(out.y) < 1e-9 && Math.abs(out.z + 4) < 1e-9);
  c.cometPoint(a, b, 0.5, 1.5, out);
  assert.ok(Math.abs(out.x - 5) < 1e-9 && Math.abs(out.z + 2) < 1e-9);
  assert.ok(Math.abs(out.y - 1.5) < 1e-9, 'lift at the middle');
});

test('tail: index 0 is the head, alpha falls to 0 along the tail, points before the start are invisible', async () => {
  const c = await loadComet();
  const samples = Array.from({ length: 6 }, () => ({ s: 0, alpha: 0 }));
  c.fillTail(0.8, 0.4, samples);
  assert.equal(samples[0].s, 0.8, 'head is at the comet progress');
  assert.equal(samples[0].alpha, 1);
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].alpha <= samples[i - 1].alpha, 'alpha never grows along the tail');
    assert.ok(samples[i].s <= samples[i - 1].s, 's never grows along the tail');
    assert.ok(samples[i].s >= 0 && samples[i].s <= 1, 's stays on the path');
  }
  // Early in the flight the tail reaches behind the start: those points are hidden
  c.fillTail(0.05, 0.4, samples);
  assert.equal(samples[samples.length - 1].alpha, 0);
  assert.equal(samples[samples.length - 1].s, 0);
});
