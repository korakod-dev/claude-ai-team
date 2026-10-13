'use strict';
/**
 * workspace-failure-hold.test.js - a failed sync sub-agent run (PostToolUseFailure of an Agent call) must close its
 * task once, as ERROR, and must never be followed by a COMPLETED of the same run. Hub (lib/workspace.js) with a fake
 * clock (test/helpers/fake-clock.js) and temp files only. The browser store (public/workspace/stellar/store.js) is
 * fed with the same events to check the final state.
 *   - sync failure: Stop, then PostToolUseFailure -> one ERROR, the held stop is dropped, the timeout sends nothing
 *   - failure before Stop: the late Stop of that run is dropped (failure marker), no timer is left
 *   - timeout path (no failure): the held stop is released once, without an id, after exactly TOOL_USE_WAIT_MS
 *   - no double count: one failed task, and the other open task of the agent is not closed by FIFO
 *   - the failure marker is only for TOOL_USE_WAIT_MS: a later stop of the agent is not dropped
 *   - a failure of a non-Agent tool, or an Agent failure without subagent_type, does not touch held stops
 *   - a held stop is NOT dropped when a sibling instance of the same agent started (parallel dispatch); per-instance rules are
 *     in test/workspace-instances.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { isolateEnv, tempWorkspaceOpts } = require('./helpers/temp-paths');
isolateEnv();
const { createWorkspaceHub, TOOL_USE_WAIT_MS, TYPE_FAILURE_MARKER_MS } = require('../lib/workspace');
const { fakeClock } = require('./helpers/fake-clock');

// Record time: T(s) = 10:00:ss UTC on 2026-10-12. The fake clock starts at the same epoch in makeHub().
const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const T = (s) => new Date(T0 + s * 1000).toISOString();

/** The browser store, loaded as an ES module (the same file the page uses). */
async function loadStore() {
  return import(pathToFileURL(path.join(__dirname, '..', 'public', 'workspace', 'stellar', 'store.js')).href);
}

/** PreToolUse(Agent): opens the task of sub-agent `sub` with tool_use_id `id`. */
const pre = (s, id, sub, desc) => ({
  ts: T(s), event: 'PreToolUse', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, subagent_type: sub, description: desc,
});
/** SubagentStop of a sync run (no PostToolUse yet, so the hub holds it). */
const stop = (s, ref, agentType, msg) => ({
  ts: T(s), event: 'SubagentStop', agent_type: agentType || 'app-dev', agent_id: ref, last_message: msg,
});
/** PostToolUseFailure of an Agent call: the caller is the main session, the sub-agent is subagent_type. No agent_ref. */
const failure = (s, id, sub) => ({
  ts: T(s), event: 'PostToolUseFailure', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id,
  ...(sub === undefined ? {} : { subagent_type: sub }), error: 'Agent type not found',
});

/** A hub on temp files with a fake clock; one SSE client collects what the hub sends. */
function makeHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-failhold-'));
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
  const append = (rec) => fs.appendFileSync(o.eventsFile, `${JSON.stringify(rec)}\n`);
  const cleanup = () => {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { hub, clock, events, append, cleanup };
}

test('sync failure: the held stop is dropped, the failure closes the task once as ERROR, and the timeout sends nothing more', async () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.hub.poll();
    h.append(stop(2, 'agA', 'app-dev', 'A done'));
    h.hub.poll();
    assert.equal(h.events().length, 1, 'the stop is held');
    assert.equal(h.clock.pending(), 1, 'one timer for the held stop');

    h.append(failure(3, 'toolu_A', 'app-dev'));
    h.hub.poll();
    const evs = h.events();
    assert.equal(evs.length, 2, 'PROCESSING A, then the ERROR of the failure');
    assert.equal(evs[1].status, 'ERROR');
    assert.equal(evs[1].agent, 'app-dev', 'the ERROR belongs to the dispatched sub-agent');
    assert.equal(evs[1].toolUseId, 'toolu_A', 'the ERROR closes task A by its id');
    // No SubagentStart in this log: the match is by agent TYPE (a hint), so the stop is kept as SUSPECT, not dropped at once
    assert.equal(h.clock.pending(), 1, 'the stop stays held as suspect: it waits for an exact PostToolUse');

    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.equal(h.clock.pending(), 0, 'no PostToolUse came: the suspect stop is dropped when its wait ends');
    assert.equal(h.events().length, 2, 'the dropped stop is never released: no COMPLETED for this run');
    assert.ok(!h.events().some((e) => e.status === 'COMPLETED'), 'no COMPLETED event at all');

    const st = (await loadStore()).createStore();
    h.events().forEach((e) => st.ingest(e));
    const snap = st.snapshot('app-dev');
    assert.equal(snap.status, 'ERROR', 'the agent stays in ERROR');
    assert.equal(snap.currentTasks.length, 0, 'task A is closed');
    assert.equal(snap.recentTasks.length, 1, 'exactly one failed task (no double count)');
    assert.equal(snap.recentTasks[0].status, 'ERROR');
    assert.equal(snap.recentTasks[0].approx, false, 'closed by its id');
  } finally {
    h.cleanup();
  }
});

