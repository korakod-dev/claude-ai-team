'use strict';
/**
 * workspace-tool-use-id.test.js - tool_use_id pass-through (lib/workspace-adapter.js, lib/workspace.js):
 *   - PreToolUse(Agent) PROCESSING and PostToolUseFailure(Agent) ERROR carry the tool_use_id
 *   - PostToolUse(Agent) links agent_ref -> tool_use_id; the SubagentStop of an async run then carries the id
 *   - a sync run (SubagentStop before PostToolUse) has no id in the ADAPTER; the hub holds the stop and adds the id
 *     from the PostToolUse (see test/workspace-stop-hold.test.js for the timing rules)
 *   - validateEvent keeps a valid id, drops a non-string / empty / oversized one
 *   - the hub replays the ids through SSE (fixture in a temp folder, never data/)
 * Real record shapes: see data/events.jsonl (PreToolUse/PostToolUse carry tool_use_id, PostToolUse carries agent_ref).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isolateEnv, tempWorkspaceOpts } = require('./helpers/temp-paths');
isolateEnv();
const { convertHookRecord, validateEvent } = require('../lib/workspace-adapter');
const { createWorkspaceHub } = require('../lib/workspace');

const T = (s) => `2026-10-12T10:00:${String(s).padStart(2, '0')}.000Z`;

/** A PreToolUse(Agent) record that starts a sub-agent. */
const pre = (s, id, sub, desc) => ({
  ts: T(s), event: 'PreToolUse', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, subagent_type: sub, description: desc,
});
/** A PostToolUse(Agent) record. agent_ref is the sub-agent id (= SubagentStart / SubagentStop agent_id). */
const post = (s, id, ref, status) => ({
  ts: T(s), event: 'PostToolUse', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, agent_ref: ref, response_status: status,
});

test('adapter: PreToolUse(Agent) PROCESSING carries the tool_use_id of the call', () => {
  const ev = convertHookRecord(pre(1, 'toolu_A', 'app-dev', 'task A'), new Map());
  assert.equal(ev.status, 'PROCESSING');
  assert.equal(ev.agent, 'app-dev');
  assert.equal(ev.toolUseId, 'toolu_A');
});

test('adapter: PostToolUse(Agent) emits no event, and with a links map it records agent_ref -> tool_use_id', () => {
  const links = new Map();
  assert.equal(convertHookRecord(post(2, 'toolu_A', 'agA', 'async_launched'), links), null, 'no log line for PostToolUse');
  assert.equal(links.get('agA'), 'toolu_A');
});

test('adapter: async run: SubagentStop after PostToolUse carries the id (exact)', () => {
  const links = new Map();
  convertHookRecord(post(2, 'toolu_A', 'agA', 'async_launched'), links);
  const stop = convertHookRecord({ ts: T(9), event: 'SubagentStop', agent_type: 'app-dev', agent_id: 'agA', last_message: 'done' }, links);
  assert.equal(stop.status, 'COMPLETED');
  assert.equal(stop.toolUseId, 'toolu_A');
});

test('adapter: sync run (no link yet at the stop) and records without a links map carry no id (FIFO fallback)', () => {
  const links = new Map();
  const stop = convertHookRecord({ ts: T(9), event: 'SubagentStop', agent_type: 'app-dev', agent_id: 'agB', last_message: 'x' }, links);
  assert.equal(stop.status, 'COMPLETED');
  assert.equal('toolUseId' in stop, false, 'no id on the event: the store matches it by FIFO');
  // The same stop without a map: the adapter does not guess an id
  const noMap = convertHookRecord({ ts: T(9), event: 'SubagentStop', agent_type: 'app-dev', agent_id: 'agA' });
  assert.equal('toolUseId' in noMap, false);
});

test('adapter: PostToolUseFailure of an Agent call carries its tool_use_id as ERROR', () => {
  const ev = convertHookRecord({ ts: T(3), event: 'PostToolUseFailure', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: 'toolu_C' });
  assert.equal(ev.status, 'ERROR');
  assert.equal(ev.toolUseId, 'toolu_C');
});

