'use strict';
/**
 * workspace.test.js - Multi-Agent Workspace tests:
 *   - unit: hook record -> workspace event mapping, event and command validation, file name safety
 *   - HTTP: /workspace static page, POST /api/events, GET /api/events (SSE), POST /api/command,
 *           hook records appended to events.jsonl are streamed, Host/Origin guards on POST.
 * Uses temporary files only (never data/): every test passes all five temp paths, and the guards in
 * test/helpers/temp-paths.js fail the test if a path points into data/. Listens on 127.0.0.1 only.
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
// Must run before ../server and ../lib/config are loaded: points the DASHBOARD_* env overrides at temp (LOW-3)
const { isolateEnv, tempWorkspaceOpts, assertTempPaths, assertConfigIsolated } = require('./helpers/temp-paths');
isolateEnv();
const { createServer } = require('../server');
const { convertHookRecord, validateEvent, resolveAgent, PIPELINE_STEPS } = require('../lib/workspace-adapter');
const { validateCommand, safeFileName, MAX_FILE_BYTES, createWorkspaceHub } = require('../lib/workspace');
const {
  forwardToSecretary, QUEUE_FORMAT, markDone, listPending, listApproved, approveItem, rejectItem, readQueueItem,
} = require('../lib/secretary-adapter');
const { spawnSync } = require('child_process');

const TS = '2026-10-11T07:00:00.000Z';

// ---------- unit: Secretary file queue (lib/secretary-adapter.js) ----------

test('forwardToSecretary writes one JSON queue file and no temp files are left behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-unit-'));
  try {
    const queueDir = path.join(dir, 'queue');
    const uploads = path.join(dir, 'uploads', 'cmd-1');
    const res = forwardToSecretary({
      id: 'cmd-1', timestamp: TS, text: 'สวัสดี', dir: uploads,
      files: [{ name: 'a.txt', storedAs: '01-a.txt', type: 'text/plain', size: 3 }],
    }, { queueDir });
    assert.deepEqual(res, { accepted: true, mode: 'queue', queued: 'cmd-1.json' });

    // Only the final file exists; the temp file was renamed away
    assert.deepEqual(fs.readdirSync(queueDir), ['cmd-1.json']);
    const record = JSON.parse(fs.readFileSync(path.join(queueDir, 'cmd-1.json'), 'utf8'));
    assert.equal(record.format, QUEUE_FORMAT);
    assert.equal(record.id, 'cmd-1');
    assert.equal(record.timestamp, TS);
    assert.equal(record.text, 'สวัสดี');
    // Attachments are referenced by path, never inlined as base64
    assert.deepEqual(record.attachments, [
      { name: 'a.txt', type: 'text/plain', size: 3, path: path.join(uploads, '01-a.txt') },
    ]);
    assert.equal(JSON.stringify(record).includes('base64'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('forwardToSecretary throws when the queue folder cannot be created (no partial file)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-unit-'));
  try {
    // A regular file where the queue folder should be: mkdir must fail
    const blocker = path.join(dir, 'queue');
    fs.writeFileSync(blocker, 'x');
    assert.throws(() => forwardToSecretary({
      id: 'cmd-2', timestamp: TS, text: 'x', dir, files: [],
    }, { queueDir: blocker }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markDone moves the queue file to done/, so listPending never returns it again after a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-done-'));
  try {
    const queueDir = path.join(dir, 'queue');
    for (const id of ['cmd-1', 'cmd-2']) {
      forwardToSecretary({ id, timestamp: TS, text: id, dir: path.join(dir, 'uploads', id), files: [] }, { queueDir });
    }
    assert.deepEqual(listPending(queueDir), ['cmd-1', 'cmd-2']);

    // markDone needs an approved item (v2 rule): approve first
    approveItem('cmd-1', { queueDir });
    const res = markDone('cmd-1', { queueDir });
    assert.equal(res.alreadyDone, false);
    assert.deepEqual(fs.readdirSync(path.join(queueDir, 'done')), ['cmd-1.json']);
    // "Restart": a new consumer lists the folder again and must not see cmd-1
    assert.deepEqual(listPending(queueDir), ['cmd-2']);
    assert.deepEqual(listApproved(queueDir), []);
    // Defense in depth: a copy put back at the top level is still not open (its status is "done")
    fs.copyFileSync(path.join(queueDir, 'done', 'cmd-1.json'), path.join(queueDir, 'cmd-1.json'));
    assert.deepEqual(listPending(queueDir), ['cmd-2']);
    assert.deepEqual(listApproved(queueDir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markDone is idempotent and rejects unknown or unsafe ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-done-'));
  try {
    const queueDir = path.join(dir, 'queue');
    forwardToSecretary({ id: 'cmd-1', timestamp: TS, text: 'x', dir, files: [] }, { queueDir });
    // A pending_approval item cannot be marked done (409 on the route, ENOT_APPROVED here)
    assert.throws(() => markDone('cmd-1', { queueDir }), { code: 'ENOT_APPROVED', status: 'pending_approval' });
    approveItem('cmd-1', { queueDir });
    markDone('cmd-1', { queueDir });
    assert.equal(markDone('cmd-1', { queueDir }).alreadyDone, true);
    assert.throws(() => markDone('cmd-9', { queueDir }), { code: 'ENOENT_QUEUE' });
    assert.throws(() => markDone('../cmd-1', { queueDir }), { code: 'EINVAL_ID' });
    assert.throws(() => markDone('.hidden', { queueDir }), { code: 'EINVAL_ID' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listPending ignores temp files, other files, and the done folder; a missing folder gives []', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-list-'));
  try {
    const queueDir = path.join(dir, 'queue');
    forwardToSecretary({ id: 'cmd-1', timestamp: TS, text: 'x', dir, files: [] }, { queueDir });
    fs.writeFileSync(path.join(queueDir, '.cmd-3.abcd.tmp'), '{}');
    fs.writeFileSync(path.join(queueDir, 'notes.txt'), 'x');
    assert.deepEqual(listPending(queueDir), ['cmd-1']);
    assert.deepEqual(listPending(path.join(dir, 'missing')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- unit: hook record -> workspace event ----------

test('handoff (PreToolUse Agent) makes the target agent PROCESSING on its pipeline node', () => {
  const ev = convertHookRecord({
    ts: TS, event: 'PreToolUse', agent_type: 'เลขาคนสวย', tool_name: 'Agent',
    subagent_type: 'Dev-ไอ้เก่ง', description: 'Build UI',
  });
  assert.equal(ev.agent, 'app-dev');
  assert.equal(ev.pipelineStep, 'appdev');
  assert.equal(ev.status, 'PROCESSING');
  assert.match(ev.message, /Build UI/);
  assert.equal(ev.ts, TS);
});

test('main persona (เลขาคนสวย) Stop maps to the router node COMPLETED with last_message', () => {
  const ev = convertHookRecord({ ts: TS, event: 'Stop', agent_type: 'เลขาคนสวย', last_message: 'เสร็จแล้วครับ' });
  assert.equal(ev.agent, 'secretary');
  assert.equal(ev.pipelineStep, 'router');
  assert.equal(ev.status, 'COMPLETED');
  assert.equal(ev.message, 'เสร็จแล้วครับ');
});

test('last_message Markdown markers are removed for the log', () => {
  const ev = convertHookRecord({ ts: TS, event: 'Stop', agent_type: 'เลขาคนสวย', last_message: '## สรุป\nส่งให้ **QA-คุณละเอียด** แล้ว `apps/`' });
  assert.equal(ev.message, 'สรุป ส่งให้ QA-คุณละเอียด แล้ว apps/');
});

test('SubagentStop maps to COMPLETED for the reviewer node', () => {
  const ev = convertHookRecord({ ts: TS, event: 'SubagentStop', agent_type: 'qa-reviewer', last_message: 'ตรวจเสร็จ 3 จุด' });
  assert.equal(ev.agent, 'qa-reviewer');
  assert.equal(ev.pipelineStep, 'qa');
  assert.equal(ev.status, 'COMPLETED');
});

test('PostToolUseFailure of an Agent call maps to ERROR; a failed ordinary tool maps to nothing; other tools map to WORKING', () => {
  // Changed on purpose (2026-10-13, owner decision). This test used to assert that ANY PostToolUseFailure (here: Bash) is an
  // ERROR. Once the hook matcher covers every tool, that rule would turn each non-zero Bash exit or Edit mismatch into a red
  // planet and a black hole, although the agent is fine. Now only a failed delegation (tool Agent) is an agent failure.
  const failed = convertHookRecord({ ts: TS, event: 'PostToolUseFailure', agent_type: 'secretary', tool_name: 'Agent' });
  assert.equal(failed.status, 'ERROR');
  assert.equal(failed.pipelineStep, 'router');
  assert.equal(convertHookRecord({ ts: TS, event: 'PostToolUseFailure', agent_type: 'secretary', tool_name: 'Bash' }), null,
    'a failed Bash call changes no status (it is a red beam, see convertToolActivity)');
  const tool = convertHookRecord({ ts: TS, event: 'PreToolUse', agent_type: 'app-dev', tool_name: 'Edit' });
  assert.equal(tool.status, 'WORKING');
  assert.equal(tool.message, 'ใช้เครื่องมือ Edit');
});

test('hook events that are not shown in the log return null', () => {
  assert.equal(convertHookRecord({ ts: TS, event: 'SessionStart', agent_type: 'secretary' }), null);
  assert.equal(convertHookRecord({ ts: TS, event: 'PostToolUse', agent_type: 'secretary' }), null);
  assert.equal(convertHookRecord(null), null);
});

test('unknown agent types are kept as-is without a pipeline step', () => {
  const ev = convertHookRecord({ ts: TS, event: 'SubagentStart', agent_type: 'general-purpose' });
  assert.equal(ev.agent, 'general-purpose');
  assert.equal(ev.pipelineStep, undefined);
});

test('main persona PreToolUse is logged but does not move the User node to WORKING (no pipelineStep)', () => {
  const ev = convertHookRecord({ ts: TS, event: 'PreToolUse', agent_type: 'เลขาคนสวย', tool_name: 'Read' });
  assert.equal(ev.status, 'WORKING');
  assert.equal(ev.message, 'ใช้เครื่องมือ Read');
  assert.equal(ev.pipelineStep, undefined);
  // Same rule when the hook record has no agent_type (treated as the main session)
  const noType = convertHookRecord({ ts: TS, event: 'PreToolUse', tool_name: 'Bash' });
  assert.equal(noType.pipelineStep, undefined);
});

test('subagent PreToolUse still drives its own pipeline node (only the main persona is changed)', () => {
  const ev = convertHookRecord({ ts: TS, event: 'PreToolUse', agent_type: 'Dev-ไอ้เก่ง', tool_name: 'Edit' });
  assert.equal(ev.pipelineStep, 'appdev');
});

test('main persona SubagentStop does not mark the User node COMPLETED while work is still running', () => {
  assert.equal(convertHookRecord({ ts: TS, event: 'SubagentStop', agent_type: 'เลขาคนสวย', last_message: 'x' }), null);
  assert.equal(convertHookRecord({ ts: TS, event: 'SubagentStop', last_message: 'x' }), null);
});

// ---------- unit: event validation ----------

test('validateEvent accepts a Thai alias, normalizes status, and fills pipelineStep', () => {
  const { event } = validateEvent({ agent: 'QA-คุณละเอียด', status: 'working', message: 'กำลังตรวจ' });
  assert.equal(event.agent, 'qa-reviewer');
  assert.equal(event.pipelineStep, 'qa');
  assert.equal(event.status, 'WORKING');
  assert.ok(!Number.isNaN(Date.parse(event.ts)), 'ts is filled when missing');
});

test('validateEvent rejects bad input with a readable error', () => {
  assert.match(validateEvent([]).error, /JSON object/);
  assert.match(validateEvent({ agent: 'x', status: 'DONE', message: 'm' }).error, /status must be/);
  assert.match(validateEvent({ agent: '', status: 'IDLE', message: 'm' }).error, /agent is required/);
  assert.match(validateEvent({ agent: 'x', status: 'IDLE' }).error, /message must be a string/);
  assert.match(validateEvent({ agent: 'x', status: 'IDLE', message: 'm', ts: 'not-a-date' }).error, /ts must be/);
  assert.match(validateEvent({ agent: 'x', status: 'IDLE', message: 'm', pipelineStep: 'db' }).error, /pipelineStep must be/);
});

test('validateEvent truncates long messages to 500 characters', () => {
  const { event } = validateEvent({ agent: 'x', status: 'IDLE', message: 'a'.repeat(900) });
  assert.equal(event.message.length, 500);
  assert.ok(event.message.endsWith('…'));
});

test('resolveAgent keeps the English id and the Thai name on the same agent', () => {
  assert.equal(resolveAgent('secretary').id, resolveAgent('เลขา').id);
  assert.equal(resolveAgent('Writer-ยัยแว่นหนา').id, 'study-writer');
  assert.equal(resolveAgent('   '), null);
});

test('เลขาคนสวย is the router (entry) step, not the user node', () => {
  assert.deepEqual(resolveAgent('เลขาคนสวย'), { id: 'secretary', step: 'router' });
  assert.deepEqual(resolveAgent('secretary'), { id: 'secretary', step: 'router' });
});

test('every team position has its own pipeline node (pm, study and portfolio included)', () => {
  assert.deepEqual(PIPELINE_STEPS, ['user', 'router', 'pm', 'appdev', 'qa', 'study', 'portfolio']);
  assert.equal(resolveAgent('Writer-ยัยแว่นหนา').step, 'study');
  assert.equal(resolveAgent('Content Director').step, 'portfolio');
  const ev = validateEvent({ agent: 'portfolio-writer', status: 'WORKING', message: 'กำลังเขียน' }).event;
  assert.equal(ev.pipelineStep, 'portfolio');
});

test('PM-Professor-X (planner): the sub-agent name "PM-Professor-X" resolves to the pm agent and the pm pipeline node, in every spelling', () => {
  // Claude Code reports the sub-agent type as the frontmatter name of .claude/agents/pm.md: "PM-Professor-X"
  for (const raw of ['PM-Professor-X', 'pm', 'Pm', ' PM-Professor-X ']) {
    assert.deepEqual(resolveAgent(raw), { id: 'pm', step: 'pm' }, JSON.stringify(raw));
  }
  // POST /api/events style event
  const posted = validateEvent({ agent: 'PM-Professor-X', status: 'WORKING', message: 'planning' }).event;
  assert.equal(posted.agent, 'pm');
  assert.equal(posted.pipelineStep, 'pm');
  // Hook records: the secretary dispatches PM-Professor-X (PreToolUse Agent, subagent_type "PM-Professor-X"), PM-Professor-X's own events carry agent_type "PM-Professor-X"
  const start = convertHookRecord({ ts: TS, event: 'PreToolUse', agent_type: 'เลขาคนสวย', tool_name: 'Agent', subagent_type: 'PM-Professor-X', description: 'plan the feature' });
  assert.equal(start.agent, 'pm');
  assert.equal(start.pipelineStep, 'pm');
  assert.equal(start.status, 'PROCESSING');
  const stop = convertHookRecord({ ts: TS, event: 'SubagentStop', agent_type: 'PM-Professor-X', last_message: 'plan ready' });
  assert.equal(stop.agent, 'pm');
  assert.equal(stop.pipelineStep, 'pm');
  assert.equal(stop.status, 'COMPLETED');
  const failed = convertHookRecord({ ts: TS, event: 'PostToolUseFailure', agent_type: 'เลขาคนสวย', tool_name: 'Agent', subagent_type: 'PM-Professor-X', error: 'boom' });
  assert.equal(failed.agent, 'pm', 'a failed PM-Professor-X dispatch is attributed to PM-Professor-X, not to the secretary');
  assert.equal(failed.status, 'ERROR');
  // The old team members are unchanged
  assert.deepEqual(resolveAgent('Dev-ไอ้เก่ง'), { id: 'app-dev', step: 'appdev' });
});

test('handoff to study-writer and portfolio-writer drives their own nodes', () => {
  const study = convertHookRecord({ ts: TS, event: 'PreToolUse', agent_type: 'เลขาคนสวย', tool_name: 'Agent', subagent_type: 'Writer-ยัยแว่นหนา', description: 'สรุปบท' });
  assert.equal(study.pipelineStep, 'study');
  const portfolio = convertHookRecord({ ts: TS, event: 'PreToolUse', agent_type: 'เลขาคนสวย', tool_name: 'Agent', subagent_type: 'portfolio-writer', description: 'หน้า project' });
  assert.equal(portfolio.pipelineStep, 'portfolio');
});

test('UserPromptSubmit enters through the router node (เลขาคนสวย PROCESSING)', () => {
  const ev = convertHookRecord({ ts: TS, event: 'UserPromptSubmit' });
  assert.equal(ev.agent, 'secretary');
  assert.equal(ev.pipelineStep, 'router');
  assert.equal(ev.status, 'PROCESSING');
});

// ---------- unit: command validation and file names ----------

test('validateCommand accepts text only and rejects an empty command', () => {
  const ok = validateCommand({ text: '  สวัสดี  ' });
  assert.equal(ok.value.text, 'สวัสดี');
  assert.deepEqual(ok.value.files, []);
  assert.match(validateCommand({ text: '   ' }).error, /text or at least one file/);
});

test('validateCommand rejects bad base64, too many files, and oversized files', () => {
  const b64 = Buffer.from('hi').toString('base64');
  assert.match(validateCommand({ text: 'x', files: [{ name: 'a.txt', data: '%%%' }] }).error, /base64/);
  const many = Array.from({ length: 11 }, () => ({ name: 'a.txt', data: b64 }));
  assert.match(validateCommand({ text: 'x', files: many }).error, /at most 10 files/);
  const big = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
  assert.match(validateCommand({ text: 'x', files: [{ name: 'big.bin', data: big }] }).error, /larger than 5 MB/);
});

test('safeFileName strips path parts, removes unsafe characters, and keeps Thai letters', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('..\\..\\evil.sh'), 'evil.sh');
  assert.equal(safeFileName('a<b>c?.txt'), 'a_b_c_.txt');
  assert.equal(safeFileName('รายงาน ทดสอบ 1.pdf'), 'รายงาน ทดสอบ 1.pdf');
  assert.equal(safeFileName('...'), 'file');
});

// ---------- HTTP helpers ----------

// Fixed token for every test server. request() sends it by default (Authorization: Bearer ...), so the
// many POST tests need no extra header. A test that wants NO header passes { Authorization: undefined }.
const TEST_TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

/**
 * Start the server on a random port with temp files for every workspace path.
 * @param {object} [overrides]  extra createServer options (e.g. a broken secretaryQueueDir)
 */
