'use strict';
/**
 * workspace-activity.test.js - server side of the activity effects: tool calls as their own live SSE channel.
 *   - convertToolActivity(): PreToolUse / PostToolUse / PostToolUseFailure -> phase start / end / error; the Agent tool and
 *     every other hook event give nothing; the agent is the agent TYPE (the main session when it has none)
 *   - attribution: agent_id of a record fired inside a sub-agent is mapped to the task id of its instance through the hub's
 *     agent_ref links, but ONLY a trusted link (exact PostToolUse(agent_ref) or the sole candidate), never a FIFO guess
 *   - the hub sends them as the named SSE event "activity", live only: not in the replay buffer, not a default `message`
 *     (so the log, the store and the pipeline never see them)
 *   - end to end over HTTP: a hook record appended to the events file reaches an SSE client as "event: activity"
 * Temp files only (test/helpers/temp-paths.js). Small injected timer intervals, no waiting for the production 700 ms / 2 s.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { isolateEnv, tempWorkspaceOpts } = require('./helpers/temp-paths');
isolateEnv();
const { createWorkspaceHub } = require('../lib/workspace');
const { convertToolActivity } = require('../lib/workspace-adapter');
const { createServer } = require('../server');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
}

const TS = '2026-10-13T10:00:00.000Z';
const FAST = { watchIntervalMs: 30, queueCheckMs: 60 };

// ---------- convertToolActivity (pure) ----------

test('convertToolActivity: Pre / Post / PostFailure of a normal tool are start / end / error with the tool name and call id', () => {
  const base = { ts: TS, agent_type: 'app-dev', tool_name: 'Read', tool_use_id: 'toolu_r1' };
  assert.deepEqual(convertToolActivity({ ...base, event: 'PreToolUse' }),
    { ts: TS, agent: 'app-dev', phase: 'start', tool: 'Read', callId: 'toolu_r1' });
  assert.equal(convertToolActivity({ ...base, event: 'PostToolUse' }).phase, 'end');
  assert.equal(convertToolActivity({ ...base, event: 'PostToolUseFailure' }).phase, 'error');
});

test('convertToolActivity: the Agent tool, other hook events and bad input give nothing', () => {
  const base = { ts: TS, agent_type: 'secretary', tool_use_id: 'toolu_x' };
  assert.equal(convertToolActivity({ ...base, event: 'PreToolUse', tool_name: 'Agent', subagent_type: 'app-dev' }), null, 'a delegation is a comet, not a tool beam');
  assert.equal(convertToolActivity({ ...base, event: 'PostToolUse', tool_name: 'Agent' }), null);
  for (const event of ['UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionStart', 'SessionEnd', 'StopFailure']) {
    assert.equal(convertToolActivity({ ...base, event, tool_name: 'Read' }), null, event);
  }
  assert.equal(convertToolActivity({ ...base, event: 'PreToolUse' }), null, 'no tool name');
  assert.equal(convertToolActivity({ ...base, event: 'PreToolUse', tool_name: '   ' }), null);
  assert.equal(convertToolActivity({ ...base, event: 'constructor', tool_name: 'Read' }), null, 'prototype keys are not events');
  assert.equal(convertToolActivity(null), null);
  assert.equal(convertToolActivity('x'), null);
});

test('convertToolActivity: the agent is the agent TYPE (alias names resolve), the main session when there is none', () => {
  const rec = { ts: TS, event: 'PreToolUse', tool_name: 'Bash' };
  assert.equal(convertToolActivity({ ...rec, agent_type: 'Dev-ไอ้เก่ง' }).agent, 'app-dev');
  assert.equal(convertToolActivity({ ...rec, agent_type: 'ป้าแจ๋ว' }).agent, 'secretary');
  assert.equal(convertToolActivity({ ...rec }).agent, 'secretary', 'no agent_type = the main session');
  assert.equal(convertToolActivity({ ...rec, agent_type: 'general-purpose' }).agent, 'general-purpose', 'an unregistered agent keeps its name');
});

test('convertToolActivity: the instance comes only from a resolver that knows the agent_id; ids and names are bounded', () => {
  const rec = { ts: TS, event: 'PreToolUse', agent_type: 'qa-reviewer', tool_name: 'Grep', tool_use_id: 'c1', agent_id: 'aQ' };
  assert.equal(convertToolActivity(rec).instance, undefined, 'no resolver: planet level');
  assert.equal(convertToolActivity(rec, () => undefined).instance, undefined, 'unknown agent_id: planet level');
  assert.equal(convertToolActivity(rec, (ref) => (ref === 'aQ' ? 'toolu_Q' : undefined)).instance, 'toolu_Q');
  assert.equal(convertToolActivity({ ...rec, agent_id: undefined }, () => 'toolu_Q').instance, undefined, 'a main-session record has no agent_id');
  assert.equal(convertToolActivity({ ...rec, tool_use_id: 'x'.repeat(200) }).callId, undefined, 'an over-long call id is dropped, not cut');
  assert.equal(convertToolActivity({ ...rec, tool_name: 'T'.repeat(200) }).tool.length <= 60, true);
  assert.ok(!Number.isNaN(Date.parse(convertToolActivity({ ...rec, ts: 'garbage' }).ts)), 'a bad ts becomes the receive time');
});

// ---------- the hub ----------

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-activity-'));
  return { dir, opts: tempWorkspaceOpts(dir) };
}

/** A hub with a fake SSE client that keeps every raw chunk written to it. */
function openHub(opts) {
  const hub = createWorkspaceHub({
    eventsFile: opts.eventsFile,
    workspaceFile: opts.workspaceEventsFile,
    commandsFile: opts.commandsFile,
    uploadsDir: opts.uploadsDir,
    secretaryQueueDir: opts.secretaryQueueDir,
    timing: FAST,
  });
  const chunks = [];
  const client = { write: (s) => chunks.push(s), on() {}, end() {} };
  hub.attach({ on() {} }, client);
  const activities = () => chunks.filter((c) => c.startsWith('event: activity\n'))
    .map((c) => JSON.parse(c.split('\n')[1].slice('data: '.length)));
  const messages = () => chunks.filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice('data: '.length)));
  return { hub, chunks, activities, messages, client };
}

