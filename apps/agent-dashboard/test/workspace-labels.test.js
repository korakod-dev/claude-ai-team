'use strict';
/**
 * workspace-labels.test.js - Label placement of the 3D workspace (public/workspace/scene.js, LABEL_LAYOUT block).
 *
 * Rules under test (owner decision: options 1 + 3):
 *   1. No relocation: a label is a function of its OWN anchor only. It never moves to avoid another label.
 *      It sits on a fixed side (LABEL_SIDE), so it never jumps or swaps side as its planet moves.
 *   2. Fade: when two labels overlap, the farther one (larger depth) gets LABEL_FADE_MIN, the nearer stays at 1.
 *      Pinned labels (hovered / focused planet) stay at 1. The fade has hysteresis, so it does not flicker.
 *   3. Opacity eases toward its target (labelOpacityStep), monotonically, without overshoot.
 *
 * Changed from the previous version (which tested the collision-avoidance layout): the no-overlap, leader line,
 * crowding, slot-stickiness and auto-side tests were removed, because the behaviour they checked is gone (see the
 * owner decision above). The occlusion tests are unchanged.
 *
 * scene.js is a browser module (window, WebGL, DOM), so this test does not import it. It extracts the
 * LABEL_LAYOUT block (between the LABEL_LAYOUT:BEGIN / END markers), runs it in a vm sandbox.
 * Pure computation, no files written, no network. Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCENE_FILE = path.join(__dirname, '..', 'public', 'workspace', 'scene.js');

/** Run the LABEL_LAYOUT block of scene.js in a sandbox and return its functions and constants. */
function loadLabelLayout() {
  const code = fs.readFileSync(SCENE_FILE, 'utf8');
  const block = code.match(/\/\/ LABEL_LAYOUT:BEGIN[\s\S]*?\/\/ LABEL_LAYOUT:END/);
  assert.ok(block, 'scene.js contains the LABEL_LAYOUT block');
  const script = [
    block[0],
    'globalThis.__labels = { labelRect, labelsOverlap, labelTargetOpacity, labelOpacityStep, bodyOccluded,',
    '  LABEL_SIDE, LABEL_GAP_PAD, LABEL_EDGE, LABEL_FADE_MIN, LABEL_OVERLAP_HYST, LABEL_FADE_RATE };',
  ].join('\n');
  const ctx = vm.createContext({ Math });
  vm.runInContext(script, ctx);
  return ctx.__labels;
}

const L = loadLabelLayout();

// Deterministic pseudo random numbers (LCG), so every run checks the same cases
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const VIEW = { w: 640, h: 520 };
const STEPS = ['router', 'user', 'appdev', 'qa', 'study', 'portfolio'];
const LABEL_W = 110;
const LABEL_H = 34;

// ---- 1. Fixed side, no relocation ----

test('side: each planet has a fixed side, the sun label is below and the beacon label is to the right', () => {
  assert.equal(L.LABEL_SIDE.router, 'below');
  assert.equal(L.LABEL_SIDE.user, 'right');
  for (const step of STEPS) assert.ok(['right', 'above', 'below'].includes(L.LABEL_SIDE[step]), `${step} has a side`);
  assert.equal(Object.isFrozen(L.LABEL_SIDE), true, 'the side table cannot be changed at run time');
});

test('side: labelRect puts the label on its side of the anchor, the gap apart', () => {
  const a = { ax: 300, ay: 200 };
  const above = L.labelRect('above', a.ax, a.ay, LABEL_W, LABEL_H, 20, VIEW);
  assert.equal(above.y + above.h, a.ay - 20, 'above: bottom edge is gap px above the anchor');
  assert.equal(above.x, a.ax - LABEL_W / 2, 'above: centred on the anchor');
  const below = L.labelRect('below', a.ax, a.ay, LABEL_W, LABEL_H, 20, VIEW);
  assert.equal(below.y, a.ay + 20, 'below: top edge is gap px below the anchor');
  const right = L.labelRect('right', a.ax, a.ay, LABEL_W, LABEL_H, 20, VIEW);
  assert.equal(right.x, a.ax + 20, 'right: left edge is gap px right of the anchor');
  assert.equal(right.y, a.ay - LABEL_H / 2, 'right: vertically centred on the anchor');
});