async function startServer(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-test-'));
  const opts = {
    ...tempWorkspaceOpts(dir), // all five paths, temp only (checked)
    workspaceToken: TEST_TOKEN, // fixed token, so the tests do not depend on the WORKSPACE_TOKEN env var
    ...overrides,
  };
  assertTempPaths(opts); // also checks the overrides
  fs.writeFileSync(opts.eventsFile, '');
  const server = createServer(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    port: server.address().port,
    opts,
    cleanup: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Send a request. A non-string body is sent as JSON with a JSON Content-Type. */
function request(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const isJson = body !== undefined && typeof body !== 'string';
    const data = body === undefined ? undefined : (isJson ? JSON.stringify(body) : body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      // Default auth header; a caller overrides it or removes it with { Authorization: undefined }
      headers: Object.fromEntries(Object.entries({
        ...(data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        Authorization: `Bearer ${TEST_TOKEN}`,
        ...headers,
      }).filter(([, value]) => value !== undefined)),
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

/**
 * Open GET /api/events and collect every parsed SSE message in `events`.
 * waitFor(predicate) resolves with the first matching event or rejects after `ms`.
 */
function openEvents(port) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx = buf.indexOf('\n\n');
        while (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
          }
          idx = buf.indexOf('\n\n');
        }
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        events,
        waitFor(predicate, ms = 5000) {
          return new Promise((done, fail) => {
            const started = Date.now();
            const timer = setInterval(() => {
              const found = events.find(predicate);
              if (found) {
                clearInterval(timer);
                done(found);
              } else if (Date.now() - started > ms) {
                clearInterval(timer);
                fail(new Error('timeout waiting for SSE event'));
              }
            }, 50);
          });
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
  });
}

// ---------- HTTP tests ----------

test('GET / serves the workspace page and its assets', async () => {
  const ctx = await startServer();
  try {
    const page = await request(ctx.port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /MULTI-AGENT WORKSPACE/);
  } finally {
    await ctx.cleanup();
  }
});

test('GET /workspace serves the page and its assets', async () => {
  const ctx = await startServer();
  try {
    const page = await request(ctx.port, 'GET', '/workspace');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /MULTI-AGENT WORKSPACE/);
    assert.match(page.body, /สายงานและการทำงาน/); // pipeline panel is still on the page
    assert.match(page.body, /Log การทำงานล่าสุด/); // live log panel is still on the page
    assert.equal((await request(ctx.port, 'GET', '/workspace/app.js')).status, 200);
    assert.equal((await request(ctx.port, 'GET', '/workspace/style.css')).status, 200);
    assert.equal((await request(ctx.port, 'GET', '/workspace/../server.js')).status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/events is delivered to an open SSE client', async () => {
  const ctx = await startServer();
  try {
    const sse = await openEvents(ctx.port);
    assert.equal(sse.status, 200);
    assert.match(sse.headers['content-type'], /text\/event-stream/);

    const res = await request(ctx.port, 'POST', '/api/events', {
      body: { agent: 'Dev-ไอ้เก่ง', status: 'working', message: 'ทดสอบ SSE' },
    });
    assert.equal(res.status, 201);

    const ev = await sse.waitFor((e) => e.message === 'ทดสอบ SSE');
    assert.equal(ev.agent, 'app-dev');
    assert.equal(ev.status, 'WORKING');
    assert.equal(ev.pipelineStep, 'appdev');
    sse.close();
  } finally {
    await ctx.cleanup();
  }
});

test('a new SSE client receives recent events right after connecting', async () => {
  const ctx = await startServer();
  try {
    await request(ctx.port, 'POST', '/api/events', { body: { agent: 'secretary', status: 'COMPLETED', message: 'ก่อนเชื่อมต่อ' } });
    const sse = await openEvents(ctx.port);
    const ev = await sse.waitFor((e) => e.message === 'ก่อนเชื่อมต่อ');
    assert.equal(ev.pipelineStep, 'router');
    sse.close();
  } finally {
    await ctx.cleanup();
  }
});

test('hook records appended to events.jsonl are streamed as converted workspace events', async () => {
  const ctx = await startServer();
  try {
    const sse = await openEvents(ctx.port);
    const record = { ts: new Date().toISOString(), event: 'SubagentStop', agent_type: 'qa-reviewer', last_message: 'ตรวจเสร็จแบบทดสอบ' };
    fs.appendFileSync(ctx.opts.eventsFile, `${JSON.stringify(record)}\n`);

    const ev = await sse.waitFor((e) => e.message === 'ตรวจเสร็จแบบทดสอบ', 6000);
    assert.equal(ev.agent, 'qa-reviewer');
    assert.equal(ev.status, 'COMPLETED');
    assert.equal(ev.pipelineStep, 'qa');
    sse.close();
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/events rejects bad JSON, wrong content type, and invalid events', async () => {
  const ctx = await startServer();
  try {
    const badJson = await request(ctx.port, 'POST', '/api/events', { body: '{not json' });
    assert.equal(badJson.status, 400);
    assert.match(badJson.body, /Invalid JSON/);

    const wrongType = await request(ctx.port, 'POST', '/api/events', {
      headers: { 'Content-Type': 'text/plain' },
      body: '{"agent":"x","status":"IDLE","message":"m"}',
    });
    assert.equal(wrongType.status, 415);

    const badStatus = await request(ctx.port, 'POST', '/api/events', {
      body: { agent: 'x', status: 'DONE', message: 'm' },
    });
    assert.equal(badStatus.status, 400);
    assert.match(badStatus.body, /status must be/);
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/command stores files, writes a command record, and emits pipeline events', async () => {
  const ctx = await startServer();
  try {
    const sse = await openEvents(ctx.port);
    const fileData = Buffer.from('console.log("hi")\n');
    const res = await request(ctx.port, 'POST', '/api/command', {
      body: {
        text: 'ทดสอบคำสั่งงาน',
        files: [{ name: '../secret/รายงาน.js', type: 'text/javascript', data: fileData.toString('base64') }],
      },
    });
    assert.equal(res.status, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.files, 1);
    assert.equal(body.forwarded.accepted, true);
    assert.equal(body.forwarded.mode, 'queue');

    // File saved inside uploads/<id>/ under a safe name (no path parts from the client)
    const stored = path.join(ctx.opts.uploadsDir, body.id, '01-รายงาน.js');
    assert.ok(fs.existsSync(stored), 'uploaded file exists');
    assert.deepEqual(fs.readFileSync(stored), fileData);

    // One queue file for the Secretary; it points to the uploaded file (outside the queue folder)
    const queued = JSON.parse(fs.readFileSync(path.join(ctx.opts.secretaryQueueDir, `${body.id}.json`), 'utf8'));
    assert.equal(queued.id, body.id);
    assert.equal(queued.text, 'ทดสอบคำสั่งงาน');
    assert.equal(queued.attachments[0].path, stored);
    assert.equal(fs.readdirSync(ctx.opts.secretaryQueueDir).some((f) => f.startsWith('.')), false, 'no temp files');

    // One command record per line
    const lines = fs.readFileSync(ctx.opts.commandsFile, 'utf8').trim().split('\n');
    const record = JSON.parse(lines[lines.length - 1]);
    assert.equal(record.id, body.id);
    assert.equal(record.text, 'ทดสอบคำสั่งงาน');
    assert.equal(record.files[0].storedAs, '01-รายงาน.js');

    // Events on the same stream: user node COMPLETED, then secretary (router) PROCESSING
    const userEv = await sse.waitFor((e) => e.agent === 'user' && e.message.startsWith('ส่งคำสั่งงาน'));
    assert.equal(userEv.status, 'COMPLETED');
    assert.equal(userEv.pipelineStep, 'user');
    const secEv = await sse.waitFor((e) => e.agent === 'secretary' && e.message.startsWith('queued:'));
    assert.equal(secEv.status, 'PROCESSING');
    assert.equal(secEv.pipelineStep, 'router');
    sse.close();
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/command returns 500, an ERROR event and a failed record when the queue cannot be written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-broken-'));
  // A regular file where the queue folder should be: the queue write must fail
  const blocker = path.join(dir, 'secretary-queue');
  fs.writeFileSync(blocker, 'x');
  const ctx = await startServer({ secretaryQueueDir: blocker });
  try {
    const sse = await openEvents(ctx.port);
    const res = await request(ctx.port, 'POST', '/api/command', { body: { text: 'งานที่คิวเสีย' } });
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body);
    assert.match(body.id, /^cmd-/);
    // The command record is still written, marked as not accepted
    const record = JSON.parse(fs.readFileSync(ctx.opts.commandsFile, 'utf8').trim().split('\n').pop());
    assert.equal(record.forwarded.accepted, false);
    const errEv = await sse.waitFor((e) => e.agent === 'secretary' && e.status === 'ERROR');
    assert.match(errEv.message, /เข้าคิว/);
    sse.close();
  } finally {
    await ctx.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/command rejects an empty command and bad base64', async () => {
  const ctx = await startServer();
  try {
    const empty = await request(ctx.port, 'POST', '/api/command', { body: { text: '   ' } });
    assert.equal(empty.status, 400);
    const badFile = await request(ctx.port, 'POST', '/api/command', {
      body: { text: 'x', files: [{ name: 'a.txt', data: '***' }] },
    });
    assert.equal(badFile.status, 400);
    assert.match(badFile.body, /base64/);
    // Nothing was written for rejected commands
    assert.equal(fs.existsSync(ctx.opts.commandsFile), false);
  } finally {
    await ctx.cleanup();
  }
});

test('other methods on the workspace API return 405, and POST still needs the Host/Origin guards', async () => {
  const ctx = await startServer();
  try {
    assert.equal((await request(ctx.port, 'PUT', '/api/command', { body: { text: 'x' } })).status, 405);
    assert.equal((await request(ctx.port, 'POST', '/api/state', { body: {} })).status, 405);
    const evilHost = await request(ctx.port, 'POST', '/api/events', {
      headers: { Host: 'evil.example.com' },
      body: { agent: 'x', status: 'IDLE', message: 'm' },
    });
    assert.equal(evilHost.status, 403);
    const evilOrigin = await request(ctx.port, 'POST', '/api/command', {
      headers: { Origin: 'http://evil.example.com' },
      body: { text: 'x' },
    });
    assert.equal(evilOrigin.status, 403);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- HTTP: upload failures (item 1) ----------

test('upload folder cannot be created: clean 500, ERROR event, failed record, nothing queued', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-upload-'));
  // A regular file where the uploads folder should be: creating <uploads>/<id>/ must fail
  const blocker = path.join(dir, 'uploads');
  fs.writeFileSync(blocker, 'x');
  const ctx = await startServer({ uploadsDir: blocker });
  try {
    const sse = await openEvents(ctx.port);
    const res = await request(ctx.port, 'POST', '/api/command', {
      body: { text: 'มีไฟล์แนบ', files: [{ name: 'a.txt', data: Buffer.from('hi').toString('base64') }] },
    });
    assert.equal(res.status, 500);
    const body = JSON.parse(res.body);
    assert.match(body.error, /not queued/);
    assert.match(body.id, /^cmd-/);
    assert.equal(fs.existsSync(ctx.opts.secretaryQueueDir), false, 'nothing was queued');

    const record = JSON.parse(fs.readFileSync(ctx.opts.commandsFile, 'utf8').trim().split('\n').pop());
    assert.equal(record.id, body.id);
    assert.equal(record.forwarded.accepted, false);
    assert.deepEqual(record.files, []);

    const errEv = await sse.waitFor((e) => e.agent === 'secretary' && e.status === 'ERROR' && e.message.includes(body.id));
    assert.match(errEv.message, /ไฟล์แนบ/);
    sse.close();
  } finally {
    await ctx.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a write failure on the second upload removes the partial upload folder', async () => {
  const ctx = await startServer();
  const realWrite = fs.writeFileSync;
  let uploadWrites = 0;
  // Fail only the second write into the uploads folder (queue files use fd writes and are not affected)
  fs.writeFileSync = function failSecondUpload(file, ...rest) {
    if (String(file).startsWith(ctx.opts.uploadsDir)) {
      uploadWrites += 1;
      if (uploadWrites === 2) {
        const err = new Error('no space left on device');
        err.code = 'ENOSPC';
        throw err;
      }
    }
    return realWrite.call(fs, file, ...rest);
  };
  let res;
  try {
    res = await request(ctx.port, 'POST', '/api/command', {
      body: {
        text: 'สองไฟล์',
        files: [
          { name: 'a.txt', data: Buffer.from('a').toString('base64') },
          { name: 'b.txt', data: Buffer.from('b').toString('base64') },
        ],
      },
    });
  } finally {
    fs.writeFileSync = realWrite;
  }
  try {
    assert.equal(res.status, 500);
    assert.equal(fs.readdirSync(ctx.opts.uploadsDir).length, 0, 'no orphan upload folder');
    assert.equal(fs.existsSync(ctx.opts.secretaryQueueDir), false, 'nothing was queued');
    const record = JSON.parse(fs.readFileSync(ctx.opts.commandsFile, 'utf8').trim().split('\n').pop());
    assert.equal(record.forwarded.accepted, false);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- HTTP: failure after the queue file exists (item 2) ----------

test('command record cannot be written after queueing: still 201 with a warning, exactly one queue file', async () => {
  const ctx = await startServer();
  try {
    // A folder where the commands.jsonl file should be: the record append must fail
    fs.mkdirSync(ctx.opts.commandsFile);
    const res = await request(ctx.port, 'POST', '/api/command', { body: { text: 'งานที่บันทึกไม่ได้' } });
    assert.equal(res.status, 201, 'the command is queued, so it must not look failed');
    const body = JSON.parse(res.body);
    assert.equal(body.forwarded.accepted, true);
    assert.match(body.warning, /queued/);
    // The queue file is the source of truth: exactly one file for this command, no duplicates
    assert.deepEqual(fs.readdirSync(ctx.opts.secretaryQueueDir), [`${body.id}.json`]);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- HTTP: queue done-marking (item 4) ----------

test('POST /api/queue/done moves the item to done/, emits one COMPLETED secretary event, and is idempotent', async () => {
  const ctx = await startServer();
  try {
    const sse = await openEvents(ctx.port);
    const queued = JSON.parse((await request(ctx.port, 'POST', '/api/command', { body: { text: 'งาน done' } })).body);

    // Still pending_approval: done is refused until the owner approves
    assert.equal((await request(ctx.port, 'POST', '/api/queue/done', { body: { id: queued.id } })).status, 409);
    assert.equal((await request(ctx.port, 'POST', '/api/queue/approve', { body: { id: queued.id } })).status, 200);

    const first = await request(ctx.port, 'POST', '/api/queue/done', { body: { id: queued.id } });
    assert.equal(first.status, 200);
    assert.equal(JSON.parse(first.body).alreadyDone, false);
    assert.equal(fs.existsSync(path.join(ctx.opts.secretaryQueueDir, `${queued.id}.json`)), false);
    assert.ok(fs.existsSync(path.join(ctx.opts.secretaryQueueDir, 'done', `${queued.id}.json`)));

    const doneEv = await sse.waitFor((e) => e.agent === 'secretary' && e.status === 'COMPLETED' && e.message.includes(queued.id));
    assert.equal(doneEv.pipelineStep, 'router');
    assert.match(doneEv.message, /^done:/); // replaces the "queued:" line on the node

    const second = await request(ctx.port, 'POST', '/api/queue/done', { body: { id: queued.id } });
    assert.equal(second.status, 200);
    assert.equal(JSON.parse(second.body).alreadyDone, true);

    assert.equal((await request(ctx.port, 'POST', '/api/queue/done', { body: { id: 'cmd-nope' } })).status, 404);
    assert.equal((await request(ctx.port, 'POST', '/api/queue/done', { body: { id: '../x' } })).status, 400);

    // Give the stream a moment, then check that the done event was emitted only once
    await new Promise((resolve) => setTimeout(resolve, 100));
    const doneCount = sse.events.filter((e) => e.status === 'COMPLETED' && e.message.includes(queued.id)).length;
    assert.equal(doneCount, 1);
    sse.close();
  } finally {
    await ctx.cleanup();
  }
});

// ---------- HTTP: token and Origin (item 5) ----------

test('every POST route needs the token: missing -> 401, wrong -> 403, right -> 2xx; GET /api/events stays open', async () => {
  const ctx = await startServer({ workspaceToken: 'secret-token-123' });
  try {
    const auth = { Authorization: 'Bearer secret-token-123' };
    const none = { Authorization: undefined };
    const wrong = { Authorization: 'Bearer wrong' };
    const cmd = { text: 'มีโทเคน' };
    const ev = { agent: 'x', status: 'IDLE', message: 'm' };
    for (const [route, body] of [['/api/command', cmd], ['/api/events', ev], ['/api/queue/approve', { id: 'cmd-1' }],
      ['/api/queue/reject', { id: 'cmd-1' }], ['/api/queue/done', { id: 'cmd-1' }]]) {
      assert.equal((await request(ctx.port, 'POST', route, { headers: none, body })).status, 401, `${route} without a token`);
      assert.equal((await request(ctx.port, 'POST', route, { headers: wrong, body })).status, 403, `${route} with a wrong token`);
      // A non-Bearer scheme or an empty Bearer value counts as missing
      assert.equal((await request(ctx.port, 'POST', route, { headers: { Authorization: 'Basic abc' }, body })).status, 401);
    }
    assert.equal(fs.existsSync(ctx.opts.secretaryQueueDir), false, 'rejected commands are not stored');
    assert.equal(fs.existsSync(ctx.opts.workspaceEventsFile), false, 'rejected events are not written');

    const ok = await request(ctx.port, 'POST', '/api/command', { headers: auth, body: cmd });
    assert.equal(ok.status, 201);
    assert.equal((await request(ctx.port, 'POST', '/api/events', { headers: auth, body: ev })).status, 201);
    // Surrounding whitespace in the client value is trimmed
    assert.equal((await request(ctx.port, 'POST', '/api/events', { headers: { Authorization: 'Bearer  secret-token-123  ' }, body: ev })).status, 201);

    // GET routes need no token
    const sse = await openEvents(ctx.port);
    assert.equal(sse.status, 200);
    sse.close();
    assert.equal((await request(ctx.port, 'GET', '/api/queue', { headers: none })).status, 200);
    assert.equal((await request(ctx.port, 'GET', '/api/agents', { headers: none })).status, 200);
  } finally {
    await ctx.cleanup();
  }
});

test('POST accepts only the server own localhost origin (other localhost ports are rejected)', async () => {
  const ctx = await startServer();
  try {
    const otherPort = await request(ctx.port, 'POST', '/api/events', {
      headers: { Origin: `http://localhost:${ctx.port + 1}` },
      body: { agent: 'x', status: 'IDLE', message: 'm' },
    });
    assert.equal(otherPort.status, 403);
    const own = await request(ctx.port, 'POST', '/api/events', {
      headers: { Origin: `http://localhost:${ctx.port}` },
      body: { agent: 'x', status: 'IDLE', message: 'm' },
    });
    assert.equal(own.status, 201);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- MED-1: event write failure after the command is queued ----------

/**
 * Make every appendFileSync to `target` throw EIO until the returned restore() is called.
 * Works for any user (a chmod-based test would not fail when the tests run as root).
 */
function failAppendsTo(target) {
  const original = fs.appendFileSync;
  fs.appendFileSync = function patchedAppend(file, ...rest) {
    if (path.resolve(String(file)) === path.resolve(target)) {
      throw Object.assign(new Error('simulated disk error'), { code: 'EIO' });
    }
    return original.call(this, file, ...rest);
  };
  return () => { fs.appendFileSync = original; };
}

test('event write fails after the command is queued: 201 with a warning, one queue file kept (MED-1)', async () => {
  const ctx = await startServer();
  const restore = failAppendsTo(ctx.opts.workspaceEventsFile);
  try {
    const res = await request(ctx.port, 'POST', '/api/command', { body: { text: 'งาน event fail' } });
    assert.equal(res.status, 201, 'the command is queued, so it must not look failed');
    const body = JSON.parse(res.body);
    assert.equal(body.forwarded.accepted, true);
    assert.match(body.warning, /events could not be written/);
    assert.match(body.warning, /Do not resubmit/);
    assert.deepEqual(fs.readdirSync(ctx.opts.secretaryQueueDir), [`${body.id}.json`]);
  } finally {
    restore();
    await ctx.cleanup();
  }
});

// ---------- MED-2: node state derived from the pending queue (not one shared "queued" state) ----------

/** Create a hub on temp files under `dir`. Caller must call hub.close(). */
function makeHub(dir) {
  const o = tempWorkspaceOpts(dir); // all five paths, temp only (checked)
  return createWorkspaceHub({
    eventsFile: o.eventsFile,
    workspaceFile: o.workspaceEventsFile,
    commandsFile: o.commandsFile,
    uploadsDir: o.uploadsDir,
    secretaryQueueDir: o.secretaryQueueDir,
  });
}

test('LOW-3 guard: every default path (env overrides) points to a temp folder, never to data/', () => {
  assertConfigIsolated(); // throws if lib/config.js resolves any path into data/
});

test('LOW-3 guard: a test that leaves out a path or points into data/ is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-guard-'));
  try {
    const full = tempWorkspaceOpts(dir);
    const { secretaryQueueDir: _omitted, ...missing } = full;
    assert.throws(() => assertTempPaths(missing), /secretaryQueueDir is missing/);
    const projectData = path.join(__dirname, '..', 'data', 'secretary-queue');
    assert.throws(() => assertTempPaths({ ...full, secretaryQueueDir: projectData }), /project data\/ folder/);
    assert.throws(() => assertTempPaths({ ...full, commandsFile: path.join(__dirname, '..', 'data', 'commands.jsonl') }),
      /project data\/ folder/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** All secretary events written to the workspace events file (oldest first). */
function secretaryEvents(dir) {
  const file = path.join(dir, 'workspace-events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .filter((e) => e.agent === 'secretary');
}

/** The newest secretary event (the state the pipeline node shows). */
function lastSecretary(dir) {
  const all = secretaryEvents(dir);
  return all[all.length - 1];
}

test('two queued items, one done: the node stays PROCESSING and shows the pending count (MED-2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-med2-'));
  const hub = makeHub(dir);
  try {
    const a = hub.submitCommand({ text: 'งาน A' }).body.id;
    const b = hub.submitCommand({ text: 'งาน B' }).body.id;
    assert.equal(lastSecretary(dir).status, 'PROCESSING');
    hub.approveQueueItem({ id: a });
    hub.approveQueueItem({ id: b });

    hub.markQueueDone({ id: a });
    const middle = lastSecretary(dir);
    assert.equal(middle.status, 'PROCESSING', 'one item is still open, so the node must not be COMPLETED');
    assert.match(middle.message, /ค้างในคิว 1 งาน/);

    hub.markQueueDone({ id: b });
    const end = lastSecretary(dir);
    assert.equal(end.status, 'COMPLETED');
    assert.match(end.message, /^done:/);
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('markDone through the module first, then HTTP-style done: the node is not stuck (MED-2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-med2-'));
  const hub = makeHub(dir);
  try {
    const id = hub.submitCommand({ text: 'งาน module' }).body.id;
    hub.approveQueueItem({ id });
    // The consumer marks the item done directly through the module (no hub call, no event)
    markDone(id, { queueDir: path.join(dir, 'secretary-queue') });

    // Then the same id arrives through POST /api/queue/done: it is alreadyDone, but the state must still update
    const res = hub.markQueueDone({ id });
    assert.equal(res.status, 200);
    assert.equal(res.body.alreadyDone, true);
    const last = lastSecretary(dir);
    assert.equal(last.status, 'COMPLETED', 'the node must leave PROCESSING');
    assert.match(last.message, /^done:/);

    // A repeated call changes nothing, so no new event
    const count = secretaryEvents(dir).length;
    hub.markQueueDone({ id });
    assert.equal(secretaryEvents(dir).length, count);
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncQueueState derives the node state after a done made outside the hub (no HTTP call)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-med2-'));
  const hub = makeHub(dir);
  try {
    const id = hub.submitCommand({ text: 'งาน CLI' }).body.id;
    hub.approveQueueItem({ id });
    markDone(id, { queueDir: path.join(dir, 'secretary-queue') });
    assert.equal(lastSecretary(dir).status, 'PROCESSING', 'nothing has been written yet');
    hub.syncQueueState();
    assert.equal(lastSecretary(dir).status, 'COMPLETED');
    // Nothing changed since, so a second sync writes nothing
    const count = secretaryEvents(dir).length;
    hub.syncQueueState();
    assert.equal(secretaryEvents(dir).length, count);
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a done made outside HTTP reaches the live stream by itself within a few seconds (MED-2)', async () => {
  const ctx = await startServer();
  try {
    const sse = await openEvents(ctx.port);
    const queued = JSON.parse((await request(ctx.port, 'POST', '/api/command', { body: { text: 'งาน timer' } })).body);
    await request(ctx.port, 'POST', '/api/queue/approve', { body: { id: queued.id } });
    markDone(queued.id, { queueDir: ctx.opts.secretaryQueueDir });
    const ev = await sse.waitFor((e) => e.agent === 'secretary' && e.status === 'COMPLETED', 6000);
    assert.match(ev.message, /^done:/);
    sse.close();
  } finally {
    await ctx.cleanup();
  }
});

// ---------- UI: the browser code path shows body.warning (MED-1) ----------
// No browser or jsdom is available (no dependencies), so app.js runs in a vm sandbox with a small DOM stub.

/** Minimal element stub: enough for app.js (textContent, className, dataset, listeners). */
function fakeElement(tag, selectors = {}) {
  const listeners = {};
  const children = [];
  return {
    tagName: tag,
    _text: '',
    children,
    // textContent setter mirrors the DOM: setting '' also removes the child nodes
    get textContent() { return this._text; },
    set textContent(value) {
      this._text = String(value);
      if (value === '') children.length = 0;
    },
    get firstChild() { return children[0]; },
    className: '',
    value: '',
    disabled: false,
    dataset: {},
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    listeners,
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    setAttribute() {},
    select() {},
    setSelectionRange() {},
    appendChild(node) { children.push(node); return node; },
    append(...nodes) { children.push(...nodes); },
    removeChild(node) { children.splice(children.indexOf(node), 1); },
    querySelector(selector) { return selectors[selector] || null; },
    querySelectorAll() { return []; },
    click() {},
    // Any innerHTML write from app.js fails the test that runs it (no HTML parsing in the page)
    set innerHTML(_value) { throw new Error('innerHTML is not allowed in app.js'); },
  };
}

/** Pipeline node stub (same data attributes as index.html): badge and message box. */
function makeNodeStub(step) {
  const badge = fakeElement('span');
  const msg = fakeElement('div');
  const name = fakeElement('span'); // .node-name: the label text, base name only until the model suffix is added
  name.textContent = NODE_BASE_NAME[step] || step;
  const model = fakeElement('span'); // .node-model: the compact 3D label chip, "Model-Effort" when known, the member name as a fallback
  const node = fakeElement('div', { '[data-badge]': badge, '[data-msg]': msg, '.node-name': name, '.node-model': model });
  node.dataset.step = step;
  node.modelEl = model;
  node.badge = badge;
  node.msg = msg;
  node.nameEl = name;
  return node;
}

// Base text of each .node-name in index.html (the owner node is 'คุณกฎ')
const NODE_BASE_NAME = { user: 'คุณกฎ', router: 'เลขาคนสวย', pm: 'PM-Professor-X', appdev: 'Dev-ไอ้เก่ง', qa: 'QA-คุณละเอียด', study: 'Writer-ยัยแว่นหนา', portfolio: 'Content Director' };
const CARD_BASE_NAME = { secretary: 'เลขาคนสวย', 'app-dev': 'Dev-ไอ้เก่ง' };

/** Agent card stub (same data attributes as index.html): status pill. */
function makeCardStub(agent) {
  const pill = fakeElement('span');
  const name = fakeElement('span'); // [data-name] inside .agent-name
  name.textContent = CARD_BASE_NAME[agent] || agent;
  const card = fakeElement('li', { '[data-pill]': pill, '[data-name]': name });
  card.dataset.agent = agent;
  card.pill = pill;
  card.nameEl = name;
  return card;
}

/** All text under a stub element (its own text plus its children), for assertions. */
function textOf(node) {
  return [node._text, ...node.children.map(textOf)].join('');
}

/**
 * Load public/workspace/app.js into a vm sandbox. `fetchImpl` answers any fetch the page makes (none in the
 * current page). `startMs` is the fake clock at page open (the page uses Date.now() for its view cutoff).
 * Returns { push(), clickClear(), setNow(), nodes, cards, log }.
 */
function loadWorkspacePage(fetchImpl, startMs = Date.now()) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'workspace', 'app.js'), 'utf8');
  const elements = new Map([['log', fakeElement('ol')]]);
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  const nodes = ['user', 'router', 'pm', 'appdev', 'qa', 'study', 'portfolio'].map(makeNodeStub);
  const cards = ['secretary', 'app-dev'].map(makeCardStub);
  const streams = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.readyState = 0; streams.push(this); }
  }
  FakeEventSource.CLOSED = 2;
  // Controllable clock: Date.now() is the only Date call that app.js uses for the view cutoff
  const clock = { now: startMs };
  class FakeDate extends Date {
    static now() { return clock.now; }
  }
  const sandbox = {
    document: {
      readyState: 'complete',
      getElementById: getEl,
      querySelectorAll(selector) {
        if (selector === '.node[data-step]') return nodes;
        if (selector === '#agent-list .agent-card[data-agent]') return cards;
        return [];
      },
      createElement: fakeElement,
    },
    window: {},
    EventSource: FakeEventSource,
    Date: FakeDate,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  return {
    code,
    window: sandbox.window,
    nodes: Object.fromEntries(nodes.map((n) => [n.dataset.step, n])),
    cards: Object.fromEntries(cards.map((c) => [c.dataset.agent, c])),
    log: elements.get('log'),
    setNow(ms) { clock.now = ms; },
    /** Deliver one SSE message to the page, the same way EventSource does. */
    push(ev) { streams[0].onmessage({ data: JSON.stringify(ev) }); },
    /** Click the "ล้างหน้าจอ" button (the registered click listener). */
    clickClear() { getEl('clear-view-btn').listeners.click[0]({ preventDefault() {} }); },
  };
}

// The two former "submit command" UI tests (201 warning / 201 ok feedback) were removed with the
// command form. The server route POST /api/command is still covered by the HTTP tests above.

test('UI: the command form, textarea, submit button, file input and dropzone are gone from the page', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'workspace', 'index.html'), 'utf8');
  assert.equal(/<textarea\b/i.test(html), false, 'no command textarea');
  assert.equal(/<form\b/i.test(html), false, 'no command form');
  assert.equal(/id="command-text"|id="command-form"|id="submit-btn"/.test(html), false, 'no command ids');
  assert.equal(/ส่งงานให้เลขา|Submit to Secretary/.test(html), false, 'no submit button text');
  assert.equal(/type="file"|id="file-input"|id="dropzone"|id="file-list"/.test(html), false, 'no file upload input or zone');
});

test('UI: app.js no longer reads the removed command or file elements and never posts to /api/command', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'workspace', 'app.js'), 'utf8');
  for (const id of ['command-text', 'command-form', 'submit-btn', 'command-feedback', 'dropzone', 'file-input', 'file-list']) {
    assert.equal(code.includes(`'${id}'`), false, `app.js must not look up #${id}`);
  }
  assert.equal(code.includes('/api/command'), false, 'the workspace page must not send commands');
});

// ---------- UI: approval queue and copy button removed from the page (server queue API kept) ----------

test('UI: the approval list, approve / reject / copy buttons and the queue message line are gone from index.html', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'workspace', 'index.html'), 'utf8');
  for (const token of ['panel-approval', 'queue-block', 'pending-list', 'approved-list', 'pending-empty', 'approved-empty', 'queue-feedback']) {
    assert.equal(html.includes(token), false, `index.html must not contain ${token}`);
  }
  for (const text of ['รายการคิวงาน', 'Approval Queue', 'รอการอนุมัติ', 'อนุมัติแล้ว รอ Claude', 'อนุมัติ', 'ปฏิเสธ', 'คัดลอกคำสั่ง']) {
    assert.equal(html.includes(text), false, `index.html must not contain "${text}"`);
  }
  // The pipeline and the live log are still on the page, unchanged
  // (#edges was the old flat-diagram SVG layer; the 3D scene uses #scene and the HTML labels in #label-layer)
  for (const id of ['stage', 'scene', 'label-layer', 'log', 'clear-view-btn', 'status-badge', 'agent-list']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html keeps #${id}`);
  }
  for (const step of ['user', 'router', 'pm', 'appdev', 'qa', 'study', 'portfolio']) {
    assert.match(html, new RegExp(`data-step="${step}"`), `index.html keeps the ${step} node`);
  }
  // Labels: the secretary is เลขาคนสวย, never เลขา, on the page and in the agent list
  assert.equal(/เลขา(?!คนสวย)/.test(html), false, 'index.html must not show the bare เลขา');
  assert.match(html, /data-agent="secretary"[\s\S]*?เลขาคนสวย/);
  assert.match(html, /สายงานและการทำงาน/);
  assert.match(html, /Log การทำงานล่าสุด/);
});

test('UI: app.js has no approval handlers, no queue calls, no copy or token code, and still drives pipeline and log', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'workspace', 'app.js'), 'utf8');
  const removed = [
    "'/api/queue", '`/api/queue', 'queue-feedback', 'pending-list', 'approved-list', 'queueItems', 'renderQueue',
    'scheduleQueueRefresh', 'runQueueAction', 'copyQueueCommand', 'buildCopyCommand', 'copyToClipboard',
    'clipboard', 'execCommand', 'postWithToken', 'postJson', 'workspaceToken', 'window.prompt', 'feedback(',
  ];
  for (const token of removed) assert.equal(code.includes(token), false, `app.js must not contain ${token}`);
  // Still wired: SSE stream, pipeline nodes, live log and the clear button
  assert.ok(code.includes("'/api/events'"), 'app.js still reads the SSE stream');
  assert.ok(code.includes(".node[data-step]"), 'app.js still registers the pipeline nodes');
  assert.ok(code.includes("$('log')"), 'app.js still writes the live log');
  assert.ok(code.includes("'clear-view-btn'"), 'app.js still wires the clear button');
  assert.equal(/\.innerHTML\s*=/.test(code), false, 'app.js must not assign innerHTML');
});

test('UI: the page makes only one read-only GET /api/agents request (model labels) and still moves the pipeline and the live log from SSE', () => {
  const calls = [];
  const page = loadWorkspacePage(async (url, init) => {
    calls.push({ url, init });
    // The agent list is the only request the page may make; the queue and the command API are not used
    if (url !== '/api/agents') throw new Error(`unexpected fetch ${url}`);
    return { ok: false };
  }, PAGE_OPEN);
  page.push({ ts: isoAt(PAGE_OPEN + 1000), agent: 'app-dev', status: 'WORKING', message: 'กำลังทำงาน', pipelineStep: 'appdev' });
  assert.deepEqual(calls.map((c) => c.url), ['/api/agents'], 'one fetch, to /api/agents only');
  assert.ok(!calls[0].init || !calls[0].init.method || calls[0].init.method === 'GET', 'a GET (no POST, no body)');
  assert.equal(page.nodes.appdev.dataset.status, 'WORKING', 'pipeline node moves');
  assert.equal(page.log.children.length, 1, 'live log gets the line');
});

/** Wait for the page's pending fetch promise chain (a few microtask hops). */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('model labels: GET /api/agents adds "(Model-Effort)" after every team name (node, agent list, log); the owner gets none', async () => {
  const agents = {
    secretary: { name: 'เลขาคนสวย', model: 'Sonnet', effort: 'Medium', suffix: 'Sonnet-Medium' },
    pm: { name: 'PM-Professor-X', model: 'Opus', effort: 'High', suffix: 'Opus-High' },
    'app-dev': { name: 'Dev-ไอ้เก่ง', model: 'Sonnet', effort: 'High', suffix: 'Sonnet-High' },
    'qa-reviewer': { name: 'QA-คุณละเอียด', model: 'Opus', effort: 'Medium', suffix: 'Opus-Medium' },
    'study-writer': { name: 'Writer-ยัยแว่นหนา', model: 'Sonnet', effort: null, suffix: null }, // missing effort: name only
    'portfolio-writer': { name: 'Content Director', model: 'Sonnet', effort: 'Medium', suffix: 'Sonnet-Medium' },
    user: { name: 'คุณกฎ', model: 'Opus', effort: 'High', suffix: 'Opus-High' }, // must be ignored: the owner has no suffix
  };
  const page = loadWorkspacePage(async () => ({ ok: true, json: async () => ({ agents }) }), PAGE_OPEN);
  // A log line written BEFORE the answer arrives is updated too
  page.push({ ts: isoAt(PAGE_OPEN + 500), agent: 'app-dev', status: 'WORKING', message: 'early', pipelineStep: 'appdev' });
  await settle();
  assert.equal(page.nodes.router.nameEl.textContent, 'เลขาคนสวย (Sonnet-Medium)');
  assert.equal(page.nodes.pm.nameEl.textContent, 'PM-Professor-X (Opus-High)', 'the PM-Professor-X node label');
  assert.equal(page.nodes.appdev.nameEl.textContent, 'Dev-ไอ้เก่ง (Sonnet-High)');
  assert.equal(page.nodes.qa.nameEl.textContent, 'QA-คุณละเอียด (Opus-Medium)');
  assert.equal(page.nodes.study.nameEl.textContent, 'Writer-ยัยแว่นหนา', 'a missing effort shows just the name');
  assert.equal(page.nodes.portfolio.nameEl.textContent, 'Content Director (Sonnet-Medium)');
  assert.equal(page.nodes.user.nameEl.textContent, 'คุณกฎ', 'the owner never gets a suffix');
  // Compact 3D label chip: Model-Effort; the member name when the model or effort is unknown (never blank)
  assert.equal(page.nodes.router.modelEl.textContent, 'Sonnet-Medium');
  assert.equal(page.nodes.pm.modelEl.textContent, 'Opus-High');
  assert.equal(page.nodes.appdev.modelEl.textContent, 'Sonnet-High');
  assert.equal(page.nodes.qa.modelEl.textContent, 'Opus-Medium');
  assert.equal(page.nodes.study.modelEl.textContent, 'Writer-ยัยแว่นหนา', 'no suffix known: the chip shows the member name');
  assert.equal(page.nodes.portfolio.modelEl.textContent, 'Sonnet-Medium');
  assert.equal(page.nodes.user.modelEl.textContent, '', 'the owner gets no model chip (its name chip stays)');
  assert.ok(!page.nodes.appdev.modelEl.textContent.includes('Dev'), 'the 3D chip never contains the member name when a suffix is known');
  assert.equal(page.cards['app-dev'].nameEl.textContent, 'Dev-ไอ้เก่ง (Sonnet-High)', 'agent list (fallback list)');
  assert.equal(page.cards.secretary.nameEl.textContent, 'เลขาคนสวย (Sonnet-Medium)');
  // Log lines: new ones use the suffix at once
  page.push({ ts: isoAt(PAGE_OPEN + 1000), agent: 'qa-reviewer', status: 'WORKING', message: 'late', pipelineStep: 'qa' });
  const logNames = page.log.children.map((line) => textOf(line.children[2]));
  assert.deepEqual(logNames, ['Dev-ไอ้เก่ง (Sonnet-High)', 'QA-คุณละเอียด (Opus-Medium)'], 'the early line was updated, the new one has the suffix');
  // Published for scene.js (HUD): the same agents object
  assert.equal(page.window.workspaceModels, agents);
});

test('model labels: before /api/agents answers the chip shows the name, then switches to Model-Effort', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const agents = { 'app-dev': { name: 'Dev-ไอ้เก่ง', suffix: 'Sonnet-High' } };
  const page = loadWorkspacePage(async () => { await gate; return { ok: true, json: async () => ({ agents }) }; }, PAGE_OPEN);
  assert.equal(page.nodes.appdev.modelEl.textContent, 'Dev-ไอ้เก่ง', 'pending request: name chip');
  release();
  await settle();
  assert.equal(page.nodes.appdev.modelEl.textContent, 'Sonnet-High', 'answer arrived: Model-Effort');
  assert.equal(page.nodes.study.modelEl.textContent, 'Writer-ยัยแว่นหนา', 'agent without a suffix keeps the name');
  assert.equal(page.nodes.appdev.nameEl.textContent, 'Dev-ไอ้เก่ง (Sonnet-High)', 'the hover name chip is unchanged');
});

test('model labels: a failed or malformed /api/agents answer keeps the plain names and breaks nothing', async () => {
  for (const answer of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ agents: { 'app-dev': { suffix: '<img src=x onerror=alert(1)>' } } }) }),
    async () => ({ ok: true, json: async () => ({ agents: { 'app-dev': { suffix: 42 } } }) }),
    async () => ({ ok: true, json: async () => null }),
  ]) {
    const page = loadWorkspacePage(answer, PAGE_OPEN);
    await settle();
    assert.equal(page.nodes.appdev.nameEl.textContent, 'Dev-ไอ้เก่ง');
    assert.equal(page.nodes.appdev.modelEl.textContent, 'Dev-ไอ้เก่ง', 'a bad answer: the 3D chip shows the member name, not blank');
    assert.equal(page.nodes.router.modelEl.textContent, 'เลขาคนสวย');
    assert.equal(page.nodes.user.modelEl.textContent, '', 'the owner still gets no chip text');
    assert.equal(page.cards['app-dev'].nameEl.textContent, 'Dev-ไอ้เก่ง');
  }
});

