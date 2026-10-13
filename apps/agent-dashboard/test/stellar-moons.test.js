'use strict';
/**
 * stellar-moons.test.js - Concurrent instances of one agent: planet status and moons
 * (public/workspace/stellar/store.js + stellar/moons.js). Behaviour level: events go into the real store, and the
 * assertions read what the scene reads (instanceState / snapshot).
 *
 *   - one instance: no moon, the status is the same as before (the single-instance behaviour is unchanged)
 *   - 2-3 instances: one moon each; the status stays PROCESSING until the LAST instance has finished (bug A)
 *   - out-of-order end events (by tool_use_id) close the right instance and its moon only
 *   - one instance fails while the others continue: its moon goes, the planet stays active, the error is recorded
 *   - a missed end event: its moon times out (MOON_TIMEOUT_MS) and the planet goes idle only after staleMs
 *   - more than MAX_MOONS: the oldest MAX_MOONS are drawn and the rest is the "+N" count
 *   - the open-task cap (maxOpen) works together with the moons and the "+N"
 *   - end events without an id (FIFO) close the oldest instance and its moon
 * No DOM, no THREE, no network. The clock is passed to the store (nowMs), nothing waits.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const STELLAR = path.join(__dirname, '..', 'public', 'workspace', 'stellar');
const loadStore = () => import(pathToFileURL(path.join(STELLAR, 'store.js')).href);
const loadMoons = () => import(pathToFileURL(path.join(STELLAR, 'moons.js')).href);

const T0 = Date.parse('2026-10-13T09:00:00.000Z');
const MIN = 60 * 1000;
/** Event time: T0 + s seconds. */
const at = (s) => new Date(T0 + s * 1000).toISOString();
/** Clock of a snapshot: T0 + s seconds. */
const now = (s) => T0 + s * 1000;

/** A workspace event of agent `agent` at second s, with an optional tool_use_id. */
function ev(s, agent, status, message, toolUseId) {
  return { ts: at(s), agent, status, message, ...(toolUseId ? { toolUseId } : {}) };
}
/** Dispatch of an instance (PROCESSING with its tool_use_id). */
const start = (s, id, task, agent = 'app-dev') => ev(s, agent, 'PROCESSING', `รับงาน: ${task}`, id);
/** End of an instance. */
const done = (s, id, agent = 'app-dev') => ev(s, agent, 'COMPLETED', `done ${id}`, id);

/** Ids of the moons drawn for an agent at second s. */
function moonIds(st, agent, s) {
  return st.instanceState(agent, now(s)).moons.shown.map((t) => t.id);
}

test('single instance: no moon, PROCESSING while it runs, COMPLETED when it ends (unchanged behaviour)', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  assert.equal(st.instanceState('app-dev', now(0)).status, 'IDLE');

  st.ingest(start(1, 'toolu_A', 'task A'));
  let inst = st.instanceState('app-dev', now(2));
  assert.equal(inst.status, 'PROCESSING');
  assert.equal(inst.running, 1, 'one running task: the energy ring counts it');
  assert.deepEqual(inst.moons, { shown: [], extra: 0, total: 1 }, 'a single instance has no moon');
  assert.equal(inst.count, 1);

  // A tool-use WORKING event while it runs does not change the picture
  st.ingest(ev(2, 'app-dev', 'WORKING', 'using tool Bash'));
  assert.equal(st.instanceState('app-dev', now(3)).status, 'PROCESSING');

  st.ingest(done(5, 'toolu_A'));
  inst = st.instanceState('app-dev', now(6));
  assert.equal(inst.status, 'COMPLETED', 'the last event decides when nothing runs any more');
  assert.equal(inst.running, 0);
  assert.equal(inst.moons.shown.length, 0);
});