test('failure before the stop: the late stop of that run is dropped (failure marker), no timer is left', async () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(failure(2, 'toolu_A', 'app-dev'));
    h.hub.poll();
    assert.equal(h.events().length, 2, 'PROCESSING A, then the ERROR');

    h.append(stop(3, 'agA', 'app-dev', 'A done'));   // the stop of the failed run arrives after its failure
    h.hub.poll();
    assert.equal(h.events().length, 2, 'the late stop is not sent');
    assert.equal(h.clock.pending(), 1, 'the type marker only makes it suspect: it is held for an exact PostToolUse');

    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.equal(h.events().length, 2, 'no PostToolUse came: it is dropped, nothing is sent later');
    assert.equal(h.clock.pending(), 0);

    const st = (await loadStore()).createStore();
    h.events().forEach((e) => st.ingest(e));
    const snap = st.snapshot('app-dev');
    assert.equal(snap.status, 'ERROR', 'no ERROR -> COMPLETED flip');
    assert.equal(snap.recentTasks.length, 1);
    assert.equal(snap.recentTasks[0].status, 'ERROR');
  } finally {
    h.cleanup();
  }
});

test('timeout path (no failure): the held stop is released once, without an id, after exactly TOOL_USE_WAIT_MS', async () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(stop(2, 'agA', 'app-dev', 'A done'));
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS - 1);
    assert.equal(h.events().length, 1, 'still held one millisecond before the wait ends');
    h.clock.advance(1);
    const evs = h.events();
    assert.equal(evs.length, 2, 'released at the end of the wait');
    assert.equal(evs[1].status, 'COMPLETED');
    assert.equal('toolUseId' in evs[1], false, 'no id: the store matches it by FIFO (approximate)');
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.equal(h.events().length, 2, 'released once, never twice');

    const st = (await loadStore()).createStore();
    h.events().forEach((e) => st.ingest(e));
    const snap = st.snapshot('app-dev');
    assert.equal(snap.status, 'COMPLETED');
    assert.equal(snap.recentTasks[0].approx, true, 'FIFO close is marked approximate');
  } finally {
    h.cleanup();
  }
});

test('no double count: a failure closes its own task by id and the other open task of the agent is not taken by FIFO', async () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(pre(2, 'toolu_B', 'app-dev', 'task B'));
    h.append(failure(3, 'toolu_B', 'app-dev'));       // no stop was held: the failure marker is set
    h.append(stop(4, 'agB', 'app-dev', 'B done'));    // the stop of run B: dropped by the marker
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS * 2);

    const st = (await loadStore()).createStore();
    h.events().forEach((e) => st.ingest(e));
    const snap = st.snapshot('app-dev');
    // Task text is "รับงานจาก <caller>: <description>", so the descriptions are matched by inclusion
    assert.equal(snap.currentTasks.length, 1, 'one task is still open');
    assert.ok(snap.currentTasks[0].text.includes('task A'), 'task A is still open (not closed by FIFO)');
    assert.equal(snap.recentTasks.length, 1, 'one failed task');
    assert.ok(snap.recentTasks[0].text.includes('task B'));
    assert.equal(snap.recentTasks[0].status, 'ERROR');
    assert.equal(snap.recentTasks[0].approx, false);
  } finally {
    h.cleanup();
  }
});

test('the failure marker (type rule) ends after TYPE_FAILURE_MARKER_MS: a stop that comes later is held as usual', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(failure(2, 'toolu_A', 'app-dev'));
    h.hub.poll();
    h.append(stop(2 + TYPE_FAILURE_MARKER_MS / 1000 + 2, 'agLater', 'app-dev', 'later run'));  // 2 s after the marker ended
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the later stop is held (not dropped by the old marker)');
    h.clock.advance(TOOL_USE_WAIT_MS);
    const last = h.events()[h.events().length - 1];
    assert.equal(last.status, 'COMPLETED');
    assert.equal(last.message, 'later run', 'released by its own timeout');
  } finally {
    h.cleanup();
  }
});

