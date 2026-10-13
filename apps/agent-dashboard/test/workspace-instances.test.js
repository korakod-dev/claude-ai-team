'use strict';
/**
 * workspace-instances.test.js - PARALLEL instances of one agent type through the hub (lib/workspace.js, lib/stop-hold.js)
 * and the browser store (public/workspace/stellar/store.js). Behaviour level: hook records go in, the SSE events come out,
 * and the store (the same file the page uses) is fed with those events.
 *
 * Covers the server side of the "moons" feature:
 *   - 3 sync runs of one agent finish out of order: every stop gets its own tool_use_id, the planet stays active until the
 *     last one ends, and the moons go one by one
 *   - a failure drops only the stop of ITS run (per instance, via agent_ref), never the stop of a sibling (finding B)
 *   - a failure of a run that never started consumes no stop of a sibling
 *   - a held stop is not lost when a sibling starts; it is dropped only when its own task is already closed (finding C)
 *   - a missed SubagentStop leaves an open task that times out as a moon and becomes stale for the status (finding D/E)
 *   - FIFO start binding is a GUESS when several Agent calls of one session and type wait (out-of-order starts under parallel
 *     dispatch): failures and closes then use the agent TYPE rule, only exact / sole-candidate bindings are per instance
 *   - start matching is keyed by session_id + type; after a rebind one tool_use_id has one agent_ref
 *   - a log without SubagentStart still uses the old type-based failure rule (no instance data, no regression)
 * Uses the fake clock (test/helpers/fake-clock.js) and temp files only. No network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { isolateEnv, tempWorkspaceOpts } = require('./helpers/temp-paths');
isolateEnv();
const { createWorkspaceHub, TOOL_USE_WAIT_MS } = require('../lib/workspace');
const { fakeClock } = require('./helpers/fake-clock');

// Record time: T(s) = 10:00:00 UTC on 2026-10-12 plus s seconds. The fake clock starts at the same epoch.
const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const T = (s) => new Date(T0 + s * 1000).toISOString();
const MIN = 60;

async function loadStore() {
  return import(pathToFileURL(path.join(__dirname, '..', 'public', 'workspace', 'stellar', 'store.js')).href);
}

/** PreToolUse(Agent): dispatch of one instance of sub-agent `sub`. */
const pre = (s, id, sub, desc) => ({
  ts: T(s), event: 'PreToolUse', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, subagent_type: sub, description: desc,
});
/** SubagentStart: the instance `ref` of agent type `type` begins (no tool_use_id on this record). */
const begin = (s, ref, type) => ({ ts: T(s), event: 'SubagentStart', agent_type: type || 'app-dev', agent_id: ref });
/** PostToolUse(Agent): links agent_ref -> tool_use_id. */
const post = (s, id, ref) => ({
  ts: T(s), event: 'PostToolUse', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, agent_ref: ref, response_status: 'completed',
});
/** SubagentStop of a sync run: arrives BEFORE its PostToolUse, so the hub holds it. */
const stop = (s, ref, type, msg) => ({
  ts: T(s), event: 'SubagentStop', agent_type: type || 'app-dev', agent_id: ref, last_message: msg,
});
/** PostToolUseFailure of an Agent call (no agent_ref on this record). */
const failure = (s, id, sub) => ({
  ts: T(s), event: 'PostToolUseFailure', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, subagent_type: sub, error: 'failed',
});

/** A hub on temp files with a fake clock; one SSE client collects what the hub sends. */
function makeHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-instances-'));
  const o = tempWorkspaceOpts(dir);
  const clock = fakeClock();
  clock.advance(T0);
  const hub = createWorkspaceHub({
    eventsFile: o.eventsFile,
    workspaceFile: o.workspaceEventsFile,
    commandsFile: o.commandsFile,
    uploadsDir: o.uploadsDir,
    secretaryQueueDir: o.secretaryQueueDir,
    timing: { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  });
  const chunks = [];
  hub.attach({ on() {} }, { write: (s) => chunks.push(s), on() {}, end() {} });
  const events = () => chunks
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice('data: '.length)));
  const append = (...recs) => recs.forEach((rec) => fs.appendFileSync(o.eventsFile, `${JSON.stringify(rec)}\n`));
  const cleanup = () => {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { hub, clock, events, append, cleanup };
}

/** What the page shows after the hub's events so far: a fresh store fed with them, read at second s. */
function viewAt(store, events, agent, s) {
  const st = store.createStore();
  events.forEach((e) => st.ingest(e));
  const inst = st.instanceState(agent, T0 + s * 1000);
  return { status: inst.status, moons: inst.moons.shown.map((t) => t.id), extra: inst.moons.extra, st };
}

