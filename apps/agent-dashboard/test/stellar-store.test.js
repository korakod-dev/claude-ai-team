'use strict';
/**
 * stellar-store.test.js - Per-agent state for the planet HUD (public/workspace/stellar/store.js):
 *   tasks are opened by PROCESSING of a sub-agent and closed by COMPLETED / ERROR (FIFO),
 *   failures with no open task are recorded, the main agent and the user never open tasks,
 *   log lines are capped, invalid events are ignored, reset clears everything.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadStore() {
  return import(pathToFileURL(path.join(__dirname, '..', 'public', 'workspace', 'stellar', 'store.js')).href);
}

/** Build a workspace event with a fixed minute so the order is easy to read. */
function ev(minute, agent, status, message) {
  const mm = String(minute).padStart(2, '0');
  return { ts: `2026-10-12T10:${mm}:00.000Z`, agent, status, message };
}

test('ingest: rejects anything that is not a workspace event, without throwing', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  assert.equal(st.ingest(null), false);
  assert.equal(st.ingest({ agent: 'app-dev', status: 'ERROR', message: 'x' }), false, 'no ts');
  assert.equal(st.ingest({ ts: '2026-10-12T10:00:00.000Z', agent: '', status: 'ERROR', message: 'x' }), false, 'empty agent');
  assert.equal(st.ingest({ ts: '2026-10-12T10:00:00.000Z', agent: 'app-dev', status: 'BOGUS', message: 'x' }), false, 'unknown status');
  assert.equal(st.ingest({ ts: '2026-10-12T10:00:00.000Z', agent: 'app-dev', status: 'ERROR' }), false, 'no message');
  assert.deepEqual(st.agents(), []);
});

test('tasks: PROCESSING opens a task, COMPLETED closes the oldest open task (FIFO) as COMPLETED; the status follows the open tasks', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(ev(1, 'app-dev', 'PROCESSING', 'task A'));
  st.ingest(ev(2, 'app-dev', 'PROCESSING', 'task B'));
  // The event times are fixed (2026-10-12), so the clock of the snapshot is fixed too: the status is derived from the OPEN tasks,
  // and a task older than the store's staleMs (30 min on the real clock) would not count as running.
  const now = Date.parse('2026-10-12T10:05:00.000Z');
  let snap = st.snapshot('app-dev', now);
  assert.deepEqual(snap.currentTasks.map((t) => t.text), ['task A', 'task B'], 'two open tasks, oldest first');
  assert.equal(snap.status, 'PROCESSING');

  st.ingest(ev(3, 'app-dev', 'COMPLETED', 'done'));
  snap = st.snapshot('app-dev', now);
  assert.deepEqual(snap.currentTasks.map((t) => t.text), ['task B']);
  assert.equal(snap.recentTasks[0].text, 'task A');
  assert.equal(snap.recentTasks[0].status, 'COMPLETED');
  assert.equal(snap.recentTasks[0].endText, 'done');
  // The COMPLETED of task A is the latest event, but task B is still open, so the agent is still PROCESSING (derived status)
  assert.equal(snap.status, 'PROCESSING');
});

test('tasks: ERROR closes the oldest open task as ERROR; an ERROR with no open task is a failed task on its own', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(ev(1, 'qa-reviewer', 'PROCESSING', 'review X'));
  st.ingest(ev(2, 'qa-reviewer', 'ERROR', 'tool failed'));
  let snap = st.snapshot('qa-reviewer');
  assert.equal(snap.currentTasks.length, 0);
  assert.equal(snap.recentTasks[0].status, 'ERROR');
  assert.equal(snap.recentTasks[0].text, 'review X');

  st.ingest(ev(3, 'qa-reviewer', 'ERROR', 'timeout-like failure'));
  snap = st.snapshot('qa-reviewer');
  assert.equal(snap.recentTasks.length, 2, 'the failure without an open task is recorded');
  assert.equal(snap.recentTasks[0].text, 'timeout-like failure', 'newest first');
});

