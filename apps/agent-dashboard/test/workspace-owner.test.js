'use strict';
/**
 * workspace-owner.test.js - Placement of the owner star (User Prompt, คุณกฎ) in the 3D workspace (public/workspace/scene.js).
 *
 * The owner sends the first prompt to the secretary (the sun), so it sits OUTSIDE the agent system: off to the side
 * (upper left, toward the back), clearly larger than the old 0.2 beacon and than a planet.
 * Geometry (honest version): horizontally the star is beyond the outermost REGISTERED orbit but still inside the first
 * DYNAMIC ring (hypot(x, z) is below dynamicOrbitRadius(0)), so the horizontal position alone does not separate it
 * from a dynamic planet. The separation comes from the elevation (OWNER_POSITION y): the star floats above the orbit plane.
 * scene.js needs a browser, so this test extracts the ORBIT_LAYOUT and CAMERA_FIT blocks (as workspace-orbit.test.js does),
 * runs them in their own function scope, and checks the owner constants against them:
 *   - the owner is farther from the sun than the outermost registered orbit, and the black hole side (+x) is not used
 *   - the owner is larger than a planet and smaller than the sun
 *   - no satellite (registered or dynamic ring, with its bob and extent) can touch the owner, with a safe clearance (explicit assert)
 *   - the owner and its whole extent sphere stay inside the frame for aspects 0.6 .. 2.0 at the start zoom (0.9) over the
 *     camera drift: yaw -0.22 .. +0.22 (read from scene.js) and pitch +-0.03
 *   - scene.js builds the 'user' body with these constants (so the owner -> secretary comet still has both ends)
 * Pure computation, no files written, no network. Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SCENE_FILE = path.join(__dirname, '..', 'public', 'workspace', 'scene.js');
const code = fs.readFileSync(SCENE_FILE, 'utf8');

/** Run the layout blocks of scene.js and return the values this test needs. */
function loadLayout() {
  const block = code.match(/\/\/ ORBIT_LAYOUT:BEGIN[\s\S]*?\/\/ ORBIT_LAYOUT:END/);
  const fit = code.match(/\/\/ CAMERA_FIT:BEGIN[\s\S]*?\/\/ CAMERA_FIT:END/);
  const config = code.match(/const SATELLITE_CONFIG = \{[\s\S]*?\n\};/);
  const sun = code.match(/const SUN_RADIUS = ([\d.]+);/);
  const body = code.match(/const BODY_RADIUS = ([\d.]+);/);
  assert.ok(block && fit && config && sun && body, 'scene.js has the layout blocks and radii');
  const script = [
    `const SUN_RADIUS = ${sun[1]};`,
    `const BODY_RADIUS = ${body[1]};`,
    config[0],
    block[0],
    fit[0],
    'return { SUN_RADIUS, BODY_RADIUS, OWNER_RADIUS, OWNER_EXTENT, OWNER_POSITION, SATELLITE_ORBIT_RADIUS, ORBIT_BOB_AMPLITUDE,',
    '  SATELLITE_EXTENT, DYNAMIC_EXTENT, dynamicOrbitRadius, fitViewAtPitch, projectToNdc };',
  ].join('\n');
  return new Function(script)();
}

const L = loadLayout();
const FOV_RAD = 50 * Math.PI / 180;
const BASE_PITCH = 0.34;
const START_ZOOM = 0.9;           // cam.zoom at the start (scene.js): the start view is 10 % closer than the fit
const MIN_CLEARANCE = 1.5;        // world units kept free between the owner extent and any ring tube (extent + bob included)
const MAX_NDC = 0.95;             // the owner extent must stay inside |NDC| <= 0.95 (5 % of the half-frame kept free)
const OUTER_ORBIT = Math.max(...Object.values(L.SATELLITE_ORBIT_RADIUS));
const [OX, OY, OZ] = L.OWNER_POSITION;
const HORIZONTAL = Math.hypot(OX, OZ); // distance from the sun on the orbit plane

// Camera drift amplitudes are read from scene.js (updateCamera), so a change there is caught by this test
const yawDrift = code.match(/Math\.sin\(sim\.time \* 0\.05\) \* ([\d.]+)/);
const pitchDrift = code.match(/Math\.sin\(sim\.time \* 0\.07\) \* ([\d.]+)/);
const YAW_DRIFT = yawDrift ? Number(yawDrift[1]) : NaN;
const PITCH_DRIFT = pitchDrift ? Number(pitchDrift[1]) : NaN;