test('no jump: while the planet moves, the label keeps the same offset and side (a wobble across the middle line too)', () => {
  // Anchor wobbles across the middle line (the old auto-side rule flipped here). The side must not change.
  const mid = VIEW.h / 2;
  const offsets = new Set();
  for (let frame = 0; frame < 300; frame++) {
    const ax = 320 + Math.sin(frame * 0.07) * 30;
    const ay = mid + Math.sin(frame * 0.3) * 40;
    const r = L.labelRect('above', ax, ay, LABEL_W, LABEL_H, 20, VIEW);
    offsets.add(`${(r.x - ax).toFixed(6)}|${(r.y - ay).toFixed(6)}`);
  }
  assert.equal(offsets.size, 1, 'one offset for every frame: the label rides along with its planet');
});

test('no relocation: a label rectangle depends only on its own anchor, never on the other labels', () => {
  // Fuzz: the rectangle of label X is the same whether X is alone or placed among crowded neighbours
  const rnd = makeRandom(20261012);
  for (let c = 0; c < 300; c++) {
    const items = STEPS.map((step) => ({ id: step, ax: rnd() * VIEW.w, ay: rnd() * VIEW.h, w: LABEL_W, h: LABEL_H, gap: 20, side: L.LABEL_SIDE[step] }));
    for (const it of items) {
      const alone = L.labelRect(it.side, it.ax, it.ay, it.w, it.h, it.gap, VIEW);
      const again = L.labelRect(it.side, it.ax, it.ay, it.w, it.h, it.gap, VIEW);
      assert.deepEqual(again, alone, `case ${c}: ${it.id} is the same rectangle every time`);
    }
  }
});

test('edge: a label of a planet off the top edge is kept inside the view (clamp only)', () => {
  const r = L.labelRect('above', 320, 2, LABEL_W, LABEL_H, 20, VIEW);
  assert.ok(r.y >= L.LABEL_EDGE, 'top edge clamp');
  assert.ok(r.y + r.h <= VIEW.h - L.LABEL_EDGE, 'bottom edge clamp');
});

test('edge: fuzz, every label rectangle stays inside the view for any anchor', () => {
  const rnd = makeRandom(7);
  for (let c = 0; c < 500; c++) {
    const side = ['right', 'above', 'below'][Math.floor(rnd() * 3)];
    const ax = (rnd() - 0.2) * (VIEW.w * 1.4);   // anchors may be well outside the view
    const ay = (rnd() - 0.2) * (VIEW.h * 1.4);
    const r = L.labelRect(side, ax, ay, LABEL_W, LABEL_H, 10 + rnd() * 30, VIEW);
    assert.ok(r.x >= L.LABEL_EDGE - 1e-9 && r.x + r.w <= VIEW.w - L.LABEL_EDGE + 1e-9, `case ${c}: x inside`);
    assert.ok(r.y >= L.LABEL_EDGE - 1e-9 && r.y + r.h <= VIEW.h - L.LABEL_EDGE + 1e-9, `case ${c}: y inside`);
  }
});

// ---- 2. Fade by depth on overlap ----

test('fade: two overlapping labels: the nearer one stays at 1, the farther one fades', () => {
  const items = [
    { id: 'far', rect: { x: 100, y: 100, w: LABEL_W, h: LABEL_H }, depth: 30, pinned: false },
    { id: 'near', rect: { x: 120, y: 100, w: LABEL_W, h: LABEL_H }, depth: 10, pinned: false },
  ];
  const t = L.labelTargetOpacity(items, null, L.LABEL_GAP_PAD);
  assert.equal(t.get('near'), 1, 'the nearer label is fully readable');
  assert.equal(t.get('far'), L.LABEL_FADE_MIN, 'the farther label fades');
});

test('fade: labels that do not overlap all stay at 1, whatever their depth', () => {
  const items = [
    { id: 'a', rect: { x: 0, y: 0, w: 50, h: 20 }, depth: 40, pinned: false },
    { id: 'b', rect: { x: 300, y: 300, w: 50, h: 20 }, depth: 5, pinned: false },
  ];
  const t = L.labelTargetOpacity(items, null, L.LABEL_GAP_PAD);
  assert.equal(t.get('a'), 1);
  assert.equal(t.get('b'), 1);
});

