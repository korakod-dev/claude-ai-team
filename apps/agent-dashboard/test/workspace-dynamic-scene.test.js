'use strict';
/**
 * workspace-dynamic-scene.test.js - dynamic planets in the 3D scene (public/workspace/scene.js):
 *   - layout: each dynamic ring is outside the registered rings, spaced like them, and no two bodies can touch
 *   - the energy ring of a dynamic planet stays inside its layout extent
 *   - camera fit: with the dynamic rings in the fit, every dynamic planet is inside the frame, and the cached solve
 *     is recomputed after invalidate()
 *   - labels: a dynamic label has the fixed side "above" and the same fade rule as the registered labels
 *   - the registered four keep their radii and their look constants
 *   - wiring: scene.js, server.js and the README name the dynamic planets, the cap and the new module
 * scene.js is a browser module (THREE, DOM), so the blocks are extracted and run in a Function scope, as the other
 * layout tests do (test/workspace-orbit.test.js, test/workspace-labels.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const SCENE_FILE = path.join(WORKSPACE_DIR, 'scene.js');
const DYNAMIC_FILE = path.join(WORKSPACE_DIR, 'stellar', 'dynamic.js');
const SERVER_FILE = path.join(__dirname, '..', 'server.js');
const README_FILE = path.join(__dirname, '..', 'README.md');

/**
 * Run the ORBIT_LAYOUT, CAMERA_FIT and LABEL_LAYOUT blocks of scene.js in their own scope and return the names the tests
 * need. The camera constants are checked against scene.js first, so the copies below cannot drift.
 */
function loadBlocks() {
  const code = fs.readFileSync(SCENE_FILE, 'utf8');
  const layout = code.match(/\/\/ ORBIT_LAYOUT:BEGIN[\s\S]*?\/\/ ORBIT_LAYOUT:END/);
  const fit = code.match(/\/\/ CAMERA_FIT:BEGIN[\s\S]*?\/\/ CAMERA_FIT:END/);
  const labels = code.match(/\/\/ LABEL_LAYOUT:BEGIN[\s\S]*?\/\/ LABEL_LAYOUT:END/);
  const sun = code.match(/const SUN_RADIUS = ([\d.]+);/);
  assert.ok(layout && fit && labels, 'scene.js has the ORBIT_LAYOUT, CAMERA_FIT and LABEL_LAYOUT blocks');
  assert.ok(sun, 'scene.js has SUN_RADIUS');
  assert.match(code, /const CAMERA_FOV = 50;/, 'CAMERA_FOV is 50 degrees (FOV_RAD below)');
  assert.match(code, /const LOOK_AT = new THREE\.Vector3\(0, 0\.4, 0\);/, 'LOOK_AT height is 0.4 (LOOK_Y below)');
  assert.match(code, /const BASE_PITCH = 0\.34;/, 'BASE_PITCH is 0.34 (BASE_PITCH below)');

  const script = [
    `const SUN_RADIUS = ${sun[1]};`,
    layout[0],
    fit[0],
    labels[0],
    'const __api = {',
    '  SATELLITE_ORBIT_RADIUS, SATELLITE_EXTENT, SATELLITE_ORBIT_ORDER, ORBIT_GAP_MARGIN, ORBIT_BOB_AMPLITUDE, LABEL_ROOM,',
    '  satelliteClearance, satellitePosition, DYNAMIC_EXTENT, DYNAMIC_CLEARANCE, DYNAMIC_ORBIT_BASE, dynamicOrbitRadius,',
    '  REGISTERED_FIT_ORBITS, setFitOrbits, createFitCache, fitViewAtPitch, fitDistanceAtPitch, projectToNdc,',
    '  FIT_EDGE_PAD, FIT_ANGLE_STEPS, FIT_DIRECTIONS, getFitPoints: () => FIT_POINTS,',
    '  labelSideOf, LABEL_SIDE, labelRect, labelTargetOpacity, LABEL_FADE_MIN, LABEL_GAP_PAD, LABEL_EDGE,',
    '};',
    'return __api;',
  ].join('\n');
  return new Function(script)();
}

const L = loadBlocks();
const FOV_RAD = 50 * Math.PI / 180;
const LOOK_Y = 0.4;
const BASE_PITCH = 0.34;
const REGISTERED_STEPS = ['pm', 'qa', 'study', 'appdev', 'portfolio', 'advisor'];   // inner -> outer (SATELLITE_ORBIT_ORDER)
const MAX_DYNAMIC = 4;                                             // MAX_DYNAMIC_PLANETS (stellar/dynamic.js), checked below

/** The dynamic orbits for n planets: radius and extent, as scene.js builds them. */
function dynamicOrbits(n) {
  return Array.from({ length: n }, (_, i) => ({ radius: L.dynamicOrbitRadius(i), extent: L.DYNAMIC_EXTENT }));
}

