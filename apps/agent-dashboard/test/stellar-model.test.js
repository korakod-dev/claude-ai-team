'use strict';
/**
 * stellar-model.test.js - Pure rules of the Stellar Universe view (public/workspace/stellar/model.js):
 *   - step <-> agent mapping (the planets are the five registered sub-agents, the sun is the main agent)
 *   - body mood from status (COMPLETED is a flash only while flashing)
 *   - planet look per mood (idle slow / active fast + energy ring / error jitter + red aura)
 *   - event -> visual intents (ERROR -> failure comet into the black hole, COMPLETED from a planet -> result comet)
 *   - data honesty: metrics that the event data does not have are "no data"
 * The stellar folder is an ES module folder (stellar/package.json), so the test imports it with import().
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const STELLAR_DIR = path.join(__dirname, '..', 'public', 'workspace', 'stellar');
const SCENE_FILE = path.join(__dirname, '..', 'public', 'workspace', 'scene.js');

/** Load the model module (ES module) once per test file. */
async function loadModel() {
  return import(pathToFileURL(path.join(STELLAR_DIR, 'model.js')).href);
}

test('mapping: the sun is the main agent and the planets are the five registered sub-agents (PM-Professor-X included)', async () => {
  const m = await loadModel();
  assert.equal(m.SUN_STEP, 'router');
  assert.deepEqual([...m.PLANET_STEPS], ['pm', 'appdev', 'qa', 'study', 'portfolio']);
  assert.equal(m.STEP_AGENT.router, 'secretary');
  assert.equal(m.STEP_AGENT.pm, 'pm');
  // The inverse map is exact (one step per agent)
  for (const [step, agent] of Object.entries(m.STEP_AGENT)) assert.equal(m.AGENT_STEP[agent], step);
});

test('mapping: scene.js has one planet per PLANET_STEPS entry (SATELLITE_CONFIG keys match)', async () => {
  const m = await loadModel();
  const code = fs.readFileSync(SCENE_FILE, 'utf8');
  const block = code.match(/const SATELLITE_CONFIG = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'scene.js declares SATELLITE_CONFIG');
  const keys = [...block[1].matchAll(/^\s+(\w+):/gm)].map((x) => x[1]).sort();
  assert.deepEqual(keys, [...m.PLANET_STEPS].sort());
});

test('PM-Professor-X: planet step, agent id and label (PM-Professor-X (Opus-High) once the model suffix is known)', async () => {
  const m = await loadModel();
  m.setAgentModels({});
  assert.equal(m.AGENT_STEP.pm, 'pm');
  assert.equal(m.isPlanetKey('pm'), true);
  assert.equal(m.agentOfBodyKey('pm'), 'pm');
  assert.equal(m.dynamicKeyOf('pm'), null, 'PM-Professor-X has a registered planet, never a dynamic one');
  assert.equal(m.bodyKeyOf({ agent: 'pm', status: 'WORKING', message: 'x' }), 'pm');
  assert.equal(m.labelOf('pm'), 'PM-Professor-X · planner');
  m.setAgentModels({ pm: { suffix: 'Opus-High' } });
  assert.equal(m.labelOf('pm'), 'PM-Professor-X (Opus-High) · planner');
  assert.equal(m.withModel('PM-Professor-X', 'pm'), 'PM-Professor-X (Opus-High)');
  assert.deepEqual(m.visualIntentsForEvent({ agent: 'pm', status: 'COMPLETED', message: 'x' }), [{ kind: 'result', step: 'pm' }]);
  m.setAgentModels({});
});

test('labelOf: known ids get their display name, unknown ids are shown as they are, junk is "unknown"', async () => {
  const m = await loadModel();
  assert.equal(m.labelOf('app-dev'), 'Dev-ไอ้เก่ง · apps/');
  assert.equal(m.labelOf('brand-new-agent'), 'brand-new-agent');
  assert.equal(m.labelOf('constructor'), 'constructor', 'prototype keys are not labels');
  assert.equal(m.labelOf(''), 'unknown');
  assert.equal(m.labelOf(undefined), 'unknown');
});

test('stepOfEvent: pipelineStep wins, otherwise the step of the agent, otherwise null', async () => {
  const m = await loadModel();
  assert.equal(m.stepOfEvent({ agent: 'app-dev', pipelineStep: 'qa' }), 'qa');
  assert.equal(m.stepOfEvent({ agent: 'app-dev' }), 'appdev');
  assert.equal(m.stepOfEvent({ agent: 'unknown-agent' }), null);
  assert.equal(m.stepOfEvent(null), null);
});