test('3 parallel sync runs finish out of order: each stop gets its own id, the planet stays active until the last, moons go one by one', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    // Three instances of Dev are dispatched at once and start
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'), pre(1.2, 'toolu_C', 'app-dev', 'task C'));
    h.append(begin(2, 'agA'), begin(2.1, 'agB'), begin(2.2, 'agC'));
    h.hub.poll();
    let v = viewAt(store, h.events(), 'app-dev', 3);
    assert.equal(v.status, 'PROCESSING');
    assert.deepEqual(v.moons, ['toolu_A', 'toolu_B', 'toolu_C'], 'three instances, three moons');

    // C finishes first (its stop is held until its PostToolUse), then A, then B
    h.append(stop(10, 'agC', 'app-dev', 'C done'), post(10.05, 'toolu_C', 'agC'));
    h.hub.poll();
    v = viewAt(store, h.events(), 'app-dev', 11);
    assert.deepEqual(v.moons, ['toolu_A', 'toolu_B'], 'only the moon of C is gone');
    assert.equal(v.status, 'PROCESSING', 'A and B still run');

    h.append(stop(20, 'agA', 'app-dev', 'A done'), post(20.05, 'toolu_A', 'agA'));
    h.hub.poll();
    v = viewAt(store, h.events(), 'app-dev', 21);
    assert.deepEqual(v.moons, [], 'one instance left: no moon');
    assert.equal(v.status, 'PROCESSING', 'B still runs (the latest event, A completed, must not decide)');

    h.append(stop(30, 'agB', 'app-dev', 'B done'), post(30.05, 'toolu_B', 'agB'));
    h.hub.poll();
    v = viewAt(store, h.events(), 'app-dev', 31);
    assert.equal(v.status, 'COMPLETED', 'the last instance ended');
    assert.equal(h.clock.pending(), 0, 'no timer is left');

    // Every close was exact: the stops carried their tool_use_id
    const completed = h.events().filter((e) => e.status === 'COMPLETED');
    assert.deepEqual(completed.map((e) => e.toolUseId), ['toolu_C', 'toolu_A', 'toolu_B']);
    assert.ok(v.st.snapshot('app-dev', T0 + 31000).recentTasks.every((t) => t.approx === false));
  } finally {
    h.cleanup();
  }
});

test('B: a failure drops only the stop of ITS run (agent_ref); the held stop of a parallel sibling is kept and resolved by id', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    // Each start has a single waiting Agent call, so both bindings are trusted (not guesses)
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), begin(2, 'agA'), pre(2.05, 'toolu_B', 'app-dev', 'task B'), begin(2.1, 'agB'));
    h.append(stop(10, 'agB', 'app-dev', 'B done'));           // the sibling B finished: its stop is held
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the stop of B is held');

    h.append(failure(10.5, 'toolu_A', 'app-dev'));            // run A fails
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the stop of B is still held: the failure belongs to A (old behaviour: B stop was dropped)');
    const errors = h.events().filter((e) => e.status === 'ERROR');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].toolUseId, 'toolu_A');

    h.append(post(11, 'toolu_B', 'agB'));                     // B's PostToolUse arrives: its stop is released WITH its id
    h.hub.poll();
    const last = h.events()[h.events().length - 1];
    assert.equal(last.status, 'COMPLETED');
    assert.equal(last.toolUseId, 'toolu_B');
    assert.equal(h.clock.pending(), 0);

    // The late stop of the failed run A is dropped by its per-instance marker, so it cannot flip anything
    h.append(stop(12, 'agA', 'app-dev', 'A stopped after its failure'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 0, 'dropped, not held');
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.equal(h.events().filter((e) => e.status === 'COMPLETED').length, 1, 'only B completed');

    const v = viewAt(store, h.events(), 'app-dev', 13);
    assert.equal(v.status, 'COMPLETED');
    const snap = v.st.snapshot('app-dev', T0 + 13000);
    assert.equal(snap.currentTasks.length, 0);
    assert.deepEqual(snap.recentTasks.map((t) => t.status).sort(), ['COMPLETED', 'ERROR']);
  } finally {
    h.cleanup();
  }
});

test('B: a failure marker of run A does not swallow the LATER stop of sibling B (marker is per agent_ref)', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), begin(2, 'agA'), pre(2.05, 'toolu_B', 'app-dev', 'task B'), begin(2.1, 'agB'));
    h.append(failure(3, 'toolu_A', 'app-dev'));               // no stop held yet: a marker for agA is kept
    h.append(stop(4, 'agB', 'app-dev', 'B done'));            // B's stop comes inside the marker window
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the stop of B is held (old behaviour: a type marker dropped it)');
    h.append(post(5, 'toolu_B', 'agB'));
    h.hub.poll();
    const last = h.events()[h.events().length - 1];
    assert.equal(last.status, 'COMPLETED');
    assert.equal(last.toolUseId, 'toolu_B');
  } finally {
    h.cleanup();
  }
});