// ---------- View: page-open cutoff, clean start, clear button ----------
// The server replays its last events to every new SSE client. The page must skip them by ts.

const PAGE_OPEN = Date.parse('2026-10-11T10:00:00.000Z'); // fake page-open time used below
const isoAt = (ms) => new Date(ms).toISOString();

test('view (a): an old event before page open is not shown, and a stale "queued:" event does not set the Secretary to PROCESSING', () => {
  const page = loadWorkspacePage(async () => ({}), PAGE_OPEN);
  // Replayed history from before the page was opened
  page.push({
    ts: isoAt(PAGE_OPEN - 60000),
    agent: 'secretary',
    status: 'PROCESSING',
    message: 'queued: ค้างในคิว 2 งาน รอ Claude session หยิบงาน',
    pipelineStep: 'router',
  });
  page.push({ ts: isoAt(PAGE_OPEN - 1000), agent: 'app-dev', status: 'COMPLETED', message: 'old work', pipelineStep: 'appdev' });

  assert.equal(page.log.children.length, 0, 'old history must not be logged');
  assert.equal(page.nodes.router.dataset.status, 'IDLE', 'stale queue must not show PROCESSING');
  assert.equal(page.nodes.router.badge.textContent, 'IDLE');
  assert.equal(page.nodes.appdev.dataset.status, 'IDLE');
  assert.equal(page.cards['app-dev'].dataset.status, 'IDLE');
});