test('mood: PROCESSING and WORKING are active, ERROR is error, COMPLETED is done only while flashing', async () => {
  const m = await loadModel();
  assert.equal(m.statusMood('PROCESSING'), m.MOOD.ACTIVE);
  assert.equal(m.statusMood('WORKING'), m.MOOD.ACTIVE);
  assert.equal(m.statusMood('ERROR'), m.MOOD.ERROR);
  assert.equal(m.statusMood('COMPLETED', true), m.MOOD.DONE);
  assert.equal(m.statusMood('COMPLETED', false), m.MOOD.IDLE, 'after the flash a completed planet is idle');
  assert.equal(m.statusMood('IDLE'), m.MOOD.IDLE);
  assert.equal(m.statusMood('whatever'), m.MOOD.IDLE);
});

test('planet look: idle is slow and pale blue, active is faster with the energy ring, error jitters and turns red', async () => {
  const m = await loadModel();
  const idle = m.planetLook(m.MOOD.IDLE);
  const active = m.planetLook(m.MOOD.ACTIVE);
  const done = m.planetLook(m.MOOD.DONE);
  const error = m.planetLook(m.MOOD.ERROR);

  assert.ok(idle.spin > 0 && idle.spin < active.spin, 'active spins faster than idle');
  assert.equal(idle.energy, 0, 'no energy ring when idle');
  assert.equal(active.energy, 1, 'energy ring when active');
  assert.equal(idle.jitter, 0);
  assert.equal(error.jitter, 1, 'error shakes');
  assert.equal(idle.tint, 0xbae6fd, 'idle halo is pale blue');
  assert.equal(done.tint, 0xfef08a, 'completed flash is pale yellow');
  assert.equal(error.tint, 0xff3b3b, 'error aura is red');
  // Unknown moods fall back to idle
  assert.deepEqual(m.planetLook('nope'), idle);
});

test('visual intents: ERROR -> failure, COMPLETED from a planet -> result, the sun and the user draw no comet', async () => {
  const m = await loadModel();
  assert.deepEqual(m.visualIntentsForEvent({ agent: 'app-dev', status: 'ERROR', message: 'x' }), [{ kind: 'failure', step: 'appdev' }]);
  assert.deepEqual(m.visualIntentsForEvent({ agent: 'portfolio-writer', status: 'COMPLETED', message: 'x' }), [{ kind: 'result', step: 'portfolio' }]);
  // The main agent failing still sends debris into the black hole
  assert.deepEqual(m.visualIntentsForEvent({ agent: 'secretary', pipelineStep: 'router', status: 'ERROR', message: 'x' }), [{ kind: 'failure', step: 'router' }]);
  // The main agent completing draws no result comet (the comet would go from the sun to itself)
  assert.deepEqual(m.visualIntentsForEvent({ agent: 'secretary', pipelineStep: 'router', status: 'COMPLETED', message: 'x' }), []);
  // Dispatch (PROCESSING) is drawn by handoff(), not by an intent
  assert.deepEqual(m.visualIntentsForEvent({ agent: 'qa-reviewer', status: 'PROCESSING', message: 'x' }), []);
  // Unknown agents and the user beacon draw nothing
  // Changed with dynamic planets: an unregistered agent has its own planet ('dyn:<agent>'), so its failure draws a comet
  assert.deepEqual(m.visualIntentsForEvent({ agent: 'mystery', status: 'ERROR', message: 'x' }), [{ kind: 'failure', step: 'dyn:mystery' }]);
  assert.deepEqual(m.visualIntentsForEvent({ agent: 'user', status: 'ERROR', message: 'x' }), []);
});

test('data honesty: formatMetric is "no data" for missing values, and metricRows never invents a number', async () => {
  const m = await loadModel();
  assert.equal(m.formatMetric(null), m.NO_DATA);
  assert.equal(m.formatMetric(undefined), m.NO_DATA);
  assert.equal(m.formatMetric(''), m.NO_DATA);
  assert.equal(m.formatMetric(NaN), m.NO_DATA);
  assert.equal(m.formatMetric(Infinity), m.NO_DATA);
  assert.equal(m.formatMetric(42), '42');
  const rows = m.metricRows({});
  assert.deepEqual(rows.map((r) => r.key), m.METRICS.map((x) => x.key));
  for (const r of rows) assert.equal(r.text, 'no data', `${r.key} has no data`);
  // A value that is present is shown; a prototype key is not treated as a value
  const withCpu = m.metricRows({ cpu: '12%', constructor: 'x' });
  assert.equal(withCpu.find((r) => r.key === 'cpu').text, '12%');
  assert.equal(withCpu.find((r) => r.key === 'memory').text, 'no data');
});