test('B: a failure of a run that never started (no agent_ref) leaves the stop of a running sibling alone', () => {
  const h = makeHub();
  try {
    // An earlier run in the same log has a SubagentStart, so this log carries start records
    h.append(pre(0.5, 'toolu_0', 'qa-reviewer', 'earlier'), begin(0.6, 'ag0', 'qa-reviewer'));
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A (cannot start)'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(failure(1.2, 'toolu_A', 'app-dev'));             // A never started: nothing will stop for it
    h.append(begin(2, 'agB'));                                // B starts (it binds to B, not to the failed A)
    h.append(stop(10, 'agB', 'app-dev', 'B done'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the stop of B is held; no marker swallowed it');
    h.append(post(11, 'toolu_B', 'agB'));
    h.hub.poll();
    const last = h.events()[h.events().length - 1];
    assert.equal(last.status, 'COMPLETED');
    assert.equal(last.toolUseId, 'toolu_B');
  } finally {
    h.cleanup();
  }
});

test('without any SubagentStart in the log the failure keeps the old type-based rule (no instance data, no regression)', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(stop(2, 'agA', 'app-dev', 'A done'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1);
    h.append(failure(3, 'toolu_A', 'app-dev'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the held stop of that agent type is kept as suspect (a type match is only a hint)');
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.equal(h.clock.pending(), 0, 'no PostToolUse: dropped when its wait ends');
    assert.ok(!h.events().some((e) => e.status === 'COMPLETED'));
  } finally {
    h.cleanup();
  }
});

test('C: a sibling that starts while a stop is held does not drop that stop; the stop is released at its timeout', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), begin(2, 'agA'));
    h.append(stop(3, 'agA', 'app-dev', 'A done'));            // held: its PostToolUse is late
    h.hub.poll();
    h.append(pre(4, 'toolu_B', 'app-dev', 'task B'), begin(5, 'agB'));   // parallel dispatch of a sibling
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS);
    const statuses = h.events().map((e) => e.status).filter((x) => x !== 'WORKING');   // SubagentStart shows as WORKING
    assert.deepEqual(statuses, ['PROCESSING', 'PROCESSING', 'COMPLETED'], 'the stop of A is released (it used to be dropped)');
    const v = viewAt(store, h.events(), 'app-dev', 20);
    assert.equal(v.status, 'PROCESSING', 'B still runs');
    const snap = v.st.snapshot('app-dev', T0 + 20000);
    assert.equal(snap.currentTasks.length, 1);
    assert.ok(snap.currentTasks[0].text.includes('task B'), 'A was closed, B is the open one');
  } finally {
    h.cleanup();
  }
});

test('C: a held stop IS dropped when the task it is bound to was already closed by id (no COMPLETED flip after a failure)', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), begin(2, 'agA'));
    h.append(stop(3, 'agA', 'app-dev', 'A done'));            // held
    h.hub.poll();
    // The task of A is closed by id through another path (an event posted to /api/events with the same toolUseId)
    h.hub.publish({ ts: T(4), agent: 'app-dev', status: 'ERROR', message: 'closed by another path', toolUseId: 'toolu_A' });
    h.clock.advance(TOOL_USE_WAIT_MS);
    const completed = h.events().filter((e) => e.status === 'COMPLETED');
    assert.equal(completed.length, 0, 'the late stop of an already closed task is not sent');
    assert.equal(h.clock.pending(), 0);
    const v = viewAt(store, h.events(), 'app-dev', 20);
    assert.equal(v.status, 'ERROR');
  } finally {
    h.cleanup();
  }
});

