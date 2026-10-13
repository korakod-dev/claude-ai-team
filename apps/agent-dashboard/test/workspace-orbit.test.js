'use strict';
/**
 * workspace-orbit.test.js - Orbit layout and camera fit of the 3D workspace (public/workspace/scene.js).
 *
 * scene.js is a browser module (it needs window, WebGL and Three.js), so this test does not import it.
 * It extracts the ORBIT_LAYOUT and CAMERA_FIT blocks (between their BEGIN / END markers) and the SATELLITE_CONFIG
 * table, runs them in their own function scope (no access to this file's globals), and checks:
 *   - every satellite has its own orbit radius, and neighbouring orbits keep the required gap
 *   - the innermost orbit clears the sun
 *   - sampled over a long time (all phases), no two satellite bodies (planet + decorations) touch in 3D
 *   - camera fit: projecting dense samples of every satellite (bob, extent, label room) with a generic look-at
 *     projection, all of them are inside the viewport for several aspect ratios, every pitch of the allowed range
 *     and several yaw angles. The camera uses the look-at height solved by fitViewAtPitch(), so the check uses that
 *     height too. The fit is also tight (a camera 15 % closer loses something off screen).
 *   - look-at solve: the search finds the minimum of the fit over its interval, never does worse than the base
 *     look-at height, stays inside LOOK_Y_MAX_SHIFT, and keeps the sun near the middle of the screen.
 *   - look-at dead-band: no shift at aspect 1.0 (gain about 1 %), full shift at aspect 2.0 (gain about 7 %), the
 *     shift follows the gain thresholds, and the height and distance change continuously across the threshold.
 *   - solve cache: same inputs reuse the solve, a pitch change within the tolerance reuses it, a real change
 *     recomputes, and the cached camera (at the pitch it was solved for) still frames every satellite.
 * Pure computation, no files written, no network. Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SCENE_FILE = path.join(__dirname, '..', 'public', 'workspace', 'scene.js');

// Camera values of scene.js (CAMERA_FOV, LOOK_AT.y, BASE_PITCH); checked against the source in loadLayout()
const FOV_RAD = 50 * Math.PI / 180;
const LOOK_Y = 0.4;       // base look-at height (LOOK_AT.y); the fit may move it by LOOK_Y_MAX_SHIFT
const BASE_PITCH = 0.34;

/**
 * Run the orbit layout and camera fit blocks of scene.js in their own function scope and return the values the tests need.
 * A new Function is used instead of a vm context: the fit solve is about 180 times faster this way (vm global lookups).
 */
function loadLayout() {
  const code = fs.readFileSync(SCENE_FILE, 'utf8');
  const block = code.match(/\/\/ ORBIT_LAYOUT:BEGIN[\s\S]*?\/\/ ORBIT_LAYOUT:END/);
  const fit = code.match(/\/\/ CAMERA_FIT:BEGIN[\s\S]*?\/\/ CAMERA_FIT:END/);
  const config = code.match(/const SATELLITE_CONFIG = \{[\s\S]*?\n\};/);
  const sun = code.match(/const SUN_RADIUS = ([\d.]+);/);
  assert.ok(block, 'scene.js contains the ORBIT_LAYOUT block');
  assert.ok(fit, 'scene.js contains the CAMERA_FIT block');
  assert.ok(config, 'scene.js contains SATELLITE_CONFIG');
  assert.ok(sun, 'scene.js contains SUN_RADIUS');
  // The fit test uses its own copies of the camera values: make sure they still match scene.js
  assert.match(code, /const CAMERA_FOV = 50;/, 'CAMERA_FOV is 50 degrees (FOV_RAD above)');
  assert.match(code, /const LOOK_AT = new THREE\.Vector3\(0, 0\.4, 0\);/, 'LOOK_AT height is 0.4 (LOOK_Y above)');
  assert.match(code, /const BASE_PITCH = 0\.34;/, 'BASE_PITCH is 0.34 (BASE_PITCH above)');

  const script = [
    `const SUN_RADIUS = ${sun[1]};`,
    config[0],
    block[0],
    fit[0],
    'const __layout = { SATELLITE_CONFIG, SATELLITE_ORBIT_RADIUS, SATELLITE_EXTENT, SATELLITE_ORBIT_ORDER,',
    '  ORBIT_GAP_MARGIN, ORBIT_BOB_AMPLITUDE, SUN_CLEARANCE, LABEL_ROOM, satelliteClearance, satellitePosition,',
    '  CAMERA_PITCH_MIN, CAMERA_PITCH_MAX, LOOK_Y_MAX_SHIFT, fitDistanceAtPitch, fitViewAtPitch, projectToNdc,',
    '  searchLookAtHeight, smoothstep, createFitCache, FIT_SHIFT_GAIN_ZERO, FIT_SHIFT_GAIN_FULL, FIT_PITCH_TOLERANCE };',
  ].join('\n');
  // The script ends with a return statement, so the layout object comes out of the function scope
  return new Function(`${script}\nreturn __layout;`)();
}