test('tasks: the main agent and the user never open tasks, so their events do not create open work', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(ev(1, 'secretary', 'PROCESSING', 'รับคำสั่งงานจากผู้ใช้แล้ว'));
  st.ingest(ev(2, 'user', 'PROCESSING', 'command'));
  assert.equal(st.snapshot('secretary').currentTasks.length, 0);
  assert.equal(st.snapshot('user').currentTasks.length, 0);
  assert.equal(st.snapshot('secretary').status, 'PROCESSING', 'status is still tracked');
});

test('snapshot: recent tasks are capped, logs are capped and shown oldest first with the newest last', async () => {
  const { createStore } = await loadStore();
  const st = createStore({ maxLogs: 5, logsShown: 3, maxRecent: 2, maxOpen: 2 });
  for (let i = 0; i < 6; i++) {
    st.ingest(ev(i, 'study-writer', 'PROCESSING', `job ${i}`));
    st.ingest(ev(i, 'study-writer', 'COMPLETED', `ok ${i}`));
  }
  const snap = st.snapshot('study-writer');
  assert.equal(snap.recentTasks.length, 2, 'recent tasks capped');
  assert.equal(snap.recentTasks[0].text, 'job 5', 'newest first');
  assert.equal(snap.logs.length, 3, 'shown logs are capped');
  assert.equal(snap.logs[2].message, 'ok 5', 'newest log line is last');
  assert.equal(snap.logs[0].message, 'ok 4', 'the last 5 events are kept, the last 3 are shown');
  assert.equal(snap.logs[1].message, 'job 5');
});

test('open tasks are capped: the oldest open task is dropped when the limit is reached', async () => {
  const { createStore } = await loadStore();
  const st = createStore({ maxOpen: 2 });
  st.ingest(ev(1, 'app-dev', 'PROCESSING', 'one'));
  st.ingest(ev(2, 'app-dev', 'PROCESSING', 'two'));
  st.ingest(ev(3, 'app-dev', 'PROCESSING', 'three'));
  assert.deepEqual(st.snapshot('app-dev').currentTasks.map((t) => t.text), ['two', 'three']);
});

test('snapshot: metrics are all "no data" (not in the event data), and unknown agents get an IDLE snapshot', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(ev(1, 'app-dev', 'WORKING', 'using a tool'));
  const snap = st.snapshot('app-dev');
  assert.ok(snap.metrics.length >= 4);
  assert.ok(snap.metrics.every((m) => m.text === 'no data'));
  assert.equal(snap.label, 'Dev-ไอ้เก่ง · apps/');
  const unknown = st.snapshot('nobody');
  assert.equal(unknown.status, 'IDLE');
  assert.deepEqual(unknown.currentTasks, []);
  assert.deepEqual(unknown.logs, []);
});

test('snapshot returns copies: changing a snapshot does not change the store', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(ev(1, 'app-dev', 'PROCESSING', 'task A'));
  const snap = st.snapshot('app-dev');
  snap.currentTasks[0].text = 'changed';
  snap.logs.length = 0;
  const again = st.snapshot('app-dev');
  assert.equal(again.currentTasks[0].text, 'task A');
  assert.equal(again.logs.length, 1);
});

test('reset: forgets every agent, and the store works again afterwards', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(ev(1, 'app-dev', 'PROCESSING', 'task A'));
  st.reset();
  assert.deepEqual(st.agents(), []);
  assert.equal(st.snapshot('app-dev').currentTasks.length, 0);
  st.ingest(ev(2, 'app-dev', 'PROCESSING', 'task B'));
  assert.deepEqual(st.snapshot('app-dev').currentTasks.map((t) => t.text), ['task B']);
});

// ---------- stale open tasks (Phase 2): FIFO matching can leave a task open forever, so it is marked stale ----------