/** Registered orbits plus n dynamic ones (the fit list of scene.js: activeFitOrbits()). */
function fitOrbits(n) {
  return L.REGISTERED_FIT_ORBITS.concat(dynamicOrbits(n));
}

/** Everything in one list: { radius, extent, step } for the registered and the dynamic orbits, inner -> outer. */
function allOrbits(n) {
  const reg = REGISTERED_STEPS.map((step) => ({ step, radius: L.SATELLITE_ORBIT_RADIUS[step], extent: L.SATELLITE_EXTENT[step] }));
  const dyn = dynamicOrbits(n).map((o, i) => ({ step: `dyn${i}`, radius: o.radius, extent: o.extent }));
  return reg.concat(dyn).sort((a, b) => a.radius - b.radius);
}

test('layout: the dynamic rings are outside the registered rings, the first clears the outermost, the spacing is fixed', () => {
  const outer = L.SATELLITE_ORBIT_RADIUS[L.SATELLITE_ORBIT_ORDER[L.SATELLITE_ORBIT_ORDER.length - 1]];
  const outerStep = L.SATELLITE_ORBIT_ORDER[L.SATELLITE_ORBIT_ORDER.length - 1];
  const r0 = L.dynamicOrbitRadius(0);
  assert.ok(r0 > outer, 'the first dynamic ring is outside every registered ring');
  const expected0 = outer + L.satelliteClearance(outerStep) + L.DYNAMIC_CLEARANCE + L.ORBIT_GAP_MARGIN;
  assert.ok(Math.abs(r0 - expected0) < 1e-9, 'the first ring follows the same gap rule as the registered rings');
  const step = 2 * L.DYNAMIC_CLEARANCE + L.ORBIT_GAP_MARGIN;
  for (let i = 1; i < MAX_DYNAMIC; i++) {
    const gap = L.dynamicOrbitRadius(i) - L.dynamicOrbitRadius(i - 1);
    assert.ok(Math.abs(gap - step) < 1e-9, `ring ${i} is one spacing step outside ring ${i - 1}`);
  }
});

test('layout: no two orbiting bodies can touch (every pair of rings, all phases sampled)', () => {
  const orbits = allOrbits(MAX_DYNAMIC);
  assert.equal(orbits.length, REGISTERED_STEPS.length + MAX_DYNAMIC);
  // Analytic rule: the radius gap clears both extents (with the bob) and the margin
  for (let a = 0; a < orbits.length; a++) {
    for (let b = a + 1; b < orbits.length; b++) {
      const gap = orbits[b].radius - orbits[a].radius;
      const need = orbits[a].extent + L.ORBIT_BOB_AMPLITUDE + orbits[b].extent + L.ORBIT_BOB_AMPLITUDE + L.ORBIT_GAP_MARGIN;
      assert.ok(gap >= need - 1e-9, `${orbits[a].step} and ${orbits[b].step} are far enough apart`);
    }
  }
  // Sampled check in 3D: every pair, a grid of phases and four times, the centre distance clears both extents
  const phases = Array.from({ length: 24 }, (_, k) => (k / 24) * Math.PI * 2);
  for (const t of [0, 13.7, 55.2, 120.4]) {
    for (let a = 0; a < orbits.length; a++) {
      for (let b = a + 1; b < orbits.length; b++) {
        for (const pa of phases) {
          for (const pb of phases) {
            const pA = L.satellitePosition({ angle: pa, radius: orbits[a].radius }, t, { set(x, y, z) { return [x, y, z]; } });
            const pB = L.satellitePosition({ angle: pb, radius: orbits[b].radius }, t, { set(x, y, z) { return [x, y, z]; } });
            const d = Math.hypot(pA[0] - pB[0], pA[1] - pB[1], pA[2] - pB[2]);
            assert.ok(d - orbits[a].extent - orbits[b].extent > 0, `${orbits[a].step}/${orbits[b].step} never touch`);
          }
        }
      }
    }
  }
});

test('layout: the energy ring of a dynamic planet stays inside DYNAMIC_EXTENT (ring scale, energy per task, body radius)', () => {
  const code = fs.readFileSync(SCENE_FILE, 'utf8');
  const num = (name) => Number(code.match(new RegExp(`const ${name} = ([\\d.]+);`))[1]);
  const ringScale = num('DYNAMIC_RING_SCALE');
  const reach = (ringScale + num('ENERGY_PER_TASK') * num('ENERGY_MAX_TASKS')) * num('BODY_RADIUS');
  assert.ok(reach <= L.DYNAMIC_EXTENT, `energy ring reach ${reach.toFixed(3)} <= extent ${L.DYNAMIC_EXTENT}`);
});