const L = loadLayout();
const STEPS = Object.keys(L.SATELLITE_CONFIG);

test('layout: every satellite has its own orbit radius (no two share one)', () => {
  assert.deepEqual([...STEPS].sort(), [...L.SATELLITE_ORBIT_ORDER].sort(), 'the order lists exactly the four satellites');
  const radii = STEPS.map((step) => L.SATELLITE_ORBIT_RADIUS[step]);
  assert.ok(radii.every((r) => Number.isFinite(r) && r > 0), 'every radius is a positive number');
  assert.equal(new Set(radii).size, STEPS.length, 'all radii are distinct');
  // Plain loop: keep the assertions independent of array prototypes
  for (let i = 1; i < L.SATELLITE_ORBIT_ORDER.length; i++) {
    const inner = L.SATELLITE_ORBIT_RADIUS[L.SATELLITE_ORBIT_ORDER[i - 1]];
    const outer = L.SATELLITE_ORBIT_RADIUS[L.SATELLITE_ORBIT_ORDER[i]];
    assert.ok(inner < outer, 'the order runs inner -> outer');
  }
});

test('layout: neighbouring orbits keep the gap (clearance of both + margin)', () => {
  const order = L.SATELLITE_ORBIT_ORDER;
  for (let i = 1; i < order.length; i++) {
    const inner = order[i - 1];
    const outer = order[i];
    const gap = L.SATELLITE_ORBIT_RADIUS[outer] - L.SATELLITE_ORBIT_RADIUS[inner];
    const needed = L.satelliteClearance(inner) + L.satelliteClearance(outer) + L.ORBIT_GAP_MARGIN;
    assert.ok(gap >= needed - 1e-9, `${inner} -> ${outer}: gap ${gap.toFixed(3)} >= ${needed.toFixed(3)}`);
  }
});

test('layout: the innermost orbit clears the sun corona', () => {
  const first = L.SATELLITE_ORBIT_ORDER[0];
  const innerEdge = L.SATELLITE_ORBIT_RADIUS[first] - L.satelliteClearance(first);
  assert.ok(innerEdge >= L.SUN_CLEARANCE + L.ORBIT_GAP_MARGIN - 1e-9, 'no satellite body enters the sun corona');
});