test('fade: the pad counts as overlap (labels closer than LABEL_GAP_PAD are treated as overlapping)', () => {
  const pad = L.LABEL_GAP_PAD;
  const near = { id: 'near', rect: { x: 0, y: 0, w: 50, h: 20 }, depth: 1, pinned: false };
  const touching = { id: 'far', rect: { x: 50 + pad - 1, y: 0, w: 50, h: 20 }, depth: 2, pinned: false };
  const apart = { id: 'far', rect: { x: 50 + pad + 1, y: 0, w: 50, h: 20 }, depth: 2, pinned: false };
  assert.equal(L.labelTargetOpacity([near, touching], null, pad).get('far'), L.LABEL_FADE_MIN);
  assert.equal(L.labelTargetOpacity([near, apart], null, pad).get('far'), 1);
});

test('fade: a faded label does not hide labels behind it (no chain reaction)', () => {
  // A (nearest) overlaps B; B (faded) overlaps C; A does not overlap C. C must stay visible.
  const items = [
    { id: 'A', rect: { x: 0, y: 0, w: 60, h: 20 }, depth: 1, pinned: false },
    { id: 'B', rect: { x: 40, y: 0, w: 60, h: 20 }, depth: 2, pinned: false },
    { id: 'C', rect: { x: 90, y: 0, w: 60, h: 20 }, depth: 3, pinned: false },
  ];
  const t = L.labelTargetOpacity(items, null, 0);
  assert.equal(t.get('A'), 1);
  assert.equal(t.get('B'), L.LABEL_FADE_MIN, 'B overlaps A');
  assert.equal(t.get('C'), 1, 'C overlaps only the faded B: it is not hidden by a label that is not shown');
});

test('fade: a pinned (hovered or focused) label is always at 1, even when it is the farther one', () => {
  const items = [
    { id: 'near', rect: { x: 100, y: 100, w: LABEL_W, h: LABEL_H }, depth: 10, pinned: false },
    { id: 'far', rect: { x: 120, y: 100, w: LABEL_W, h: LABEL_H }, depth: 30, pinned: true },
  ];
  const t = L.labelTargetOpacity(items, null, L.LABEL_GAP_PAD);
  assert.equal(t.get('far'), 1, 'the pinned label is never faded');
});

test('fade: the depth tie is broken by id, so the result is the same for any input order', () => {
  const a = { id: 'a', rect: { x: 0, y: 0, w: 60, h: 20 }, depth: 5, pinned: false };
  const b = { id: 'b', rect: { x: 30, y: 0, w: 60, h: 20 }, depth: 5, pinned: false };
  const t1 = L.labelTargetOpacity([a, b], null, 0);
  const t2 = L.labelTargetOpacity([b, a], null, 0);
  assert.deepEqual([...t1.entries()], [...t2.entries()]);
  assert.equal(t1.get('a'), 1, 'the smaller id wins a tie');
  assert.equal(t1.get('b'), L.LABEL_FADE_MIN);
});

test('hysteresis: a faded label stays faded while it is still close (no flicker at the threshold)', () => {
  const pad = L.LABEL_GAP_PAD;
  // Near label at x=0..60; far label moves in x so the gap to the near label alternates between
  // "touching" (inside the pad, overlap) and "a few px clear" (inside pad + LABEL_OVERLAP_HYST, still overlapping for a faded label)
  let prev = null;
  const targets = [];
  for (let frame = 0; frame < 200; frame++) {
    const gap = frame % 2 === 0 ? pad - 2 : pad + 3;   // gap in px between the two rectangles
    const items = [
      { id: 'near', rect: { x: 0, y: 0, w: 60, h: 20 }, depth: 1, pinned: false },
      { id: 'far', rect: { x: 60 + gap, y: 0, w: 60, h: 20 }, depth: 2, pinned: false },
    ];
    prev = L.labelTargetOpacity(items, prev, pad);
    targets.push(prev.get('far'));
  }
  const changes = targets.slice(1).filter((v, i) => v !== targets[i]).length;
  assert.equal(changes, 0, 'the target does not flip while the gap alternates around the threshold');
  assert.equal(targets[199], L.LABEL_FADE_MIN, 'and it stays faded');
});

