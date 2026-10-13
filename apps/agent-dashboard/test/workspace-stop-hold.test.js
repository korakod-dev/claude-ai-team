'use strict';
/**
 * workspace-stop-hold.test.js - the hub holds a SubagentStop of a SYNC run until its PostToolUse id arrives
 * (lib/workspace.js + lib/stop-hold.js). Uses a fake clock (test/helpers/fake-clock.js) and temp files only.
 *   - live: the stop is held, the PostToolUse releases it with the exact id
 *   - live: other events are not held and keep their order; the held stop comes out at its own release
 *   - live: no PostToolUse in time -> released without an id after exactly TOOL_USE_WAIT_MS
 *   - replay (one batch from the file): exact where the data allows, approximate only when the wait ended
 *   - a file reset and hub.close() cancel the held stops and their timers
 *   - async runs, the main persona stop and a stop without agent_id are not held
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isolateEnv, tempWorkspaceOpts } = require('./helpers/temp-paths');
isolateEnv();
const { createWorkspaceHub, TOOL_USE_WAIT_MS } = require('../lib/workspace');
const { fakeClock } = require('./helpers/fake-clock');

// Record time: T(s) = 10:00:ss UTC on 2026-10-12. The fake clock is moved to the same epoch in makeHub().
const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const T = (s) => new Date(T0 + s * 1000).toISOString();

const pre = (s, id, sub, desc) => ({
  ts: T(s), event: 'PreToolUse', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, subagent_type: sub, description: desc,
});
const post = (s, id, ref) => ({
  ts: T(s), event: 'PostToolUse', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, agent_ref: ref, response_status: 'completed',
});
const stop = (s, ref, agentType, msg) => ({
  ts: T(s), event: 'SubagentStop', agent_type: agentType || 'app-dev', agent_id: ref, last_message: msg,
});

/**
 * A hub on temp files with a fake clock. The fake time starts at T0 (the record epoch), and one client is attached,
 * so live events are collected in `messages()` in the order they were written to the SSE stream.
 */
function makeHub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-stophold-'));
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
  return { hub, o, clock, events, append, cleanup, dir };
}

test('the wait constant is 8 s and exported (named constant, see lib/workspace.js)', () => {
  assert.equal(TOOL_USE_WAIT_MS, 8000);
});

test('live: a sync stop is held, then released WITH the id of the PostToolUse that follows', () => {
  const h = makeHub();
  try {
    h.append(pre(1, 'toolu_A', 'app-dev', 'task A'));
    h.hub.poll();
    assert.equal(h.events().length, 1, 'the PROCESSING of task A');

    h.append(stop(2, 'agA', 'app-dev', 'A done'));
    h.hub.poll();
    assert.equal(h.events().length, 1, 'the stop is held, not sent yet');
    assert.equal(h.clock.pending(), 1, 'one timer for the held stop');

    h.append(post(3, 'toolu_A', 'agA'));
    h.hub.poll();
    const done = h.events().find((e) => e.message === 'A done');
    assert.ok(done, 'the stop is sent once the PostToolUse arrived');
    assert.equal(done.toolUseId, 'toolu_A', 'released with the exact id');
    assert.equal(done.ts, T(2), 'the event keeps the time of the SubagentStop');
    assert.equal(h.clock.pending(), 0, 'its timer is cancelled');
  } finally {
    h.cleanup();
  }
});

test('live: other events are not held and keep their order; the held stop is sent later', () => {
  const h = makeHub();
  try {
    h.append(stop(1, 'agA', 'app-dev', 'A done'));
    h.hub.poll();
    h.append(pre(2, 'toolu_B', 'qa-reviewer', 'task B'));
    h.hub.poll();
    h.append(pre(3, 'toolu_C', 'study-writer', 'task C'));
    h.hub.poll();
    const before = h.events().map((e) => e.message);
    assert.equal(before.length, 2, 'B and C went out at once');
    assert.ok(before[0].includes('task B') && before[1].includes('task C'), 'B then C, in file order');

    h.append(post(4, 'toolu_A', 'agA'));
    h.hub.poll();
    const all = h.events().map((e) => e.message);
    assert.equal(all.length, 3);
    assert.ok(all[2].includes('A done'), 'the held stop comes out last, when its id arrived');
    assert.equal(h.events()[2].toolUseId, 'toolu_A');
  } finally {
    h.cleanup();
  }
});