test('stale: a task still open after staleMs is marked stale; a newer open task is not', async () => {
  const { createStore } = await loadStore();
  const st = createStore({ staleMs: 60 * 1000 });
  st.ingest({ ts: '2026-10-12T10:00:00.000Z', agent: 'app-dev', status: 'PROCESSING', message: 'old' });
  st.ingest({ ts: '2026-10-12T10:30:00.000Z', agent: 'app-dev', status: 'PROCESSING', message: 'fresh' });
  const now = Date.parse('2026-10-12T10:30:30.000Z');
  const snap = st.snapshot('app-dev', now);
  assert.deepEqual(snap.currentTasks.map((t) => t.stale), [true, false], 'only the task older than 60 s is stale');
  assert.equal(snap.currentTasks[0].ageMs, 30 * 60 * 1000 + 30 * 1000, 'age is now minus the task start');
  assert.equal(snap.currentTasks[1].ageMs, 30 * 1000);
});

test('stale: the FIFO close of the oldest task removes the stale entry (documented limitation: the match may be wrong)', async () => {
  const { createStore } = await loadStore();
  const st = createStore({ staleMs: 60 * 1000 });
  st.ingest({ ts: '2026-10-12T10:00:00.000Z', agent: 'qa-reviewer', status: 'PROCESSING', message: 'lost close' });
  st.ingest({ ts: '2026-10-12T10:30:00.000Z', agent: 'qa-reviewer', status: 'PROCESSING', message: 'current' });
  st.ingest({ ts: '2026-10-12T10:31:00.000Z', agent: 'qa-reviewer', status: 'COMPLETED', message: 'done' });
  const snap = st.snapshot('qa-reviewer', Date.parse('2026-10-12T10:31:10.000Z'));
  assert.deepEqual(snap.currentTasks.map((t) => t.text), ['current'], 'the close matched the oldest task (FIFO)');
  assert.equal(snap.recentTasks[0].text, 'lost close', 'so the record shows the oldest text as finished');
});

test('unreadable ts: the age comes from the receive time, so the task times out (moon) and becomes stale like any other', async () => {
  const { createStore } = await loadStore();
  const MIN = 60 * 1000;
  const t0 = Date.parse('2026-10-12T12:00:00.000Z');
  const st = createStore({ now: () => t0 });          // the store received the event at t0
  st.ingest({ ts: 'not-a-date', agent: 'study-writer', status: 'PROCESSING', message: 'odd' });
  let snap = st.snapshot('study-writer', t0 + 30 * 1000);
  assert.equal(snap.currentTasks[0].ageMs, 30 * 1000, 'age = now - receive time (it used to be null)');
  assert.equal(snap.currentTasks[0].stale, false);
  assert.equal(snap.currentTasks[0].timedOut, false);
  snap = st.snapshot('study-writer', t0 + 11 * MIN);
  assert.equal(snap.currentTasks[0].timedOut, true, 'past the moon timeout: no longer a live instance');
  assert.equal(snap.currentTasks[0].stale, false);
  snap = st.snapshot('study-writer', t0 + 31 * MIN);
  assert.equal(snap.currentTasks[0].stale, true, 'past staleMs');
  assert.equal(snap.status, 'IDLE', 'a stale task no longer keeps the planet active');
});

/** Build a workspace event that carries a tool_use_id (the way the hub passes it on). */
function evId(minute, agent, status, message, toolUseId) {
  return { ...ev(minute, agent, status, message), toolUseId };
}

test('match by id: the end event with the same tool_use_id closes its own task, even out of order', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(evId(1, 'app-dev', 'PROCESSING', 'task A', 'toolu_A'));
  st.ingest(evId(2, 'app-dev', 'PROCESSING', 'task B', 'toolu_B'));
  // B finishes first: FIFO would have closed A here
  st.ingest(evId(3, 'app-dev', 'COMPLETED', 'B done', 'toolu_B'));
  let snap = st.snapshot('app-dev');
  assert.deepEqual(snap.currentTasks.map((t) => t.text), ['task A'], 'only task A is still open');
  assert.equal(snap.recentTasks[0].text, 'task B', 'task B is the one closed');
  assert.equal(snap.recentTasks[0].approx, false, 'exact match: not approximate');
  st.ingest(evId(4, 'app-dev', 'COMPLETED', 'A done', 'toolu_A'));
  snap = st.snapshot('app-dev');
  assert.equal(snap.currentTasks.length, 0);
  assert.deepEqual(snap.recentTasks.map((t) => t.text), ['task A', 'task B']);
});