test('view (b): a new event after page open is shown in the log and moves its pipeline node', () => {
  const page = loadWorkspacePage(async () => ({}), PAGE_OPEN);
  page.push({ ts: isoAt(PAGE_OPEN - 60000), agent: 'user', status: 'COMPLETED', message: 'old command', pipelineStep: 'user' });
  page.push({
    ts: isoAt(PAGE_OPEN + 2000),
    agent: 'secretary',
    status: 'PROCESSING',
    message: 'queued: ค้างในคิว 1 งาน รอ Claude session หยิบงาน (cmd-new)',
    pipelineStep: 'router',
  });

  assert.equal(page.log.children.length, 1, 'only the new event is logged');
  assert.match(textOf(page.log), /queued: ค้างในคิว 1 งาน/);
  assert.equal(page.nodes.router.dataset.status, 'PROCESSING');
  assert.equal(page.nodes.router.badge.textContent, 'PROCESSING');
  assert.match(page.nodes.router.msg.textContent, /cmd-new/);
  assert.equal(page.nodes.user.dataset.status, 'IDLE', 'the old user event did not move the User node');
});

test('view (c): the clear button resets nodes and cards to IDLE and empties the log; older replays stay hidden', () => {
  const page = loadWorkspacePage(async () => ({}), PAGE_OPEN);
  page.push({ ts: isoAt(PAGE_OPEN + 1000), agent: 'secretary', status: 'PROCESSING', message: 'queued: x', pipelineStep: 'router' });
  page.push({ ts: isoAt(PAGE_OPEN + 2000), agent: 'app-dev', status: 'WORKING', message: 'กำลังทำงาน', pipelineStep: 'appdev' });
  assert.equal(page.log.children.length, 2);
  assert.equal(page.nodes.appdev.dataset.status, 'WORKING');

  // Clear at a later time than the events above
  page.setNow(PAGE_OPEN + 3000);
  page.clickClear();

  assert.equal(page.log.children.length, 0, 'log is empty after clear');
  for (const step of ['user', 'router', 'pm', 'appdev', 'qa', 'study', 'portfolio']) {
    assert.equal(page.nodes[step].dataset.status, 'IDLE', `${step} node back to IDLE`);
    assert.equal(page.nodes[step].badge.textContent, 'IDLE', `${step} badge back to IDLE`);
  }
  assert.equal(page.nodes.router.msg.textContent, '', 'node message cleared');
  assert.equal(page.cards['app-dev'].dataset.status, 'IDLE');
  assert.equal(page.cards['app-dev'].pill.textContent, 'IDLE');

  // An event never seen before, but with a ts earlier than the clear time (e.g. a late replay): skipped
  page.push({ ts: isoAt(PAGE_OPEN + 2500), agent: 'secretary', status: 'PROCESSING', message: 'queued: late replay', pipelineStep: 'router' });
  assert.equal(page.log.children.length, 0, 'an event older than the clear time must not be shown');
  assert.equal(page.nodes.router.dataset.status, 'IDLE');

  // A newer event after the clear is shown normally
  page.push({ ts: isoAt(PAGE_OPEN + 4000), agent: 'qa-reviewer', status: 'COMPLETED', message: 'ผ่าน', pipelineStep: 'qa' });
  assert.equal(page.log.children.length, 1);
  assert.equal(page.nodes.qa.dataset.status, 'COMPLETED');
});

