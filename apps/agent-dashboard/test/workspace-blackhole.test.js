'use strict';
/**
 * workspace-blackhole.test.js - Placement of the black hole (BLACK_HOLE_HOME, scene.js) in the 3D workspace.
 * Modeled on workspace-owner.test.js. Failed tasks are pulled into the black hole, so it must always be visible and
 * must never touch the orbit system.
 *   - it sits on the right side (+x), behind and above the orbit plane (the owner star is on the other side)
 *   - clearance: the disk (outer radius BLACK_HOLE_DISK_OUTER) keeps a safe distance from every ring (registered orbits
 *     and the four dynamic rings, with bob and extents), the outermost one included
 *   - framing: the disk stays inside |NDC| <= 0.95 at the start view (zoom 0.9) over the camera drift (yaw -0.22 .. +0.22,
 *     pitch +-0.03), for aspect 0.6 .. 2.0
 *   - the PM-Professor-X planet has its own surface type (not the same as Writer-ยัยแว่นหนา)
 * The soft halo sprite (3 x outer radius, additive, fades to 0 at its edge) is a glow, not geometry: it is not counted.
 * scene.js needs a browser, so the layout blocks are extracted and run as in workspace-owner.test.js.
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
    'return { SUN_RADIUS, BODY_RADIUS, ORBIT_BOB_AMPLITUDE, SATELLITE_ORBIT_RADIUS, SATELLITE_EXTENT, DYNAMIC_EXTENT,',
    '  dynamicOrbitRadius, fitViewAtPitch, projectToNdc };',
  ].join('\n');
  return new Function(script)();
}

const L = loadLayout();

// Black hole constants, read from scene.js so a change there is caught here
const home = code.match(/const BLACK_HOLE_HOME = new THREE\.Vector3\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)/);
const diskOuter = code.match(/const BLACK_HOLE_DISK_OUTER = ([\d.]+);/);
assert.ok(home && diskOuter, 'scene.js defines BLACK_HOLE_HOME and BLACK_HOLE_DISK_OUTER');
const [BX, BY, BZ] = [Number(home[1]), Number(home[2]), Number(home[3])];
const DISK_R = Number(diskOuter[1]);
const HORIZONTAL = Math.hypot(BX, BZ);

const FOV_RAD = 50 * Math.PI / 180;
const BASE_PITCH = 0.34;
const START_ZOOM = 0.9;        // cam.zoom at the start (scene.js)
const MAX_NDC = 0.95;          // the disk must stay inside |NDC| <= 0.95 (5 % of the half-frame kept free)
const MIN_CLEARANCE = 1.5;     // world units kept free between the disk and any ring (extent + bob included)

// Camera drift amplitudes are read from scene.js (updateCamera), as in workspace-owner.test.js
const yawDrift = code.match(/Math\.sin\(sim\.time \* 0\.05\) \* ([\d.]+)/);
const pitchDrift = code.match(/Math\.sin\(sim\.time \* 0\.07\) \* ([\d.]+)/);
const YAW_DRIFT = yawDrift ? Number(yawDrift[1]) : NaN;
const PITCH_DRIFT = pitchDrift ? Number(pitchDrift[1]) : NaN;

/** All rings the black hole could be too close to: the registered orbits and the four dynamic rings. */
function allRings() {
  return [
    ...Object.keys(L.SATELLITE_ORBIT_RADIUS).map((s) => ({ name: s, radius: L.SATELLITE_ORBIT_RADIUS[s], extent: L.SATELLITE_EXTENT[s] })),
    ...[0, 1, 2, 3].map((i) => ({ name: `dynamic${i}`, radius: L.dynamicOrbitRadius(i), extent: L.DYNAMIC_EXTENT })),
  ];
}

/** 26 unit directions (cube corners, edge and face centres): sample points on the disk extent sphere. */
const DIRECTIONS = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
  if (x || y || z) { const n = Math.hypot(x, y, z); DIRECTIONS.push([x / n, y / n, z / n]); }
}

/**
 * Largest |NDC| over the black hole centre and a sphere of the disk radius around it, for one aspect, yaw and pitch.
 * The camera is placed the way scene.js updateCamera() does (fitted distance x start zoom, orbiting (0, lookY, 0)).
 */
function worstNdc(aspect, yaw, pitch) {
  const solved = L.fitViewAtPitch(aspect, FOV_RAD, pitch, 0.4, {});
  const dist = solved.distance * START_ZOOM;
  const cam = [dist * Math.cos(pitch) * Math.sin(yaw), solved.lookY + dist * Math.sin(pitch), dist * Math.cos(pitch) * Math.cos(yaw)];
  const look = [0, solved.lookY, 0];
  let worst = 0;
  for (const d of [[0, 0, 0], ...DIRECTIONS.map((v) => v.map((c) => c * DISK_R))]) {
    const ndc = L.projectToNdc([BX + d[0], BY + d[1], BZ + d[2]], cam, look, FOV_RAD, aspect);
    assert.ok(ndc.depth > 0, 'in front of the camera');
    worst = Math.max(worst, Math.abs(ndc.x), Math.abs(ndc.y));
  }
  return worst;
}

