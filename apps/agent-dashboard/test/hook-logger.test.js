'use strict';
/**
 * hook-logger.test.js - runs hook-logger.js as a child process, the same way Claude Code does.
 * Checks: one line appended, prompt not stored, stdout empty, exit code 0 on bad input,
 * and the 1 MiB stdin cap (oversized payload -> one compact record with truncated: true).
 * Uses a temp events file (DASHBOARD_EVENTS_FILE), never touches data/.
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hook-logger.js');

/** Run the hook with the given stdin text. Returns spawn result and the temp events file path. */
function runHook(input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-hook-'));
  const file = path.join(dir, 'events.jsonl');
  const result = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, DASHBOARD_EVENTS_FILE: file },
  });
  return { result, file, dir };
}

test('hook-logger appends one normalized line, stores no prompt, prints nothing', () => {
  const payload = {
    hook_event_name: 'PreToolUse',
    session_id: 'hook-test',
    cwd: '/home/user/project',
    tool_name: 'Agent',
    tool_use_id: 'toolu_hook_1',
    prompt: 'SECRET PROMPT TEXT',
    tool_input: { subagent_type: 'app-dev', description: 'build the thing', prompt: 'SECRET PROMPT TEXT' },
  };
  const { result, file, dir } = runHook(JSON.stringify(payload));
  try {
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '', 'hook must not write to stdout');
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.event, 'PreToolUse');
    assert.equal(rec.session_id, 'hook-test');
    assert.equal(rec.subagent_type, 'app-dev');
    assert.equal(text.includes('SECRET PROMPT TEXT'), false, 'prompt text must never be stored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook-logger exits 0 and writes nothing on empty stdin', () => {
  const { result, file, dir } = runHook('');
  try {
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook-logger exits 0 and writes nothing on invalid JSON', () => {
  const { result, file, dir } = runHook('{not json');
  try {
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook-logger ignores JSON that is not a hook payload', () => {
  const { result, file, dir } = runHook(JSON.stringify({ foo: 'bar' }));
  try {
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- stdin cap (1 MiB) ----------

const CAP = 1024 * 1024;

/** A PostToolUse payload of a Read call whose tool_response is `bytes` long (as a JSON text). */
function bigReadPayload(bytes, extra = {}) {
  return JSON.stringify({
    session_id: 'hook-big',
    cwd: '/home/user/project',
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_use_id: 'toolu_big_1',
    tool_input: { file_path: '/tmp/huge.txt' },
    // Text that looks like top-level fields: it must never be picked up by the cut-payload scanner
    tool_response: { file: { content: `"tool_name":"Evil","hook_event_name":"Stop" ${'x'.repeat(bytes)}` } },
    ...extra,
  });
}

test('hook-logger: a payload over the cap is logged as ONE compact record with truncated: true', () => {
  const input = bigReadPayload(3 * CAP);
  assert.ok(input.length > 3 * CAP);
  const started = Date.now();
  const { result, file, dir } = runHook(input);
  try {
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '', 'hook must not write to stdout');
    assert.ok(Date.now() - started < 4000, 'must not hang on a large payload');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].length < 1000, `record must stay compact (was ${lines[0].length} chars)`);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.truncated, true);
    assert.equal(rec.event, 'PostToolUse');
    assert.equal(rec.tool_name, 'Read', 'tool_name comes from the head, not from the text inside tool_response');
    assert.equal(rec.session_id, 'hook-big');
    assert.equal(rec.tool_use_id, 'toolu_big_1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook-logger: a payload under the cap has no truncated flag', () => {
  const { result, file, dir } = runHook(bigReadPayload(CAP / 2));
  try {
    assert.equal(result.status, 0);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    assert.equal(rec.tool_name, 'Read');
    assert.equal('truncated' in rec, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook-logger: an oversized payload that is not JSON at all writes nothing and still exits 0 quietly', () => {
  const { result, file, dir } = runHook('x'.repeat(2 * CAP));
  try {
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook-logger: an oversized payload cut inside its first string field writes nothing and exits 0', () => {
  // The cap falls inside the very first value: no complete hook_event_name, so there is no record
  const { result, file, dir } = runHook(`{"session_id":"${'a'.repeat(2 * CAP)}"}`);
  try {
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook-logger: an oversized Agent call keeps subagent_type from tool_input (head of the payload)', () => {
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Agent', tool_use_id: 'toolu_a',
    tool_input: { subagent_type: 'app-dev', description: 'big job', prompt: 'p'.repeat(2 * CAP) },
  });
  const { result, file, dir } = runHook(input);
  try {
    assert.equal(result.status, 0);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    assert.equal(rec.truncated, true);
    assert.equal(rec.subagent_type, 'app-dev');
    assert.equal(rec.description, 'big job');
    assert.equal(JSON.stringify(rec).includes('ppppp'), false, 'the prompt is never stored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook-logger: still exits 0 quietly when the events file cannot be written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-hook-'));
  // The "file" is a directory, so appendFileSync fails
  const file = path.join(dir, 'events.jsonl');
  fs.mkdirSync(file);
  try {
    const result = spawnSync(process.execPath, [HOOK], {
      input: bigReadPayload(2 * CAP), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, DASHBOARD_EVENTS_FILE: file },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- cut-payload scanner (lib/partial-json.js) ----------

const { scanPartialPayload } = require('../lib/partial-json');

test('scanPartialPayload: collects only complete top-level / tool_input / tool_response strings from a cut text', () => {
  const full = JSON.stringify({
    session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: 'qa', description: 'review', nested: { subagent_type: 'NOPE' }, list: ['subagent_type'] },
    tool_response: { agentId: 'ag1', status: 'ok' },
    last_assistant_message: 'tail message',
  });
  const whole = scanPartialPayload(full);
  assert.deepEqual(whole, {
    session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Agent',
    tool_input: { subagent_type: 'qa', description: 'review' },
    tool_response: { agentId: 'ag1', status: 'ok' },
    last_assistant_message: 'tail message',
  });
  // Cut inside last_assistant_message: that unterminated value is dropped, the rest is kept
  const cut = scanPartialPayload(full.slice(0, full.indexOf('tail') + 2));
  assert.equal(cut.last_assistant_message, undefined);
  assert.equal(cut.tool_response.agentId, 'ag1');
  // Garbage and non-strings never throw
  for (const v of ['', 'garbage', '{', '{"a":', null, undefined, 5]) assert.deepEqual(scanPartialPayload(v), {});
});