test('missed SubagentStop: the task stays open, its moon times out after 10 min and the planet stays active only until the stale limit', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A (stop lost)'), begin(2, 'agA'));
    h.append(pre(1.1, 'toolu_B', 'app-dev', 'task B'), begin(2.1, 'agB'));
    h.append(pre(1.2, 'toolu_C', 'app-dev', 'task C'), begin(2.2, 'agC'));
    // B and C end normally; the SubagentStop of A is never written
    h.append(stop(8 * MIN, 'agB', 'app-dev', 'B done'), post(8 * MIN + 0.05, 'toolu_B', 'agB'));
    h.append(stop(9 * MIN, 'agC', 'app-dev', 'C done'), post(9 * MIN + 0.05, 'toolu_C', 'agC'));
    h.hub.poll();
    const events = h.events();

    let v = viewAt(store, events, 'app-dev', 9 * MIN + 30);
    assert.deepEqual(v.moons, [], 'only A is left: no moon');
    assert.equal(v.status, 'PROCESSING');

    // Two instances with a lost stop: both are open, so both are moons until each times out
    h.append(pre(9 * MIN + 40, 'toolu_D', 'app-dev', 'task D'), begin(9 * MIN + 41, 'agD'));
    h.hub.poll();
    v = viewAt(store, h.events(), 'app-dev', 9 * MIN + 50);
    assert.deepEqual(v.moons, ['toolu_A', 'toolu_D'], 'A (9 min old) and D are two live instances');
    v = viewAt(store, h.events(), 'app-dev', 10 * MIN + 5);
    assert.deepEqual(v.moons, [], 'A timed out: only D is live, so no moon');
    assert.equal(v.status, 'PROCESSING');

    v = viewAt(store, h.events(), 'app-dev', 38 * MIN);
    assert.equal(v.status, 'PROCESSING', 'A is stale (37 min) but D is not (28 min): the planet is still active');
    v = viewAt(store, h.events(), 'app-dev', 41 * MIN);
    assert.equal(v.status, 'IDLE', 'after 30 min both open tasks are stale: nothing keeps the planet active (the last event was a start)');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// FIFO start binding is a guess under parallel dispatch (reviewer findings 1 and 2)
// ---------------------------------------------------------------------------------------------------------------------

/** Parallel dispatch of A and B whose starts arrive swapped: agB starts first (it is really B's run), then agA. */
function swappedStarts(h) {
  h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
  h.append(begin(2, 'agB'), begin(2.1, 'agA'));   // FIFO would bind agB -> toolu_A and agA -> toolu_B: both wrong
}

test('regression: out-of-order starts + failure of A: the stop of A is dropped, B keeps running and closes by its own id', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    swappedStarts(h);
    h.append(stop(10, 'agA', 'app-dev', 'A stopped'));       // held (the PostToolUse has not come)
    h.hub.poll();
    assert.equal(h.clock.pending(), 1);
    h.append(failure(10.5, 'toolu_A', 'app-dev'));           // A fails
    h.hub.poll();
    assert.deepEqual(h.events().map((e) => e.status), ['PROCESSING', 'PROCESSING', 'WORKING', 'WORKING', 'ERROR'],
      'ERROR A only: the stop of A was dropped, no COMPLETED without an id');
    assert.equal(h.events()[4].toolUseId, 'toolu_A');
    assert.equal(h.clock.pending(), 1, 'the stop of A stays held as SUSPECT (type match is a hint): it waits for an exact PostToolUse');
    h.clock.advance(TOOL_USE_WAIT_MS);
    assert.equal(h.clock.pending(), 0, 'no PostToolUse(agA) came: the suspect stop is dropped when its wait ends');
    assert.equal(h.events().length, 5, 'still ERROR A only, no COMPLETED without an id');

    let v = viewAt(store, h.events(), 'app-dev', 11);
    assert.equal(v.status, 'PROCESSING', 'B still runs: the planet must not show COMPLETED');
    assert.equal(v.st.snapshot('app-dev', T0 + 11000).currentTasks.map((t) => t.id).join(), 'toolu_B');

    h.append(stop(20, 'agB', 'app-dev', 'B done'), post(20.05, 'toolu_B', 'agB'));
    h.hub.poll();
    const last = h.events()[h.events().length - 1];
    assert.equal(last.status, 'COMPLETED');
    assert.equal(last.toolUseId, 'toolu_B', 'B closes by its own id');
    v = viewAt(store, h.events(), 'app-dev', 21);
    assert.equal(v.status, 'COMPLETED');
    assert.ok(v.st.snapshot('app-dev', T0 + 21000).recentTasks.every((t) => t.approx === false || t.status === 'ERROR'));
  } finally {
    h.cleanup();
  }
});

test('regression: out-of-order starts + success: each stop is closed by the id of ITS PostToolUse', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    swappedStarts(h);
    h.append(stop(10, 'agA', 'app-dev', 'A done'), post(10.05, 'toolu_A', 'agA'));
    h.hub.poll();
    let v = viewAt(store, h.events(), 'app-dev', 11);
    assert.equal(v.status, 'PROCESSING', 'B still runs');
    assert.deepEqual(h.events().filter((e) => e.status === 'COMPLETED').map((e) => e.toolUseId), ['toolu_A']);
    h.append(stop(20, 'agB', 'app-dev', 'B done'), post(20.05, 'toolu_B', 'agB'));
    h.hub.poll();
    assert.deepEqual(h.events().filter((e) => e.status === 'COMPLETED').map((e) => e.toolUseId), ['toolu_A', 'toolu_B']);
    v = viewAt(store, h.events(), 'app-dev', 21);
    assert.equal(v.status, 'COMPLETED');
    assert.equal(v.st.snapshot('app-dev', T0 + 21000).currentTasks.length, 0);
    assert.equal(h.clock.pending(), 0);
  } finally {
    h.cleanup();
  }
});

test('regression: out-of-order starts + failure of B: the stop of B is dropped, A is not touched and closes by its own id', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    swappedStarts(h);
    h.append(stop(10, 'agB', 'app-dev', 'B stopped'));       // held
    h.hub.poll();
    h.append(failure(10.5, 'toolu_B', 'app-dev'));           // B fails (FIFO had bound agA -> toolu_B, i.e. the wrong ref)
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the stop of B is held as suspect (type match is a hint)');
    assert.deepEqual(h.events().slice(4).map((e) => `${e.status}:${e.toolUseId}`), ['ERROR:toolu_B']);
    h.clock.advance(TOOL_USE_WAIT_MS);
    assert.equal(h.clock.pending(), 0, 'no PostToolUse(agB) came: the suspect stop is dropped when its wait ends');
    assert.deepEqual(h.events().slice(4).map((e) => `${e.status}:${e.toolUseId}`), ['ERROR:toolu_B'], 'nothing else was sent');
    let v = viewAt(store, h.events(), 'app-dev', 11);
    assert.equal(v.status, 'PROCESSING', 'A still runs');

    h.append(stop(20, 'agA', 'app-dev', 'A done'), post(20.05, 'toolu_A', 'agA'));
    h.hub.poll();
    assert.equal(h.events()[h.events().length - 1].toolUseId, 'toolu_A');
    v = viewAt(store, h.events(), 'app-dev', 21);
    assert.equal(v.status, 'COMPLETED');
    assert.deepEqual(v.st.snapshot('app-dev', T0 + 21000).recentTasks.map((t) => t.status).sort(), ['COMPLETED', 'ERROR']);
  } finally {
    h.cleanup();
  }
});

