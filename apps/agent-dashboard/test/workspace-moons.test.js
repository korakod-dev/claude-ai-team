'use strict';
/**
 * workspace-moons.test.js - the moons of the 3D scene (public/workspace/scene.js).
 *
 * scene.js imports three.js and needs a browser, so (as the other scene tests do) this test
 *   - extracts the ORBIT_LAYOUT block and checks the GEOMETRY: every moon orbit plus the moon size stays inside the satellite
 *     extent of every planet, so the orbit spacing and the camera framing are not touched (finding G)
 *   - extracts the real functions that handle the moons (onWorkspaceEvent, refreshPlanet, syncMoons, updateMoons, ...) and runs
 *     them in a vm with a tiny fake THREE, the real store (stellar/store.js) and the real model.js. The fake clock is injected as
 *     Date, so a moon timeout needs no waiting.
 * Checked at behaviour level: moons appear and disappear with the instances, the planet status is derived from the open
 * instances (finding A), a registered planet is not painted by replayed history, the "+N" chip, the timeout, reset, and that the
 * moons are children of the planet body (not of the dynamic-planet registry, finding F).
 * No browser, no files written, no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const code = fs.readFileSync(path.join(WORKSPACE_DIR, 'scene.js'), 'utf8');
const imp = (...parts) => import(pathToFileURL(path.join(WORKSPACE_DIR, ...parts)).href);

// ---------- geometry (ORBIT_LAYOUT block) ----------

/** Run the ORBIT_LAYOUT block (it needs SUN_RADIUS from the file) and return the names the geometry tests use. */
function loadLayout() {
  const block = code.match(/\/\/ ORBIT_LAYOUT:BEGIN[\s\S]*?\/\/ ORBIT_LAYOUT:END/);
  const sun = code.match(/const SUN_RADIUS = ([\d.]+);/);
  assert.ok(block && sun, 'scene.js has the ORBIT_LAYOUT block and SUN_RADIUS');
  return new Function(`const SUN_RADIUS = ${sun[1]};\n${block[0]}\nreturn {
    SATELLITE_EXTENT, DYNAMIC_EXTENT, SATELLITE_ORBIT_RADIUS, SATELLITE_ORBIT_ORDER, ORBIT_BOB_AMPLITUDE,
    MOON_ORBIT_RADIUS, MOON_RADIUS, MOON_ORBIT_TILT, moonPosition };`)();
}
const L = loadLayout();

test('G: the moon orbit radius plus the moon size stays inside the satellite extent of EVERY planet (registered and dynamic)', () => {
  const extents = { ...L.SATELLITE_EXTENT, dynamic: L.DYNAMIC_EXTENT };
  for (const [name, extent] of Object.entries(extents)) {
    assert.ok(L.MOON_ORBIT_RADIUS + L.MOON_RADIUS <= extent,
      `${name}: moon orbit ${L.MOON_ORBIT_RADIUS} + moon ${L.MOON_RADIUS} must be <= extent ${extent}`);
  }
  const smallest = Math.min(...Object.values(extents));
  assert.ok(smallest - (L.MOON_ORBIT_RADIUS + L.MOON_RADIUS) >= 0.1, 'and a margin of at least 0.1 is left');
});