test('live: no PostToolUse in time -> released without an id after exactly TOOL_USE_WAIT_MS (approximate)', () => {
  const h = makeHub();
  try {
    h.append(stop(1, 'agX', 'app-dev', 'X done'));
    h.hub.poll();
    h.clock.advance(TOOL_USE_WAIT_MS - 1);
    assert.equal(h.events().length, 0, 'still held one millisecond before the wait ends');
    h.clock.advance(1);
    const late = h.events();
    assert.equal(late.length, 1, 'released at the end of the wait');
    assert.equal(late[0].message, 'X done');
    assert.equal('toolUseId' in late[0], false, 'no id: the browser matches it by FIFO and shows ~');
    assert.equal(h.clock.pending(), 0, 'no timer left');
  } finally {
    h.cleanup();
  }
});

test('replay (one batch from the file): exact pairing where the data allows, approximate only after the wait', () => {
  const h = makeHub();
  try {
    const lines = [
      pre(0, 'toolu_A', 'app-dev', 'task A'),
      pre(1, 'toolu_B', 'qa-reviewer', 'task B'),
      stop(2, 'agB', 'qa-reviewer', 'B done'),          // sync: its PostToolUse comes 2 s later -> exact
      post(4, 'toolu_B', 'agB'),
      stop(5, 'agC', 'study-writer', 'C done'),         // no PostToolUse at all -> approximate
      pre(20, 'toolu_D', 'portfolio-writer', 'task D'), // event time 20 s: the wait of C (due 13 s) has ended
      stop(21, 'agE', 'app-dev', 'E done'),             // PostToolUse 9 s later: longer than the wait -> approximate
      post(30, 'toolu_E', 'agE'),
    ];
    fs.writeFileSync(h.o.eventsFile, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    h.hub.poll();

    const evs = h.events();
    const at = (text) => evs.find((e) => e.message.includes(text));
    // Tag each sent message by the first marker it contains (the markers are unique in this fixture)
    const TAGS = ['task A', 'task B', 'B done', 'C done', 'task D', 'E done'];
    const tags = evs.map((e) => TAGS.find((t) => e.message.includes(t)) || e.message);
    assert.deepEqual(
      tags,
      ['task A', 'task B', 'B done', 'C done', 'task D', 'E done'],
      'file order is kept; the held stops come out where they are released',
    );
    assert.equal(at('B done').toolUseId, 'toolu_B', 'B: exact');
    assert.equal('toolUseId' in at('C done'), false, 'C: no id (approximate)');
    assert.equal('toolUseId' in at('E done'), false, 'E: no id, its PostToolUse came after the wait');
    assert.equal(h.clock.pending(), 0, 'no held stop and no timer left after the replay');
  } finally {
    h.cleanup();
  }
});

test('file reset (truncation) cancels the held stops and their timers', () => {
  const h = makeHub();
  try {
    h.append(stop(1, 'agR', 'app-dev', 'R done'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1);
    fs.writeFileSync(h.o.eventsFile, '');   // truncated: the held stop came from the old content
    h.hub.poll();
    assert.equal(h.clock.pending(), 0, 'the timer of the held stop is cancelled by the reset');
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.equal(h.events().length, 0, 'the stop from the old content is never sent');
  } finally {
    h.cleanup();
  }
});

test('hub.close() cancels every held stop timer and releases nothing', () => {
  const h = makeHub();
  try {
    h.append(stop(1, 'agZ', 'app-dev', 'Z done'));
    h.hub.poll();
    assert.equal(h.clock.pending(), 1);
    h.hub.close();
    assert.equal(h.clock.pending(), 0, 'no timer survives close()');
    h.clock.advance(TOOL_USE_WAIT_MS * 2);
    assert.equal(h.events().length, 0, 'nothing is sent after close()');
  } finally {
    h.cleanup();
  }
});

test('async run: the PostToolUse comes first, so the stop is not held and carries the id at once', () => {
  const h = makeHub();
  try {
    h.append(post(1, 'toolu_A', 'agA'));
    h.append(stop(2, 'agA', 'app-dev', 'A done'));
    h.hub.poll();
    const done = h.events().find((e) => e.message === 'A done');
    assert.equal(done.toolUseId, 'toolu_A');
    assert.equal(h.clock.pending(), 0, 'nothing was held');
  } finally {
    h.cleanup();
  }
});

test('the main persona stop is not held (it produces no event), and a stop without agent_id is sent at once', () => {
  const h = makeHub();
  try {
    h.append({ ts: T(1), event: 'SubagentStop', agent_type: 'secretary', agent_id: 'agMain', last_message: 'main' });
    h.append({ ts: T(2), event: 'SubagentStop', agent_type: 'app-dev', last_message: 'no id' });
    h.hub.poll();
    assert.equal(h.clock.pending(), 0, 'no timer: neither record was held');
    const msgs = h.events().map((e) => e.message);
    assert.deepEqual(msgs, ['no id'], 'the main stop is ignored; the stop without id goes out at once (FIFO as before)');
    assert.equal('toolUseId' in h.events()[0], false);
  } finally {
    h.cleanup();
  }
});
