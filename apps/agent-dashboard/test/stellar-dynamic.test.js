'use strict';
/**
 * stellar-dynamic.test.js - dynamic planets, pure part (public/workspace/stellar/model.js and dynamic.js):
 *   - keys: a dynamic key only for an agent with no registered planet (registered team agents, secretary, user excluded)
 *   - bodyKeyOf: pipeline step first, then the registered step of the agent, then the dynamic key
 *   - the look is deterministic per name and stays in its ranges; the colour maths is right (HSL to hex)
 *   - the registry: arrival order, the orbit ring = arrival index, the cap (MAX_DYNAMIC_PLANETS) and the refusals
 *   - the surface numbers match SURFACE in stellar/bodies.js (checked on the source text: bodies.js imports THREE)
 * Both files are ES modules (stellar/package.json), so the test imports them with import().
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const STELLAR_DIR = path.join(__dirname, '..', 'public', 'workspace', 'stellar');

/** Load the modules once per test file. */
async function load() {
  const model = await import(pathToFileURL(path.join(STELLAR_DIR, 'model.js')).href);
  const dyn = await import(pathToFileURL(path.join(STELLAR_DIR, 'dynamic.js')).href);
  return { model, dyn };
}

const REGISTERED_AGENTS = ['pm', 'app-dev', 'qa-reviewer', 'study-writer', 'portfolio-writer', 'advisor', 'secretary', 'user'];

test('keys: a registered team agent, the main agent and the user have no dynamic key', async () => {
  const { model } = await load();
  for (const agent of REGISTERED_AGENTS) {
    assert.equal(model.dynamicKeyOf(agent), null, `${agent} has a registered body, not a dynamic one`);
  }
  assert.equal(model.dynamicKeyOf('data-analyst'), 'dyn:data-analyst');
  assert.equal(model.dynamicKeyOf('สมชาย'), 'dyn:สมชาย', 'Thai names work');
  assert.equal(model.dynamicKeyOf(''), null);
  assert.equal(model.dynamicKeyOf(undefined), null);
  assert.equal(model.dynamicKeyOf(42), null);
});

test('keys: isDynamicKey and agentOfBodyKey round-trip; registered steps map back to their agent', async () => {
  const { model } = await load();
  assert.equal(model.isDynamicKey('dyn:data-analyst'), true);
  assert.equal(model.isDynamicKey('dyn:'), false, 'a bare prefix is not a key');
  assert.equal(model.isDynamicKey('appdev'), false);
  assert.equal(model.isDynamicKey(null), false);
  assert.equal(model.agentOfBodyKey('dyn:data-analyst'), 'data-analyst');
  assert.equal(model.agentOfBodyKey('appdev'), 'app-dev');
  assert.equal(model.agentOfBodyKey('router'), 'secretary');
  assert.equal(model.agentOfBodyKey('nothing'), null);
  assert.equal(model.agentOfBodyKey('constructor'), null, 'prototype keys are not agents');
});

test('keys: isPlanetKey is true for the four registered planets and for dynamic keys only', async () => {
  const { model } = await load();
  for (const step of ['appdev', 'qa', 'study', 'portfolio']) assert.equal(model.isPlanetKey(step), true);
  assert.equal(model.isPlanetKey('dyn:x'), true);
  assert.equal(model.isPlanetKey('router'), false, 'the sun is not a planet');
  assert.equal(model.isPlanetKey('user'), false, 'the beacon is not a planet');
  assert.equal(model.isPlanetKey('blackhole'), false);
});