test('G: at every angle a moon centre is exactly MOON_ORBIT_RADIUS from the planet centre (the tilt does not change it)', () => {
  const p = { set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
  const cosT = Math.cos(L.MOON_ORBIT_TILT);
  const sinT = Math.sin(L.MOON_ORBIT_TILT);
  for (let i = 0; i < 360; i += 7) {
    L.moonPosition((i / 180) * Math.PI, p);
    assert.ok(Math.abs(Math.hypot(p.x, p.y, p.z) - L.MOON_ORBIT_RADIUS) < 1e-9, 'circle in the pivot plane');
    // The pivot is rotated about X by the tilt: the world offset has the same length
    const y = p.y * cosT - p.z * sinT;
    const z = p.y * sinT + p.z * cosT;
    assert.ok(Math.abs(Math.hypot(p.x, y, z) - L.MOON_ORBIT_RADIUS) < 1e-9, 'tilted circle');
  }
});

test('the moon circle is clear of the planet body and its atmosphere, and the 4 moons cannot touch each other', () => {
  const bodyRadius = Number(code.match(/const BODY_RADIUS = ([\d.]+);/)[1]);
  assert.ok(L.MOON_ORBIT_RADIUS - L.MOON_RADIUS > bodyRadius * 1.12 + 0.05, 'outside the atmosphere (1.12 x radius)');
  const chord = 2 * L.MOON_ORBIT_RADIUS * Math.sin(Math.PI / 4);   // 4 moons, 90 degrees apart
  assert.ok(chord > 4 * L.MOON_RADIUS, 'neighbouring moons are far apart');
});

test('G: the orbit layout was not changed by the moons (radii of the five registered orbits are the known values)', () => {
  // Same numbers that test/workspace-orbit.test.js and workspace-owner.test.js rely on; the moons add NO spacing
  const r = L.SATELLITE_ORBIT_RADIUS;
  assert.deepEqual(L.SATELLITE_ORBIT_ORDER, ['pm', 'qa', 'study', 'appdev', 'portfolio']);
  assert.ok(Math.abs(r.portfolio - 21.14) < 0.01, `outermost orbit is 21.14, got ${r.portfolio}`);
  assert.deepEqual(L.SATELLITE_EXTENT, { pm: 1.46, appdev: 1.46, qa: 1.49, study: 1.46, portfolio: 1.52 });
});

test('F: moons are children of the planet body and do not use the dynamic-planet registry', () => {
  const rig = code.match(/function attachMoonRig\([\s\S]*?\n}\n/)[0];
  assert.match(rig, /body\.group\.add\(pivot\)/, 'the moon pivot is added to the planet group');
  const moonCode = code.slice(code.indexOf('/* ---------- moons:'), code.indexOf('/* ---------- dynamic planets'));
  assert.equal(/dynamic\.(add|get|keys)\(/.test(moonCode), false, 'the moon code never touches the dynamic registry');
  assert.equal(/world\.add\(/.test(moonCode), false, 'a moon is never added to the world directly');
});

// ---------- behaviour: the real scene functions in a vm ----------

/** Pull one top-level function out of scene.js. */
function fnSource(name) {
  const m = code.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`));
  assert.ok(m, `${name} found in scene.js`);
  return m[0];
}
/** The value of a top-level `const NAME = <number>;` of scene.js. */
function constNumber(name) {
  const m = code.match(new RegExp(`const ${name} = ([\\d.]+);`));
  assert.ok(m, `${name} found in scene.js`);
  return Number(m[1]);
}

/** A tiny THREE: only what the moon code calls. Positions and scales are plain numbers/objects. */
function fakeThree() {
  class Vec { constructor() { this.x = 0; this.y = 0; this.z = 0; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
  class Group {
    constructor() { this.children = []; this.rotation = { x: 0 }; this.visible = true; this.position = new Vec(); }
    add(c) { this.children.push(c); c.parent = this; }
    remove(c) { this.children = this.children.filter((x) => x !== c); }
  }
  class Mesh {
    constructor(geometry, material) {
      this.geometry = geometry; this.material = material; this.position = new Vec(); this.scaleValue = 1;
      this.scale = { setScalar: (v) => { this.scaleValue = v; } };
    }
  }
  class Color {
    constructor(hex) { this.hex = hex; }
    lerp() { return this; }
    multiplyScalar() { return this; }
  }
  return {
    Group, Mesh, Color, SphereGeometry: class {}, MeshBasicMaterial: class { constructor(o) { Object.assign(this, o); } },
  };
}

/** A fake element: enough for the "+N" chip. */
function fakeEl(tag) {
  return { tag, className: '', textContent: '', children: [], appendChild(c) { this.children.push(c); return c; } };
}

/**
 * Load the real moon functions with the real store and model. Returns helpers to feed events, move the clock and read bodies.
 * The planets are 'appdev' (registered) and, on request, a dynamic planet (badge element present, tracking from creation).
 */
async function harness() {
  const model = await imp('stellar', 'model.js');
  const moonsMod = await imp('stellar', 'moons.js');
  const { createStore } = await imp('stellar', 'store.js');
  const THREE = fakeThree();
  const clock = { ms: Date.parse('2026-10-13T09:00:00.000Z') };
  const bodies = new Map();
  const store = createStore();
  const sandbox = {
    THREE,
    Date: { now: () => clock.ms },
    document: { createElement: fakeEl },
    bodies, store,
    sim: { time: 0 },
    hover: {}, focusStep: null, hud: null,
    ringLine: () => ({ visible: true }),
    MOON_GEOMETRY: new THREE.SphereGeometry(),
    moonAngle: moonsMod.moonAngle, moonTip: moonsMod.moonTip,
    agentOfBodyKey: model.agentOfBodyKey, isPlanetKey: model.isPlanetKey, isDynamicKey: model.isDynamicKey,
    dynamicKeyOf: model.dynamicKeyOf, stepOfEvent: model.stepOfEvent, AGENT_STEP: model.AGENT_STEP,
    visualIntentsForEvent: () => [], SUN_STEP: 'router', BLACK_HOLE_STEP: 'blackhole',
    ensureDynamicPlanet: () => null, handoff: () => {}, launchComet: () => {}, refreshHud: () => {},
    COMPLETE_FLASH_SECONDS: constNumber('COMPLETE_FLASH_SECONDS'),
    MOON_ORBIT_RADIUS: L.MOON_ORBIT_RADIUS, MOON_ORBIT_TILT: L.MOON_ORBIT_TILT, MOON_RADIUS: L.MOON_RADIUS,
    MOON_SPEED: constNumber('MOON_SPEED'), MOON_GROW_EASE: constNumber('MOON_GROW_EASE'),
    MOON_SLOT_EASE: constNumber('MOON_SLOT_EASE'), MOON_LIGHTEN: constNumber('MOON_LIGHTEN'),
    moonPosition: L.moonPosition,
    // Badge class table of the dynamic labels, read from scene.js so it cannot drift
    BADGE_CLASS: new Function(`${code.match(/const BADGE_CLASS = \{[^}]*\};/)[0]}\nreturn BADGE_CLASS;`)(),
  };
  vm.createContext(sandbox);
  const names = ['setBodyStatus', 'setNodeStatus', 'attachMoonRig', 'attachMoreChip', 'syncMoons', 'clearMoons', 'angleDelta',
    'updateMoons', 'refreshPlanet', 'refreshPlanets', 'showDynamicStatus', 'onWorkspaceEvent'];
  vm.runInContext(`${names.map(fnSource).join('\n')}\n${names.map((n) => `this.${n} = ${n};`).join(' ')}`, sandbox);

  /** A planet body as makeBody() shapes it (only the fields the moon code reads). */
  function addPlanet(step, { dynamic = false } = {}) {
    const body = {
      step, kind: 'planet', group: new THREE.Group(), info: fakeEl('div'),
      status: 'IDLE', state: 'idle', error: false, flashUntil: 0, openTasks: 0,
      tracking: dynamic, moons: new Map(), moonPivot: null, moonRing: null, moonMat: null, moonSpin: 0, moreEl: null,
    };
    if (dynamic) { body.badgeEl = fakeEl('span'); body.msgEl = fakeEl('div'); body.node = { dataset: {} }; }
    bodies.set(step, body);
    sandbox.attachMoonRig(body, 0x38bdf8);
    return body;
  }
  const iso = (offsetMs = 0) => new Date(clock.ms + offsetMs).toISOString();
  /** Send one event through the real onWorkspaceEvent, like app.js's 'workspace:event'. */
  function send(agent, status, message, toolUseId, replay = false) {
    const ev = { ts: iso(), agent, status, message, ...(toolUseId ? { toolUseId } : {}) };
    sandbox.onWorkspaceEvent({ detail: { event: ev, replay } });
    return ev;
  }
  /** Run frames until the eased moons settle (grow in / shrink out). */
  function frames(body, n = 120, dt = 1 / 60) {
    for (let i = 0; i < n; i += 1) sandbox.updateMoons(body, dt);
  }
  const live = (body) => Array.from(body.moons.entries()).filter(([, m]) => m.target === 1).map(([id]) => id);
  return { sandbox, bodies, store, clock, addPlanet, send, frames, live, THREE };
}

test('moons appear with the 2nd instance, go with their instance, and the planet stays active until the last one ends', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  h.send('app-dev', 'PROCESSING', 'task A', 'toolu_A');
  assert.equal(dev.moons.size, 0, 'one instance: no moon');
  assert.equal(dev.status, 'PROCESSING');
  h.send('app-dev', 'PROCESSING', 'task B', 'toolu_B');
  h.send('app-dev', 'PROCESSING', 'task C', 'toolu_C');
  assert.deepEqual(h.live(dev), ['toolu_A', 'toolu_B', 'toolu_C'], 'three instances, three moons');
  h.frames(dev);
  assert.equal(dev.moonPivot.visible, true);
  assert.equal(dev.openTasks, 3, 'the energy ring counts the running tasks');
  assert.ok(dev.moons.get('toolu_A').mesh.scaleValue > 0.95, 'the moons have grown in');

  h.send('app-dev', 'COMPLETED', 'B done', 'toolu_B');            // out of order
  assert.deepEqual(h.live(dev), ['toolu_A', 'toolu_C']);
  assert.equal(dev.status, 'PROCESSING', 'A and C run: the planet must not turn idle');
  assert.equal(dev.state, 'active');
  h.frames(dev);
  assert.equal(dev.moons.size, 2, 'the moon of B has shrunk out and is removed');

  h.send('app-dev', 'COMPLETED', 'A done', 'toolu_A');
  assert.equal(dev.status, 'PROCESSING', 'C still runs (the event that just came is a COMPLETED)');
  assert.deepEqual(h.live(dev), [], 'one instance left: no moon');
  h.frames(dev);
  assert.equal(dev.moons.size, 0);
  assert.equal(dev.moonPivot.visible, false, 'nothing is drawn without a moon');

  h.send('app-dev', 'COMPLETED', 'C done', 'toolu_C');
  assert.equal(dev.status, 'COMPLETED');
  assert.equal(dev.state, 'idle');
  assert.ok(dev.flashUntil > 0, 'the COMPLETED flash plays when the last instance ends');
});

test('one instance fails while the others run: the planet stays active and not red; the last failure turns it red', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  h.send('app-dev', 'PROCESSING', 'A', 'toolu_A');
  h.send('app-dev', 'PROCESSING', 'B', 'toolu_B');
  h.send('app-dev', 'ERROR', 'Agent failed', 'toolu_A');
  assert.equal(dev.status, 'PROCESSING');
  assert.equal(dev.error, false, 'B runs: no error mood');
  assert.deepEqual(h.live(dev), []);
  h.send('app-dev', 'ERROR', 'Agent failed', 'toolu_B');
  assert.equal(dev.status, 'ERROR');
  assert.equal(dev.error, true);
});

test('a single instance behaves as before: PROCESSING -> active, COMPLETED -> flash then idle, no moon', async () => {
  const h = await harness();
  const qa = h.addPlanet('qa');
  h.send('qa-reviewer', 'PROCESSING', 'review', 'toolu_Q');
  assert.equal(qa.state, 'active');
  assert.equal(qa.moons.size, 0);
  h.send('qa-reviewer', 'COMPLETED', 'done', 'toolu_Q');
  assert.equal(qa.status, 'COMPLETED');
  assert.equal(qa.state, 'idle');
  assert.equal(qa.moonPivot.visible, false);
});

test('more than 4 instances: 4 moons and a "+N" chip that follows the count', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  for (let i = 0; i < 6; i += 1) h.send('app-dev', 'PROCESSING', `task ${i}`, `toolu_${i}`);
  assert.equal(dev.moons.size, 4, 'at most 4 moons');
  assert.equal(dev.moreEl.textContent, '+2');
  h.send('app-dev', 'COMPLETED', 'done', 'toolu_0');
  assert.equal(dev.moreEl.textContent, '+1', 'one ended: the next instance takes a moon, +N shrinks');
  assert.deepEqual(h.live(dev), ['toolu_1', 'toolu_2', 'toolu_3', 'toolu_4']);
  h.send('app-dev', 'COMPLETED', 'done', 'toolu_1');
  h.send('app-dev', 'COMPLETED', 'done', 'toolu_2');
  assert.equal(dev.moreEl.textContent, '', 'no chip when everything is drawn');
  assert.equal(h.live(dev).length, 3);
});

test('a missed end event: the moon times out with NO new event (periodic read), after 10 minutes', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  h.send('app-dev', 'PROCESSING', 'A (stop lost)', 'toolu_A');
  h.clock.ms += 9 * 60 * 1000;
  h.send('app-dev', 'PROCESSING', 'B', 'toolu_B');
  assert.deepEqual(h.live(dev), ['toolu_A', 'toolu_B']);

  h.clock.ms += 30 * 1000;                                  // 9.5 min after A: still two live instances
  h.sandbox.refreshPlanets(null, null);
  assert.deepEqual(h.live(dev), ['toolu_A', 'toolu_B']);

  h.clock.ms += 60 * 1000;                                  // 10.5 min after A: A timed out
  h.sandbox.refreshPlanets(null, null);
  assert.deepEqual(h.live(dev), [], 'one live instance left: no moon');
  assert.equal(dev.status, 'PROCESSING', 'both tasks are still open and not stale');

  h.clock.ms += 30 * 60 * 1000;                             // everything is stale now
  h.sandbox.refreshPlanets(null, null);
  assert.equal(dev.status, 'IDLE', 'no running task is left: the planet goes idle without an event');
  assert.equal(dev.state, 'idle');
});

test('replayed history does not paint a registered planet (no status, no moons) until a live event for it arrives', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  h.send('app-dev', 'PROCESSING', 'old A', 'toolu_A', true);
  h.send('app-dev', 'PROCESSING', 'old B', 'toolu_B', true);
  assert.equal(dev.status, 'IDLE', 'history alone leaves the planet as it was');
  assert.equal(dev.moons.size, 0);
  assert.equal(dev.openTasks, 2, 'the open-task count (ring width) still follows the store, as before');
  h.sandbox.refreshPlanets(null, null);                      // the periodic read must not paint it either
  assert.equal(dev.status, 'IDLE');

  h.send('app-dev', 'PROCESSING', 'live C', 'toolu_C');       // a live event: now it follows the store, history included
  assert.equal(dev.status, 'PROCESSING');
  assert.deepEqual(h.live(dev), ['toolu_A', 'toolu_B', 'toolu_C']);
});

test('a dynamic planet follows the store from its first event, and shows the derived status in its badge', async () => {
  const h = await harness();
  const dyn = h.addPlanet('dyn:helper-x', { dynamic: true });
  h.send('helper-x', 'PROCESSING', 'job 1', 'toolu_1', true);
  h.send('helper-x', 'PROCESSING', 'job 2', 'toolu_2', true);
  assert.equal(dyn.status, 'PROCESSING', 'a dynamic planet is painted by any event, as before');
  assert.deepEqual(h.live(dyn), ['toolu_1', 'toolu_2'], 'and gets moons by the same rule');
  h.send('helper-x', 'COMPLETED', 'job 1 done', 'toolu_1');
  assert.equal(dyn.badgeEl.textContent, 'PROCESSING', 'the label badge shows the derived status, not the COMPLETED event');
  assert.equal(dyn.moonPivot.parent, dyn.group, 'the moon pivot is a child of the planet body');
});

test('setNodeStatus (the app.js hook) drives the sun but ignores a planet: planets derive their status from the instances', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  const sun = { step: 'router', kind: 'sun', status: 'IDLE', state: 'idle', error: false, flashUntil: 0 };
  h.bodies.set('router', sun);
  h.sandbox.setNodeStatus('appdev', 'ERROR');
  assert.equal(dev.status, 'IDLE', 'ignored for a planet');
  h.sandbox.setNodeStatus('router', 'PROCESSING');
  assert.equal(sun.state, 'active');
});

test('clearMoons (reset) removes every moon, hides the pivot and clears the chip', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  for (let i = 0; i < 6; i += 1) h.send('app-dev', 'PROCESSING', `task ${i}`, `toolu_${i}`);
  h.frames(dev);
  h.sandbox.clearMoons(dev);
  assert.equal(dev.moons.size, 0);
  assert.equal(dev.moonPivot.children.filter((c) => c.geometry).length, 0, 'no moon mesh is left in the pivot');
  assert.equal(dev.moreEl.textContent, '');
  assert.equal(dev.moonPivot.visible, false);
});

test('moons stay on their circle every frame and keep apart: radius from the planet centre = MOON_ORBIT_RADIUS', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  for (let i = 0; i < 4; i += 1) h.send('app-dev', 'PROCESSING', `task ${i}`, `toolu_${i}`);
  for (let f = 0; f < 200; f += 1) {
    h.sandbox.updateMoons(dev, 1 / 60);
    const pos = Array.from(dev.moons.values()).map((m) => m.mesh.position);
    pos.forEach((p) => assert.ok(Math.abs(Math.hypot(p.x, p.y, p.z) - L.MOON_ORBIT_RADIUS) < 1e-9));
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = i + 1; j < pos.length; j += 1) {
        assert.ok(Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y, pos[i].z - pos[j].z) > 2 * L.MOON_RADIUS, 'moons do not touch');
      }
    }
  }
});

test('hover text: a moon shows what its instance is doing (task text and age)', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  h.send('app-dev', 'PROCESSING', 'รับงานจาก secretary: write the tests', 'toolu_A');
  h.send('app-dev', 'PROCESSING', 'รับงานจาก secretary: fix the bug', 'toolu_B');
  h.clock.ms += 75 * 1000;
  const task = h.store.instanceState('app-dev', h.clock.ms).live.find((t) => t.id === 'toolu_B');
  const tip = (await imp('stellar', 'moons.js')).moonTip(task);
  assert.equal(tip, 'รับงานจาก secretary: fix the bug (1m 15s)');
  assert.equal(dev.moons.has('toolu_B'), true);
});

test('wiring: the periodic read, the tip and the pointer clear are in the frame loop and buildScene; the fallback block is untouched', () => {
  assert.match(code, /moonClock \+= dt;[\s\S]*?refreshPlanets\(null, null\);/, 'the frame loop re-reads the store a few times per second');
  assert.match(code, /moonHover = moonPointer && !cam\.dragging \? pickMoon\(moonPointer\) : null;/);
  assert.match(code, /dom\.addEventListener\('pointerleave', clearMoonPointer\);/);
  assert.match(code, /window\.createWorkspaceStore = createStore;/, 'the list view (app.js) can build the same store');
  const fallback = code.match(/\/\/ FALLBACK:BEGIN[\s\S]*?\/\/ FALLBACK:END/)[0];
  assert.equal(/moon/i.test(fallback), false, 'the FALLBACK block (tested in a sandbox) does not use moon state');
});

test('every ES module that scene.js imports (recursively) is served by server.js (a missing whitelist entry is a 404 and a dead page)', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const served = new Set(Array.from(server.matchAll(/^\s*'(\/workspace\/[^']+)':/gm)).map((m) => m[1]));
  assert.ok(served.has('/workspace/scene.js'), 'the parser read the whitelist');
  const seen = new Set();
  const queue = [path.join(WORKSPACE_DIR, 'scene.js')];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+'(\.[^']+)'|import\s+'(\.[^']+)'/g)) {
      queue.push(path.resolve(path.dirname(file), m[1] || m[2]));
    }
  }
  assert.ok(seen.has(path.join(WORKSPACE_DIR, 'stellar', 'moons.js')), 'the walk reaches stellar/moons.js');
  for (const file of seen) {
    const url = `/workspace/${path.relative(WORKSPACE_DIR, file).split(path.sep).join('/')}`;
    assert.ok(served.has(url), `${url} is imported but not in STATIC_FILES`);
  }
});