test('a failure of a non-Agent tool makes no ERROR and does not touch held stops; an Agent failure without subagent_type keeps the caller ERROR', () => {
  // Changed on purpose (2026-10-13): the Bash failure used to be an ERROR too (errs.length was 2). Now only the Agent failure is.
  const h = makeHub();
  try {
    h.append(stop(1, 'agH', 'app-dev', 'held'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1);
    h.append({ ts: T(2), event: 'PostToolUseFailure', agent_type: 'app-dev', tool_name: 'Bash', tool_use_id: 'toolu_bash' });
    h.hub.poll();
    assert.equal(h.events().filter((e) => e.status === 'ERROR').length, 0, 'a failed Bash call is not an ERROR');
    assert.equal(h.clock.pending(), 1, 'the held stop is still held');
    h.append(failure(3, 'toolu_X', undefined));       // Agent call without subagent_type: the caller keeps the ERROR
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the held stop is still held');
    const errs = h.events().filter((e) => e.status === 'ERROR');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].agent, 'secretary', 'no sub-agent named: the caller keeps the event');
    h.clock.advance(TOOL_USE_WAIT_MS);
    assert.equal(h.events()[h.events().length - 1].message, 'held', 'the held stop is released at its timeout');
  } finally {
    h.cleanup();
  }
});

test('a held stop is NOT dropped because a sibling of the same agent started (parallel dispatch): it is released, FIFO closes the oldest', async () => {
  // Changed on purpose (2026-10-13). This test used to assert the opposite: "a newer PROCESSING of the same agent drops
  // the held stop, so no ERROR->COMPLETED flip". That rule looked only at the agent TYPE, so with parallel dispatch of one
  // agent (several instances, shown as moons) it silently LOST the stop of a finished run: task A stayed open until the 30 min
  // stale limit and the planet looked busy. The flip it guarded against is now handled per instance (failed() drops the stop of
  // the failed run by agent_ref, and the shouldRelease check below drops a stop whose bound task is already closed; see
  // test/workspace-instances.test.js). Without any instance data (this log has no SubagentStart) the stop is released.
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(stop(2, 'agA', 'app-dev', 'A done'));     // held: no PostToolUse yet
    h.hub.poll();
    h.append(pre(3, 'toolu_B', 'app-dev', 'task B'));  // a sibling instance of the same agent starts
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS);                 // the wait of the stop ends now
    const msgs = h.events().map((e) => e.status);
    assert.deepEqual(msgs, ['PROCESSING', 'PROCESSING', 'COMPLETED'], 'the stop is released: the finished run is not lost');
    assert.equal('toolUseId' in h.events()[2], false, 'without an id: the browser matches it by FIFO (approximate)');
    assert.equal(h.clock.pending(), 0);

    const st = (await loadStore()).createStore();
    h.events().forEach((e) => st.ingest(e));
    const now = T0 + 60 * 1000;
    const snap = st.snapshot('app-dev', now);
    assert.equal(snap.status, 'PROCESSING', 'task B still runs, so the agent stays active (derived status)');
    assert.equal(snap.currentTasks.length, 1, 'task A was closed by the released stop (FIFO: the oldest)');
    assert.ok(snap.currentTasks[0].text.includes('task B'));
    assert.equal(snap.recentTasks[0].approx, true);
  } finally {
    h.cleanup();
  }
});

test('a held stop with no newer PROCESSING of its agent is still released at its timeout (the rule is narrow)', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(stop(2, 'agA', 'app-dev', 'A done'));
    h.append(pre(3, 'toolu_Q', 'qa-reviewer', 'review'));   // a PROCESSING of ANOTHER agent does not count
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS);
    const last = h.events()[h.events().length - 1];
    assert.equal(last.agent, 'app-dev');
    assert.equal(last.status, 'COMPLETED', 'released as before');
  } finally {
    h.cleanup();
  }
});

test('no SubagentStart in the log: the late stop of a failed run (after TOOL_USE_WAIT_MS) is dropped, it does not FIFO-close a newer task', async () => {
  // The old "newer PROCESSING drops the held stop" rule is gone (it lost stops of parallel runs). Without instance data the
  // failure leaves a type marker that lives TYPE_FAILURE_MARKER_MS, longer than the 8 s hold, so this late stop is still caught.
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(failure(2, 'toolu_A', 'app-dev'));                    // A fails; its stop has not come yet
    h.append(pre(5, 'toolu_B', 'app-dev', 'task B'));               // a newer task of the same agent starts and runs
    h.append(stop(2 + TOOL_USE_WAIT_MS / 1000 + 4, 'agA', 'app-dev', 'A stopped late'));   // 4 s after the 8 s window
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the late stop is held as suspect by the type marker');
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.ok(!h.events().some((e) => e.status === 'COMPLETED'), 'no COMPLETED that could close task B');

    const st = (await loadStore()).createStore();
    h.events().forEach((e) => st.ingest(e));
    const snap = st.snapshot('app-dev', T0 + 20 * 1000);
    assert.equal(snap.status, 'PROCESSING', 'task B still runs and keeps the planet active');
    assert.equal(snap.currentTasks.length, 1);
    assert.ok(snap.currentTasks[0].text.includes('task B'), 'B was not closed by FIFO');
    assert.equal(snap.recentTasks.length, 1, 'only the failed task A is finished');
    assert.equal(snap.recentTasks[0].status, 'ERROR');
  } finally {
    h.cleanup();
  }
});