/** All rings an owner could be too close to: the registered orbits and the four dynamic rings. */
function allRings() {
  return [
    ...Object.keys(L.SATELLITE_ORBIT_RADIUS).map((s) => ({ radius: L.SATELLITE_ORBIT_RADIUS[s], extent: L.SATELLITE_EXTENT[s] })),
    ...[0, 1, 2, 3].map((i) => ({ radius: L.dynamicOrbitRadius(i), extent: L.DYNAMIC_EXTENT })),
  ];
}

/** 26 unit directions (cube corners, edge and face centres): sample points on the owner extent sphere. */
const DIRECTIONS = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
  if (x || y || z) { const n = Math.hypot(x, y, z); DIRECTIONS.push([x / n, y / n, z / n]); }
}

/**
 * Largest |NDC| over the owner centre and its extent sphere, for one aspect, camera yaw and pitch.
 * The camera is placed the way scene.js updateCamera() does: distance = fitted distance (at this pitch) x start zoom,
 * orbiting the look-at point (0, lookY, 0) at the given yaw and pitch.
 */
function worstNdc(aspect, yaw, pitch) {
  const solved = L.fitViewAtPitch(aspect, FOV_RAD, pitch, 0.4, {});
  const dist = solved.distance * START_ZOOM;
  const cam = [dist * Math.cos(pitch) * Math.sin(yaw), solved.lookY + dist * Math.sin(pitch), dist * Math.cos(pitch) * Math.cos(yaw)];
  const look = [0, solved.lookY, 0];
  const e = L.OWNER_EXTENT;
  let worst = 0;
  for (const d of [[0, 0, 0], ...DIRECTIONS.map((v) => v.map((c) => c * e))]) {
    const ndc = L.projectToNdc([OX + d[0], OY + d[1], OZ + d[2]], cam, look, FOV_RAD, aspect);
    assert.ok(ndc.depth > 0, 'in front of the camera');
    worst = Math.max(worst, Math.abs(ndc.x), Math.abs(ndc.y));
  }
  return worst;
}

test('owner: noticeably larger than the old beacon (0.2) and than a planet, smaller than the sun', () => {
  assert.ok(L.OWNER_RADIUS >= 1, `owner radius ${L.OWNER_RADIUS} >= 1 (old beacon 0.2)`);
  assert.ok(L.OWNER_RADIUS >= 2 * L.BODY_RADIUS, 'at least twice a planet radius');
  assert.ok(L.OWNER_RADIUS < L.SUN_RADIUS, 'the sun (เลขาคนสวย) stays the biggest body');
  assert.ok(L.OWNER_EXTENT > L.OWNER_RADIUS, 'the extent covers the ring around the body');
});