test('ambiguous binding (parallel dispatch, in-order starts): a type match is only a hint - the stop of the SUCCESSFUL sibling B closes by its own id', async () => {
  // With two Agent calls waiting at the start, nothing proves agA -> toolu_A, so a failure of A matches by agent TYPE. The held
  // stop here is B's (B really succeeded): it is held as suspect and released WITH its id when B's PostToolUse arrives.
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(begin(2, 'agA'), begin(2.1, 'agB'));
    h.append(stop(10, 'agB', 'app-dev', 'B done'));
    h.hub.poll();
    h.append(failure(10.5, 'toolu_A', 'app-dev'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'type rule: the stop is held as suspect, not dropped');
    h.append(post(10.55, 'toolu_B', 'agB'));
    h.hub.poll();
    const last = h.events()[h.events().length - 1];
    assert.equal(last.status, 'COMPLETED');
    assert.equal(last.toolUseId, 'toolu_B', 'B closes by its own id');
    assert.equal(h.clock.pending(), 0);
    const v = viewAt(store, h.events(), 'app-dev', 11);
    assert.equal(v.status, 'COMPLETED');
    assert.equal(v.st.snapshot('app-dev', T0 + 11000).currentTasks.length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Type failure marker vs a sibling that really succeeded (QA High finding): the marker only makes a stop SUSPECT
// ---------------------------------------------------------------------------------------------------------------------

/** The ids of the COMPLETED events sent so far, as "id" or "-" for a COMPLETED without an id. */
const completedIds = (h) => h.events().filter((e) => e.status === 'COMPLETED').map((e) => e.toolUseId || '-');

test('parallel dispatch, starts in order: A fails with NO stop, B stop + Post come within 60 s -> COMPLETED:B with its id', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(begin(2, 'agA'), begin(2.1, 'agB'));            // ambiguous bindings -> type rule on failure
    h.append(failure(5, 'toolu_A', 'app-dev'));              // A fails and never stops: a type marker is kept
    h.append(stop(20, 'agB', 'app-dev', 'B done'), post(20.05, 'toolu_B', 'agB'));
    h.hub.poll();
    assert.deepEqual(completedIds(h), ['toolu_B'], 'B closes by its id (the marker used to swallow its stop)');
    assert.equal(h.clock.pending(), 0);
    const v = viewAt(store, h.events(), 'app-dev', 21);
    assert.equal(v.status, 'COMPLETED');
    const snap = v.st.snapshot('app-dev', T0 + 21000);
    assert.equal(snap.currentTasks.length, 0, 'no task stays open');
    assert.deepEqual(snap.recentTasks.map((t) => `${t.status}:${t.approx}`).sort(), ['COMPLETED:false', 'ERROR:false'], 'both closed by id (not approximate)');
  } finally {
    h.cleanup();
  }
});

test('same without any SubagentStart in the log: A fails with no stop, B stop + Post within 60 s -> COMPLETED:B with its id', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(failure(5, 'toolu_A', 'app-dev'));
    h.append(stop(20, 'agB', 'app-dev', 'B done'), post(20.05, 'toolu_B', 'agB'));
    h.hub.poll();
    assert.deepEqual(completedIds(h), ['toolu_B']);
    assert.equal(h.clock.pending(), 0);
    const v = viewAt(store, h.events(), 'app-dev', 21);
    assert.equal(v.status, 'COMPLETED');
    assert.equal(v.st.snapshot('app-dev', T0 + 21000).currentTasks.length, 0);
  } finally {
    h.cleanup();
  }
});

test('P2 repro: parallel dispatch with SubagentStart in normal order; A fails before its own stop; B stop at +15 s then Post +50 ms -> B closes', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(begin(2, 'agA'), begin(2.1, 'agB'));
    h.append(failure(10, 'toolu_A', 'app-dev'));             // A fails before its own stop
    h.hub.poll();
    assert.deepEqual(h.events().filter((e) => e.status === 'ERROR').map((e) => e.toolUseId), ['toolu_A']);
    h.append(stop(25, 'agB', 'app-dev', 'B done'));          // +15 s after the failure
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'held as suspect');
    h.append(post(25.05, 'toolu_B', 'agB'));
    h.hub.poll();
    assert.deepEqual(completedIds(h), ['toolu_B'], 'not only ERROR:A - B closes too (the planet used to stay PROCESSING for 30 min)');
    const v = viewAt(store, h.events(), 'app-dev', 26);
    assert.equal(v.status, 'COMPLETED');
    assert.equal(v.st.snapshot('app-dev', T0 + 26000).currentTasks.length, 0);
    assert.equal(h.clock.pending(), 0);
  } finally {
    h.cleanup();
  }
});