test('layout: sampled over 700 s (all phases), no two satellite bodies touch and none enters the sun', () => {
  // Same angle update as scene.js (angle += speed * dt) and the same position function, sampled every 0.05 s.
  const dt = 0.05;
  const duration = 700;
  const states = STEPS.map((step) => ({
    step,
    orbit: { angle: L.SATELLITE_CONFIG[step].angle, speed: L.SATELLITE_CONFIG[step].speed, radius: L.SATELLITE_ORBIT_RADIUS[step] },
    pos: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } },
  }));
  const minPairGap = {};
  let minSunGap = Infinity;
  let steps = 0;

  for (let t = 0; t <= duration; t += dt) {
    steps += 1;
    for (const s of states) {
      s.orbit.angle = L.SATELLITE_CONFIG[s.step].angle + L.SATELLITE_CONFIG[s.step].speed * t;
      L.satellitePosition(s.orbit, t, s.pos);
      const fromSun = Math.hypot(s.pos.x, s.pos.y, s.pos.z) - L.satelliteClearance(s.step);
      minSunGap = Math.min(minSunGap, fromSun);
    }
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        const a = states[i];
        const b = states[j];
        const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
        // Surface-to-surface gap of the two extents (planet + decoration, without the bob margin)
        const gap = d - L.SATELLITE_EXTENT[a.step] - L.SATELLITE_EXTENT[b.step];
        const key = `${a.step}/${b.step}`;
        minPairGap[key] = Math.min(minPairGap[key] ?? Infinity, gap);
      }
    }
  }

  assert.ok(steps > 10000, 'the sample covers many orbit positions');
  for (const [key, gap] of Object.entries(minPairGap)) {
    assert.ok(gap > L.ORBIT_GAP_MARGIN, `${key}: smallest surface gap ${gap.toFixed(3)} is above the margin`);
  }
  assert.ok(minSunGap > 0, `no satellite body enters the sun (smallest gap ${minSunGap.toFixed(3)})`);
});

// ---------- camera fit ----------

const ASPECTS = [0.6, 1.0, 1.5, 2.0, 2.5];     // narrow, square-ish, normal, wide (1051x520 ~ 2.0), very wide
const YAWS = [0, 0.5, -0.22];                  // drift range of the camera is about +-0.22 rad
/** Pitches of the allowed range: both ends and the steps in between. */
function pitchSamples() {
  const out = [];
  for (let i = 0; i <= 8; i++) out.push(L.CAMERA_PITCH_MIN + (L.CAMERA_PITCH_MAX - L.CAMERA_PITCH_MIN) * (i / 8));
  return out;
}

/**
 * Independent dense sample of everything that must be on screen: every satellite on a fine circle (720 steps),
 * at both bob extremes, with its centre, and with 26 offset directions at extent + label room (planet, decoration,
 * label). Built here on purpose, not from the scene's own FIT_POINTS, so the test does not check the fit with itself.
 */
function denseSamplePoints() {
  const dirs = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    if (x || y || z) dirs.push([x, y, z]);
  }
  const pts = [];
  for (const step of L.SATELLITE_ORBIT_ORDER) {
    const r = L.SATELLITE_ORBIT_RADIUS[step];
    const reach = L.SATELLITE_EXTENT[step] + L.LABEL_ROOM;
    for (let k = 0; k < 720; k++) {
      const a = (k / 720) * Math.PI * 2;
      for (const by of [-L.ORBIT_BOB_AMPLITUDE, L.ORBIT_BOB_AMPLITUDE]) {
        const c = [Math.cos(a) * r, by, Math.sin(a) * r];
        pts.push(c);
        for (const d of dirs) {
          const n = Math.hypot(d[0], d[1], d[2]);
          pts.push([c[0] + (d[0] / n) * reach, c[1] + (d[1] / n) * reach, c[2] + (d[2] / n) * reach]);
        }
      }
    }
  }
  return pts;
}
const DENSE = denseSamplePoints();

/**
 * Camera position exactly as updateCamera() computes it: looks at (0, lookY, 0) from pitch and yaw at distance d.
 * lookY is the solved height from fitViewAtPitch(); the base height LOOK_Y is used when no solve is given.
 */
function cameraAt(d, pitch, yaw, lookY = LOOK_Y) {
  return [d * Math.cos(pitch) * Math.sin(yaw), lookY + d * Math.sin(pitch), d * Math.cos(pitch) * Math.cos(yaw)];
}

/** Largest |NDC| over the dense sample for a camera (1 = the frame edge). Points behind the camera give Infinity. */
function worstNdc(camPos, aspect, lookY = LOOK_Y) {
  const look = [0, lookY, 0];
  let worst = 0;
  for (const p of DENSE) {
    const n = L.projectToNdc(p, camPos, look, FOV_RAD, aspect);
    if (!(n.depth > 0)) return Infinity;
    worst = Math.max(worst, Math.abs(n.x), Math.abs(n.y));
  }
  return worst;
}