test('bodyKeyOf: pipelineStep first, then the registered step, then the dynamic key of the agent', async () => {
  const { model } = await load();
  assert.equal(model.bodyKeyOf({ agent: 'app-dev', pipelineStep: 'qa' }), 'qa', 'explicit step wins');
  assert.equal(model.bodyKeyOf({ agent: 'app-dev' }), 'appdev', 'registered agent');
  assert.equal(model.bodyKeyOf({ agent: 'user' }), 'user', 'the user beacon');
  assert.equal(model.bodyKeyOf({ agent: 'secretary' }), 'router', 'the sun');
  assert.equal(model.bodyKeyOf({ agent: 'data-analyst' }), 'dyn:data-analyst', 'unregistered agent -> dynamic planet');
  assert.equal(model.bodyKeyOf({ agent: 'data-analyst', pipelineStep: 'portfolio' }), 'portfolio', 'explicit step still wins');
  assert.equal(model.bodyKeyOf(null), null);
});

test('events: an unregistered agent draws its failure and result comets from its own planet', async () => {
  const { model } = await load();
  assert.deepEqual(model.visualIntentsForEvent({ agent: 'data-analyst', status: 'ERROR', message: 'x' }),
    [{ kind: 'failure', step: 'dyn:data-analyst' }]);
  assert.deepEqual(model.visualIntentsForEvent({ agent: 'data-analyst', status: 'COMPLETED', message: 'x' }),
    [{ kind: 'result', step: 'dyn:data-analyst' }]);
  assert.deepEqual(model.visualIntentsForEvent({ agent: 'data-analyst', status: 'PROCESSING', message: 'x' }), [],
    'the dispatch comet is drawn by handoff(), not by the intents');
});

test('look: the same name always gives the same look, and different names usually differ', async () => {
  const { dyn } = await load();
  assert.deepEqual(dyn.dynamicLook('data-analyst'), dyn.dynamicLook('data-analyst'));
  const names = ['data-analyst', 'Explore', 'general-purpose', 'Plan', 'สมชาย', 'writer-x', 'ops-bot', 'rev-2'];
  const colours = new Set(names.map((n) => dyn.dynamicLook(n).color));
  assert.ok(colours.size >= names.length - 1, `names get different colours (${colours.size} of ${names.length})`);
});

test('look: every field is inside its range (hue, surface type, colours, start angle, speed)', async () => {
  const { dyn } = await load();
  for (const name of ['a', 'data-analyst', 'Explore', 'สมชาย', 'x'.repeat(64), 'Content Director-2', 'agent 🙂']) {
    const look = dyn.dynamicLook(name);
    assert.ok(Number.isInteger(look.hue) && look.hue >= 0 && look.hue < 360, `${name}: hue`);
    assert.ok(dyn.DYNAMIC_SURFACE_TYPES.includes(look.surface), `${name}: surface type`);
    for (const k of ['color', 'atmo', 'c0', 'c1', 'c2']) {
      assert.ok(Number.isInteger(look[k]) && look[k] >= 0 && look[k] <= 0xffffff, `${name}: ${k} is 0xRRGGBB`);
    }
    assert.ok(look.angle >= 0 && look.angle < Math.PI * 2, `${name}: start angle in [0, 2pi)`);
    assert.ok(look.speed >= 0.07 && look.speed <= 0.1, `${name}: speed like the registered planets`);
  }
});

test('surface types: the four types cover all surfaces, and the numbers match SURFACE in bodies.js', async () => {
  const { dyn } = await load();
  const bodies = fs.readFileSync(path.join(STELLAR_DIR, 'bodies.js'), 'utf8');
  assert.match(bodies, /export const SURFACE = Object\.freeze\(\{ CIRCUIT: 0, BANDS: 1, CONTINENTS: 2, MARBLE: 3 \}\);/,
    'bodies.js numbers the four surfaces 0..3 in this order');
  assert.deepEqual([...dyn.DYNAMIC_SURFACE_TYPES], [0, 1, 2, 3]);
  // Over many names every surface type is used (the choice is spread by the hash)
  const used = new Set();
  for (let i = 0; i < 200; i++) used.add(dyn.dynamicLook(`agent-${i}`).surface);
  assert.deepEqual([...used].sort(), [0, 1, 2, 3]);
});