test('single instance: WORKING without any task keeps the planet active (as before); a failed single run reads ERROR', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(ev(1, 'qa-reviewer', 'WORKING', 'using tool Read'));
  assert.equal(st.instanceState('qa-reviewer', now(2)).status, 'WORKING', 'no task, so the latest event decides, as before');

  st.ingest(start(3, 'toolu_Q', 'review', 'qa-reviewer'));
  st.ingest(ev(4, 'qa-reviewer', 'ERROR', 'failed', 'toolu_Q'));
  assert.equal(st.instanceState('qa-reviewer', now(5)).status, 'ERROR', 'ERROR stays until the next status');
});

test('the secretary and the user keep the latest-event status (they have no tasks)', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(ev(1, 'secretary', 'PROCESSING', 'got a prompt'));
  assert.equal(st.instanceState('secretary', now(2)).status, 'PROCESSING');
  st.ingest(ev(3, 'secretary', 'COMPLETED', 'answered'));
  assert.equal(st.instanceState('secretary', now(4)).status, 'COMPLETED');
  assert.deepEqual(st.instanceState('secretary', now(4)).moons.shown, []);
});

test('2 instances: two moons, and the planet stays active when the FIRST one completes (bug A: it used to flip to idle)', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(start(1, 'toolu_A', 'task A'));
  assert.deepEqual(moonIds(st, 'app-dev', 2), [], 'one instance: no moon');
  st.ingest(start(2, 'toolu_B', 'task B'));
  assert.deepEqual(moonIds(st, 'app-dev', 3), ['toolu_A', 'toolu_B'], 'two instances: one moon each');

  st.ingest(done(10, 'toolu_A'));
  const inst = st.instanceState('app-dev', now(11));
  assert.equal(inst.status, 'PROCESSING', 'B still runs: the latest event (A completed) must not turn the planet idle');
  assert.equal(inst.running, 1);
  assert.deepEqual(inst.moons.shown, [], 'one instance left: its moon is gone and it has none (single-instance look)');
  assert.equal(st.snapshot('app-dev', now(11)).status, 'PROCESSING', 'the HUD snapshot agrees');

  st.ingest(done(20, 'toolu_B'));
  assert.equal(st.instanceState('app-dev', now(21)).status, 'COMPLETED', 'all finished: the last event decides');
});

test('3 instances, out-of-order end events by tool_use_id: the right moon goes each time, active until the last one ends', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(start(1, 'toolu_A', 'task A'));
  st.ingest(start(2, 'toolu_B', 'task B'));
  st.ingest(start(3, 'toolu_C', 'task C'));
  assert.deepEqual(moonIds(st, 'app-dev', 4), ['toolu_A', 'toolu_B', 'toolu_C']);

  st.ingest(done(10, 'toolu_B'));          // the middle one ends first
  assert.deepEqual(moonIds(st, 'app-dev', 11), ['toolu_A', 'toolu_C'], 'only the moon of B is gone');
  assert.equal(st.instanceState('app-dev', 11 * 1000 + T0).status, 'PROCESSING');

  st.ingest(done(12, 'toolu_C'));          // then the newest
  assert.deepEqual(moonIds(st, 'app-dev', 13), [], 'two instances ended: one is left, so no moon');
  assert.equal(st.instanceState('app-dev', now(13)).status, 'PROCESSING', 'A still runs');
  assert.equal(st.snapshot('app-dev', now(13)).currentTasks[0].id, 'toolu_A');

  st.ingest(done(14, 'toolu_A'));
  assert.equal(st.instanceState('app-dev', now(15)).status, 'COMPLETED');
  const recent = st.snapshot('app-dev', now(15)).recentTasks;
  assert.deepEqual(recent.map((t) => t.approx), [false, false, false], 'every close was exact (by id)');
});

test('moons keep their identity: a new instance does not change the moons that are already drawn', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(start(1, 'toolu_A', 'a'));
  st.ingest(start(2, 'toolu_B', 'b'));
  const before = moonIds(st, 'app-dev', 3);
  st.ingest(start(4, 'toolu_C', 'c'));
  assert.deepEqual(moonIds(st, 'app-dev', 5).slice(0, 2), before, 'A and B keep their moons, C gets a new one');
});