/** Solved view (look-at height and distance) for an aspect and pitch, as updateCamera() gets it. */
function solvedView(aspect, pitch) {
  return L.fitViewAtPitch(aspect, FOV_RAD, pitch, LOOK_Y, {});
}

test('camera fit: every satellite (bob, extent, label room) is inside the viewport for all aspects, pitches and yaws', () => {
  const failures = [];
  let checked = 0;
  for (const aspect of ASPECTS) {
    for (const pitch of pitchSamples()) {
      // Zoom 1 (cam.dist = fitDist) at this pitch: updateCamera() uses the solved distance and look-at height
      const view = solvedView(aspect, pitch);
      for (const yaw of YAWS) {
        checked += 1;
        const worst = worstNdc(cameraAt(view.distance, pitch, yaw, view.lookY), aspect, view.lookY);
        if (!(worst <= 1)) failures.push(`aspect ${aspect}, pitch ${pitch.toFixed(3)}, yaw ${yaw}: |ndc| ${worst}`);
      }
    }
  }
  assert.ok(checked === ASPECTS.length * 9 * YAWS.length, 'every aspect, pitch and yaw was checked');
  assert.deepEqual(failures, [], 'nothing is cut off at the frame edge');
});

test('camera fit: the default pitch fits at every aspect, and a narrow stage needs a longer distance than a wide one', () => {
  const views = ASPECTS.map((aspect) => solvedView(aspect, BASE_PITCH));
  ASPECTS.forEach((aspect, i) => {
    const v = views[i];
    assert.ok(worstNdc(cameraAt(v.distance, BASE_PITCH, 0, v.lookY), aspect, v.lookY) <= 1, `aspect ${aspect}: default view fits`);
  });
  // Narrow stages are limited by the width, so they need a longer distance. From about aspect 1.5 on the height
  // limits the view, so the distance stops changing with the width.
  const fits = views.map((v) => v.distance);
  assert.ok(fits[0] >= fits[1] && fits[1] >= fits[2] - 1e-9, 'narrower stages need a longer distance');
  assert.ok(Math.abs(fits[3] - fits[4]) < 1e-9, 'from aspect 2.0 on the height limits the view, so the fit no longer changes');
});

test('camera fit: tight, a camera 15 % closer than the fit loses part of the orbit system', () => {
  for (const aspect of ASPECTS) {
    for (const pitch of [L.CAMERA_PITCH_MIN, BASE_PITCH, L.CAMERA_PITCH_MAX]) {
      const view = solvedView(aspect, pitch);
      const worst = worstNdc(cameraAt(view.distance * 0.85, pitch, 0, view.lookY), aspect, view.lookY);
      assert.ok(worst > 1, `aspect ${aspect}, pitch ${pitch.toFixed(3)}: 0.85 x fit is cut off (|ndc| ${worst.toFixed(3)})`);
    }
  }
});

// ---------- look-at solve ----------

test('look-at solve: never worse than the base look-at height, and the height stays within LOOK_Y_MAX_SHIFT', () => {
  for (const aspect of ASPECTS) {
    for (const pitch of pitchSamples()) {
      const view = solvedView(aspect, pitch);
      const base = L.fitDistanceAtPitch(aspect, FOV_RAD, pitch, LOOK_Y);
      assert.ok(view.distance <= base + 1e-9, `aspect ${aspect}, pitch ${pitch.toFixed(3)}: solved ${view.distance} <= base ${base}`);
      assert.ok(Math.abs(view.lookY - LOOK_Y) <= L.LOOK_Y_MAX_SHIFT + 1e-9, `aspect ${aspect}: look-at shift is capped`);
      // The reported distance is the exact fit at the reported height (the framing guarantee holds for the pair)
      assert.ok(Math.abs(view.distance - L.fitDistanceAtPitch(aspect, FOV_RAD, pitch, view.lookY)) < 1e-9,
        `aspect ${aspect}: distance matches the fit at the solved height`);
    }
  }
});

