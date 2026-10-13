'use strict';
/**
 * delegation-task-parity.test.js - older Claude Code names the sub-agent tool "Task", current versions "Agent".
 * Both names must behave the same wherever the code asks "is this a delegation?" (lib/delegation.js isDelegationTool is the
 * one shared check). Coverage, site by site:
 *   - the helper itself
 *   - lib/normalize.js: the task description is kept for both names
 *   - lib/workspace-adapter.js: Pre -> handoff PROCESSING, PostToolUse -> agent link, PostToolUseFailure -> ERROR of the
 *     sub-agent, and neither is a tool-activity beam
 *   - lib/workspace.js (hub, fake clock, temp files). Two kinds of test:
 *       (a) end-to-end scenarios that compare Task with Agent (failure closes the task, pairing, no "using tool: Task" beam).
 *           These alone do NOT pin each hub site: the adapter handles Task on its own and masks a hub regression.
 *       (b) one isolated test per hub site, built so that ONLY that site decides the result (see "hub site" below):
 *             isToolStartLog         (Pre handoff stays in the replay buffer)
 *             trackInstance Pre      (pending start -> sole-candidate binding -> trusted instance)
 *             trackInstance Post     (exact agent_ref link -> trusted instance, with no Pre / Start in the log)
 *             pullHook stopHold.resolve (a held sync stop is released at once by PostToolUse)
 *             pullHook failure branch   (a failed call drops the stop of its run)
 *         Verified by mutation: reverting any ONE of these checks in lib/workspace.js to `=== 'Agent'` fails at least one test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isolateEnv, tempWorkspaceOpts } = require('./helpers/temp-paths');
isolateEnv();
const { isDelegationTool } = require('../lib/delegation');
const { normalize } = require('../lib/normalize');
const { convertHookRecord, convertToolActivity } = require('../lib/workspace-adapter');
const { createWorkspaceHub, TOOL_USE_WAIT_MS } = require('../lib/workspace');
const { fakeClock } = require('./helpers/fake-clock');

const NOW = new Date('2026-10-13T10:00:00.000Z');
const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const T = (s) => new Date(T0 + s * 1000).toISOString();
const NAMES = ['Agent', 'Task'];

test('isDelegationTool: Agent and Task only, exact match, any other input is false', () => {
  assert.equal(isDelegationTool('Agent'), true);
  assert.equal(isDelegationTool('Task'), true);
  for (const v of ['agent', 'task', 'TaskCreate', 'TaskOutput', 'Bash', 'Read', '', ' Agent', undefined, null, 5, {}, ['Agent']]) {
    assert.equal(isDelegationTool(v), false, `not a delegation: ${JSON.stringify(v)}`);
  }
});

test('normalize: the task description is kept for Task as for Agent, and dropped for an ordinary tool', () => {
  for (const tool_name of NAMES) {
    const rec = normalize({ hook_event_name: 'PreToolUse', tool_name, tool_input: { subagent_type: 'app-dev', description: 'do the thing' } }, NOW);
    assert.equal(rec.description, 'do the thing', tool_name);
    assert.equal(rec.subagent_type, 'app-dev', tool_name);
  }
  const bash = normalize({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { description: 'list files' } }, NOW);
  assert.equal(bash.description, undefined);
});

test('convertHookRecord: Pre / PostToolUse / PostToolUseFailure of Task give the same result as Agent', () => {
  for (const tool_name of NAMES) {
    const pre = convertHookRecord({ ts: T(1), event: 'PreToolUse', agent_type: 'secretary', tool_name, tool_use_id: 'toolu_A', subagent_type: 'app-dev', description: 'job' });
    assert.equal(pre.status, 'PROCESSING', tool_name);
    assert.equal(pre.agent, 'app-dev', tool_name);
    assert.equal(pre.toolUseId, 'toolu_A', tool_name);

    // PostToolUse is not a log line, but it links agent_ref -> tool_use_id for the SubagentStop that follows
    const links = new Map();
    assert.equal(convertHookRecord({ ts: T(2), event: 'PostToolUse', tool_name, tool_use_id: 'toolu_A', agent_ref: 'agA' }, links), null, tool_name);
    const stop = convertHookRecord({ ts: T(3), event: 'SubagentStop', agent_type: 'app-dev', agent_id: 'agA', last_message: 'done' }, links);
    assert.equal(stop.toolUseId, 'toolu_A', `${tool_name}: stop is paired through the link`);

    const fail = convertHookRecord({ ts: T(4), event: 'PostToolUseFailure', agent_type: 'secretary', tool_name, tool_use_id: 'toolu_A', subagent_type: 'app-dev', error: 'x' });
    assert.equal(fail.status, 'ERROR', tool_name);
    assert.equal(fail.agent, 'app-dev', `${tool_name}: the ERROR belongs to the dispatched sub-agent`);
    assert.equal(fail.toolUseId, 'toolu_A', tool_name);
  }
});

test('convertToolActivity: neither Agent nor Task is a tool beam (a delegation is a comet)', () => {
  for (const tool_name of NAMES) {
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      assert.equal(convertToolActivity({ ts: T(1), event, agent_type: 'secretary', tool_name, tool_use_id: 'toolu_A', subagent_type: 'app-dev' }), null, `${tool_name} ${event}`);
    }
  }
  // Control: a tool whose name only starts like the delegation tool is still a normal tool
  assert.equal(convertToolActivity({ ts: T(1), event: 'PreToolUse', agent_type: 'secretary', tool_name: 'TaskCreate' }).tool, 'TaskCreate');
});

/** A hub on temp files with a fake clock; collects the default events and the "activity" channel. */
function makeHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-taskparity-'));
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
  const parse = (prefix) => chunks.filter((c) => c.startsWith(prefix)).map((c) => JSON.parse(c.slice(c.indexOf('data: ') + 6)));
  return {
    hub, clock,
    events: () => parse('data: '),
    activities: () => parse('event: activity'),
    /** Attach one more client AFTER the records were read: what it receives is the replay buffer. */
    lateClient: () => {
      const got = [];
      hub.attach({ on() {} }, { write: (c) => got.push(c), on() {}, end() {} });
      return got.filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(c.indexOf('data: ') + 6)));
    },
    append: (rec) => fs.appendFileSync(o.eventsFile, `${JSON.stringify(rec)}\n`),
    cleanup: () => { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Run one scenario with the given delegation tool name and return the events / activities the hub sent (ts stripped). */
function runScenario(toolName, records) {
  const h = makeHub();
  try {
    for (const make of records) {
      h.append(make(toolName));
      h.hub.poll();
    }
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    // ts is dropped; the only legitimate difference is the tool name inside a message ("... Task ..." vs "... Agent ..."),
    // so it is mapped to a placeholder before the two runs are compared.
    const strip = (o) => {
      const { ts, ...rest } = o; // eslint-disable-line no-unused-vars
      if (typeof rest.message === 'string') rest.message = rest.message.split(toolName).join('<tool>');
      return rest;
    };
    return { events: h.events().map(strip), activities: h.activities().map(strip), pending: h.clock.pending() };
  } finally {
    h.cleanup();
  }
}

test('hub: a failed Task call ends in ERROR exactly like a failed Agent call (no lingering "using tool: Task" beam)', () => {
  const records = [
    (n) => ({ ts: T(1), event: 'PreToolUse', agent_type: 'secretary', tool_name: n, tool_use_id: 'toolu_A', subagent_type: 'app-dev', description: 'task A' }),
    (n) => ({ ts: T(2), event: 'SubagentStop', agent_type: 'app-dev', agent_id: 'agA', last_message: 'A done' }),
    (n) => ({ ts: T(3), event: 'PostToolUseFailure', agent_type: 'secretary', tool_name: n, tool_use_id: 'toolu_A', subagent_type: 'app-dev', error: 'Agent type not found' }),
  ];
  const viaAgent = runScenario('Agent', records);
  const viaTask = runScenario('Task', records);
  assert.deepEqual(viaTask, viaAgent, 'Task must behave exactly like Agent');
  assert.ok(viaTask.events.some((e) => e.status === 'ERROR' && e.agent === 'app-dev' && e.toolUseId === 'toolu_A'), 'the failure is an ERROR of app-dev');
  assert.ok(!viaTask.events.some((e) => e.status === 'COMPLETED'), 'the dropped stop never completes the failed run');
  assert.equal(viaTask.activities.length, 0, 'a delegation sends no tool activity (no beam that could linger)');
  assert.equal(viaTask.pending, 0, 'no timer is left');
});

test('hub: Task Pre + PostToolUse + SubagentStop pair by id like Agent, and no activity is sent for the delegation', () => {
  const records = [
    (n) => ({ ts: T(1), event: 'PreToolUse', agent_type: 'secretary', tool_name: n, tool_use_id: 'toolu_B', subagent_type: 'qa', description: 'review' }),
    (n) => ({ ts: T(2), event: 'SubagentStart', agent_type: 'qa', agent_id: 'agB' }),
    (n) => ({ ts: T(3), event: 'PostToolUse', agent_type: 'secretary', tool_name: n, tool_use_id: 'toolu_B', agent_ref: 'agB', response_status: 'async_launched' }),
    (n) => ({ ts: T(4), event: 'SubagentStop', agent_type: 'qa', agent_id: 'agB', last_message: 'reviewed' }),
  ];
  const viaAgent = runScenario('Agent', records);
  const viaTask = runScenario('Task', records);
  assert.deepEqual(viaTask, viaAgent);
  const completed = viaTask.events.find((e) => e.status === 'COMPLETED');
  assert.ok(completed, 'the sub-agent completed');
  assert.equal(completed.toolUseId, 'toolu_B', 'closed by the id of the Task call');
  assert.equal(viaTask.activities.some((a) => a.tool === 'Task'), false, 'no beam for the Task call itself');
});

// ---- one isolated test per hub site (lib/workspace.js); each runs for both tool names ----

/** Run `fn(hubHandle, toolName)` for Agent and Task on a fresh hub each time. */
function forBothNames(fn) {
  for (const toolName of NAMES) {
    const h = makeHub();
    try {
      fn(h, toolName);
    } finally {
      h.cleanup();
    }
  }
}

const delegPre = (s, n, id, sub) => ({ ts: T(s), event: 'PreToolUse', agent_type: 'secretary', tool_name: n, tool_use_id: id, subagent_type: sub, description: `job ${id}` });
const delegPost = (s, n, id, ref) => ({ ts: T(s), event: 'PostToolUse', agent_type: 'secretary', tool_name: n, tool_use_id: id, agent_ref: ref, response_status: 'completed' });
const subStart = (s, ref, type) => ({ ts: T(s), event: 'SubagentStart', agent_type: type, agent_id: ref });
const subStop = (s, ref, type) => ({ ts: T(s), event: 'SubagentStop', agent_type: type, agent_id: ref, last_message: 'done' });
const workTool = (s, ref, type, id) => ({ ts: T(s), event: 'PreToolUse', agent_type: type, agent_id: ref, tool_name: 'Bash', tool_use_id: id });

test('hub site isToolStartLog: the Pre handoff of Task stays in the replay buffer (a late client sees it); a plain tool start does not', () => {
  forBothNames((h, n) => {
    h.append(delegPre(1, n, 'toolu_R', 'app-dev'));
    h.append({ ts: T(2), event: 'PreToolUse', agent_type: 'app-dev', agent_id: 'aR', tool_name: 'Bash', tool_use_id: 'c1' });
    h.hub.poll();
    const replay = h.lateClient();
    assert.ok(replay.some((e) => e.status === 'PROCESSING' && e.agent === 'app-dev' && e.toolUseId === 'toolu_R'), `${n}: handoff is replayed`);
    assert.equal(replay.some((e) => /Bash/.test(e.message || '')), false, `${n}: the plain tool start is live only (control)`);
  });
});

test('hub site trackInstance(Pre): Pre + SubagentStart with no PostToolUse binds the sole candidate, so its tool call gets the instance', () => {
  forBothNames((h, n) => {
    h.append(delegPre(1, n, 'toolu_S', 'qa-reviewer'));
    h.append(subStart(2, 'aS', 'qa-reviewer'));
    h.append(workTool(3, 'aS', 'qa-reviewer', 'c1'));
    h.hub.poll();
    const acts = h.activities();
    assert.equal(acts.length, 1, n);
    assert.equal(acts[0].instance, 'toolu_S', `${n}: attributed to the instance of the ${n} call`);
  });
});

test('hub site trackInstance(PostToolUse): an exact agent_ref link (no Pre, no Start in the log) gives the tool call its instance', () => {
  forBothNames((h, n) => {
    h.append(delegPost(1, n, 'toolu_X', 'aX'));
    h.append(workTool(2, 'aX', 'app-dev', 'c1'));
    h.hub.poll();
    const acts = h.activities();
    assert.equal(acts.length, 1, n);
    assert.equal(acts[0].instance, 'toolu_X', `${n}: exact link used`);
  });
});

test('hub site stopHold.resolve: a held sync stop is released with its id as soon as PostToolUse arrives (no wait)', () => {
  forBothNames((h, n) => {
    h.append(delegPre(1, n, 'toolu_H', 'app-dev'));
    h.append(subStop(2, 'aH', 'app-dev'));
    h.hub.poll();
    assert.equal(h.events().some((e) => e.status === 'COMPLETED'), false, `${n}: the stop is held (control)`);
    h.append(delegPost(3, n, 'toolu_H', 'aH'));
    h.hub.poll();   // the fake clock has NOT advanced: only the PostToolUse can release the stop
    const done = h.events().filter((e) => e.status === 'COMPLETED');
    assert.equal(done.length, 1, n);
    assert.equal(done[0].toolUseId, 'toolu_H', `${n}: released with the id of the call`);
  });
});

test('hub site failure branch: a failed call drops the held stop of its run, so no COMPLETED follows the ERROR', () => {
  forBothNames((h, n) => {
    h.append(delegPre(1, n, 'toolu_F', 'app-dev'));
    h.append(subStart(2, 'aF', 'app-dev'));
    h.append(subStop(3, 'aF', 'app-dev'));            // held (sync stop, no id yet)
    h.append({ ts: T(4), event: 'PostToolUseFailure', agent_type: 'secretary', tool_name: n, tool_use_id: 'toolu_F', subagent_type: 'app-dev', error: 'x' });
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS * 2);            // the wait ends: a stop that was not dropped would be released now
    const evs = h.events();
    assert.ok(evs.some((e) => e.status === 'ERROR' && e.toolUseId === 'toolu_F'), `${n}: ERROR closes the task`);
    assert.equal(evs.some((e) => e.status === 'COMPLETED'), false, `${n}: the stop of the failed run is dropped`);
  });
});