test('one instance fails while the others continue: its moon goes, the planet stays active, the failure is recorded once', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(start(1, 'toolu_A', 'task A'));
  st.ingest(start(2, 'toolu_B', 'task B'));
  st.ingest(start(3, 'toolu_C', 'task C'));

  st.ingest(ev(10, 'app-dev', 'ERROR', 'เครื่องมือ Agent ล้มเหลว', 'toolu_B'));   // B fails (PostToolUseFailure)
  const inst = st.instanceState('app-dev', now(11));
  assert.equal(inst.status, 'PROCESSING', 'A and C continue: the ERROR must not turn the planet red or idle');
  assert.deepEqual(moonIds(st, 'app-dev', 11), ['toolu_A', 'toolu_C'], 'only the moon of B is gone');
  const snap = st.snapshot('app-dev', now(11));
  assert.equal(snap.recentTasks.length, 1);
  assert.equal(snap.recentTasks[0].status, 'ERROR');
  assert.ok(snap.recentTasks[0].text.includes('task B'), 'the failed task is B');
  assert.equal(snap.recentTasks[0].approx, false);

  st.ingest(done(20, 'toolu_A'));
  st.ingest(done(21, 'toolu_C'));
  assert.equal(st.instanceState('app-dev', now(22)).status, 'COMPLETED', 'after the survivors finish the planet reads COMPLETED');
});

test('the last instance fails: nothing else runs, so the planet reads ERROR', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(start(1, 'toolu_A', 'task A'));
  st.ingest(start(2, 'toolu_B', 'task B'));
  st.ingest(done(5, 'toolu_A'));
  st.ingest(ev(6, 'app-dev', 'ERROR', 'failed', 'toolu_B'));
  const inst = st.instanceState('app-dev', now(7));
  assert.equal(inst.status, 'ERROR');
  assert.equal(inst.moons.shown.length, 0);
});

test('a missed end event: the moon times out after MOON_TIMEOUT_MS, the planet goes idle only after the stale limit', async () => {
  const { createStore } = await loadStore();
  const { MOON_TIMEOUT_MS } = await loadMoons();
  const st = createStore();
  assert.equal(MOON_TIMEOUT_MS, 10 * MIN, 'the timeout is 10 minutes');

  st.ingest(start(0, 'toolu_A', 'task A (its end event is lost)'));
  st.ingest(start(9 * 60, 'toolu_B', 'task B'));
  st.ingest(start(9 * 60 + 10, 'toolu_C', 'task C'));
  assert.deepEqual(moonIds(st, 'app-dev', 9 * 60 + 30), ['toolu_A', 'toolu_B', 'toolu_C'], '3 live instances at 9.5 min');

  // 10 min + 1 s after A started: A is timed out, B and C are still live
  assert.deepEqual(moonIds(st, 'app-dev', 10 * 60 + 1), ['toolu_B', 'toolu_C'], 'the moon of A timed out by itself');
  const mid = st.snapshot('app-dev', now(10 * 60 + 1));
  assert.equal(mid.currentTasks.length, 3, 'A is still an open task (HUD list) until it is closed or stale');
  assert.equal(mid.currentTasks[0].timedOut, true);

  // B and C end; A never does
  st.ingest(done(11 * 60, 'toolu_B'));
  st.ingest(done(11 * 60 + 5, 'toolu_C'));
  let inst = st.instanceState('app-dev', now(12 * 60));
  assert.deepEqual(inst.moons.shown, [], 'no moon: nothing is live');
  assert.equal(inst.count, 0);
  assert.equal(inst.status, 'PROCESSING', 'A is open and not stale yet, so the planet is still active (bounded by staleMs)');

  inst = st.instanceState('app-dev', now(31 * 60));
  assert.equal(inst.status, 'COMPLETED', 'after staleMs (30 min) A no longer counts: the last event (C completed) shows');
  assert.equal(inst.running, 0);
});