test('look-at solve: the golden-section result matches a dense scan of the interval (the fit is convex in the height)', () => {
  // Checks the raw search (searchLookAtHeight), before the dead-band: the dead-band may keep the base height on purpose
  const steps = 400;   // scan spacing 0.0075 units: the solve must still be at or below every scan value
  const out = {};
  for (const aspect of [0.6, 1.5, 2.0]) {
    for (const pitch of [L.CAMERA_PITCH_MIN, BASE_PITCH, 0.7, L.CAMERA_PITCH_MAX]) {
      let scanMin = Infinity;
      for (let i = 0; i <= steps; i++) {
        const y = LOOK_Y - L.LOOK_Y_MAX_SHIFT + (2 * L.LOOK_Y_MAX_SHIFT * i) / steps;
        scanMin = Math.min(scanMin, L.fitDistanceAtPitch(aspect, FOV_RAD, pitch, y));
      }
      const raw = L.searchLookAtHeight(aspect, FOV_RAD, pitch, LOOK_Y, out);
      assert.ok(raw.distance <= scanMin + 1e-4, `aspect ${aspect}, pitch ${pitch.toFixed(3)}: ${raw.distance} <= scan ${scanMin}`);
    }
  }
});

// ---------- look-at dead-band ----------

/** Gain of the raw search over the base height: 1 - best / base (what the dead-band decides on). */
function shiftGain(aspect, pitch) {
  const base = L.fitDistanceAtPitch(aspect, FOV_RAD, pitch, LOOK_Y);
  const raw = L.searchLookAtHeight(aspect, FOV_RAD, pitch, LOOK_Y, {});
  return { gain: 1 - raw.distance / base, rawLookY: raw.lookY, base };
}

test('dead-band: no look-at shift at aspect 1.0 (gain about 1 %), the base height and the base distance are kept', () => {
  const view = solvedView(1.0, BASE_PITCH);
  const { gain } = shiftGain(1.0, BASE_PITCH);
  assert.ok(gain < L.FIT_SHIFT_GAIN_ZERO, `gain ${(gain * 100).toFixed(2)} % is below the dead-band start`);
  assert.equal(view.lookY, LOOK_Y, 'the look-at height stays at the base height');
  assert.equal(view.distance, L.fitDistanceAtPitch(1.0, FOV_RAD, BASE_PITCH, LOOK_Y), 'the distance is the base fit');
});

test('dead-band: the full look-at shift is kept at aspect 2.0 (gain about 7 %, capped at LOOK_Y_MAX_SHIFT)', () => {
  const view = solvedView(2.0, BASE_PITCH);
  const { gain, base } = shiftGain(2.0, BASE_PITCH);
  assert.ok(gain >= L.FIT_SHIFT_GAIN_FULL, `gain ${(gain * 100).toFixed(2)} % is above the full-shift point`);
  assert.ok(Math.abs(view.lookY - LOOK_Y) > L.LOOK_Y_MAX_SHIFT - 1e-6, `look-at moved by ${(view.lookY - LOOK_Y).toFixed(3)}`);
  assert.ok(view.distance < base * (1 - L.FIT_SHIFT_GAIN_FULL) + 1e-9, 'the distance is at least the full-shift gain below the base');
});