test('match by id: an ERROR with the id closes the task even when it is reported by another agent', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(evId(1, 'app-dev', 'PROCESSING', 'task A', 'toolu_A'));
  // The failure of the Agent call is logged on the caller (secretary), but it names the same tool_use_id
  st.ingest(evId(2, 'secretary', 'ERROR', 'เครื่องมือ Agent ล้มเหลว', 'toolu_A'));
  const snap = st.snapshot('app-dev');
  assert.equal(snap.currentTasks.length, 0, 'the app-dev task is closed');
  assert.equal(snap.recentTasks[0].status, 'ERROR');
  assert.equal(snap.recentTasks[0].text, 'task A');
  assert.equal(snap.recentTasks[0].approx, false);
  assert.equal(st.snapshot('secretary').recentTasks.length, 0, 'the caller does not get a task of its own');
});

test('match by id: a COMPLETED with an id that has no open task is ignored and no other task is taken', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(evId(1, 'app-dev', 'PROCESSING', 'task A', 'toolu_A'));
  st.ingest(evId(2, 'app-dev', 'COMPLETED', 'stray', 'toolu_unknown'));
  const snap = st.snapshot('app-dev');
  assert.deepEqual(snap.currentTasks.map((t) => t.text), ['task A'], 'task A stays open');
  assert.equal(snap.recentTasks.length, 0);
});

test('FIFO fallback: a close without an id takes the oldest open task of its agent and is marked approx', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(evId(1, 'app-dev', 'PROCESSING', 'task A', 'toolu_A'));
  st.ingest(evId(2, 'app-dev', 'PROCESSING', 'task B', 'toolu_B'));
  st.ingest(ev(3, 'app-dev', 'COMPLETED', 'sync done')); // no id: the sync-run case
  const snap = st.snapshot('app-dev');
  assert.equal(snap.recentTasks[0].text, 'task A', 'FIFO: the oldest open task');
  assert.equal(snap.recentTasks[0].approx, true, 'marked approximate');
  assert.deepEqual(snap.currentTasks.map((t) => t.text), ['task B']);
});

test('approx: an open task without an id is shown as approx; a task with an id is not', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(ev(1, 'qa-reviewer', 'PROCESSING', 'no id'));
  st.ingest(evId(2, 'app-dev', 'PROCESSING', 'with id', 'toolu_X'));
  const snap1 = st.snapshot('qa-reviewer');
  const snap2 = st.snapshot('app-dev');
  assert.equal(snap1.currentTasks[0].approx, true);
  assert.equal(snap2.currentTasks[0].approx, false);
});

test('STALE is an age check: an old task with an id is stale; a young one is not, approx or not', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(evId(0, 'app-dev', 'PROCESSING', 'old with id', 'toolu_old'));
  const now = Date.parse('2026-10-12T11:00:00.000Z'); // 60 min after the task opened
  const snap = st.snapshot('app-dev', now);
  assert.equal(snap.currentTasks[0].stale, true, 'open 60 min: genuinely old');
  assert.equal(snap.currentTasks[0].approx, false, 'it has an id, so it is not approximate');
});

test('ERROR with an id and no open task of that id is a failed task on its own (not approx)', async () => {
  const { createStore } = await loadStore();
  const st = createStore();
  st.ingest(evId(1, 'app-dev', 'ERROR', 'boom', 'toolu_none'));
  const snap = st.snapshot('app-dev');
  assert.equal(snap.recentTasks.length, 1);
  assert.equal(snap.recentTasks[0].status, 'ERROR');
  assert.equal(snap.recentTasks[0].approx, false);
});
