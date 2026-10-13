'use strict';
/**
 * workspace-tool-failure.test.js - the failure rule (owner decision 2026-10-13), hub level with a fake clock and temp files.
 *   - PostToolUseFailure of an ORDINARY tool (Bash, Edit, Read, ... in the main session or inside a sub-agent) is not an agent
 *     failure: no ERROR workspace event (so no red planet and no black hole comet), no change of the planet status in the
 *     browser store, no stop-hold side effect (held stops stay held, no failure marker is left for a later stop), and no
 *     log line. It is sent only on the "activity" channel as phase 'error' (the scene draws a red beam).
 *   - PostToolUseFailure of the Agent tool (a failed delegation) is unchanged: ERROR of the dispatched sub-agent, closes the
 *     task by id, drops the held stop; it is not an activity message (a delegation is a comet).
 *   - non-Agent tool events of every kind (Pre / Post / PostFailure) never reach the stop-hold or the instance pairing.
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
const { convertHookRecord, convertToolActivity } = require('../lib/workspace-adapter');
const { fakeClock } = require('./helpers/fake-clock');

const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const T = (s) => new Date(T0 + s * 1000).toISOString();

async function loadStore() {
  return import(pathToFileURL(path.join(__dirname, '..', 'public', 'workspace', 'stellar', 'store.js')).href);
}

const pre = (s, id, sub, desc) => ({
  ts: T(s), event: 'PreToolUse', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, subagent_type: sub, description: desc,
});
const stop = (s, ref, agentType, msg) => ({ ts: T(s), event: 'SubagentStop', agent_type: agentType || 'app-dev', agent_id: ref, last_message: msg });
/** A failed ordinary tool; `agentType` / `agentId` say who ran it (a sub-agent has both, the main session neither). */
const toolFail = (s, tool, agentType, agentId) => ({
  ts: T(s), event: 'PostToolUseFailure', tool_name: tool, tool_use_id: `toolu_${tool}_${s}`, error: 'exit code 1',
  ...(agentType ? { agent_type: agentType } : {}), ...(agentId ? { agent_id: agentId } : {}),
});
const agentFail = (s, id, sub) => ({
  ts: T(s), event: 'PostToolUseFailure', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, subagent_type: sub, error: 'Agent type not found',
});

function makeHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-toolfail-'));
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
  const events = () => chunks.filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice('data: '.length)));
  const activities = () => chunks.filter((c) => c.startsWith('event: activity')).map((c) => JSON.parse(c.split('\n')[1].slice('data: '.length)));
  const append = (rec) => fs.appendFileSync(o.eventsFile, `${JSON.stringify(rec)}\n`);
  const cleanup = () => {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { hub, clock, events, activities, append, cleanup };
}

// ---------- adapter ----------

test('adapter: a failed ordinary tool gives no workspace event but still an activity error; a failed Agent call is the reverse', () => {
  for (const tool of ['Bash', 'Edit', 'Read', 'Write', 'Grep', 'WebFetch', 'mcp__srv__tool']) {
    for (const agent_type of [undefined, 'app-dev']) {
      const rec = { ts: T(1), event: 'PostToolUseFailure', tool_name: tool, tool_use_id: 'toolu_1', agent_type };
      assert.equal(convertHookRecord(rec), null, `${tool}: no workspace event`);
      assert.equal(convertToolActivity(rec).phase, 'error', `${tool}: red beam message`);
    }
  }
  const agent = { ts: T(1), event: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'toolu_A', agent_type: 'secretary', subagent_type: 'app-dev' };
  const ev = convertHookRecord(agent);
  assert.equal(ev.status, 'ERROR');
  assert.equal(ev.agent, 'app-dev');
  assert.equal(ev.toolUseId, 'toolu_A');
  assert.equal(convertToolActivity(agent), null, 'a delegation is a comet, not an activity');
});

// ---------- hub: ordinary tool failure ----------

test('hub: a failed Bash call in the main session and in a sub-agent makes no ERROR, no log event, and a red-beam activity each', async () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.hub.poll();
    const before = h.events().length;
    h.append(toolFail(2, 'Bash', undefined, undefined));          // main session
    h.append(toolFail(3, 'Edit', 'app-dev', 'agA'));              // inside the sub-agent
    h.append(toolFail(4, 'Read', 'app-dev', 'agA'));
    h.hub.poll();
    assert.equal(h.events().length, before, 'no workspace event at all (no ERROR, no log line)');
    assert.ok(!h.events().some((e) => e.status === 'ERROR'));
    const acts = h.activities();
    assert.deepEqual(acts.map((a) => [a.agent, a.phase, a.tool]),
      [['secretary', 'error', 'Bash'], ['app-dev', 'error', 'Edit'], ['app-dev', 'error', 'Read']]);

    const st = (await loadStore()).createStore();
    h.events().forEach((e) => st.ingest(e));
    const snap = st.snapshot('app-dev', T0 + 5000);
    assert.equal(snap.status, 'PROCESSING', 'the planet status is untouched by tool failures');
    assert.equal(snap.currentTasks.length, 1, 'the open task stays open');
    assert.equal(snap.recentTasks.length, 0);
  } finally {
    h.cleanup();
  }
});