test('camera fit: with the dynamic rings in the fit, every dynamic planet is inside the frame (aspects, pitches, yaws)', () => {
  const n = MAX_DYNAMIC;
  L.setFitOrbits(fitOrbits(n));
  // Independent dense sample of the dynamic planets: angles on each ring, both bob extremes, centre and label reach
  const dirs = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) dirs.push([x, y, z]);
  const pts = [];
  for (const o of dynamicOrbits(n)) {
    const reach = o.extent + L.LABEL_ROOM;
    for (let k = 0; k < 120; k++) {
      const a = (k / 120) * Math.PI * 2;
      for (const by of [-L.ORBIT_BOB_AMPLITUDE, L.ORBIT_BOB_AMPLITUDE]) {
        const c = [Math.cos(a) * o.radius, by, Math.sin(a) * o.radius];
        pts.push(c);
        for (const d of dirs) {
          const m = Math.hypot(d[0], d[1], d[2]);
          pts.push([c[0] + (d[0] / m) * reach, c[1] + (d[1] / m) * reach, c[2] + (d[2] / m) * reach]);
        }
      }
    }
  }
  const failures = [];
  for (const aspect of [0.6, 1.0, 1.8]) {
    for (const pitch of [0.09, BASE_PITCH, 1.19]) {
      const view = L.fitViewAtPitch(aspect, FOV_RAD, pitch, LOOK_Y, {});
      for (const yaw of [0, 1.2]) {
        const cam = [view.distance * Math.cos(pitch) * Math.sin(yaw), view.lookY + view.distance * Math.sin(pitch),
          view.distance * Math.cos(pitch) * Math.cos(yaw)];
        let worst = 0;
        for (const p of pts) {
          const q = L.projectToNdc(p, cam, [0, view.lookY, 0], FOV_RAD, aspect);
          if (!(q.depth > 0)) { worst = Infinity; break; }
          worst = Math.max(worst, Math.abs(q.x), Math.abs(q.y));
        }
        if (!(worst <= 1)) failures.push(`aspect ${aspect}, pitch ${pitch}, yaw ${yaw}: |ndc| ${worst}`);
      }
    }
  }
  L.setFitOrbits(L.REGISTERED_FIT_ORBITS);   // restore the registered-only fit for the other tests
  assert.deepEqual(failures, [], 'no dynamic planet is cut off at the frame edge');
});

test('camera fit: adding dynamic rings zooms the fitted view out (the system is bigger), and the cache needs invalidate()', () => {
  L.setFitOrbits(L.REGISTERED_FIT_ORBITS);
  const cache = L.createFitCache(LOOK_Y);
  const before = cache.solve(1.0, FOV_RAD, BASE_PITCH).distance;
  assert.equal(cache.solves, 1);
  cache.solve(1.0, FOV_RAD, BASE_PITCH);
  assert.equal(cache.solves, 1, 'the same inputs are served from the cache');

  L.setFitOrbits(fitOrbits(MAX_DYNAMIC));
  cache.solve(1.0, FOV_RAD, BASE_PITCH);
  assert.equal(cache.solves, 1, 'without invalidate() the old solve is still used (scene.js calls invalidate)');
  cache.invalidate();
  const after = cache.solve(1.0, FOV_RAD, BASE_PITCH).distance;
  assert.equal(cache.solves, 2, 'after invalidate() the solve runs again');
  assert.ok(after > before, `the fitted distance grows with the dynamic rings (${before.toFixed(2)} -> ${after.toFixed(2)})`);
  L.setFitOrbits(L.REGISTERED_FIT_ORBITS);
});

test('camera fit: with no dynamic planet the fit points are the registered ones (the default view does not change)', () => {
  L.setFitOrbits(L.REGISTERED_FIT_ORBITS);
  const points = L.getFitPoints();
  const perOrbit = L.FIT_ANGLE_STEPS * 2 * (1 + L.FIT_DIRECTIONS.length);
  assert.equal(points.length, REGISTERED_STEPS.length * perOrbit, 'six orbits (Advisor + PM-Professor-X + the four older ones), the same sample count per orbit as before');
});

test('labels: a dynamic label sits on the fixed side "above"; the registered sides are unchanged', () => {
  assert.equal(L.labelSideOf('dyn:data-analyst'), 'above');
  assert.equal(L.labelSideOf('constructor'), 'above', 'prototype keys fall back to the dynamic side');
  assert.equal(L.labelSideOf('router'), 'below');
  assert.equal(L.labelSideOf('user'), 'right');
  for (const step of REGISTERED_STEPS) assert.equal(L.labelSideOf(step), L.LABEL_SIDE[step], step);
  const view = { w: 800, h: 600 };
  const dynRect = L.labelRect(L.labelSideOf('dyn:x'), 300, 300, 120, 30, 20, view);
  const aboveRect = L.labelRect('above', 300, 300, 120, 30, 20, view);
  assert.deepEqual(dynRect, aboveRect, 'the dynamic label is placed exactly like an "above" label');
});