test('N1 repro: no SubagentStart; A fails, a NEW sequential task B starts and its stop + Post come 28 s after the failure -> B closes', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), failure(2, 'toolu_A', 'app-dev'));
    h.append(pre(20, 'toolu_B', 'app-dev', 'task B'));       // sequential: B is dispatched after A failed
    h.append(stop(30, 'agB', 'app-dev', 'B done'), post(30.05, 'toolu_B', 'agB'));   // 28 s after the failure, inside the marker
    h.hub.poll();
    assert.deepEqual(completedIds(h), ['toolu_B']);
    const v = viewAt(store, h.events(), 'app-dev', 31);
    assert.equal(v.status, 'COMPLETED');
    assert.equal(v.st.snapshot('app-dev', T0 + 31000).currentTasks.length, 0, 'B is closed (it used to stay open)');
    assert.equal(h.clock.pending(), 0);
  } finally {
    h.cleanup();
  }
});

test('a failed run whose stray stop comes WITHOUT any PostToolUse: held for the wait, then dropped - no false COMPLETED', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(begin(2, 'agA'), begin(2.1, 'agB'));
    h.append(failure(5, 'toolu_A', 'app-dev'));
    h.append(stop(6, 'agA', 'app-dev', 'A stray stop after its failure'));   // no PostToolUse(Agent) ever for a failed run
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'held as suspect');
    assert.deepEqual(completedIds(h), []);
    h.clock.advance(TOOL_USE_WAIT_MS);
    assert.equal(h.clock.pending(), 0, 'dropped when the wait ends');
    assert.deepEqual(completedIds(h), [], 'no false COMPLETED (neither with an id nor a FIFO one that could close B)');
    const v = viewAt(store, h.events(), 'app-dev', 30);
    assert.equal(v.status, 'PROCESSING', 'B still runs');
    assert.equal(v.st.snapshot('app-dev', T0 + 30000).currentTasks.map((t) => t.id).join(), 'toolu_B');
  } finally {
    h.cleanup();
  }
});

test('a suspect stop released by its Post produces exactly one COMPLETED (no duplicate), also when the stray stop of the failed run follows', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(begin(2, 'agA'), begin(2.1, 'agB'));
    h.append(failure(5, 'toolu_A', 'app-dev'));
    h.append(stop(6, 'agB', 'app-dev', 'B done'), post(6.05, 'toolu_B', 'agB'));   // consumes the type marker, confirmed by Post
    h.append(stop(7, 'agA', 'app-dev', 'A stray'));                                   // the marker is used up: held normally
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS);
    assert.deepEqual(completedIds(h).filter((x) => x === 'toolu_B'), ['toolu_B'], 'B is completed once');
    assert.equal(h.clock.pending(), 0);
  } finally {
    h.cleanup();
  }
});

test('ambiguous binding never drops a stop by id: a late PostToolUse (after the 8 s wait) does not lose the correct stop', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    swappedStarts(h);                                        // FIFO guess: agB -> toolu_A (wrong, B's run)
    h.append(stop(10, 'agB', 'app-dev', 'B done'));          // held; its PostToolUse comes after more than 8 s
    h.hub.poll();
    // Task A is closed by id through another path (an event posted to /api/events)
    h.hub.publish({ ts: T(11), agent: 'app-dev', status: 'ERROR', message: 'A closed elsewhere', toolUseId: 'toolu_A' });
    h.clock.advance(TOOL_USE_WAIT_MS);
    const completed = h.events().filter((e) => e.status === 'COMPLETED');
    assert.equal(completed.length, 1, 'the stop of B is released (the old rule dropped it because the guessed toolu_A was closed)');
    assert.equal('toolUseId' in completed[0], false, 'released without an id');
    const v = viewAt(store, h.events(), 'app-dev', 30);
    assert.equal(v.st.snapshot('app-dev', T0 + 30000).currentTasks.length, 0, 'B is closed (FIFO: the oldest open task)');
  } finally {
    h.cleanup();
  }
});

test('after a rebind one tool_use_id has one agent_ref: a failure uses the exact ref, not the stale guess', () => {
  const h = makeHub();
  try {
    swappedStarts(h);                                        // guesses: agB -> toolu_A, agA -> toolu_B
    h.append(post(5, 'toolu_B', 'agB'));                     // exact: agB IS toolu_B. The guess agA -> toolu_B must go
    h.append(stop(10, 'agA', 'app-dev', 'A done'));          // A's stop is held
    h.hub.poll();
    assert.equal(h.clock.pending(), 1);
    h.append(failure(10.5, 'toolu_B', 'app-dev'));           // B fails: per instance with ref agB (exact), A's stop is NOT touched
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the held stop of agA stays (an unstable lookup could have returned agA for toolu_B)');
    h.append(post(11, 'toolu_A', 'agA'));
    h.hub.poll();
    const last = h.events()[h.events().length - 1];
    assert.equal(last.status, 'COMPLETED');
    assert.equal(last.toolUseId, 'toolu_A');
  } finally {
    h.cleanup();
  }
});

