'use strict';
/**
 * workspace-effects-scene.test.js - the activity wiring of the 3D scene (public/workspace/scene.js), run in a vm like the moon tests:
 * the REAL scene functions (effectBodyKey, refreshActivity, pulseMoons, effectAnchor, spawnBeam, spawnBurst, onActivity,
 * onEventEffects) with the real store (stellar/store.js), the real activity rules (stellar/activity.js) and model.js, and a fake
 * `fx` that records what would be drawn. No THREE, no browser.
 *   - beams: from the moon of the instance when it is drawn, else from the planet; the sun beams for the main session; colour by tool
 *   - pulse: a planet thinks only while a live instance is not running a tool; moons take the state of their own instance
 *   - bursts: green on COMPLETED, red on ERROR, only for LIVE events (never the replay), on the moon of that instance when it has one
 *   - nothing draws for an agent without a body, and a tool call never creates a planet
 *   - the pulse and the beams change no layout: the constants stay inside the satellite extent / camera fit is not read
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

/** Pull one top-level function out of scene.js. */
function fnSource(name) {
  const m = code.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`));
  assert.ok(m, `${name} found in scene.js`);
  return m[0];
}
const constNumber = (name) => Number(code.match(new RegExp(`const ${name} = ([\\d.]+);`))[1]);
/** A `const NAME = { ... };` object of scene.js (it may use BODY_RADIUS / SUN_RADIUS, passed in). */
function constObject(name, scope = {}) {
  const m = code.match(new RegExp(`const ${name} = (\\{[^}]*\\});`));
  assert.ok(m, `${name} found in scene.js`);
  return new Function(...Object.keys(scope), `return ${m[1]};`)(...Object.values(scope));
}

const T0 = Date.parse('2026-10-13T09:00:00.000Z');

async function harness({ reduced = false } = {}) {
  const model = await imp('stellar', 'model.js');
  const act = await imp('stellar', 'activity.js');
  const { createStore } = await imp('stellar', 'store.js');
  const clock = { ms: T0 };
  const draws = { beams: [], bursts: [] };
  const fx = {
    beam: (anchor, radius, length, color, seq) => { draws.beams.push({ anchor, radius, length, color, seq }); return true; },
    burst: (anchor, radius, max, color) => { draws.bursts.push({ anchor, radius, max, color }); return true; },
  };
  const store = createStore();
  const activity = act.createActivityTracker();
  const bodies = new Map();
  const BODY_RADIUS = constNumber('BODY_RADIUS');
  const SUN_RADIUS = constNumber('SUN_RADIUS');
  const refreshed = [];
  const sandbox = {
    Date: { now: () => clock.ms },
    bodies, store, activity, fx,
    sim: { time: 0 }, REDUCED_MOTION: reduced,
    agentOfBodyKey: model.agentOfBodyKey, dynamicKeyOf: model.dynamicKeyOf, AGENT_STEP: model.AGENT_STEP,
    isActivity: act.isActivity, burstFor: act.burstFor, heartbeat: act.heartbeat,
    PULSE_PERIOD: constNumber('PULSE_PERIOD'), PULSE_EASE: constNumber('PULSE_EASE'), PULSE_MOON_SCALE: constNumber('PULSE_MOON_SCALE'),
    PULSE_STATIC: constNumber('PULSE_STATIC'), FAILURE_BEAM_LENGTH: constNumber('FAILURE_BEAM_LENGTH'),
    BEAM_PLANET: constObject('BEAM_PLANET', { BODY_RADIUS }), BEAM_MOON: constObject('BEAM_MOON'),
    BEAM_SUN: constObject('BEAM_SUN', { SUN_RADIUS }),
    BURST_PLANET: constObject('BURST_PLANET', { BODY_RADIUS }), BURST_MOON: constObject('BURST_MOON'),
    refreshPlanet: (b) => refreshed.push(b.step),   // the moon / status refresh is covered by workspace-moons.test.js
  };
  vm.createContext(sandbox);
  const names = ['effectBodyKey', 'refreshActivity', 'refreshActivityAll', 'pulseMoons', 'effectAnchor', 'spawnBeam', 'spawnBurst',
    'onActivity', 'onEventEffects'];
  vm.runInContext(`${names.map(fnSource).join('\n')}\n${names.map((n) => `this.${n} = ${n};`).join(' ')}`, sandbox);

  const addPlanet = (step) => {
    const body = { step, kind: 'planet', group: { name: `planet:${step}` }, tracking: true, thinking: false, pulseOffset: 0, moons: new Map() };
    bodies.set(step, body);
    return body;
  };
  const addMoon = (body, id, { target = 1, scale = 1 } = {}) => {
    const moon = { mesh: { name: `moon:${id}`, scale: { v: 1, multiplyScalar(k) { this.v *= k; } } }, target, scale, thinking: false, pulse: 0 };
    body.moons.set(id, moon);
    return moon;
  };
  const iso = () => new Date(clock.ms).toISOString();
  const send = (agent, status, toolUseId, replay = false) => {
    const ev = { ts: iso(), agent, status, message: 'm', ...(toolUseId ? { toolUseId } : {}) };
    store.ingest(ev);                                              // onWorkspaceEvent does this first (tested in workspace-moons.test.js)
    sandbox.onEventEffects({ detail: { event: ev, replay } });
    return ev;
  };
  const tool = (agent, phase, toolName, extra = {}) => sandbox.onActivity({ detail: { activity: { ts: iso(), agent, phase, tool: toolName, ...extra } } });
  return { sandbox, bodies, draws, clock, addPlanet, addMoon, send, tool, refreshed, constants: { BODY_RADIUS, SUN_RADIUS }, act };
}

test('beam: a planet without moons beams from the planet, coloured by the tool, with the planet beam size', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  h.send('app-dev', 'PROCESSING', 'toolu_A');
  h.tool('app-dev', 'start', 'Edit', { callId: 'c1', instance: 'toolu_A' });
  assert.equal(h.draws.beams.length, 1);
  const b = h.draws.beams[0];
  assert.equal(b.anchor, dev.group);
  assert.equal(b.color, h.act.BEAM_COLORS.write, 'Edit is orange');
  assert.equal(b.radius, h.sandbox.BEAM_PLANET.radius);
  assert.equal(b.length, h.sandbox.BEAM_PLANET.length);
  assert.ok(dev.tracking, 'a tool call is a live event: the planet follows the store');
  assert.deepEqual(h.refreshed, ['appdev'], 'the planet status and moons are re-read');
});

test('beam: with moons, the call of an instance beams from ITS moon; an unknown / shrinking-out instance falls back to the planet', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  const moonA = h.addMoon(dev, 'toolu_A');
  h.addMoon(dev, 'toolu_B');
  h.addMoon(dev, 'toolu_C', { target: 0, scale: 0.8 });   // shrinking out (its instance finished)
  h.tool('app-dev', 'start', 'Read', { callId: 'c1', instance: 'toolu_A' });
  h.clock.ms += 500;
  h.tool('app-dev', 'start', 'Read', { callId: 'c2', instance: 'toolu_C' });
  h.clock.ms += 500;
  h.tool('app-dev', 'start', 'Grep', { callId: 'c3' });   // no instance
  h.clock.ms += 500;
  h.tool('app-dev', 'start', 'Grep', { callId: 'c4', instance: 'toolu_unknown' });
  assert.equal(h.draws.beams[0].anchor, moonA.mesh);
  assert.equal(h.draws.beams[0].radius, h.sandbox.BEAM_MOON.radius, 'a moon beam is smaller');
  assert.equal(h.draws.beams[0].color, h.act.BEAM_COLORS.read);
  assert.equal(h.draws.beams[1].anchor, dev.group, 'a moon that is going away is not a source');
  assert.equal(h.draws.beams[2].anchor, dev.group);
  assert.equal(h.draws.beams[3].anchor, dev.group);
});

test('beam: the main session beams from the sun; a tool call never creates a planet; an agent without a body draws nothing', async () => {
  const h = await harness();
  const sun = { step: 'router', kind: 'sun', group: { name: 'sun' }, moons: new Map() };
  h.bodies.set('router', sun);
  h.tool('secretary', 'start', 'Bash', { callId: 's1' });
  assert.equal(h.draws.beams[0].anchor, sun.group);
  assert.equal(h.draws.beams[0].radius, h.sandbox.BEAM_SUN.radius);
  assert.equal(h.draws.beams[0].color, h.act.BEAM_COLORS.shell, 'Bash is red');
  assert.ok(h.draws.beams[0].radius > h.constants.SUN_RADIUS, 'starts outside the sun surface');

  const before = h.bodies.size;
  h.tool('general-purpose', 'start', 'Read', { callId: 'g1' });   // no dynamic planet yet
  h.tool('pm', 'start', 'Read', { callId: 'p1' });                // registered but not built in this harness
  assert.equal(h.draws.beams.length, 1, 'nothing drawn for bodies that do not exist');
  assert.equal(h.bodies.size, before, 'no body was created');
});

test('beam: the tool end draws no beam and returns the planet to thinking', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  h.send('app-dev', 'PROCESSING', 'toolu_A');
  h.tool('app-dev', 'start', 'Edit', { callId: 'c1', instance: 'toolu_A' });
  assert.equal(dev.thinking, false, 'acting: no pulse');
  h.tool('app-dev', 'end', 'Edit', { callId: 'c1', instance: 'toolu_A' });
  assert.equal(h.draws.beams.length, 1, 'only the start drew a beam');
  assert.equal(dev.thinking, true, 'a tool just finished: thinking again');
});

test('beam: a failed ordinary tool draws ONE red failure beam (longer) from that actor and changes no status or burst', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  const moon = h.addMoon(dev, 'toolu_A');
  h.send('app-dev', 'PROCESSING', 'toolu_A');
  h.tool('app-dev', 'start', 'Bash', { callId: 'c1', instance: 'toolu_A' });
  h.clock.ms += 300;
  h.tool('app-dev', 'error', 'Bash', { callId: 'c1', instance: 'toolu_A' });
  assert.equal(h.draws.beams.length, 2, 'the start beam and the failure beam');
  const f = h.draws.beams[1];
  assert.equal(f.color, h.act.FAILURE_BEAM_COLOR);
  assert.equal(f.anchor, moon.mesh, 'from the moon of the instance that ran the tool');
  assert.ok(f.length > h.sandbox.BEAM_MOON.length, 'a failure beam is longer');
  assert.equal(f.length, h.sandbox.BEAM_MOON.length * h.sandbox.FAILURE_BEAM_LENGTH);
  assert.equal(h.draws.bursts.length, 0, 'no burst: the planet did not fail');
  assert.equal(dev.thinking, true, 'the call ended: thinking again');
});

test('beam: a failed tool of the main session beams red from the sun', async () => {
  const h = await harness();
  const sun = { step: 'router', kind: 'sun', group: { name: 'sun' }, moons: new Map() };
  h.bodies.set('router', sun);
  h.tool('secretary', 'error', 'Bash', { callId: 's1' });
  assert.equal(h.draws.beams.length, 1);
  assert.equal(h.draws.beams[0].anchor, sun.group);
  assert.equal(h.draws.beams[0].color, h.act.FAILURE_BEAM_COLOR);
  assert.equal(h.draws.beams[0].length, h.sandbox.BEAM_SUN.length * h.sandbox.FAILURE_BEAM_LENGTH);
});

test('beam: invalid activity messages are ignored', async () => {
  const h = await harness();
  h.addPlanet('appdev');
  for (const bad of [null, {}, { agent: 'app-dev' }, { agent: 'app-dev', phase: 'zap', tool: 'Read' }]) {
    h.sandbox.onActivity({ detail: { activity: bad } });
  }
  h.sandbox.onActivity({});
  h.sandbox.onActivity(null);
  assert.equal(h.draws.beams.length, 0);
});

test('pulse: a planet thinks while a live instance exists and no tool runs; idle planets and the unfollowed ones do not', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  const qa = h.addPlanet('qa');
  const pm = h.addPlanet('pm');
  pm.tracking = false;                                  // history alone does not paint a registered planet
  h.send('app-dev', 'PROCESSING', 'toolu_A');
  h.send('pm', 'PROCESSING', 'toolu_P');
  assert.equal(dev.thinking, true, 'the instance has started');
  assert.equal(qa.thinking, false, 'no instance: idle');
  assert.equal(pm.thinking, false, 'not following the store yet');
  h.send('app-dev', 'COMPLETED', 'toolu_A');
  assert.equal(dev.thinking, false, 'the instance finished');
});

test('pulse: each moon takes the state of its own instance; a single running call does not stop the other moon', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  h.send('app-dev', 'PROCESSING', 'toolu_A');
  h.send('app-dev', 'PROCESSING', 'toolu_B');
  const mA = h.addMoon(dev, 'toolu_A');
  const mB = h.addMoon(dev, 'toolu_B');
  h.sandbox.refreshActivityAll();
  assert.deepEqual([mA.thinking, mB.thinking], [true, true]);
  h.tool('app-dev', 'start', 'Edit', { callId: 'c1', instance: 'toolu_A' });
  assert.deepEqual([mA.thinking, mB.thinking], [false, true], 'A acts, B still thinks');
  assert.equal(dev.thinking, true, 'the planet halo keeps pulsing for B');
  h.tool('app-dev', 'end', 'Edit', { callId: 'c1', instance: 'toolu_A' });
  assert.deepEqual([mA.thinking, mB.thinking], [true, true]);
});

test('pulseMoons: a thinking moon swells with the heartbeat, a quiet one is untouched; reduced motion gives a static bump', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  const thinking = h.addMoon(dev, 'toolu_A'); thinking.thinking = true;
  const quiet = h.addMoon(dev, 'toolu_B');
  const k = h.sandbox.PULSE_MOON_SCALE;
  let max = 1;
  for (let i = 0; i < 400; i++) {
    h.sandbox.sim.time = i / 100;                        // 4 s = more than two heartbeats
    thinking.mesh.scale.v = 1; quiet.mesh.scale.v = 1;   // updateMoons rewrites the scale from scratch every frame
    h.sandbox.pulseMoons(dev, 0.1);
    max = Math.max(max, thinking.mesh.scale.v);
    assert.ok(thinking.mesh.scale.v <= 1 + k + 1e-9 && thinking.mesh.scale.v >= 1 - 1e-9, 'bounded');
    assert.equal(quiet.mesh.scale.v, 1);
  }
  assert.ok(max > 1 + k * 0.8, 'it really swells at the top of a beat');

  const r = await harness({ reduced: true });
  const dev2 = r.addPlanet('appdev');
  const m = r.addMoon(dev2, 'toolu_A'); m.thinking = true;
  const sizes = new Set();
  for (let i = 0; i < 200; i++) {
    r.sandbox.sim.time = i / 50;
    m.mesh.scale.v = 1;
    r.sandbox.pulseMoons(dev2, 0.1);
    if (i >= 100) sizes.add(m.mesh.scale.v.toFixed(6));   // after the short ease-in
  }
  assert.equal(sizes.size, 1, 'reduced motion: the same size at every time (a static glow, no pulse)');
  assert.ok(Number(Array.from(sizes)[0]) > 1, 'but still marked as thinking');
});

test('burst: a live COMPLETED draws a green burst and a live ERROR a red one, on the planet', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  h.send('app-dev', 'PROCESSING', 'toolu_A');
  h.send('app-dev', 'COMPLETED', 'toolu_A');
  assert.equal(h.draws.bursts.length, 1);
  assert.equal(h.draws.bursts[0].color, h.act.BURST_COLORS.complete);
  assert.equal(h.draws.bursts[0].anchor, dev.group);
  assert.equal(h.draws.bursts[0].radius, h.sandbox.BURST_PLANET.radius);

  h.send('app-dev', 'PROCESSING', 'toolu_B');
  h.send('app-dev', 'ERROR', 'toolu_B');
  assert.equal(h.draws.bursts.length, 2);
  assert.equal(h.draws.bursts[1].color, h.act.BURST_COLORS.error);
});

test('burst: on the moon of the instance that finished (it may already be shrinking out), else on the planet', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  h.send('app-dev', 'PROCESSING', 'toolu_A');
  h.send('app-dev', 'PROCESSING', 'toolu_B');
  const mA = h.addMoon(dev, 'toolu_A');
  const mB = h.addMoon(dev, 'toolu_B');
  mA.target = 0;                                         // the store closed A first, the moon shrinks out
  h.send('app-dev', 'COMPLETED', 'toolu_A');
  assert.equal(h.draws.bursts[0].anchor, mA.mesh);
  assert.equal(h.draws.bursts[0].radius, h.sandbox.BURST_MOON.radius);
  mB.target = 0; mB.scale = 0.05;                        // almost gone: the planet marks the place instead
  h.send('app-dev', 'COMPLETED', 'toolu_B');
  assert.equal(h.draws.bursts[1].anchor, dev.group, 'no moon to burst on: the burst goes on the planet');
});

test('burst: the replay never draws one, an event that closes nothing draws none, the sun and unknown bodies draw none', async () => {
  const h = await harness();
  h.addPlanet('appdev');
  h.bodies.set('router', { step: 'router', kind: 'sun', group: {}, moons: new Map() });
  h.send('app-dev', 'PROCESSING', 'toolu_A', true);
  h.send('app-dev', 'COMPLETED', 'toolu_A', true);       // replay: history
  assert.equal(h.draws.bursts.length, 0, 'history draws no burst');
  h.send('app-dev', 'COMPLETED', 'toolu_gone');          // a late duplicate: no task closed
  h.send('app-dev', 'WORKING');
  h.send('secretary', 'ERROR');                          // the main agent failing: no planet burst on the sun
  h.send('qa-reviewer', 'PROCESSING', 'toolu_Q');
  h.send('qa-reviewer', 'COMPLETED', 'toolu_Q');         // qa has no body in this harness
  assert.equal(h.draws.bursts.length, 0);
});

test('burst: a finished instance forgets its running tool calls (they cannot leak into a later instance with the same id)', async () => {
  const h = await harness();
  const dev = h.addPlanet('appdev');
  h.send('app-dev', 'PROCESSING', 'toolu_A');
  h.tool('app-dev', 'start', 'Bash', { callId: 'c1', instance: 'toolu_A' });
  h.send('app-dev', 'COMPLETED', 'toolu_A');
  h.send('app-dev', 'PROCESSING', 'toolu_A');
  assert.equal(dev.thinking, true, 'a new run with that id starts thinking, not acting');
});

test('layout: the effects add nothing to the orbit layout or the camera fit (sizes stay inside the satellite extent)', async () => {
  const h = await harness();
  const extent = Math.min(...Object.values(JSON.parse(JSON.stringify(
    new Function(`${code.match(/const SATELLITE_EXTENT = (\{[^}]*\});/)[0]}\nreturn SATELLITE_EXTENT;`)()))));
  const planetBeamEnd = h.sandbox.BEAM_PLANET.radius + h.sandbox.BEAM_PLANET.length;
  assert.ok(planetBeamEnd <= extent + 0.05, `a planet beam ends at ${planetBeamEnd.toFixed(2)}, inside the extent ${extent}`);
  assert.ok(h.sandbox.BURST_PLANET.max <= extent, 'a planet burst stays inside the extent');
  // The effect code never reads or writes the fit / orbit structures
  const effectsBlock = code.slice(code.indexOf('/* ---------- activity effects:'), code.indexOf('/* ---------- dynamic planets'));
  assert.equal(/setFitOrbits|camFit|SATELLITE_ORBIT_RADIUS|fitDist|refitCamera|\.orbit\b/.test(effectsBlock), false, 'no layout or camera state is touched');
  assert.ok(h.constants.BODY_RADIUS > 0);
});