test('dead-band: the shift follows the gain (none below the start, full at or above the full point, a ramp in between)', () => {
  const pitches = [L.CAMERA_PITCH_MIN, BASE_PITCH, 0.7, L.CAMERA_PITCH_MAX];
  const failures = [];
  let ramp = 0;
  for (let aspect = 0.6; aspect <= 2.5 + 1e-9; aspect += 0.01) {
    for (const pitch of pitches) {
      const view = solvedView(aspect, pitch);
      const { gain, rawLookY } = shiftGain(aspect, pitch);
      const moved = view.lookY - LOOK_Y;
      const fullMove = rawLookY - LOOK_Y;
      if (gain <= L.FIT_SHIFT_GAIN_ZERO && moved !== 0) failures.push(`a ${aspect.toFixed(2)} p ${pitch.toFixed(3)}: shifted at gain ${gain}`);
      if (gain >= L.FIT_SHIFT_GAIN_FULL && Math.abs(moved - fullMove) > 1e-9) failures.push(`a ${aspect.toFixed(2)} p ${pitch.toFixed(3)}: not the full shift`);
      // In the ramp the shift is a fraction of the full shift and has the same direction
      if (gain > L.FIT_SHIFT_GAIN_ZERO && gain < L.FIT_SHIFT_GAIN_FULL) {
        ramp += 1;
        const frac = moved / fullMove;
        if (!(frac >= -1e-9 && frac <= 1 + 1e-9)) failures.push(`a ${aspect.toFixed(2)} p ${pitch.toFixed(3)}: ramp fraction ${frac}`);
      }
      // Whatever the weight, the framing holds for the returned pair
      assert.ok(Math.abs(view.distance - L.fitDistanceAtPitch(aspect, FOV_RAD, pitch, view.lookY)) < 1e-9, 'distance is the exact fit at the returned height');
    }
  }
  assert.deepEqual(failures, [], 'the shift follows the gain thresholds');
  assert.ok(ramp > 0, 'the ramp zone is sampled');
});

test('dead-band: height and distance change continuously across the threshold (no jump on resize)', () => {
  // Fine aspect steps (0.002, about 1 px of window width) across the whole range. The largest change between two
  // neighbouring steps is bounded per pitch. Measured with the shipped ramp (1.5-3 %): height 0.051 at pitch 0.34,
  // 0.118 at 0.7, 0.318 at 1.19 (the steep part near aspect 0.9 at top-down pitch, see the constants in scene.js).
  // The distance step (about 0.22) comes from the aspect itself, not from the dead-band: HEAD gives 0.22-0.23 as well.
  // Phase 2: the qa energy ring now reaches 1.48 (was 1.21 in the layout), so the orbit system is a little larger at the
  // top-down pitch and the largest distance step grew there. It is still a smooth change (no jump), so the bound was 0.3 at that point (raised to 0.32 below, after the PM planet).
  // PM-Professor-X planet (fifth orbit, outermost registered orbit 17.27 -> 21.14): the whole system is about 22 % larger, so the look-at
  // height step per aspect step grows with it. Re-measured with the PM planet: height 0.0614 at pitch 0.34, 0.149 at 0.7,
  // 0.291 at 1.19 (the steep part near aspect 0.9 got smoother, so its bound stays 0.4); distance step about 0.294 at 1.19
  // (0.286 at the other two), no longer "about 0.25". Still continuous: bounds 0.07 / 0.16 / 0.4, distance 0.32.
  // The distance bound is 0.32, not 0.3: 0.3 left only about 2 % margin over the measured 0.294, so a tiny layout change
  // would fail the test without any real jump. 0.32 keeps about 9 % margin and is still far below a visible jump.
  const step = 0.002;
  const bounds = [[BASE_PITCH, 0.07], [0.7, 0.16], [L.CAMERA_PITCH_MAX, 0.4]];
  for (const [pitch, maxHeightStep] of bounds) {
    let prev = solvedView(0.6, pitch);
    let maxDy = 0;
    let maxDd = 0;
    for (let aspect = 0.6 + step; aspect <= 2.5 + 1e-9; aspect += step) {
      const cur = solvedView(aspect, pitch);
      maxDy = Math.max(maxDy, Math.abs(cur.lookY - prev.lookY));
      maxDd = Math.max(maxDd, Math.abs(cur.distance - prev.distance));
      prev = cur;
    }
    assert.ok(maxDy <= maxHeightStep, `pitch ${pitch.toFixed(3)}: largest height step ${maxDy.toFixed(4)} per ${step} aspect`);
    assert.ok(maxDd < 0.32, `pitch ${pitch.toFixed(3)}: largest distance step ${maxDd.toFixed(4)} per ${step} aspect`);
  }
});

// ---------- solve cache ----------