test('adapter: a failure of a non-Agent tool makes no event at all (it was an ERROR without id before 2026-10-13)', () => {
  // Changed on purpose: with hooks on every tool, a failed Bash / Edit / Read is normal work, not a failed agent. The old test
  // only checked that this ERROR had no toolUseId; the ERROR itself is gone now (the failure is a red beam, see
  // test/workspace-activity.test.js).
  const ev = convertHookRecord({ ts: T(3), event: 'PostToolUseFailure', agent_type: 'app-dev', tool_name: 'Bash', tool_use_id: 'toolu_bash' });
  assert.equal(ev, null);
});

test('adapter: the link map is bounded (oldest links are dropped)', () => {
  const links = new Map();
  for (let i = 0; i < 1000; i++) convertHookRecord(post(1, `toolu_${i}`, `ag${i}`, 'async_launched'), links);
  assert.ok(links.size <= 500, `at most 500 links (got ${links.size})`);
  assert.equal(links.has('ag0'), false, 'the oldest link was dropped');
  assert.equal(links.get('ag999'), 'toolu_999', 'the newest link is kept');
});

test('validateEvent: a valid toolUseId is kept, a bad one is dropped (not an error)', () => {
  const base = { agent: 'app-dev', status: 'PROCESSING', message: 'm' };
  assert.equal(validateEvent({ ...base, toolUseId: 'toolu_OK' }).event.toolUseId, 'toolu_OK');
  assert.equal('toolUseId' in validateEvent({ ...base, toolUseId: '   ' }).event, false, 'blank id dropped');
  assert.equal('toolUseId' in validateEvent({ ...base, toolUseId: 42 }).event, false, 'non-string id dropped');
  assert.equal('toolUseId' in validateEvent({ ...base, toolUseId: 'x'.repeat(129) }).event, false, 'oversized id dropped');
  assert.equal('toolUseId' in validateEvent(base).event, false, 'no id is the normal case');
});

test('hub: ids reach the browser through the SSE replay (fixture in a temp folder)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-toolid-'));
  let hub = null;
  try {
    const o = tempWorkspaceOpts(dir);
    // Sync run order: Pre(B), Pre(A), Post(A, async) and stop(A) first, then stop(B) before Post(B, completed)
    const lines = [
      pre(1, 'toolu_A', 'app-dev', 'task A'),
      pre(2, 'toolu_B', 'app-dev', 'task B'),
      post(3, 'toolu_A', 'agA', 'async_launched'),
      { ts: T(4), event: 'SubagentStop', agent_type: 'app-dev', agent_id: 'agA', last_message: 'A done' },
      { ts: T(5), event: 'SubagentStop', agent_type: 'app-dev', agent_id: 'agB', last_message: 'B done' },
      post(6, 'toolu_B', 'agB', 'completed'),
      { ts: T(7), event: 'PostToolUseFailure', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: 'toolu_F' },
    ];
    fs.writeFileSync(o.eventsFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    hub = createWorkspaceHub({
      eventsFile: o.eventsFile,
      workspaceFile: o.workspaceEventsFile,
      commandsFile: o.commandsFile,
      uploadsDir: o.uploadsDir,
      secretaryQueueDir: o.secretaryQueueDir,
    });
    const chunks = [];
    const res = { write: (s) => chunks.push(s), on() {}, end() {} };   // end() is called by hub.close()
    hub.attach({ on() {} }, res);
    const events = chunks
      .filter((c) => c.startsWith('data: '))
      .map((c) => JSON.parse(c.slice('data: '.length)));

    const byMsg = (text) => events.find((e) => e.message.includes(text));
    assert.equal(byMsg('task A').toolUseId, 'toolu_A', 'PROCESSING A carries its id');
    assert.equal(byMsg('task B').toolUseId, 'toolu_B', 'PROCESSING B carries its id');
    assert.equal(byMsg('A done').toolUseId, 'toolu_A', 'async stop carries the id through agent_ref');
    // Changed in the stop-hold change: the sync stop is held and released WITH the id of the PostToolUse that follows it
    assert.equal(byMsg('B done').toolUseId, 'toolu_B', 'sync stop is held until its PostToolUse, then carries the id (exact)');
    assert.equal(byMsg('ล้มเหลว').toolUseId, 'toolu_F', 'failure of an Agent call carries its id');
  } finally {
    if (hub) hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