test('black hole: disk radius is about 2.6, on the right (+x), behind (-z) and above the orbit plane', () => {
  assert.ok(Math.abs(DISK_R - 2.6) < 0.05, `disk outer radius ${DISK_R} is about 2.6`);
  assert.ok(BX > 0, 'right side (the owner star is on the left)');
  assert.ok(BZ < 0, 'toward the back, so it shows in the upper right corner');
  assert.ok(BY - L.ORBIT_BOB_AMPLITUDE > 0, 'above the orbit plane, above the highest bob');
});

test(`black hole: clearance - the disk keeps at least ${MIN_CLEARANCE} world units free to every ring, the outermost included`, () => {
  const rings = allRings();
  let smallest = Infinity;
  for (const ring of rings) {
    // Closest approach of the disk centre to the ring tube: horizontal gap to the circle, vertical gap to the bob extreme
    const horizontalGap = Math.abs(HORIZONTAL - ring.radius);
    const verticalGap = BY - L.ORBIT_BOB_AMPLITUDE;
    const free = Math.hypot(horizontalGap, verticalGap) - (DISK_R + ring.extent);
    smallest = Math.min(smallest, free);
    assert.ok(free >= MIN_CLEARANCE, `ring ${ring.name} r=${ring.radius.toFixed(2)}: free space ${free.toFixed(2)} >= ${MIN_CLEARANCE}`);
  }
  // Outermost ring of all (the last dynamic ring) and the outermost registered orbit are part of the loop above
  const outermost = rings.reduce((a, b) => (b.radius > a.radius ? b : a));
  assert.equal(outermost.name, 'dynamic3', 'the outermost ring is the last dynamic ring');
  assert.ok(smallest >= MIN_CLEARANCE, `smallest clearance ${smallest.toFixed(2)}`);
  // Clear of the sun corona as well
  assert.ok(Math.hypot(HORIZONTAL, BY) > L.SUN_RADIUS * 1.45 + DISK_R, 'clear of the sun corona');
});

test('black hole: the camera drift constants are read from scene.js (yaw 0.22 rad, pitch 0.03 rad)', () => {
  assert.ok(Number.isFinite(YAW_DRIFT) && Math.abs(YAW_DRIFT - 0.22) < 1e-9, `yaw drift ${YAW_DRIFT}`);
  assert.ok(Number.isFinite(PITCH_DRIFT) && PITCH_DRIFT > 0, `pitch drift ${PITCH_DRIFT}`);
});

test('black hole: inside the frame (|NDC| <= 0.95) at the start view, yaw 0, for aspect 0.6 .. 2.0', () => {
  for (const aspect of [0.6, 0.8, 1, 1.3, 1.6, 2]) {
    const w = worstNdc(aspect, 0, BASE_PITCH);
    assert.ok(w <= MAX_NDC, `aspect ${aspect}: worst |NDC| ${w.toFixed(3)} <= ${MAX_NDC}`);
  }
});

for (const sign of [-1, 1]) {
  test(`black hole: inside the frame at the extreme camera drift, yaw ${sign < 0 ? '-' : '+'}0.22, for aspect 0.6 .. 2.0`, () => {
    for (const aspect of [0.6, 0.7, 0.8, 1, 1.3, 1.6, 2]) {
      const w = worstNdc(aspect, sign * YAW_DRIFT, BASE_PITCH);
      assert.ok(w <= MAX_NDC, `yaw ${sign * YAW_DRIFT}, aspect ${aspect}: worst |NDC| ${w.toFixed(3)} <= ${MAX_NDC}`);
    }
  });
}

test('black hole: inside the frame over the whole drift range (yaw x pitch grid) for aspect 0.6 .. 2.0', () => {
  for (const aspect of [0.6, 0.8, 1, 1.3, 1.6, 2]) {
    for (const yaw of [-YAW_DRIFT, -YAW_DRIFT / 2, 0, YAW_DRIFT / 2, YAW_DRIFT]) {
      for (const dp of [-PITCH_DRIFT, 0, PITCH_DRIFT]) {
        const w = worstNdc(aspect, yaw, BASE_PITCH + dp);
        assert.ok(w <= MAX_NDC, `aspect ${aspect}, yaw ${yaw.toFixed(2)}, pitch ${(BASE_PITCH + dp).toFixed(2)}: ${w.toFixed(3)} <= ${MAX_NDC}`);
      }
    }
  }
});

test('planet surfaces: PM-Professor-X does not share a surface type with Writer-ยัยแว่นหนา', () => {
  const theme = code.match(/const PLANET_THEME = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  assert.ok(theme, 'PLANET_THEME found');
  const typeOf = (step) => {
    const m = theme[0].match(new RegExp(`\\n  ${step}: \\{\\s*type: SURFACE\\.(\\w+)`));
    assert.ok(m, `${step} has a surface type`);
    return m[1];
  };
  assert.notEqual(typeOf('pm'), typeOf('study'), 'PM and Writer are distinguishable by surface');
  assert.equal(typeOf('pm'), 'BANDS', 'PM uses the rose bands surface');
});