test('owner: outside the agent system - beyond the outermost registered orbit, lifted above the plane, on the left', () => {
  assert.ok(OX < 0, 'owner is on the left side (x < 0)');
  assert.ok(OZ < 0, 'owner is toward the back, so it shows in the upper left corner of the frame');
  assert.ok(OY - L.ORBIT_BOB_AMPLITUDE > 0, 'owner is lifted above the orbit plane, above the highest bob');
  assert.ok(HORIZONTAL > OUTER_ORBIT, `owner distance ${HORIZONTAL.toFixed(2)} > outermost registered orbit ${OUTER_ORBIT.toFixed(2)}`);
  // Documented geometry: horizontally the owner is still inside the first dynamic ring, the elevation separates it (next test)
  assert.ok(HORIZONTAL < L.dynamicOrbitRadius(0), `owner distance ${HORIZONTAL.toFixed(2)} < first dynamic ring ${L.dynamicOrbitRadius(0).toFixed(2)} (separation is vertical)`);
  const blackHole = code.match(/const BLACK_HOLE_HOME = new THREE\.Vector3\(([-\d.]+),/);
  assert.ok(blackHole && Number(blackHole[1]) > 0, 'the black hole is on the right (+x), the owner on the other side');
});

test(`owner: clearance - no satellite can touch it; at least ${MIN_CLEARANCE} world units stay free to every ring (bob and extents included)`, () => {
  let smallest = Infinity;
  for (const ring of allRings()) {
    // Closest approach of the owner centre to the ring tube: horizontal gap to the circle, vertical gap to the bob extreme
    const horizontalGap = Math.abs(HORIZONTAL - ring.radius);
    const verticalGap = OY - L.ORBIT_BOB_AMPLITUDE;
    const distance = Math.hypot(horizontalGap, verticalGap);
    const free = distance - (L.OWNER_EXTENT + ring.extent); // free space between the two visual extents
    smallest = Math.min(smallest, free);
    assert.ok(free >= MIN_CLEARANCE, `ring r=${ring.radius.toFixed(2)}: free space ${free.toFixed(2)} >= ${MIN_CLEARANCE}`);
  }
  assert.ok(smallest >= MIN_CLEARANCE, `smallest clearance ${smallest.toFixed(2)}`);
  // The sun corona is far away too
  assert.ok(Math.hypot(HORIZONTAL, OY) > L.SUN_RADIUS * 1.45 + L.OWNER_EXTENT, 'clear of the sun corona');
});

test('owner: the camera drift constants are read from scene.js (yaw 0.22 rad, pitch 0.03 rad)', () => {
  assert.ok(Number.isFinite(YAW_DRIFT) && YAW_DRIFT >= 0.2, `yaw drift ${YAW_DRIFT}`);
  assert.ok(Number.isFinite(PITCH_DRIFT) && PITCH_DRIFT > 0, `pitch drift ${PITCH_DRIFT}`);
});

test('owner: inside the frame (whole extent sphere) at the start view, yaw 0, for aspect 0.6 .. 2.0', () => {
  for (const aspect of [0.6, 0.8, 1, 1.3, 1.6, 2]) {
    const w = worstNdc(aspect, 0, BASE_PITCH);
    assert.ok(w <= MAX_NDC, `aspect ${aspect}: worst |NDC| ${w.toFixed(3)} <= ${MAX_NDC}`);
  }
});

for (const sign of [-1, 1]) {
  test(`owner: inside the frame at the extreme camera drift, yaw ${sign < 0 ? '-' : '+'}0.22, for aspect 0.6 .. 2.0`, () => {
    for (const aspect of [0.6, 0.7, 0.8, 1, 1.3, 1.6, 2]) {
      const w = worstNdc(aspect, sign * YAW_DRIFT, BASE_PITCH);
      assert.ok(w <= MAX_NDC, `yaw ${sign * YAW_DRIFT}, aspect ${aspect}: worst |NDC| ${w.toFixed(3)} <= ${MAX_NDC}`);
    }
  });
}

test('owner: inside the frame over the whole drift range (yaw x pitch grid) for aspect 0.6 .. 2.0', () => {
  for (const aspect of [0.6, 0.8, 1, 1.3, 1.6, 2]) {
    for (const yaw of [-YAW_DRIFT, -YAW_DRIFT / 2, 0, YAW_DRIFT / 2, YAW_DRIFT]) {
      for (const dp of [-PITCH_DRIFT, 0, PITCH_DRIFT]) {
        const w = worstNdc(aspect, yaw, BASE_PITCH + dp);
        assert.ok(w <= MAX_NDC, `aspect ${aspect}, yaw ${yaw.toFixed(2)}, pitch ${(BASE_PITCH + dp).toFixed(2)}: ${w.toFixed(3)} <= ${MAX_NDC}`);
      }
    }
  }
});

test('wiring: scene.js builds the user body from the owner constants (the owner -> secretary comet keeps both ends)', () => {
  assert.match(code, /createBeacon\(\{ radius: OWNER_RADIUS \}\)/, 'the owner body uses OWNER_RADIUS');
  assert.match(code, /beaconBuilt\.group\.position\.copy\(OWNER_HOME\)/, 'the owner body starts at OWNER_HOME');
  assert.match(code, /bodies\.set\('user', makeBody\('user', beaconBuilt, \{ kind: 'beacon', home: OWNER_HOME/, 'registered as body "user"');
  assert.equal(code.includes('BEACON_HOME'), false, 'the old position above the sun is gone');
  // app.js still sends the owner -> secretary beam on the router step
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'workspace', 'app.js'), 'utf8');
  assert.match(app, /router: \[\['user', 'router'\]\]/, 'handoff user -> router is unchanged');
});