test('view: the page has the Thai clear button, and app.js still avoids innerHTML', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'workspace', 'index.html'), 'utf8');
  assert.match(html, /<button id="clear-view-btn"[^>]*>ล้างหน้าจอ<\/button>/);
  const page = loadWorkspacePage(async () => ({}), PAGE_OPEN);
  assert.equal(/\.innerHTML\s*=/.test(page.code), false, 'app.js must not assign innerHTML');
});

// ---------- LOW-1 / LOW-2: failing queue or disk, logging and startup retry ----------

/**
 * Capture console.error and console.log lines until restore() is called.
 * Used to count how many server log lines a failure produces.
 */
function captureLogs() {
  const out = { errors: [], logs: [] };
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args) => { out.errors.push(args.join(' ')); };
  console.log = (...args) => { out.logs.push(args.join(' ')); };
  out.restore = () => { console.error = origError; console.log = origLog; };
  return out;
}

/** Poll until predicate() is truthy or timeoutMs passes. */
async function waitUntil(predicate, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('LOW-1: an unreadable queue is logged once while it stays broken, and once on recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-low1-'));
  const hub = makeHub(dir);
  const queueDir = path.join(dir, 'secretary-queue');
  const logs = captureLogs();
  try {
    // Break the queue folder: a regular file where the folder should be, so readdir fails (ENOTDIR)
    fs.writeFileSync(queueDir, 'x');
    for (let i = 0; i < 5; i += 1) assert.equal(hub.syncQueueState(), false);
    assert.equal(logs.errors.length, 1, `expected one log line while broken, got ${logs.errors.length}`);

    // Recover: the folder is back. One recovery line, no error line.
    fs.rmSync(queueDir);
    fs.mkdirSync(queueDir);
    assert.equal(hub.syncQueueState(), null);
    assert.equal(logs.errors.length, 1);
    assert.equal(logs.logs.filter((l) => /recovered/.test(l)).length, 1);
  } finally {
    logs.restore();
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LOW-1: a failed event write is logged once per failure, retried quietly, and logged again only when the count changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-low1-'));
  const hub = makeHub(dir);
  const queueDir = path.join(dir, 'secretary-queue');
  const workspaceFile = path.join(dir, 'workspace-events.jsonl');
  const logs = captureLogs();
  const restore = failAppendsTo(workspaceFile);
  try {
    forwardToSecretary({ id: 'cmd-1', timestamp: TS, text: 'a', dir, files: [] }, { queueDir });
    for (let i = 0; i < 5; i += 1) assert.equal(hub.syncQueueState(), false);
    assert.equal(logs.errors.length, 1, 'same pending count while failing: one log line only');

    // A new pending count is a new state, so it is logged once more
    forwardToSecretary({ id: 'cmd-2', timestamp: TS, text: 'b', dir, files: [] }, { queueDir });
    for (let i = 0; i < 3; i += 1) assert.equal(hub.syncQueueState(), false);
    assert.equal(logs.errors.length, 2);

    // Disk back: the write succeeds, one recovery line, and the node shows the current count
    restore();
    assert.equal(hub.syncQueueState(), true);
    assert.equal(logs.logs.filter((l) => /recovered/.test(l)).length, 1);
    assert.match(lastSecretary(dir).message, /ค้างในคิว 2 งาน/);
  } finally {
    restore();
    logs.restore();
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LOW-2: a failed startup write is retried on the next timer tick (no count change needed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-low2-'));
  const queueDir = path.join(dir, 'secretary-queue');
  const workspaceFile = path.join(dir, 'workspace-events.jsonl');
  // One item is already pending before the server starts
  forwardToSecretary({ id: 'cmd-1', timestamp: TS, text: 'before restart', dir, files: [] }, { queueDir });

  const logs = captureLogs();
  const restore = failAppendsTo(workspaceFile);
  let hub = null;
  try {
    // Startup: the forced write fails because the event file cannot be written
    hub = makeHub(dir);
    assert.equal(secretaryEvents(dir).length, 0);
    assert.equal(logs.errors.length, 1, 'the startup failure is logged once');

    // Disk back. The count did not change, but the timer (every 2 s) must retry the forced write.
    restore();
    await waitUntil(() => secretaryEvents(dir).length > 0, 6000);
    assert.equal(lastSecretary(dir).status, 'PROCESSING');
    assert.match(lastSecretary(dir).message, /ค้างในคิว 1 งาน/);

    // Wait past one more timer tick (QUEUE_CHECK_MS = 2000 ms). The state is unchanged, so the
    // retry must not write the same event again: exactly one line, not just "more than zero".
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(secretaryEvents(dir).length, 1, 'the forced write is done once; later ticks add nothing');
  } finally {
    restore();
    logs.restore();
    if (hub) hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Owner approval: secretary-queue/v2 (lib/secretary-adapter.js, hub, CLI, UI) ----------
// Every test below uses temp folders only. The queue folder of a hub is <dir>/secretary-queue (makeHub).

const QUEUE_CLI = path.join(__dirname, '..', 'scripts', 'queue.js');

/** A temp folder and the queue folder inside it. Caller removes dir. */
function tempQueue(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, queueDir: path.join(dir, 'secretary-queue') };
}

/** Forward one pending_approval item into queueDir (no uploads). */
function forwardItem(queueDir, dir, id, text = id) {
  forwardToSecretary({ id, timestamp: TS, text, dir, files: [] }, { queueDir });
}

/** Parse a JSON file. */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Name -> content of every file directly in dir (used to prove that nothing changed). */
function snapshotFolder(dir) {
  return fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]);
}

test('approve moves a pending item to approved in place: status, approvedAt and format v2 are set, the file stays in the queue', () => {
  const { dir, queueDir } = tempQueue('ws-approve-');
  try {
    forwardItem(queueDir, dir, 'cmd-1');
    forwardItem(queueDir, dir, 'cmd-2');
    assert.equal(readJson(path.join(queueDir, 'cmd-1.json')).status, 'pending_approval');

    const res = approveItem('cmd-1', { queueDir });
    assert.equal(res.status, 'approved');
    const file = path.join(queueDir, 'cmd-1.json');
    assert.ok(fs.existsSync(file), 'an approved item stays in the queue folder');
    const rec = readJson(file);
    assert.equal(rec.status, 'approved');
    assert.equal(rec.format, QUEUE_FORMAT);
    assert.equal(rec.approvedAt, res.approvedAt);
    assert.match(rec.approvedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(listPending(queueDir), ['cmd-2']);
    assert.deepEqual(listApproved(queueDir).map((r) => r.id), ['cmd-1']);
    assert.equal(fs.readdirSync(queueDir).some((f) => f.startsWith('.')), false, 'no temp files are left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approving twice gives ENOT_PENDING (409 on the route); unknown and unsafe ids give ENOENT_QUEUE and EINVAL_ID', () => {
  const { dir, queueDir } = tempQueue('ws-approve2-');
  try {
    forwardItem(queueDir, dir, 'cmd-1');
    approveItem('cmd-1', { queueDir });
    assert.throws(() => approveItem('cmd-1', { queueDir }), { code: 'ENOT_PENDING', status: 'approved' });
    assert.throws(() => approveItem('cmd-9', { queueDir }), { code: 'ENOENT_QUEUE' });
    assert.throws(() => approveItem('../cmd-1', { queueDir }), { code: 'EINVAL_ID' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hub: approve answers 200, a second approve 409, unknown id 404, bad or missing id 400', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-hub-approve-'));
  const hub = makeHub(dir);
  try {
    const id = hub.submitCommand({ text: 'งานอนุมัติ' }).body.id;
    const ok = hub.approveQueueItem({ id });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'approved');
    assert.equal(hub.approveQueueItem({ id }).status, 409, 'approving twice is a conflict');
    assert.equal(hub.approveQueueItem({ id: 'cmd-nope' }).status, 404);
    assert.equal(hub.approveQueueItem({ id: '../x' }).status, 400);
    assert.equal(hub.approveQueueItem({}).status, 400);
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('done on a pending_approval item returns 409 and changes nothing (no file moved, no done event)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-done409-'));
  const hub = makeHub(dir);
  const queueDir = path.join(dir, 'secretary-queue');
  try {
    const id = hub.submitCommand({ text: 'ยังไม่อนุมัติ' }).body.id;
    const res = hub.markQueueDone({ id });
    assert.equal(res.status, 409);
    assert.equal(readJson(path.join(queueDir, `${id}.json`)).status, 'pending_approval');
    assert.equal(fs.existsSync(path.join(queueDir, 'done', `${id}.json`)), false);
    assert.equal(secretaryEvents(dir).some((e) => e.message.startsWith('done:')), false);
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reject moves the file to rejected/ (nothing is deleted) and writes exactly one rejected: event', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-reject-'));
  const hub = makeHub(dir);
  const queueDir = path.join(dir, 'secretary-queue');
  try {
    const id = hub.submitCommand({ text: 'งานปฏิเสธ' }).body.id;
    const before = secretaryEvents(dir).length;

    const res = hub.rejectQueueItem({ id });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(path.join(queueDir, `${id}.json`)), false, 'the item left the open queue');
    const rejected = path.join(queueDir, 'rejected', `${id}.json`);
    assert.ok(fs.existsSync(rejected), 'the file is kept in rejected/');
    const rec = readJson(rejected);
    assert.equal(rec.status, 'rejected');
    assert.match(rec.rejectedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(rec.text, 'งานปฏิเสธ', 'the content is kept');

    const added = secretaryEvents(dir).slice(before);
    assert.equal(added.length, 1, 'exactly one event for the reject');
    assert.match(added[0].message, /^rejected:/);
    assert.equal(added[0].status, 'COMPLETED', 'nothing is open any more, so the node is COMPLETED');
    assert.equal(hub.syncQueueState(), null, 'the timer writes nothing more for the same change');

    // A rejected item is not listed, cannot be approved or done
    assert.deepEqual(hub.listQueue().body.items, []);
    assert.equal(hub.approveQueueItem({ id }).status, 404);
    assert.equal(hub.markQueueDone({ id }).status, 404);
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Secretary node is PROCESSING while an item is pending or approved, COMPLETED only when both are empty; each action writes one event', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-states-'));
  const hub = makeHub(dir);
  try {
    const a = hub.submitCommand({ text: 'งาน A' }).body.id;
    const b = hub.submitCommand({ text: 'งาน B' }).body.id;
    assert.equal(lastSecretary(dir).status, 'PROCESSING');

    let n = secretaryEvents(dir).length;
    hub.approveQueueItem({ id: a });
    assert.equal(secretaryEvents(dir).length, n + 1, 'approve: one event');
    assert.match(lastSecretary(dir).message, /^approved:/);
    assert.equal(lastSecretary(dir).status, 'PROCESSING', 'an approved item is still open');

    n = secretaryEvents(dir).length;
    hub.rejectQueueItem({ id: a });
    assert.equal(secretaryEvents(dir).length, n + 1, 'reject: one event');
    assert.match(lastSecretary(dir).message, /^rejected:/);
    assert.equal(lastSecretary(dir).status, 'PROCESSING', 'item b is still open');

    hub.approveQueueItem({ id: b });
    n = secretaryEvents(dir).length;
    hub.markQueueDone({ id: b });
    assert.equal(secretaryEvents(dir).length, n + 1, 'done: one event');
    assert.match(lastSecretary(dir).message, /^done:/);
    assert.equal(lastSecretary(dir).status, 'COMPLETED', 'both lists are empty, so the node is COMPLETED');
    assert.equal(hub.syncQueueState(), null);
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approve when the event log cannot be written: 200 with a warning, and the approval is kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-approve-warn-'));
  const hub = makeHub(dir);
  const logs = captureLogs();
  try {
    const id = hub.submitCommand({ text: 'งานเตือน' }).body.id;
    const restore = failAppendsTo(path.join(dir, 'workspace-events.jsonl'));
    let res;
    try {
      res = hub.approveQueueItem({ id });
    } finally {
      restore();
    }
    assert.equal(res.status, 200);
    assert.match(res.body.warning, /workspace event could not be written/);
    assert.equal(readJson(path.join(dir, 'secretary-queue', `${id}.json`)).status, 'approved');
  } finally {
    logs.restore();
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration: a v1 file without status is read as pending_approval, is not rewritten at startup, and only approving it rewrites it', () => {
  const { dir, queueDir } = tempQueue('ws-v1-');
  try {
    fs.mkdirSync(queueDir, { recursive: true });
    const file = path.join(queueDir, 'cmd-old.json');
    const original = `${JSON.stringify({
      format: 'secretary-queue/v1', id: 'cmd-old', timestamp: TS, text: 'งานเก่า', attachments: [],
    }, null, 2)}\n`;
    fs.writeFileSync(file, original);

    const hub = makeHub(dir); // startup: the queue is read, but the v1 file must not be touched
    try {
      assert.equal(fs.readFileSync(file, 'utf8'), original, 'startup does not rewrite the v1 file');
      assert.deepEqual(listPending(queueDir), ['cmd-old']);
      assert.deepEqual(listApproved(queueDir), []);
      assert.equal(readQueueItem('cmd-old', { queueDir }).status, 'pending_approval');
      assert.equal(hub.listQueue().body.items[0].status, 'pending_approval');

      assert.equal(hub.markQueueDone({ id: 'cmd-old' }).status, 409, 'a v1 item needs approval before done');
      assert.equal(hub.approveQueueItem({ id: 'cmd-old' }).status, 200);
      const rec = readJson(file);
      assert.equal(rec.format, QUEUE_FORMAT, 'the approved file is upgraded to v2');
      assert.equal(rec.status, 'approved');
      assert.equal(rec.text, 'งานเก่า', 'the content is kept');
    } finally {
      hub.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listApproved returns only approved items (pending, rejected and done items are excluded)', () => {
  const { dir, queueDir } = tempQueue('ws-only-approved-');
  try {
    for (const id of ['cmd-a', 'cmd-b', 'cmd-c', 'cmd-d']) forwardItem(queueDir, dir, id);
    approveItem('cmd-a', { queueDir });
    approveItem('cmd-b', { queueDir });
    approveItem('cmd-c', { queueDir });
    rejectItem('cmd-c', { queueDir });
    markDone('cmd-a', { queueDir });
    assert.deepEqual(listApproved(queueDir).map((r) => r.id), ['cmd-b']);
    assert.deepEqual(listPending(queueDir), ['cmd-d']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scripts/queue.js prints approved items as JSON, one item by id with its paths, refuses a pending item, and changes no file', () => {
  const { dir, queueDir } = tempQueue('ws-cli-');
  try {
    const uploadDir = path.join(dir, 'uploads', 'cmd-ok');
    forwardToSecretary({
      id: 'cmd-ok',
      timestamp: TS,
      text: 'งานอนุมัติแล้ว',
      dir: uploadDir,
      files: [{ name: 'note.txt', storedAs: '01-note.txt', type: 'text/plain', size: 6 }],
    }, { queueDir });
    forwardItem(queueDir, dir, 'cmd-wait', 'ยังไม่อนุมัติ');
    approveItem('cmd-ok', { queueDir });

    const before = snapshotFolder(queueDir);
    const env = { ...process.env, DASHBOARD_SECRETARY_QUEUE_DIR: queueDir };
    const run = (args) => spawnSync(process.execPath, [QUEUE_CLI, ...args], { env, encoding: 'utf8' });

    // All approved items
    const list = run([]);
    assert.equal(list.status, 0, list.stderr);
    const items = JSON.parse(list.stdout);
    assert.deepEqual(items.map((i) => i.id), ['cmd-ok'], 'the pending item is not printed');
    assert.equal(items[0].text, 'งานอนุมัติแล้ว');
    assert.equal(items[0].attachments[0].path, path.join(uploadDir, '01-note.txt'));

    // One approved item by id
    const one = run(['cmd-ok']);
    assert.equal(one.status, 0, one.stderr);
    const rec = JSON.parse(one.stdout);
    assert.equal(rec.id, 'cmd-ok');
    assert.equal(rec.status, 'approved');
    assert.equal(rec.attachments[0].name, 'note.txt');

    // A pending item is refused (exit 2, nothing on stdout)
    const pending = run(['cmd-wait']);
    assert.equal(pending.status, 2);
    assert.equal(pending.stdout, '');
    assert.match(pending.stderr, /not approved/);

    // Unknown and unsafe ids: exit 1
    assert.equal(run(['cmd-nope']).status, 1);
    assert.equal(run(['../cmd-ok']).status, 1);

    assert.deepEqual(snapshotFolder(queueDir), before, 'the CLI changes no file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/queue lists open items; a rejected item disappears and a non-JSON file is listed as unreadable (reject still works)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-unreadable-'));
  const hub = makeHub(dir);
  const queueDir = path.join(dir, 'secretary-queue');
  try {
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(path.join(queueDir, 'cmd-bad.json'), '{ not json');
    const items = hub.listQueue().body.items;
    assert.equal(items.length, 1);
    assert.equal(items[0].unreadable, true);
    assert.equal(items[0].status, 'pending_approval');
    assert.equal(hub.approveQueueItem({ id: 'cmd-bad' }).status, 409, 'an unreadable file cannot be approved');
    assert.equal(hub.rejectQueueItem({ id: 'cmd-bad' }).status, 200, 'but it can be rejected');
    assert.equal(fs.existsSync(path.join(queueDir, 'rejected', 'cmd-bad.json')), true);
    assert.deepEqual(hub.listQueue().body.items, []);
  } finally {
    hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP: approve 200 + one approved: event, second approve 409, reject 200 moves the file, unknown 404, bad id 400', async () => {
  const ctx = await startServer();
  try {
    const sse = await openEvents(ctx.port);
    const first = JSON.parse((await request(ctx.port, 'POST', '/api/command', { body: { text: 'งาน http อนุมัติ' } })).body);
    const ok = await request(ctx.port, 'POST', '/api/queue/approve', { body: { id: first.id } });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).status, 'approved');
    const apEv = await sse.waitFor((e) => e.agent === 'secretary' && e.message.startsWith('approved:'));
    assert.equal(apEv.status, 'PROCESSING');
    assert.equal((await request(ctx.port, 'POST', '/api/queue/approve', { body: { id: first.id } })).status, 409);

    const second = JSON.parse((await request(ctx.port, 'POST', '/api/command', { body: { text: 'งาน http ปฏิเสธ' } })).body);
    assert.equal((await request(ctx.port, 'POST', '/api/queue/reject', { body: { id: second.id } })).status, 200);
    assert.equal(fs.existsSync(path.join(ctx.opts.secretaryQueueDir, `${second.id}.json`)), false);
    assert.ok(fs.existsSync(path.join(ctx.opts.secretaryQueueDir, 'rejected', `${second.id}.json`)));
    await sse.waitFor((e) => e.agent === 'secretary' && e.message.startsWith('rejected:'));

    assert.equal((await request(ctx.port, 'POST', '/api/queue/reject', { body: { id: 'cmd-nope' } })).status, 404);
    assert.equal((await request(ctx.port, 'POST', '/api/queue/approve', { body: { id: '../x' } })).status, 400);
    sse.close();
  } finally {
    await ctx.cleanup();
  }
});