test('labels: a dynamic label fades like the others when it overlaps a nearer label', () => {
  const rect = { x: 100, y: 100, w: 80, h: 20 };
  const items = [
    { id: 'appdev', depth: 5, rect, pinned: false },
    { id: 'dyn:far', depth: 9, rect: { ...rect, x: 110 }, pinned: false },
    { id: 'dyn:apart', depth: 9, rect: { x: 400, y: 400, w: 80, h: 20 }, pinned: false },
  ];
  const targets = L.labelTargetOpacity(items, null, L.LABEL_GAP_PAD);
  assert.equal(targets.get('appdev'), 1, 'the nearer label stays at full opacity');
  assert.equal(targets.get('dyn:far'), L.LABEL_FADE_MIN, 'the farther dynamic label fades');
  assert.equal(targets.get('dyn:apart'), 1, 'a dynamic label with room stays visible');
});

test('registered planets: radii and extents of the registered layout (PM-Professor-X innermost; Advisor outermost; the dynamic rings only come after advisor)', () => {
  // The radii follow the registered formula. PM-Professor-X was added as the innermost orbit, so every older orbit moved out by 3.87. Advisor was added as the outermost orbit (25.07), so the older radii are unchanged.
  const radii = Object.fromEntries(REGISTERED_STEPS.map((s) => [s, Number(L.SATELLITE_ORBIT_RADIUS[s].toFixed(2))]));
  assert.deepEqual(radii, { pm: 5.54, qa: 9.44, study: 13.34, appdev: 17.21, portfolio: 21.14, advisor: 25.07 });
  assert.deepEqual(REGISTERED_STEPS.map((s) => L.SATELLITE_EXTENT[s]), [1.46, 1.49, 1.46, 1.46, 1.52, 1.46]);
});

test('wiring: scene.js uses the registry and the cap, refits the camera, builds the label and routes every event through it', () => {
  const code = fs.readFileSync(SCENE_FILE, 'utf8');
  assert.match(code, /import \{ MAX_DYNAMIC_PLANETS, createDynamicRegistry, cssHex \} from '\.\/stellar\/dynamic\.js';/);
  assert.match(code, /const dynamic = createDynamicRegistry\(MAX_DYNAMIC_PLANETS\);/);
  assert.match(code, /function ensureDynamicPlanet\(agent\) \{[\s\S]*?buildDynamicPlanet\(dynamic\.get\(res\.key\)\);[\s\S]*?refitCamera\(\);/,
    'a new dynamic planet is built and the camera refitted');
  assert.match(code, /function refitCamera\(\) \{\s*setFitOrbits\(activeFitOrbits\(\)\);\s*camFit\.invalidate\(\);/,
    'the refit updates the fit points and invalidates the cached solve');
  assert.match(code, /const step = stepOfEvent\(ev\);\s*const bodyKey = step \|\| ensureDynamicPlanet\(ev\.agent\);/,
    'every event without a registered step goes through ensureDynamicPlanet');
  assert.match(code, /\[\.\.\.LABEL_ORDER, \.\.\.dynamic\.keys\(\)\]/, 'the label loop includes the dynamic planets');
  assert.match(code, /if \(active && !detail\.replay\) handoff\(SUN_STEP, bodyKey\);/,
    'a dynamic dispatch draws its comet, not during the replay burst');
  assert.match(code, /if \(res\.status === 'full' && res\.first\) \{/, 'the cap is logged once per agent');
  assert.match(fs.readFileSync(DYNAMIC_FILE, 'utf8'), /export const MAX_DYNAMIC_PLANETS = 4;/, 'the cap is 4');
});

test('wiring: server.js serves the new module and the file exists', () => {
  const server = fs.readFileSync(SERVER_FILE, 'utf8');
  assert.match(server, /'\/workspace\/stellar\/dynamic\.js': \{ file: path\.join\(PUBLIC_DIR, 'workspace', 'stellar', 'dynamic\.js'\)/);
  assert.ok(fs.existsSync(DYNAMIC_FILE));
});

test('docs: the README describes the dynamic planets, the cap and what happens beyond it', () => {
  const readme = fs.readFileSync(README_FILE, 'utf8');
  assert.match(readme, /MAX_DYNAMIC_PLANETS/, 'the README names the cap constant');
  assert.match(readme, /dyn:/, 'the README names the body key of a dynamic planet');
});