test('start matching is keyed by session_id + type: a start never binds to an Agent call of another session', () => {
  const h = makeHub();
  try {
    const s1 = (rec) => ({ ...rec, session_id: 'S1' });
    const s2 = (rec) => ({ ...rec, session_id: 'S2' });
    h.append(s1(pre(1, 'toolu_A', 'app-dev', 'task A in S1')), s2(pre(1.1, 'toolu_B', 'app-dev', 'task B in S2')));
    h.append(s2(begin(2, 'agB')));                           // belongs to S2: binds to toolu_B (the only S2 candidate, trusted)
    h.append(stop(10, 'agB', 'app-dev', 'B done'));          // held
    h.hub.poll();
    h.append(s1(failure(10.5, 'toolu_A', 'app-dev')));       // S1 run A fails; it never started, nothing of it to drop
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the stop of B is kept (without session keying agB would be bound to toolu_A and dropped)');
    h.append(post(11, 'toolu_B', 'agB'));
    h.hub.poll();
    assert.equal(h.events()[h.events().length - 1].toolUseId, 'toolu_B');
  } finally {
    h.cleanup();
  }
});

test('start matching: a start with no Agent call waiting in ITS session binds nothing', () => {
  const h = makeHub();
  try {
    h.append({ ...pre(1, 'toolu_A', 'app-dev', 'task A in S1'), session_id: 'S1' });
    h.append({ ...begin(2, 'agX'), session_id: 'S2' });      // no pending call in S2
    h.append(stop(10, 'agX', 'app-dev', 'X done'));
    h.hub.poll();
    h.hub.publish({ ts: T(11), agent: 'app-dev', status: 'ERROR', message: 'A closed elsewhere', toolUseId: 'toolu_A' });
    h.clock.advance(TOOL_USE_WAIT_MS);
    assert.equal(h.events().filter((e) => e.status === 'COMPLETED').length, 1, 'not dropped through a cross-session binding to toolu_A');
  } finally {
    h.cleanup();
  }
});

// ---------- consumed type marker is restored (P3, P3c, I1) and a late Post still closes a dropped suspect (N2) ----------

/** The COMPLETED events without an id (FIFO, approximate "~") sent so far. */
const fifoCompleted = (h) => h.events().filter((e) => e.status === 'COMPLETED' && !e.toolUseId);

test('P3 repro: A fails, sibling B succeeds (its suspect stop is confirmed by Post), A stop arrives LATE -> no false COMPLETED', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(begin(2, 'agA'), begin(2.1, 'agB'));                    // ambiguous bindings -> type rule
    h.append(failure(5, 'toolu_A', 'app-dev'));
    h.append(stop(6, 'agB', 'app-dev', 'B done'), post(6.05, 'toolu_B', 'agB'));   // consumes the marker, confirmed by Post
    h.hub.poll();
    assert.deepEqual(completedIds(h), ['toolu_B']);
    h.append(stop(12, 'agA', 'app-dev', 'A stray stop, late'));      // the stop of the failed run
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'caught by the restored marker: held as suspect');
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.deepEqual(completedIds(h), ['toolu_B'], 'no COMPLETED:~ for the failed run');
    assert.equal(fifoCompleted(h).length, 0);
    assert.equal(h.clock.pending(), 0);
    const v = viewAt(store, h.events(), 'app-dev', 30);
    const snap = v.st.snapshot('app-dev', T0 + 30000);
    assert.equal(snap.currentTasks.length, 0);
    assert.deepEqual(snap.recentTasks.map((t) => `${t.status}:${t.approx}`).sort(), ['COMPLETED:false', 'ERROR:false']);
  } finally {
    h.cleanup();
  }
});

test('P3c repro: same, but a new run C starts before the stop of A -> the stop of A does not FIFO-close C', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(begin(2, 'agA'), begin(2.1, 'agB'));
    h.append(failure(5, 'toolu_A', 'app-dev'));
    h.append(stop(6, 'agB', 'app-dev', 'B done'), post(6.05, 'toolu_B', 'agB'));
    h.append(pre(8, 'toolu_C', 'app-dev', 'task C'), begin(8.1, 'agC'));   // C starts before A's late stop
    h.append(stop(12, 'agA', 'app-dev', 'A stray stop, late'));
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.deepEqual(completedIds(h), ['toolu_B'], 'neither COMPLETED:~ nor a close of C');
    const v = viewAt(store, h.events(), 'app-dev', 30);
    assert.equal(v.status, 'PROCESSING', 'C still runs');
    assert.equal(v.st.snapshot('app-dev', T0 + 30000).currentTasks.map((t) => t.id).join(), 'toolu_C');
  } finally {
    h.cleanup();
  }
});

test('I1 repro (no SubagentStart): COMPLETED:B must not be followed by COMPLETED:~ from the stop of the failed run', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(failure(5, 'toolu_A', 'app-dev'));
    h.append(stop(6, 'agB', 'app-dev', 'B done'), post(6.05, 'toolu_B', 'agB'));
    h.append(stop(7, 'agA', 'app-dev', 'A stray stop'));
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.deepEqual(completedIds(h), ['toolu_B'], 'exactly COMPLETED:B, no COMPLETED:~ after it');
    assert.equal(h.clock.pending(), 0);
    const v = viewAt(store, h.events(), 'app-dev', 30);
    assert.equal(v.st.snapshot('app-dev', T0 + 30000).currentTasks.length, 0);
  } finally {
    h.cleanup();
  }
});