/** Append hook records (with a ts) to the events file. */
function append(opts, ...records) {
  fs.appendFileSync(opts.eventsFile, records.map((r) => `${JSON.stringify({ ts: TS, session_id: 's1', ...r })}\n`).join(''));
}

const agentPre = (id, sub) => ({ event: 'PreToolUse', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, subagent_type: sub, description: `task ${id}` });
const agentStart = (ref, type) => ({ event: 'SubagentStart', agent_type: type, agent_id: ref });
const agentPost = (id, sub, ref) => ({ event: 'PostToolUse', agent_type: 'secretary', tool_name: 'Agent', tool_use_id: id, subagent_type: sub, agent_ref: ref, response_status: 'async_launched' });
const toolPre = (type, ref, tool, id) => ({ event: 'PreToolUse', agent_type: type, ...(ref ? { agent_id: ref } : {}), tool_name: tool, tool_use_id: id });

test('hub: a tool call is sent as the named SSE event "activity" with the exact wire format, and never as a default message', async () => {
  const { dir, opts } = makeEnv();
  let ctx = null;
  try {
    fs.writeFileSync(opts.eventsFile, '');
    ctx = openHub(opts);
    append(opts, toolPre('secretary', null, 'Bash', 'toolu_b1'));
    assert.ok(await waitFor(() => ctx.activities().length === 1), 'the activity arrived');
    const chunk = ctx.chunks.find((c) => c.startsWith('event: activity'));
    assert.match(chunk, /^event: activity\ndata: \{.*\}\n\n$/, 'named event, one JSON line, blank line');
    assert.deepEqual(ctx.activities()[0], { ts: TS, agent: 'secretary', phase: 'start', tool: 'Bash', callId: 'toolu_b1' });
    // The same record still produces its usual workspace event (the log line) on the default channel, unchanged
    assert.deepEqual(ctx.messages().map((m) => m.message), ['ใช้เครื่องมือ Bash']);
  } finally {
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub attribution: an exact PostToolUse(agent_ref) link gives the instance (the task id of the Agent call)', async () => {
  const { dir, opts } = makeEnv();
  let ctx = null;
  try {
    fs.writeFileSync(opts.eventsFile, '');
    ctx = openHub(opts);
    append(opts, agentPre('toolu_A', 'app-dev'), agentStart('aA', 'app-dev'), agentPost('toolu_A', 'app-dev', 'aA'),
      toolPre('app-dev', 'aA', 'Edit', 'c1'),
      { event: 'PostToolUse', agent_type: 'app-dev', agent_id: 'aA', tool_name: 'Edit', tool_use_id: 'c1' });
    assert.ok(await waitFor(() => ctx.activities().length === 2));
    const [start, end] = ctx.activities();
    assert.equal(start.phase, 'start');
    assert.equal(start.agent, 'app-dev');
    assert.equal(start.instance, 'toolu_A', 'the call is attributed to its instance');
    assert.equal(end.phase, 'end');
    assert.equal(end.instance, 'toolu_A');
    assert.equal(ctx.activities().some((a) => a.tool === 'Agent'), false, 'the Agent calls themselves are not activity');
  } finally {
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub attribution: the sole candidate (a sync run: no PostToolUse yet) is trusted', async () => {
  const { dir, opts } = makeEnv();
  let ctx = null;
  try {
    fs.writeFileSync(opts.eventsFile, '');
    ctx = openHub(opts);
    append(opts, agentPre('toolu_S', 'qa-reviewer'), agentStart('aS', 'qa-reviewer'), toolPre('qa-reviewer', 'aS', 'Grep', 'c1'));
    assert.ok(await waitFor(() => ctx.activities().length === 1));
    assert.equal(ctx.activities()[0].instance, 'toolu_S');
  } finally {
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub attribution: a FIFO GUESS (parallel starts of one type) is not used: planet level until the exact link arrives', async () => {
  const { dir, opts } = makeEnv();
  let ctx = null;
  try {
    fs.writeFileSync(opts.eventsFile, '');
    ctx = openHub(opts);
    // Two Agent calls of the same type, then two starts: the start order may differ from the call order = ambiguous binding
    append(opts, agentPre('toolu_A', 'app-dev'), agentPre('toolu_B', 'app-dev'),
      agentStart('aA', 'app-dev'), agentStart('aB', 'app-dev'),
      toolPre('app-dev', 'aA', 'Read', 'c1'), toolPre('app-dev', 'aB', 'Read', 'c2'));
    assert.ok(await waitFor(() => ctx.activities().length === 2));
    assert.deepEqual(ctx.activities().map((a) => a.instance), [undefined, undefined], 'a guess could put the beam on the wrong moon');
    assert.deepEqual(ctx.activities().map((a) => a.agent), ['app-dev', 'app-dev'], 'the planet is still known');

    // The exact link arrives: from now on the instance is known
    append(opts, agentPost('toolu_A', 'app-dev', 'aA'), agentPost('toolu_B', 'app-dev', 'aB'),
      toolPre('app-dev', 'aA', 'Edit', 'c3'), toolPre('app-dev', 'aB', 'Bash', 'c4'));
    assert.ok(await waitFor(() => ctx.activities().length === 4));
    assert.deepEqual(ctx.activities().slice(2).map((a) => a.instance), ['toolu_A', 'toolu_B']);
  } finally {
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub attribution: main-session calls (no agent_id) and a sub-agent with an unknown agent_id stay at agent level', async () => {
  const { dir, opts } = makeEnv();
  let ctx = null;
  try {
    fs.writeFileSync(opts.eventsFile, '');
    ctx = openHub(opts);
    append(opts, toolPre('secretary', null, 'Read', 'c1'), toolPre('app-dev', 'never-started', 'Edit', 'c2'), toolPre('app-dev', null, 'Bash', 'c3'));
    assert.ok(await waitFor(() => ctx.activities().length === 3));
    assert.deepEqual(ctx.activities().map((a) => [a.agent, a.instance]), [['secretary', undefined], ['app-dev', undefined], ['app-dev', undefined]]);
  } finally {
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub: activity is live only. It is not in the replay buffer, so a client that connects later gets none of it', async () => {
  const { dir, opts } = makeEnv();
  let ctx = null;
  try {
    fs.writeFileSync(opts.eventsFile, '');
    ctx = openHub(opts);
    append(opts, { event: 'UserPromptSubmit', agent_type: 'secretary' }, toolPre('secretary', null, 'Read', 'c1'));
    assert.ok(await waitFor(() => ctx.activities().length === 1 && ctx.messages().length >= 2));

    const late = [];
    ctx.hub.attach({ on() {} }, { write: (s) => late.push(s), on() {}, end() {} });
    assert.ok(late.some((c) => c.startsWith('data: ')), 'the normal history is replayed');
    assert.equal(late.some((c) => c.startsWith('event: activity')), false, 'the activity channel is not replayed');
  } finally {
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub: history read at startup is not broadcast to anybody, and many tool calls do not push real events out of the replay buffer', async () => {
  const { dir, opts } = makeEnv();
  let ctx = null;
  try {
    // 500 old tool calls plus one real event already in the file when the hub starts
    const lines = [JSON.stringify({ ts: TS, event: 'UserPromptSubmit', session_id: 's1', agent_type: 'secretary' })];
    for (let i = 0; i < 250; i++) {
      lines.push(JSON.stringify({ ts: TS, event: 'PreToolUse', session_id: 's1', agent_type: 'secretary', tool_name: 'Read', tool_use_id: `p${i}` }));
      lines.push(JSON.stringify({ ts: TS, event: 'PostToolUse', session_id: 's1', agent_type: 'secretary', tool_name: 'Read', tool_use_id: `p${i}` }));
    }
    fs.writeFileSync(opts.eventsFile, `${lines.join('\n')}\n`);
    ctx = openHub(opts);   // the client attaches AFTER the startup poll: nothing live yet
    assert.equal(ctx.activities().length, 0, 'startup history is not sent as activity');
    assert.ok(ctx.messages().some((m) => m.message === 'รับคำสั่งงานจากผู้ใช้แล้ว'), 'the real event is still replayed');
  } finally {
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub: a client whose write throws is dropped from the activity channel (no crash, the other client still gets it)', async () => {
  const { dir, opts } = makeEnv();
  let ctx = null;
  try {
    fs.writeFileSync(opts.eventsFile, '');
    ctx = openHub(opts);
    let ended = false;
    ctx.hub.attach({ on() {} }, { write: (s) => { if (s.startsWith('event: activity')) throw new Error('socket closed'); }, on() {}, end() { ended = true; } });
    append(opts, toolPre('secretary', null, 'Read', 'c1'));
    assert.ok(await waitFor(() => ctx.activities().length === 1));
    assert.equal(ended, true, 'the dead client was ended');
    append(opts, toolPre('secretary', null, 'Grep', 'c2'));
    assert.ok(await waitFor(() => ctx.activities().length === 2), 'the live client keeps receiving');
  } finally {
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- over HTTP ----------

test('HTTP: GET /api/events delivers a hook tool call as "event: activity" (default messages are not mixed with it)', async () => {
  const { dir, opts } = makeEnv();
  fs.writeFileSync(opts.eventsFile, '');
  const server = createServer({ ...opts, timing: FAST });
  let req = null;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    let body = '';
    await new Promise((resolve, reject) => {
      req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/event-stream/);
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        resolve();
      });
      req.on('error', reject);
    });
    append(opts, toolPre('qa-reviewer', null, 'WebFetch', 'toolu_w'));
    assert.ok(await waitFor(() => body.includes('event: activity')), 'the activity reached the HTTP client');
    const block = body.split('\n\n').find((b) => b.startsWith('event: activity'));
    const data = JSON.parse(block.split('\n')[1].slice('data: '.length));
    assert.equal(data.tool, 'WebFetch');
    assert.equal(data.agent, 'qa-reviewer');
    assert.equal(data.phase, 'start');
  } finally {
    if (req) req.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP: the two new stellar modules are served as JavaScript with the CSP header', async () => {
  const { dir, opts } = makeEnv();
  fs.writeFileSync(opts.eventsFile, '');
  const server = createServer({ ...opts, timing: FAST });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    for (const url of ['/workspace/stellar/activity.js', '/workspace/stellar/effects.js']) {
      const res = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: url }, (r) => {
          r.resume();
          r.on('end', () => resolve(r));
        }).on('error', reject);
      });
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers['content-type'], /^text\/javascript/, url);
      assert.ok(res.headers['content-security-policy'], `${url} has the CSP header`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