test('a lone instance that runs longer than the moon timeout keeps its planet active and gets no moon (as before)', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(start(0, 'toolu_A', 'long task'));
  const inst = st.instanceState('app-dev', now(20 * 60));   // 20 min
  assert.equal(inst.status, 'PROCESSING');
  assert.deepEqual(inst.moons.shown, []);
});

test('more than MAX_MOONS instances: the oldest MAX_MOONS are drawn and the rest is the "+N" count', async () => {
  const { createStore } = await loadStore();
  const { MAX_MOONS } = await loadMoons();
  assert.equal(MAX_MOONS, 4);
  const st = createStore();
  const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((x) => `toolu_${x}`);
  ids.forEach((id, i) => st.ingest(start(i + 1, id, `task ${id}`)));

  let view = st.instanceState('app-dev', now(10)).moons;
  assert.deepEqual(view.shown.map((t) => t.id), ids.slice(0, 4), 'the 4 oldest are drawn');
  assert.equal(view.extra, 3, '+3');
  assert.equal(view.total, 7);

  st.ingest(done(20, ids[0]));                       // the oldest ends: the next oldest takes its moon, +N shrinks
  view = st.instanceState('app-dev', now(21)).moons;
  assert.deepEqual(view.shown.map((t) => t.id), ids.slice(1, 5));
  assert.equal(view.extra, 2);

  ids.slice(1, 4).forEach((id, i) => st.ingest(done(22 + i, id)));   // B, C, D end: E, F, G are left
  view = st.instanceState('app-dev', now(30)).moons;
  assert.deepEqual(view.shown.map((t) => t.id), ids.slice(4), '3 left: 3 moons, no +N');
  assert.equal(view.extra, 0);
  assert.equal(st.instanceState('app-dev', now(30)).status, 'PROCESSING');
});

test('the open-task cap (maxOpen) is far above the moon cap: a burst of 20 instances gives 4 moons and a sane "+N"', async () => {
  const { createStore } = await loadStore();
  const { MAX_MOONS } = await loadMoons();
  const st = createStore();
  for (let i = 0; i < 20; i += 1) st.ingest(start(i, `toolu_${i}`, `task ${i}`));
  const snap = st.snapshot('app-dev', now(30));
  assert.ok(snap.currentTasks.length >= MAX_MOONS + 1, 'more tasks are kept than moons are drawn');
  assert.equal(snap.currentTasks.length, 16, 'the default cap is 16 open tasks; older ones are dropped');
  assert.equal(snap.moons.shown.length, MAX_MOONS);
  assert.equal(snap.moons.extra, 16 - MAX_MOONS, '"+N" counts what is kept, never more');
  assert.equal(snap.status, 'PROCESSING');
  assert.equal(snap.metrics.find((m) => m.key === 'moons').text, '16', 'the HUD moon metric is the live instance count');
  // The oldest were dropped, so the shown moons are the oldest KEPT ones
  assert.equal(snap.moons.shown[0].id, 'toolu_4');
});

test('end events without an id (FIFO): the oldest instance and its moon go, the close is marked approximate', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(ev(1, 'study-writer', 'PROCESSING', 'one'));
  st.ingest(ev(2, 'study-writer', 'PROCESSING', 'two'));
  st.ingest(ev(3, 'study-writer', 'PROCESSING', 'three'));
  assert.equal(st.instanceState('study-writer', now(4)).moons.shown.length, 3);
  const firstId = st.instanceState('study-writer', now(4)).moons.shown[0].id;
  assert.match(firstId, /^task-\d+$/, 'a task without a tool_use_id gets a local id');

  st.ingest(ev(5, 'study-writer', 'COMPLETED', 'done'));                 // no id: FIFO closes "one"
  const view = st.instanceState('study-writer', now(6));
  assert.equal(view.moons.shown.length, 2);
  assert.ok(!view.moons.shown.some((t) => t.id === firstId), 'the oldest moon is gone');
  assert.equal(view.status, 'PROCESSING');
  assert.equal(st.snapshot('study-writer', now(6)).recentTasks[0].approx, true);
});

