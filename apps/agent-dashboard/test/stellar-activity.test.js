'use strict';
/**
 * stellar-activity.test.js - logic of the activity effects (public/workspace/stellar/activity.js and the close hook of store.js).
 * Pure: no THREE, no DOM, no timers (a fake clock is passed in). Covers
 *   - the thinking / acting state machine per instance and per planet
 *   - beam colour by tool type
 *   - burst triggers (green on COMPLETED, red on ERROR, nothing for anything else) and the store hook that feeds them
 *   - caps: beam / burst pool size, one beam per actor per gap, bounded memory, call timeout
 *   - the heartbeat curve, message validation and the text label of the agent list
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const imp = (...parts) => import(pathToFileURL(path.join(WORKSPACE_DIR, ...parts)).href);

const T0 = Date.parse('2026-10-13T10:00:00.000Z');
const start = (agent, tool, extra = {}) => ({ agent, phase: 'start', tool, ...extra });
const end = (agent, tool, extra = {}) => ({ agent, phase: 'end', tool, ...extra });

// ---------- state machine ----------

test('state machine: an instance is thinking from its start, acting between PreToolUse and PostToolUse, thinking again after', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  const live = ['toolu_A'];

  // Started, no tool yet: thinking
  assert.deepEqual(tr.instanceActivity('app-dev', 'toolu_A', T0), { state: 'thinking', tool: null });
  assert.equal(tr.agentActivity('app-dev', live, T0).state, 'thinking');

  // PreToolUse: acting (the tool name is reported)
  tr.ingest(start('app-dev', 'Read', { callId: 'c1', instance: 'toolu_A' }), T0 + 10);
  assert.deepEqual(tr.instanceActivity('app-dev', 'toolu_A', T0 + 20), { state: 'acting', tool: 'Read' });
  const acting = tr.agentActivity('app-dev', live, T0 + 20);
  assert.equal(acting.state, 'acting');
  assert.equal(acting.tool, 'Read');
  assert.equal(acting.thinking, 0);

  // PostToolUse: a tool just finished and none runs: thinking again
  tr.ingest(end('app-dev', 'Read', { callId: 'c1', instance: 'toolu_A' }), T0 + 500);
  assert.equal(tr.instanceActivity('app-dev', 'toolu_A', T0 + 510).state, 'thinking');
  assert.equal(tr.agentActivity('app-dev', live, T0 + 510).state, 'thinking');
});

test('state machine: PostToolUseFailure ends the call too (phase error), and overlapping calls keep the actor acting until the last ends', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  tr.ingest(start('qa-reviewer', 'Grep', { callId: 'c1', instance: 'i1' }), T0);
  tr.ingest(start('qa-reviewer', 'Bash', { callId: 'c2', instance: 'i1' }), T0 + 200);   // parallel tool calls
  tr.ingest({ agent: 'qa-reviewer', phase: 'error', tool: 'Grep', callId: 'c1', instance: 'i1' }, T0 + 400);
  assert.deepEqual(tr.instanceActivity('qa-reviewer', 'i1', T0 + 410), { state: 'acting', tool: 'Bash' }, 'one call still runs');
  tr.ingest(end('qa-reviewer', 'Bash', { callId: 'c2', instance: 'i1' }), T0 + 600);
  assert.equal(tr.instanceActivity('qa-reviewer', 'i1', T0 + 610).state, 'thinking');
});

test('state machine: no live instance = idle; an instance that is gone is not counted even if it had a running call', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  assert.equal(tr.agentActivity('pm', [], T0).state, 'idle');
  tr.ingest(start('pm', 'Read', { callId: 'c1', instance: 'gone' }), T0);
  // The planet asks with its LIVE ids only: 'gone' is not live, so its call does not make the planet act
  assert.equal(tr.agentActivity('pm', [], T0 + 10).state, 'idle');
  assert.equal(tr.agentActivity('pm', ['other'], T0 + 10).state, 'thinking');
});

test('state machine per instance: one moon acts while the other thinks; the planet is acting and still counts the thinking one', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  const live = ['A', 'B'];
  tr.ingest(start('app-dev', 'Edit', { callId: 'c1', instance: 'A' }), T0);
  assert.equal(tr.instanceActivity('app-dev', 'A', T0 + 1).state, 'acting');
  assert.equal(tr.instanceActivity('app-dev', 'B', T0 + 1).state, 'thinking', 'B is not touched by the call of A');
  const planet = tr.agentActivity('app-dev', live, T0 + 1);
  assert.equal(planet.state, 'acting');
  assert.equal(planet.acting, 1);
  assert.equal(planet.thinking, 1, 'B still thinks: the planet halo keeps pulsing');
  tr.ingest(end('app-dev', 'Edit', { callId: 'c1', instance: 'A' }), T0 + 300);
  assert.equal(tr.agentActivity('app-dev', live, T0 + 310).thinking, 2);
});

test('attribution fallback: a call without an instance is a planet-level actor and takes one thinking instance with it', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  tr.ingest(start('app-dev', 'Read', { callId: 'c1' }), T0);   // no instance: the server could not attribute it
  // A single live instance: it must be the one acting
  const single = tr.agentActivity('app-dev', ['A'], T0 + 1);
  assert.equal(single.state, 'acting');
  assert.equal(single.thinking, 0);
  // Two live instances: one of them acts, the other is still thinking
  const two = tr.agentActivity('app-dev', ['A', 'B'], T0 + 1);
  assert.equal(two.acting, 1);
  assert.equal(two.thinking, 1);
  tr.ingest(end('app-dev', 'Read', { callId: 'c1' }), T0 + 200);
  assert.equal(tr.agentActivity('app-dev', ['A'], T0 + 210).state, 'thinking');
});

test('the main session (no instance, no live task) only acts: the sun never "thinks"', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  assert.equal(tr.agentActivity('secretary', [], T0).state, 'idle');
  tr.ingest(start('secretary', 'Bash', { callId: 's1' }), T0);
  assert.deepEqual(
    (({ state, tool }) => ({ state, tool }))(tr.agentActivity('secretary', [], T0 + 1)),
    { state: 'acting', tool: 'Bash' },
  );
  tr.ingest(end('secretary', 'Bash', { callId: 's1' }), T0 + 100);
  assert.equal(tr.agentActivity('secretary', [], T0 + 110).state, 'idle');
});

test('an end without a call id closes the oldest call of the same tool, else the oldest call', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  tr.ingest(start('qa-reviewer', 'Read', {}), T0);
  tr.ingest(start('qa-reviewer', 'Grep', {}), T0 + 1);
  tr.ingest(end('qa-reviewer', 'Read', {}), T0 + 2);
  assert.equal(tr.instanceActivity('qa-reviewer', null, T0 + 3).tool, 'Grep', 'the Read call ended, the Grep call still runs');
  tr.ingest(end('qa-reviewer', 'WebFetch', {}), T0 + 4);   // unknown tool name: the oldest call is closed
  assert.equal(tr.instanceActivity('qa-reviewer', null, T0 + 5).state, 'thinking');
  tr.ingest(end('qa-reviewer', 'Read', {}), T0 + 6);       // nothing left: ignored, no throw
});

test('an end that names another instance than its start (the link became trusted in between) still closes the call by its id', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  tr.ingest(start('app-dev', 'Edit', { callId: 'c1' }), T0);                       // planet level
  tr.ingest(end('app-dev', 'Edit', { callId: 'c1', instance: 'A' }), T0 + 50);     // now with an instance
  assert.equal(tr.agentActivity('app-dev', ['A'], T0 + 60).state, 'thinking');
});

test('a call whose end event is lost stops counting after CALL_TIMEOUT_MS (the planet cannot stay "acting" for ever)', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  tr.ingest(start('app-dev', 'Bash', { callId: 'c1', instance: 'A' }), T0);
  assert.equal(tr.instanceActivity('app-dev', 'A', T0 + A.CALL_TIMEOUT_MS - 1).state, 'acting');
  assert.equal(tr.instanceActivity('app-dev', 'A', T0 + A.CALL_TIMEOUT_MS + 1).state, 'thinking');
  assert.equal(tr.agentActivity('app-dev', ['A'], T0 + A.CALL_TIMEOUT_MS + 1).state, 'thinking');
});

test('release() forgets an instance (it finished), clear() forgets everything', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  tr.ingest(start('app-dev', 'Read', { callId: 'c1', instance: 'A' }), T0);
  tr.ingest(start('app-dev', 'Read', { callId: 'c2' }), T0 + 200);
  assert.equal(tr.size(), 2);
  tr.release('app-dev', 'A');
  assert.equal(tr.instanceActivity('app-dev', 'A', T0 + 300).state, 'thinking');
  assert.equal(tr.size(), 1);
  tr.clear();
  assert.equal(tr.size(), 0);
});

test('invalid messages are ignored and never throw', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  for (const bad of [null, undefined, 5, 'x', {}, { agent: 'a' }, { agent: 'a', phase: 'start' }, { agent: 'a', phase: 'bogus', tool: 'Read' },
    { agent: '', phase: 'start', tool: 'Read' }, { agent: 'a', phase: 'start', tool: '' }, [1, 2]]) {
    assert.deepEqual(tr.ingest(bad, T0), { beam: null });
  }
  assert.equal(tr.size(), 0);
});

// ---------- beam colours ----------

test('beam colour by tool type: Read/Grep/Glob cyan, Edit/Write orange, Bash red, WebSearch/WebFetch purple, other white', async () => {
  const A = await imp('stellar', 'activity.js');
  const cyan = A.BEAM_COLORS.read;
  const orange = A.BEAM_COLORS.write;
  const red = A.BEAM_COLORS.shell;
  const purple = A.BEAM_COLORS.web;
  const white = A.BEAM_COLORS.other;
  assert.equal(new Set([cyan, orange, red, purple, white]).size, 5, 'five distinct colours');
  assert.equal(white, 0xffffff);
  for (const tool of ['Read', 'Grep', 'Glob']) assert.equal(A.beamColor(tool), cyan, tool);
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.equal(A.beamColor(tool), orange, tool);
  assert.equal(A.beamColor('Bash'), red);
  for (const tool of ['WebSearch', 'WebFetch']) assert.equal(A.beamColor(tool), purple, tool);
  for (const tool of ['TodoWrite', 'mcp__server__tool', 'Task', 'SomethingNew', '', undefined, null, 42]) assert.equal(A.beamColor(tool), white, String(tool));
  // Case and surrounding space do not matter
  assert.equal(A.beamColor('  read '), cyan);
  assert.equal(A.beamColor('BASH'), red);
  assert.equal(A.toolGroup('webfetch'), 'web');
  assert.equal(A.toolGroup('nope'), 'other');
});

test('ingest(start) returns the beam with the colour of its tool, and the agent / instance it belongs to', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  const { beam } = tr.ingest(start('app-dev', 'Edit', { callId: 'c1', instance: 'A' }), T0);
  assert.equal(beam.color, A.BEAM_COLORS.write);
  assert.equal(beam.group, 'write');
  assert.equal(beam.agent, 'app-dev');
  assert.equal(beam.instance, 'A');
  assert.equal(beam.tool, 'Edit');
  assert.equal(tr.ingest(end('app-dev', 'Edit', { callId: 'c1', instance: 'A' }), T0 + 10).beam, null, 'an end draws no beam');
  assert.equal(tr.ingest(start('app-dev', 'Bash', { callId: 'c2' }), T0 + 500).beam.instance, null, 'no instance = planet level');
});

// ---------- burst triggers ----------

test('burst triggers: COMPLETED is green, ERROR is red, anything else (or no close) draws nothing', async () => {
  const A = await imp('stellar', 'activity.js');
  const ok = A.burstFor({ agent: 'app-dev', id: 'toolu_A', status: 'COMPLETED' });
  assert.deepEqual(ok, { kind: 'complete', agent: 'app-dev', id: 'toolu_A', color: A.BURST_COLORS.complete });
  const bad = A.burstFor({ agent: 'app-dev', id: 'toolu_A', status: 'ERROR' });
  assert.deepEqual(bad, { kind: 'error', agent: 'app-dev', id: 'toolu_A', color: A.BURST_COLORS.error });
  assert.equal(A.BURST_COLORS.complete, 0x4ade80, 'green');
  assert.equal(A.BURST_COLORS.error, 0xff4d4d, 'red');
  assert.equal(A.burstFor({ agent: 'app-dev', id: null, status: 'ERROR' }).id, null, 'a failure with no task: planet only');
  for (const none of [null, undefined, {}, { agent: 'a', id: 'x', status: 'WORKING' }, { agent: 'a', id: 'x', status: 'PROCESSING' },
    { agent: '', id: 'x', status: 'COMPLETED' }, { id: 'x', status: 'COMPLETED' }]) {
    assert.equal(A.burstFor(none), null);
  }
});

test('store.takeClose: reports the task an event closed (exact id, FIFO, failure on its own) and nothing else; read once', async () => {
  const { createStore } = await imp('stellar', 'store.js');
  const st = createStore();
  const ev = (agent, status, toolUseId) => ({ ts: new Date(T0).toISOString(), agent, status, message: 'm', ...(toolUseId ? { toolUseId } : {}) });

  st.ingest(ev('app-dev', 'PROCESSING', 'toolu_A'));
  assert.equal(st.takeClose(), null, 'opening a task closes nothing');
  st.ingest(ev('app-dev', 'PROCESSING', 'toolu_B'));
  st.ingest(ev('app-dev', 'COMPLETED', 'toolu_B'));
  assert.deepEqual(st.takeClose(), { agent: 'app-dev', id: 'toolu_B', status: 'COMPLETED' }, 'exact close by id');
  assert.equal(st.takeClose(), null, 'read once');

  // A failure reported by the caller closes the task of ANOTHER agent: the burst belongs to that agent
  st.ingest(ev('qa-reviewer', 'PROCESSING', 'toolu_Q'));
  st.ingest(ev('secretary', 'ERROR', 'toolu_Q'));
  assert.deepEqual(st.takeClose(), { agent: 'qa-reviewer', id: 'toolu_Q', status: 'ERROR' });

  // FIFO close without an id: the oldest open task of the agent (toolu_A)
  st.ingest(ev('app-dev', 'COMPLETED'));
  assert.deepEqual(st.takeClose(), { agent: 'app-dev', id: 'toolu_A', status: 'COMPLETED' });

  // A failure with no open task: a failed task on its own (no id)
  st.ingest(ev('pm', 'ERROR'));
  assert.deepEqual(st.takeClose(), { agent: 'pm', id: null, status: 'ERROR' });

  // A COMPLETED with an id and no open task (late duplicate), a COMPLETED without a task, and a WORKING event close nothing
  st.ingest(ev('app-dev', 'COMPLETED', 'toolu_gone'));
  assert.equal(st.takeClose(), null);
  st.ingest(ev('study-writer', 'COMPLETED'));
  assert.equal(st.takeClose(), null);
  st.ingest(ev('study-writer', 'WORKING'));
  assert.equal(st.takeClose(), null);
  // An invalid event is ignored; reset forgets a pending close
  st.ingest(ev('app-dev', 'PROCESSING', 'toolu_Z'));
  st.ingest(ev('app-dev', 'COMPLETED', 'toolu_Z'));
  st.reset();
  assert.equal(st.takeClose(), null);
});

test('an unknown id close keeps the same id shape the moons use: a task without a tool_use_id is task-<n>', async () => {
  const { createStore } = await imp('stellar', 'store.js');
  const st = createStore();
  const ev = (status) => ({ ts: new Date(T0).toISOString(), agent: 'app-dev', status, message: 'm' });
  st.ingest(ev('PROCESSING'));
  const id = st.snapshot('app-dev', T0).currentTasks[0].id;
  assert.match(id, /^task-\d+$/);
  st.ingest(ev('COMPLETED'));
  assert.equal(st.takeClose().id, id, 'the burst finds the moon by the same id');
});

// ---------- caps ----------

test('pickSlot: a free slot first, then the oldest active one; never beyond the pool; steal=false refuses', async () => {
  const A = await imp('stellar', 'activity.js');
  const pool = Array.from({ length: 3 }, () => ({ active: false, start: 0 }));
  assert.equal(A.pickSlot(pool), 0);
  pool[0].active = true; pool[0].start = 5;
  pool[1].active = true; pool[1].start = 2;
  assert.equal(A.pickSlot(pool), 2, 'the free slot');
  pool[2].active = true; pool[2].start = 9;
  assert.equal(A.pickSlot(pool), 1, 'full: the oldest (smallest start)');
  assert.equal(A.pickSlot(pool, false), -1, 'full and not allowed to steal');
  assert.equal(A.pickSlot([]), -1, 'an empty (disposed) pool');
});

test('caps: a storm of beams never uses more than MAX_BEAMS slots and MAX_BURSTS slots (the pool is reused)', async () => {
  const A = await imp('stellar', 'activity.js');
  const beams = Array.from({ length: A.MAX_BEAMS }, () => ({ active: false, start: 0 }));
  const bursts = Array.from({ length: A.MAX_BURSTS }, () => ({ active: false, start: 0 }));
  const used = new Set();
  for (let i = 0; i < 500; i++) {
    const k = A.pickSlot(beams);
    assert.ok(k >= 0 && k < A.MAX_BEAMS);
    beams[k].active = true; beams[k].start = i; used.add(k);
    const j = A.pickSlot(bursts);
    assert.ok(j >= 0 && j < A.MAX_BURSTS);
    bursts[j].active = true; bursts[j].start = i;
  }
  assert.equal(beams.length, A.MAX_BEAMS, 'the pool never grows');
  assert.equal(bursts.length, A.MAX_BURSTS);
  assert.equal(used.size, A.MAX_BEAMS);
  assert.ok(A.MAX_BEAMS >= 4 && A.MAX_BEAMS <= 24, 'a small pool');
  assert.ok(A.MAX_BURSTS >= 2 && A.MAX_BURSTS <= 12);
});

test('caps: one actor draws at most one beam per BEAM_MIN_GAP_MS (calls are still tracked); other actors are not limited', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  let beams = 0;
  for (let i = 0; i < 100; i++) {
    // 100 Grep calls in 500 ms from ONE instance
    if (tr.ingest(start('qa-reviewer', 'Grep', { callId: `c${i}`, instance: 'Q' }), T0 + i * 5).beam) beams += 1;
  }
  assert.ok(beams <= Math.ceil(500 / A.BEAM_MIN_GAP_MS) + 1, `a Grep storm gives ${beams} beams, not 100`);
  assert.equal(tr.instanceActivity('qa-reviewer', 'Q', T0 + 600).state, 'acting', 'every call is still tracked');
  // Another actor at the same moment still gets its beam
  assert.ok(tr.ingest(start('app-dev', 'Read', { callId: 'x', instance: 'D' }), T0 + 500).beam);
  // After the gap the same actor draws again, and the seq (fan-out angle) advances
  const a = tr.ingest(start('app-dev', 'Read', { callId: 'y', instance: 'D' }), T0 + 500 + A.BEAM_MIN_GAP_MS).beam;
  assert.ok(a && a.seq === 1);
});

test('caps: the tracker is bounded in actors and in calls per actor', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker({ maxActors: 5, maxCalls: 3 });
  for (let i = 0; i < 20; i++) tr.ingest(start('app-dev', 'Read', { callId: `c${i}`, instance: `i${i}` }), T0 + i * 1000);
  assert.equal(tr.size(), 5, 'at most maxActors actors are kept');
  for (let i = 0; i < 10; i++) tr.ingest(start('pm', 'Read', { callId: `p${i}` }), T0 + 100000 + i);
  // 3 calls kept: ending the 3 newest leaves the actor thinking, so older ones were dropped
  for (const n of [9, 8, 7]) tr.ingest(end('pm', 'Read', { callId: `p${n}` }), T0 + 100100);
  assert.equal(tr.instanceActivity('pm', null, T0 + 100200).state, 'thinking', 'the calls older than maxCalls were dropped');
});

test('caps: activity messages older than ACTIVITY_MAX_AGE_MS are stale (history), unreadable ts counts as stale', async () => {
  const A = await imp('stellar', 'activity.js');
  const now = T0 + 60000;
  assert.equal(A.isStale({ ts: new Date(now - 1000).toISOString() }, now), false);
  assert.equal(A.isStale({ ts: new Date(now - A.ACTIVITY_MAX_AGE_MS - 1).toISOString() }, now), true);
  assert.equal(A.isStale({ ts: 'nope' }, now), true);
  assert.equal(A.isStale({}, now), true);
});

// ---------- pulse, labels ----------

test('heartbeat: bounded 0..1, periodic, two beats then a rest (slow)', async () => {
  const A = await imp('stellar', 'activity.js');
  let max = 0;
  let min = 1;
  for (let t = 0; t < 3.6; t += 0.01) {
    const v = A.heartbeat(t);
    assert.ok(v >= 0 && v <= 1, `heartbeat(${t}) = ${v}`);
    max = Math.max(max, v); min = Math.min(min, v);
    assert.ok(Math.abs(v - A.heartbeat(t + 1.8)) < 1e-9, 'periodic');
  }
  assert.ok(max > 0.9, 'reaches the top of a beat');
  assert.ok(min < 0.05, 'rests between beats');
  assert.ok(A.heartbeat(0.12 * 1.8) > A.heartbeat(0.34 * 1.8) && A.heartbeat(0.34 * 1.8) > 0.4, 'the second beat is weaker but real');
  assert.ok(A.heartbeat(-0.5) >= 0, 'negative time is fine');
});

test('activityLabel: the text state of the agent list ("คิดอยู่" / "กำลังใช้ tool: Read" / nothing)', async () => {
  const A = await imp('stellar', 'activity.js');
  assert.equal(A.activityLabel({ state: 'thinking', tool: null }), 'คิดอยู่');
  assert.equal(A.activityLabel({ state: 'acting', tool: 'Read' }), 'กำลังใช้ tool: Read');
  assert.equal(A.activityLabel({ state: 'acting', tool: null }), 'กำลังใช้ tool');
  assert.equal(A.activityLabel({ state: 'idle', tool: null }), '');
  assert.equal(A.activityLabel(null), '');
});

test('activity.js is pure (no DOM, no THREE); effects.js builds its pools once and can dispose them', async () => {
  const fs = require('fs');
  const strip = (code) => code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const pure = strip(fs.readFileSync(path.join(WORKSPACE_DIR, 'stellar', 'activity.js'), 'utf8'));
  assert.equal(/\bdocument\b|\bwindow\b|three/i.test(pure), false, 'activity.js has no DOM and no THREE');

  const fx = strip(fs.readFileSync(path.join(WORKSPACE_DIR, 'stellar', 'effects.js'), 'utf8'));
  assert.match(fx, /for \(let i = 0; i < MAX_BEAMS; i\+\+\)/, 'beam pool built once, MAX_BEAMS slots');
  assert.match(fx, /for \(let i = 0; i < MAX_BURSTS; i\+\+\)/, 'burst pool built once, MAX_BURSTS slots');
  assert.match(fx, /pickSlot\(beams\)/);
  assert.match(fx, /pickSlot\(bursts\)/);
  assert.match(fx, /function dispose\(\)/, 'a dispose path');
  for (const what of ['beamGeo.dispose()', 'burstGeo.dispose()', 'beamTex.dispose()', 'dotTex.dispose()', 'material.dispose()']) {
    assert.ok(fx.includes(what), `dispose frees ${what}`);
  }
  assert.match(fx, /if \(reducedMotion \|\| !anchor\) return false;/, 'beam() and burst() do nothing with reduced motion');
  // No allocation in the per-frame update: no `new` between "function update" and "function clear"
  const update = fx.slice(fx.indexOf('function update('), fx.indexOf('function clear()'));
  assert.equal(/\bnew\s+\w/.test(update), false, 'update() creates no objects');
  assert.equal(/\.map\(|\.filter\(|\.slice\(|\[\.\.\./.test(update), false, 'update() creates no arrays');
});

// ---------- failed ordinary tool = red beam (2026-10-13) ----------

test('failed tool call (phase error): ends the call AND returns a red failure beam for that actor, not rate-limited by the beam gap', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  const first = tr.ingest(start('app-dev', 'Bash', { callId: 'c1', instance: 'A' }), T0).beam;
  assert.equal(first.color, A.BEAM_COLORS.shell);
  assert.notEqual(A.FAILURE_BEAM_COLOR, A.BEAM_COLORS.shell, 'a failure is told apart from a normal Bash beam');
  assert.notEqual(A.FAILURE_BEAM_COLOR, A.BEAM_COLORS.other);
  // 10 ms later (inside BEAM_MIN_GAP_MS): the failure still draws
  const { beam } = tr.ingest({ agent: 'app-dev', phase: 'error', tool: 'Bash', callId: 'c1', instance: 'A' }, T0 + 10);
  assert.ok(beam, 'a failure draws a beam');
  assert.equal(beam.color, A.FAILURE_BEAM_COLOR);
  assert.equal(beam.failed, true);
  assert.equal(beam.group, 'error');
  assert.equal(beam.agent, 'app-dev');
  assert.equal(beam.instance, 'A');
  assert.equal(beam.tool, 'Bash');
  assert.equal(beam.seq, first.seq + 1, 'fans out after the start beam of the same actor');
  assert.equal(tr.instanceActivity('app-dev', 'A', T0 + 20).state, 'thinking', 'the call ended: thinking again');
});

test('failed tool call: a call that was never seen (lost start, other page load) still draws the red beam; planet level without instance', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  const { beam } = tr.ingest({ agent: 'secretary', phase: 'error', tool: 'Edit', callId: 'unknown' }, T0);
  assert.equal(beam.failed, true);
  assert.equal(beam.instance, null);
  assert.equal(beam.agent, 'secretary');
});

test('only the error phase draws a failure beam: start draws a normal one, end draws none', async () => {
  const A = await imp('stellar', 'activity.js');
  const tr = A.createActivityTracker();
  const s = tr.ingest(start('pm', 'Read', { callId: 'c1' }), T0).beam;
  assert.equal('failed' in s, false);
  assert.equal(tr.ingest(end('pm', 'Read', { callId: 'c1' }), T0 + 5).beam, null);
});