test('I1 (stop of the failed run already HELD before the failure): no extra COMPLETED:~ after COMPLETED:B', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(stop(4, 'agB', 'app-dev', 'B done'), stop(4.1, 'agA', 'app-dev', 'A stray stop'));   // both held, both plain
    h.append(failure(4.2, 'toolu_A', 'app-dev'));                    // no SubagentStart: type rule marks the oldest held stop (B) suspect
    h.append(post(4.3, 'toolu_B', 'agB'));                           // B proven a success: the marker must move to the held stop of A
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.deepEqual(completedIds(h), ['toolu_B'], 'exactly COMPLETED:B');
    assert.equal(fifoCompleted(h).length, 0, 'the held stop of A is dropped, not FIFO-released');
    assert.equal(h.clock.pending(), 0);
  } finally {
    h.cleanup();
  }
});

test('I1c: a new run C opened within the wait is NOT closed wrongly by the held stop of the failed run', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(begin(2, 'agA'), begin(2.1, 'agB'));
    h.append(stop(10, 'agB', 'app-dev', 'B done'), stop(10.1, 'agA', 'app-dev', 'A stray stop'));
    h.append(failure(10.2, 'toolu_A', 'app-dev'));
    h.append(post(10.3, 'toolu_B', 'agB'));
    h.append(pre(11, 'toolu_C', 'app-dev', 'task C'), begin(11.1, 'agC'));   // C opens before the wait of A's stop ends
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS * 3);
    assert.deepEqual(completedIds(h), ['toolu_B'], 'neither COMPLETED:~ nor a close of C');
    const v = viewAt(store, h.events(), 'app-dev', 30);
    assert.equal(v.status, 'PROCESSING', 'C still runs');
    assert.equal(v.st.snapshot('app-dev', T0 + 30000).currentTasks.map((t) => t.id).join(), 'toolu_C');
  } finally {
    h.cleanup();
  }
});

test('restore also covers a suspect made by the failure itself (stop held first, failure later, then B Post, then A stop)', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(stop(4, 'agB', 'app-dev', 'B done'));                   // held
    h.append(failure(5, 'toolu_A', 'app-dev'));                      // no SubagentStart: type rule marks the held stop suspect
    h.append(post(5.05, 'toolu_B', 'agB'));                          // B's Post proves it a success
    h.append(stop(9, 'agA', 'app-dev', 'A stray stop'));             // the failed run's own stop
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.deepEqual(completedIds(h), ['toolu_B'], 'the stop of A is caught, not released as COMPLETED:~');
  } finally {
    h.cleanup();
  }
});

test('N2 repro: A fails, B suspect stop, B Post arrives 12 s after the stop (> 8 s) -> B still closes by id, once', async () => {
  const store = await loadStore();
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'));
    h.append(failure(5, 'toolu_A', 'app-dev'));
    h.append(stop(6, 'agB', 'app-dev', 'B done'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'held as suspect');
    h.clock.advance(TOOL_USE_WAIT_MS);                               // dropped: no Post within 8 s
    assert.deepEqual(completedIds(h), []);
    h.append(post(18, 'toolu_B', 'agB'));                            // 12 s after the stop
    h.hub.poll();
    assert.deepEqual(completedIds(h), ['toolu_B'], 'the late exact Post still closes B');
    const v = viewAt(store, h.events(), 'app-dev', 19);
    assert.equal(v.status, 'COMPLETED');
    assert.equal(v.st.snapshot('app-dev', T0 + 19000).currentTasks.length, 0, 'B is no longer open');
    h.append(post(18.5, 'toolu_B', 'agB'));                          // the same Post twice
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.deepEqual(completedIds(h), ['toolu_B'], 'no duplicate completion');
    assert.equal(h.clock.pending(), 0);
  } finally {
    h.cleanup();
  }
});

test('N2: a Post after LATE_POST_MS finds nothing (bounded memory); a task already closed by id is not closed twice', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'), pre(1.1, 'toolu_B', 'app-dev', 'task B'), failure(5, 'toolu_A', 'app-dev'));
    h.append(stop(6, 'agB', 'app-dev', 'B done'));
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS);
    h.append(post(14 + 61, 'toolu_B', 'agB'));                       // dropped at +14 s, memory ends at +74 s
    h.hub.poll();
    assert.deepEqual(completedIds(h), [], 'too late: nothing is emitted');

    // Second case: the task was closed by id elsewhere before the late Post -> no second close
    h.append(pre(100, 'toolu_D', 'app-dev', 'task D'), failure(101, 'toolu_X', 'app-dev'));
    h.append(stop(102, 'agD', 'app-dev', 'D done'));
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    h.hub.publish({ ts: T(120), agent: 'app-dev', status: 'ERROR', message: 'D closed elsewhere', toolUseId: 'toolu_D' });
    h.append(post(125, 'toolu_D', 'agD'));
    h.hub.poll();
    assert.deepEqual(completedIds(h), [], 'toolu_D is already closed by id: the late Post adds no COMPLETED');
  } finally {
    h.cleanup();
  }
});