test('every team agent gets moons by the same rule (Dev, QA, Writer, Content Director, PM) and a dynamic agent too', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  const agents = ['app-dev', 'qa-reviewer', 'study-writer', 'portfolio-writer', 'pm', 'some-new-agent'];
  agents.forEach((agent) => {
    st.ingest(start(1, `${agent}-1`, 'one', agent));
    st.ingest(start(2, `${agent}-2`, 'two', agent));
  });
  agents.forEach((agent) => {
    assert.equal(moonIds(st, agent, 3).length, 2, `${agent}: two moons`);
    st.ingest(done(4, `${agent}-1`, agent));
    assert.equal(moonIds(st, agent, 5).length, 0, `${agent}: back to one instance, no moon`);
    assert.equal(st.instanceState(agent, now(5)).status, 'PROCESSING', `${agent}: still active`);
  });
});

test('moons.js: view rules, even angles and the hover text', async () => {
  const m = await loadMoons();
  assert.deepEqual(m.moonView([]), { shown: [], extra: 0, total: 0 });
  assert.deepEqual(m.moonView([{ id: 'a' }]), { shown: [], extra: 0, total: 1 }, 'one instance: no moon');
  assert.equal(m.moonView([{ id: 'a' }, { id: 'b' }]).shown.length, 2);

  // Even spacing: n moons are 2*pi/n apart
  const a = [0, 1, 2, 3].map((i) => m.moonAngle(i, 4));
  assert.ok(Math.abs(a[1] - a[0] - Math.PI / 2) < 1e-9);
  assert.equal(m.moonAngle(0, 0), 0, 'no division by zero');

  // Hover text: the task text with its age; a neutral line without a task text
  assert.equal(m.moonTip({ text: 'write the tests', ageMs: 65 * 1000 }), 'write the tests (1m 05s)');
  assert.equal(m.moonTip({ text: 'x', ageMs: 12 * 1000 }), 'x (12s)');
  assert.equal(m.moonTip({ text: '  ', ageMs: null }), 'running (no task text)');
  assert.equal(m.moonTip({ text: 'only text' }), 'only text');
});

test('timeouts are ordered: moon timeout < stale limit; liveInstances() keeps unknown ages', async () => {
  const m = await loadMoons();
  const { createStore } = await loadStore();
  assert.ok(m.MOON_TIMEOUT_MS < 30 * MIN, 'well below the 30 min stale limit');
  assert.deepEqual(m.liveInstances([{ ageMs: null }, { ageMs: 1 }, { ageMs: m.MOON_TIMEOUT_MS + 1 }]).length, 2);
  // An event with an unreadable ts is dated by the receive time: live at first, then its moon times out like any other
  const st = createStore({ now: () => now(0) });
  st.ingest({ ts: 'not a date', agent: 'app-dev', status: 'PROCESSING', message: 'x', toolUseId: 'toolu_X' });
  st.ingest({ ts: 'not a date', agent: 'app-dev', status: 'PROCESSING', message: 'y', toolUseId: 'toolu_Y' });
  assert.equal(st.instanceState('app-dev', now(0)).moons.shown.length, 2);
  assert.equal(st.instanceState('app-dev', now(0) + m.MOON_TIMEOUT_MS + 1000).moons.shown.length, 0, 'both moons timed out: the moon is not stuck');
});

test('reset() forgets every instance', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(start(1, 'toolu_A', 'a'));
  st.ingest(start(2, 'toolu_B', 'b'));
  st.reset();
  const inst = st.instanceState('app-dev', now(3));
  assert.equal(inst.status, 'IDLE');
  assert.equal(inst.moons.shown.length, 0);
});