test('hysteresis: a faded label is shown again only after it is clear by pad + LABEL_OVERLAP_HYST', () => {
  const pad = L.LABEL_GAP_PAD;
  const near = { id: 'near', rect: { x: 0, y: 0, w: 60, h: 20 }, depth: 1, pinned: false };
  const far = (gap) => ({ id: 'far', rect: { x: 60 + gap, y: 0, w: 60, h: 20 }, depth: 2, pinned: false });
  const faded = L.labelTargetOpacity([near, far(0)], null, pad);
  assert.equal(faded.get('far'), L.LABEL_FADE_MIN);
  const stillClose = L.labelTargetOpacity([near, far(pad + 3)], faded, pad);
  assert.equal(stillClose.get('far'), L.LABEL_FADE_MIN, 'inside pad + hysteresis: still faded');
  const clear = L.labelTargetOpacity([near, far(pad + L.LABEL_OVERLAP_HYST + 2)], stillClose, pad);
  assert.equal(clear.get('far'), 1, 'clear by pad + hysteresis: shown again');
});

// ---- 3. Opacity easing ----

test('easing: opacity moves monotonically toward the target and never overshoots', () => {
  let from = 1;
  const to = L.LABEL_FADE_MIN;
  for (let frame = 0; frame < 600; frame++) {
    const next = L.labelOpacityStep(from, to, 1 / 60);
    assert.ok(next <= from + 1e-12, `frame ${frame}: moves toward the target`);
    assert.ok(next >= to - 1e-12, `frame ${frame}: no overshoot past the target`);
    from = next;
  }
  assert.ok(Math.abs(from - to) < 1e-3, 'settles on the target');
});

test('easing: dt = 0 jumps to the target at once; a new label (no previous value) starts at its target', () => {
  assert.equal(L.labelOpacityStep(1, L.LABEL_FADE_MIN, 0), L.LABEL_FADE_MIN);
  assert.equal(L.labelOpacityStep(undefined, 1, 1 / 60), 1);
  assert.equal(L.labelOpacityStep(0.5, 0.5, 1 / 60), 0.5, 'already at the target: no change');
});

test('easing: the step is slow enough to read (about a tenth of the gap per 1/LABEL_FADE_RATE second)', () => {
  // With rate R, one time constant (1/R s) closes 1 - 1/e of the gap
  const k = 1 - Math.exp(-L.LABEL_FADE_RATE * (1 / L.LABEL_FADE_RATE));
  const from = 1;
  const next = L.labelOpacityStep(from, 0, 1 / L.LABEL_FADE_RATE);
  assert.ok(Math.abs((from - next) / from - k) < 1e-9, 'one time constant closes the expected share');
  assert.ok(k > 0.6 && k < 0.7, 'a time constant closes about 63 percent of the gap');
});

// ---- Occlusion (unchanged) ----

test('bodyOccluded: a sphere between camera and target hides it; a sphere to the side or behind does not', () => {
  const cam = { x: 0, y: 0, z: 20 };
  const target = { x: 0, y: 0, z: -10 };
  assert.equal(L.bodyOccluded(cam, target, 0.6, [{ x: 0, y: 0, z: 0, r: 1.5 }]), true, 'sun in front hides the planet');
  assert.equal(L.bodyOccluded(cam, target, 0.6, [{ x: 5, y: 0, z: 0, r: 1.5 }]), false, 'sphere beside the line of sight');
  assert.equal(L.bodyOccluded(cam, target, 0.6, [{ x: 0, y: 0, z: -20, r: 1.5 }]), false, 'sphere behind the target');
  assert.equal(L.bodyOccluded(cam, target, 0.6, [{ x: 0, y: 0, z: 25, r: 1.5 }]), false, 'sphere behind the camera');
  assert.equal(L.bodyOccluded(cam, target, 0.6, []), false, 'no occluders');
});

test('bodyOccluded: a sphere whose centre is behind the target front surface is ignored', () => {
  // Target at z=-10 with radius 0.6: its front surface faces the camera at z=-9.4.
  // The occluder centre at z=-9.8 is behind that surface, so the target itself covers it.
  const cam = { x: 0, y: 0, z: 20 };
  const target = { x: 0, y: 0, z: -10 };
  assert.equal(L.bodyOccluded(cam, target, 0.6, [{ x: 0, y: 0, z: -9.8, r: 0.2 }]), false, 'hidden by the target itself, not an occluder');
  // The same small sphere centred in front of the target surface does hide it
  assert.equal(L.bodyOccluded(cam, target, 0.6, [{ x: 0, y: 0, z: -9.0, r: 0.2 }]), true, 'in front of the target surface: occludes');
});