test('hash: FNV-1a 32-bit reference values (empty string and "a")', async () => {
  const { dyn } = await load();
  assert.equal(dyn.hashName(''), 0x811c9dc5);
  assert.equal(dyn.hashName('a'), 0xe40c292c);
});

test('colour maths: hslToHex gives the primary colours and the grey axis; cssHex pads to six digits', async () => {
  const { dyn } = await load();
  assert.equal(dyn.hslToHex(0, 1, 0.5), 0xff0000);
  assert.equal(dyn.hslToHex(120, 1, 0.5), 0x00ff00);
  assert.equal(dyn.hslToHex(240, 1, 0.5), 0x0000ff);
  assert.equal(dyn.hslToHex(0, 0, 1), 0xffffff);
  assert.equal(dyn.hslToHex(0, 0, 0), 0x000000);
  assert.equal(dyn.hslToHex(-120, 1, 0.5), dyn.hslToHex(240, 1, 0.5), 'negative hue wraps');
  assert.equal(dyn.cssHex(0x0a0b0c), '#0a0b0c');
  assert.equal(dyn.cssHex(0x00ff00), '#00ff00');
});

test('registry: planets are added in arrival order, the ring is the arrival index, a repeat is "exists"', async () => {
  const { dyn } = await load();
  const reg = dyn.createDynamicRegistry();
  const a = reg.add('data-analyst');
  const b = reg.add('Explore');
  assert.equal(a.status, 'added');
  assert.equal(a.key, 'dyn:data-analyst');
  assert.equal(a.index, 0);
  assert.equal(b.index, 1);
  const again = reg.add('data-analyst');
  assert.deepEqual(again, { status: 'exists', key: 'dyn:data-analyst', index: 0 });
  assert.deepEqual(reg.keys(), ['dyn:data-analyst', 'dyn:Explore'], 'keys in arrival order');
  assert.equal(reg.size(), 2);
  assert.equal(reg.get('dyn:Explore').agent, 'Explore');
  assert.deepEqual(reg.get('dyn:Explore').look, dyn.dynamicLook('Explore'), 'the entry holds the look of its name');
  assert.equal(reg.get('dyn:none'), undefined);
});

test('registry: registered agents are ignored (no planet created by the registry)', async () => {
  const { dyn } = await load();
  const reg = dyn.createDynamicRegistry();
  for (const agent of REGISTERED_AGENTS) {
    assert.deepEqual(reg.add(agent), { status: 'ignored', key: null, index: -1 }, agent);
  }
  assert.equal(reg.size(), 0);
});

test('registry: the cap is MAX_DYNAMIC_PLANETS (4); the fifth agent is refused, logged once, and not drawn', async () => {
  const { dyn } = await load();
  assert.equal(dyn.MAX_DYNAMIC_PLANETS, 4, 'the documented cap');
  const reg = dyn.createDynamicRegistry();
  for (let i = 0; i < 4; i++) assert.equal(reg.add(`agent-${i}`).status, 'added');
  const first = reg.add('agent-4');
  assert.equal(first.status, 'full');
  assert.equal(first.first, true, 'the first refusal is flagged for the one-time log line');
  const second = reg.add('agent-4');
  assert.equal(second.status, 'full');
  assert.equal(second.first, false, 'a repeated refusal is not flagged again');
  assert.equal(reg.size(), 4, 'the cap is never exceeded');
  assert.deepEqual(reg.refused(), ['agent-4']);
  // A planet that exists keeps its ring while the cap is full
  assert.deepEqual(reg.add('agent-3'), { status: 'exists', key: 'dyn:agent-3', index: 3 });
});

test('registry: a smaller cap works the same way (the parameter is used)', async () => {
  const { dyn } = await load();
  const reg = dyn.createDynamicRegistry(2);
  assert.equal(reg.max, 2);
  reg.add('one');
  reg.add('two');
  assert.equal(reg.add('three').status, 'full');
  assert.deepEqual(reg.keys(), ['dyn:one', 'dyn:two']);
});