test('hub: a failed ordinary tool does not drop, release or mark anything in the stop-hold', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(stop(2, 'agA', 'app-dev', 'A done'));   // sync stop: held for its PostToolUse id
    h.hub.poll();
    assert.equal(h.clock.pending(), 1);
    h.append(toolFail(3, 'Bash', 'app-dev', 'agB'));
    h.append(toolFail(3, 'Edit', 'app-dev', 'agA'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the held stop is still held (not dropped)');
    h.clock.advance(TOOL_USE_WAIT_MS);
    const last = h.events()[h.events().length - 1];
    assert.equal(last.status, 'COMPLETED', 'released at its normal timeout');
    assert.equal(last.message, 'A done');

    // No failure marker was left: a later sync stop of the same agent is held normally and released, not dropped as suspect
    h.append(pre(20, 'toolu_B', 'app-dev', 'task B'));
    h.append(toolFail(21, 'Bash', 'app-dev', 'agC'));
    h.append(stop(22, 'agC', 'app-dev', 'B done'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'the new stop is held');
    h.clock.advance(TOOL_USE_WAIT_MS);
    const last2 = h.events()[h.events().length - 1];
    assert.equal(last2.status, 'COMPLETED');
    assert.equal(last2.message, 'B done', 'a stop after a tool failure is released (no marker swallowed it)');
  } finally {
    h.cleanup();
  }
});

test('hub: non-Agent tool events of every kind never touch the stop-hold or the instance pairing', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(stop(2, 'agA', 'app-dev', 'A done'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1);
    // A PostToolUse of an ordinary tool with a response id that looks like an agent_ref must not release the held stop
    h.append({ ts: T(3), event: 'PostToolUse', agent_type: 'app-dev', tool_name: 'Read', tool_use_id: 'toolu_r', agent_ref: 'agA' });
    h.append({ ts: T(3), event: 'PreToolUse', agent_type: 'app-dev', agent_id: 'agA', tool_name: 'Bash', tool_use_id: 'toolu_b' });
    h.append(toolFail(4, 'Bash', 'app-dev', 'agA'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1, 'still held: only PostToolUse(Agent) releases a sync stop');
    assert.ok(!h.events().some((e) => e.toolUseId === 'toolu_r'), 'no id was taken from an ordinary tool');
    h.clock.advance(TOOL_USE_WAIT_MS);
    const last = h.events()[h.events().length - 1];
    assert.equal(last.status, 'COMPLETED');
    assert.equal('toolUseId' in last, false, 'released by timeout, without an id (FIFO, approximate)');
  } finally {
    h.cleanup();
  }
});

test('hub: the replay buffer holds no tool line (start logs are live only) and no activity', () => {
  const h = makeHub();
  try {
    h.append({ ts: T(1), event: 'PreToolUse', agent_type: 'app-dev', agent_id: 'agA', tool_name: 'Read', tool_use_id: 't1' });
    h.append({ ts: T(2), event: 'PostToolUse', agent_type: 'app-dev', agent_id: 'agA', tool_name: 'Read', tool_use_id: 't1' });
    h.append(toolFail(3, 'Bash', 'app-dev', 'agA'));
    h.hub.poll();
    // A client that attaches later gets the replay buffer
    const late = [];
    h.hub.attach({ on() {} }, { write: (s) => late.push(s), on() {}, end() {} });
    assert.equal(late.filter((c) => c.startsWith('data: ')).length, 0, 'no tool line in the replay');
    assert.equal(late.filter((c) => c.startsWith('event: activity')).length, 0, 'no activity in the replay');
  } finally {
    h.cleanup();
  }
});

// ---------- hub: Agent failure unchanged ----------

test('hub: a failed Agent call is still an ERROR of the dispatched sub-agent, closes its task and drops the held stop', async () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(stop(2, 'agA', 'app-dev', 'A done'));
    h.hub.poll();
    h.append(agentFail(3, 'toolu_A', 'app-dev'));
    h.hub.poll();
    const evs = h.events();
    assert.equal(evs[evs.length - 1].status, 'ERROR');
    assert.equal(evs[evs.length - 1].agent, 'app-dev');
    assert.equal(evs[evs.length - 1].toolUseId, 'toolu_A');
    assert.equal(h.activities().length, 0, 'an Agent failure is not a tool activity');
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.ok(!h.events().some((e) => e.status === 'COMPLETED'), 'the held stop of the failed run is dropped');

    const st = (await loadStore()).createStore();
    h.events().forEach((e) => st.ingest(e));
    assert.equal(st.snapshot('app-dev', T0 + 5000).status, 'ERROR');
  } finally {
    h.cleanup();
  }
});

test('hub: an ordinary tool failure right before / after an Agent failure does not change the Agent failure handling', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.append(toolFail(2, 'Bash', 'app-dev', 'agA'));
    h.append(agentFail(3, 'toolu_A', 'app-dev'));
    h.append(toolFail(4, 'Edit', 'secretary'));
    h.hub.poll();
    const errs = h.events().filter((e) => e.status === 'ERROR');
    assert.equal(errs.length, 1, 'exactly the Agent failure');
    assert.equal(errs[0].toolUseId, 'toolu_A');
    assert.equal(h.activities().length, 2, 'the two ordinary failures are red-beam activities');
  } finally {
    h.cleanup();
  }
});