test('solve cache: same inputs reuse the solve, a pitch change within the tolerance reuses it, a real change recomputes', () => {
  const cache = L.createFitCache(LOOK_Y);
  const p0 = BASE_PITCH;
  const first = cache.solve(1.5, FOV_RAD, p0);
  const snap = { pitch: first.pitch, lookY: first.lookY, distance: first.distance };
  assert.equal(cache.solves, 1, 'first call solves');
  // The cached record equals a fresh solve at the same pitch
  const fresh = solvedView(1.5, p0);
  assert.equal(snap.lookY, fresh.lookY);
  assert.equal(snap.distance, fresh.distance);

  cache.solve(1.5, FOV_RAD, p0);
  assert.equal(cache.solves, 1, 'same inputs: no new solve');

  const near = cache.solve(1.5, FOV_RAD, p0 + L.FIT_PITCH_TOLERANCE * 0.5);
  assert.equal(cache.solves, 1, 'pitch inside the tolerance: no new solve');
  assert.equal(near.pitch, p0, 'the cached pitch is returned (the camera uses it, so solve and camera agree)');
  assert.equal(near.distance, snap.distance);

  const moved = cache.solve(1.5, FOV_RAD, p0 + 0.01);
  assert.equal(cache.solves, 2, 'pitch change beyond the tolerance: recomputed');
  assert.equal(moved.pitch, p0 + 0.01);
  const freshMoved = solvedView(1.5, p0 + 0.01);
  assert.equal(moved.lookY, freshMoved.lookY);
  assert.equal(moved.distance, freshMoved.distance);

  cache.solve(1.5, FOV_RAD, p0 + 0.01);
  cache.solve(1.5, FOV_RAD, p0 + 0.01 + L.FIT_PITCH_TOLERANCE * 0.5);
  assert.equal(cache.solves, 2, 'the cache is keyed on the last solve, not on the last call');

  cache.solve(1.0, FOV_RAD, p0 + 0.01);
  assert.equal(cache.solves, 3, 'aspect change (resize): recomputed');
  cache.solve(1.0, FOV_RAD * 1.01, p0 + 0.01);
  assert.equal(cache.solves, 4, 'fov change: recomputed');
});

test('solve cache: a slow pitch drift (camera drift) solves far less often than once per frame, and the framing holds', () => {
  const cache = L.createFitCache(LOOK_Y);
  const aspect = 1.5;
  const frames = 60 * 120;             // two minutes at 60 fps
  let worst = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / 60;
    // Same drift formula as updateCamera(): BASE_PITCH + 0.03 * sin(0.07 t), clamped to the allowed range
    const wanted = Math.min(L.CAMERA_PITCH_MAX, Math.max(L.CAMERA_PITCH_MIN, BASE_PITCH + Math.sin(t * 0.07) * 0.03));
    const fit = cache.solve(aspect, FOV_RAD, wanted);
    assert.ok(Math.abs(fit.pitch - wanted) < L.FIT_PITCH_TOLERANCE + 1e-12, 'the solved pitch lags the wanted one by less than the tolerance');
    if (f % 600 === 0) {
      // Camera at the cached pitch and distance, looking at the cached height: every satellite stays inside the frame
      worst = Math.max(worst, worstNdc(cameraAt(fit.distance, fit.pitch, 0.1, fit.lookY), aspect, fit.lookY));
    }
  }
  assert.ok(cache.solves < frames * 0.05, `solves ${cache.solves} of ${frames} frames`);
  assert.ok(worst <= 1, `framing with the cached solve: |ndc| ${worst}`);
});

test('look-at solve: the sun stays near the middle of the screen at every aspect and pitch', () => {
  // Sun = world origin. Its NDC height shows how far the solve moves it off centre (1 = top edge of the frame).
  let worstSun = 0;
  for (const aspect of ASPECTS) {
    for (const pitch of pitchSamples()) {
      const view = solvedView(aspect, pitch);
      const sun = L.projectToNdc([0, 0, 0], cameraAt(view.distance, pitch, 0, view.lookY), [0, view.lookY, 0], FOV_RAD, aspect);
      worstSun = Math.max(worstSun, Math.abs(sun.y));
    }
  }
  assert.ok(worstSun <= 0.2, `the sun is within 0.2 NDC of the centre (worst ${worstSun.toFixed(3)})`);
});
