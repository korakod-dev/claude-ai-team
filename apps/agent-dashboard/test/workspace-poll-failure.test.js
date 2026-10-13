'use strict';
/**
 * workspace-poll-failure.test.js - the hub must survive an events file it cannot read, and a failing poll
 * after a successful append must not fail the request.
 *   - startup with an unreadable events file (a directory -> EISDIR): the hub is created, the failure is
 *     logged once as "could not read the event files", the other source still works
 *   - the file watcher / timer poll cannot throw out of the timer (file replaced by a directory while running)
 *   - a failed poll is retried on the next queue-timer tick, even when the file does not change again (chmod 000 -> 644)
 *   - publish(): poll fails AFTER a successful append -> still 201, the line is in the file exactly once, no
 *     "could not write event" warning, no duplicate on retry. An append failure still throws (nothing written).
 *   - a failure that lasts several queue ticks is logged exactly once, with NO false "recovered" line (the queue
 *     sync must not close a poll failure); the real recovery is logged exactly once, when the poll works again
 *   - a reset detected by the hook file reader whose read fails is not lost: the next good poll still clears the
 *     old events from the replay buffer
 *   - the queue timer polls the event files on EVERY tick, so a change made between the startup poll and the first stat of
 *     fs.watchFile (which runs asynchronously on the libuv threadpool) is still seen (regression of a flaky test)
 * Temp files only (test/helpers/temp-paths.js). Real timers (watchFile + queue timer) with small injected intervals
 * (hub option `timing.watchIntervalMs` / `timing.queueCheckMs`), so every test finishes in well under a second.
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
const { createServer } = require('../server');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until fn() is truthy or the time is up. */
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

/** Capture console.error / console.log lines while a test runs. restore() puts the originals back. */
function captureConsole() {
  const errors = [];
  const logs = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args) => { errors.push(args.join(' ')); };
  console.log = (...args) => { logs.push(args.join(' ')); };
  return { errors, logs, restore() { console.error = origError; console.log = origLog; } };
}

/** Temp folder + options for one hub / server. */
function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-pollfail-'));
  const opts = tempWorkspaceOpts(dir);
  return { dir, opts };
}

// Small real-timer intervals for the hub under test (production: 700 ms watcher, 2000 ms queue timer)
const FAST = { watchIntervalMs: 50, queueCheckMs: 100 };

/** A hub on the given options with one fake SSE client; returns the events it received. */
function openHub(opts, timing = FAST) {
  const hub = createWorkspaceHub({
    timing,
    eventsFile: opts.eventsFile,
    workspaceFile: opts.workspaceEventsFile,
    commandsFile: opts.commandsFile,
    uploadsDir: opts.uploadsDir,
    secretaryQueueDir: opts.secretaryQueueDir,
  });
  const chunks = [];
  hub.attach({ on() {} }, { write: (s) => chunks.push(s), on() {}, end() {} });
  const events = () => chunks.filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice('data: '.length)));
  return { hub, events };
}

const pollErrors = (cap) => cap.errors.filter((line) => line.includes('could not read the event files'));
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

test('startup with an events file that is a directory (EISDIR): the hub starts, logs once, and the other source still works', async () => {
  const { dir, opts } = makeEnv();
  const cap = captureConsole();
  let ctx = null;
  try {
    fs.mkdirSync(opts.eventsFile); // not a file: reading it throws EISDIR (not ENOENT)
    fs.writeFileSync(opts.workspaceEventsFile,
      `${JSON.stringify({ ts: '2026-10-13T10:00:00.000Z', agent: 'pm', status: 'WORKING', message: 'still readable' })}\n`);

    ctx = openHub(opts); // must not throw
    assert.equal(pollErrors(cap).length, 1, 'the failure is logged once');
    assert.match(pollErrors(cap)[0], /startup/);
    assert.match(pollErrors(cap)[0], /EISDIR/);
    // The workspace file is read although the hook file failed
    assert.deepEqual(ctx.events().map((e) => e.message), ['still readable']);

    // Same failure on a manual poll: hub.poll() still reports it to a direct caller (it throws), never silently
    assert.throws(() => ctx.hub.poll(), /EISDIR/);
  } finally {
    cap.restore();
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the watcher timer cannot crash the process: a file replaced by a directory while running is logged, not thrown', async () => {
  const { dir, opts } = makeEnv();
  const cap = captureConsole();
  let ctx = null;
  try {
    const rec = (prompt) => `${JSON.stringify({ ts: '2026-10-13T10:00:00.000Z', event: 'UserPromptSubmit', agent_type: 'secretary', prompt })}\n`;
    fs.writeFileSync(opts.eventsFile, rec('first'));
    // The queue timer is set to 60 s here, so ONLY the file watcher can report the replacement (the path under test)
    ctx = openHub(opts, { watchIntervalMs: 50, queueCheckMs: 60000 });
    assert.equal(pollErrors(cap).length, 0, 'no failure at start');
    const startCount = ctx.events().length;

    // Wait until the watcher is ARMED: fs.watchFile takes its first stat asynchronously (libuv threadpool). A change made
    // before that stat is invisible to it. An append whose event arrives proves the watcher saw a stat before the append.
    // One append per attempt, then a pause longer than the debounce (150 ms): appending faster would keep resetting the debounce.
    let armed = false;
    for (let attempt = 0; attempt < 8 && !armed; attempt++) {
      fs.appendFileSync(opts.eventsFile, rec(`arm-${attempt}`));
      armed = await waitFor(() => ctx.events().length > startCount, 500);
    }
    assert.ok(armed, 'the watcher is armed (an append reached the stream)');

    // Replace the file with a directory: stat works, reading throws EISDIR inside the debounced timer
    fs.rmSync(opts.eventsFile);
    fs.mkdirSync(opts.eventsFile);
    // An uncaught exception from the timer would fail this test (node:test reports it)
    assert.ok(await waitFor(() => pollErrors(cap).length > 0, 4000), 'the watcher poll failure is logged');
    assert.match(pollErrors(cap)[0], /file watcher/);
    assert.match(pollErrors(cap)[0], /EISDIR/);
    await sleep(300);
    assert.equal(pollErrors(cap).length, 1, 'the same failure is not logged again');
  } finally {
    cap.restore();
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startup window: with a watcher that never fires, the queue timer still sees an append and a replacement made right after startup', async () => {
  const { dir, opts } = makeEnv();
  const cap = captureConsole();
  let ctx = null;
  try {
    const rec = (prompt) => `${JSON.stringify({ ts: '2026-10-13T10:00:00.000Z', event: 'UserPromptSubmit', agent_type: 'secretary', prompt })}\n`;
    fs.writeFileSync(opts.eventsFile, rec('before'));
    // watchIntervalMs of one hour = the watcher never reports anything during this test. This is exactly what the
    // watcher looks like when its first stat (threadpool) happens after the change below.
    ctx = openHub(opts, { watchIntervalMs: 3600000, queueCheckMs: 50 });
    const startCount = ctx.events().length;

    fs.appendFileSync(opts.eventsFile, rec('after-start'));
    assert.ok(await waitFor(() => ctx.events().length > startCount, 3000), 'the append was picked up by the queue timer');

    fs.rmSync(opts.eventsFile);
    fs.mkdirSync(opts.eventsFile);
    assert.ok(await waitFor(() => pollErrors(cap).length > 0, 3000), 'the replacement is logged by the queue timer');
    assert.match(pollErrors(cap)[0], /queue timer|retry/);
    assert.match(pollErrors(cap)[0], /EISDIR/);
    await sleep(400); // several more ticks
    assert.equal(pollErrors(cap).length, 1, 'polling on every tick does not repeat the failure line');
    assert.equal(cap.errors.length, 1, 'no other error line');
  } finally {
    cap.restore();
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('polling every tick is quiet when nothing is wrong: no log lines and no events while the files do not change', async () => {
  const { dir, opts } = makeEnv();
  const cap = captureConsole();
  let ctx = null;
  try {
    ctx = openHub(opts, { watchIntervalMs: 3600000, queueCheckMs: 20 });
    const startCount = ctx.events().length;
    await sleep(400); // ~20 ticks over files that do not exist / do not change
    assert.equal(ctx.events().length, startCount, 'no event is invented by polling');
    assert.deepEqual(cap.errors, [], 'no error lines');
    assert.deepEqual(cap.logs, [], 'no log lines (no false "recovered")');
  } finally {
    cap.restore();
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('polling every tick stays cheap: an idle tick re-reads no file content (only the first-line fingerprint), whatever the file size', async () => {
  const { dir, opts } = makeEnv();
  const cap = captureConsole();
  const realRead = fs.readSync;
  const reads = [];
  let ctx = null;
  try {
    // A large events file: 3000 records (about 400 KB). A tick that re-read it would show up as a big readSync.
    const rec = (i) => `${JSON.stringify({ ts: '2026-10-13T10:00:00.000Z', event: 'UserPromptSubmit', agent_type: 'secretary', prompt: `p${i}` })}\n`;
    fs.writeFileSync(opts.eventsFile, Array.from({ length: 3000 }, (_v, i) => rec(i)).join(''));
    ctx = openHub(opts, { watchIntervalMs: 3600000, queueCheckMs: 20 });   // the watcher is silent: only the queue timer polls
    const firstLine = rec(0).length;
    fs.readSync = function spy(fd, buffer, offset, length, position) {
      reads.push({ length, position });
      return realRead.call(this, fd, buffer, offset, length, position);
    };
    await sleep(400);                                                       // about 20 idle ticks
    fs.readSync = realRead;
    assert.ok(reads.length > 0, 'the ticks did poll (they check the first-line fingerprint)');
    assert.ok(reads.every((r) => r.length <= firstLine + 1 && r.position === 0), 'only the first line is read, never the file body');
    assert.deepEqual(cap.errors, []);
    assert.deepEqual(cap.logs, []);
  } finally {
    fs.readSync = realRead;
    cap.restore();
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed poll is retried on the next queue tick even when the file does not change (EACCES, then readable again)', { skip: isRoot ? 'root can read any file' : false }, async () => {
  const { dir, opts } = makeEnv();
  const cap = captureConsole();
  let ctx = null;
  try {
    const line = { ts: '2026-10-13T10:00:00.000Z', agent: 'qa', status: 'WORKING', message: 'after retry' };
    fs.writeFileSync(opts.workspaceEventsFile, `${JSON.stringify(line)}\n`);
    fs.chmodSync(opts.workspaceEventsFile, 0o000); // exists, stat works, open fails with EACCES

    ctx = openHub(opts); // must not throw
    assert.equal(pollErrors(cap).length, 1);
    assert.match(pollErrors(cap)[0], /EACCES/);
    assert.deepEqual(ctx.events(), []);

    // chmod changes only ctime: mtime and size stay the same, so the file watcher stays silent.
    // Only the queue timer (every tick polls the event files) can pick the file up.
    fs.chmodSync(opts.workspaceEventsFile, 0o644);
    assert.ok(await waitFor(() => ctx.events().some((e) => e.message === 'after retry'), 3000), 'the retry read the file');
    assert.ok(cap.logs.some((l) => l.includes('recovered')), 'one recovery line is logged');
  } finally {
    cap.restore();
    if (ctx) ctx.hub.close();
    try { fs.chmodSync(opts.workspaceEventsFile, 0o644); } catch (_err) { /* already readable */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publish: a poll failure AFTER a successful append still returns 201, writes the line once, and logs no "could not write" warning', async () => {
  const { dir, opts } = makeEnv();
  const cap = captureConsole();
  let ctx = null;
  try {
    fs.mkdirSync(opts.eventsFile); // the hook source cannot be read, so every poll throws
    ctx = openHub(opts);

    const result = ctx.hub.publish({ agent: 'app-dev', status: 'WORKING', message: 'written once' });
    assert.equal(result.status, 201, 'the request does not fail');
    assert.equal(result.body.ok, true);

    const lines = fs.readFileSync(opts.workspaceEventsFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one line in the file (a client retry is not needed)');
    assert.equal(JSON.parse(lines[0]).message, 'written once');
    // The workspace source was still read by that poll, so the event reached the stream at once
    assert.deepEqual(ctx.events().map((e) => e.message), ['written once']);
    assert.equal(cap.errors.some((l) => l.includes('could not write event')), false, 'no false "could not be written" warning');

    // submitCommand() goes through publishSafely(): the command is stored, no warning in the body
    const cmd = ctx.hub.submitCommand({ text: 'command during a read failure' });
    assert.equal(cmd.status, 201);
    assert.equal(cmd.body.warning, undefined, 'no warning: the events were written');
    assert.equal(cap.errors.some((l) => l.includes('could not write event')), false);
  } finally {
    cap.restore();
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/events returns 201 when the append worked but the poll failed (no duplicate on the one request)', async () => {
  const { dir, opts } = makeEnv();
  const cap = captureConsole();
  const server = createServer({ ...opts, workspaceToken: 'poll-fail-token-0123456789abcdef' });
  try {
    fs.mkdirSync(opts.eventsFile); // created after createServer(): the first poll after the append throws
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const post = (payload) => new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Authorization: 'Bearer poll-fail-token-0123456789abcdef',
        },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end(data);
    });

    const res = await post({ agent: 'qa', status: 'COMPLETED', message: 'http once' });
    assert.equal(res.status, 201, `POST must not be 500 (got ${res.status}: ${res.body})`);
    const lines = fs.readFileSync(opts.workspaceEventsFile, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
  } finally {
    cap.restore();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publish: an APPEND failure still throws (nothing was written, so the caller can report it and a retry is safe)', () => {
  const { dir, opts } = makeEnv();
  const cap = captureConsole();
  let ctx = null;
  try {
    // The parent of the workspace log is a regular file, so mkdir/append fails with ENOTDIR / EEXIST
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    ctx = openHub({ ...opts, workspaceEventsFile: path.join(blocker, 'ws.jsonl') });
    assert.throws(() => ctx.hub.publish({ agent: 'qa', status: 'WORKING', message: 'nope' }));
    assert.equal(ctx.events().length, 0, 'nothing was emitted');
  } finally {
    cap.restore();
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a read failure that lasts 3+ queue ticks: exactly one failure line, no false "recovered"; fixing the file gives exactly one "recovered"', async () => {
  const { dir, opts } = makeEnv();
  const cap = captureConsole();
  let ctx = null;
  try {
    fs.mkdirSync(opts.eventsFile); // EISDIR on every poll
    ctx = openHub(opts);
    assert.equal(pollErrors(cap).length, 1, 'logged once at startup');

    // Queue timer is 100 ms here: wait for at least 3 ticks (the old code alternated "could not read" / "recovered" every tick)
    await sleep(450);
    assert.equal(pollErrors(cap).length, 1, 'still exactly one failure line after 3+ ticks');
    assert.equal(cap.errors.length, 1, 'no other error line either');
    assert.equal(cap.logs.filter((l) => l.includes('recovered')).length, 0, 'no false "recovered" while the file is still unreadable');

    // Fix the file: the next tick polls successfully and logs exactly one recovery
    fs.rmSync(opts.eventsFile, { recursive: true });
    fs.writeFileSync(opts.eventsFile,
      `${JSON.stringify({ ts: '2026-10-13T10:00:00.000Z', event: 'UserPromptSubmit', agent_type: 'secretary' })}\n`);
    assert.ok(await waitFor(() => cap.logs.some((l) => l.includes('recovered')), 3000), 'the recovery is logged');
    await sleep(350); // three more ticks: nothing more may be logged
    assert.equal(cap.logs.filter((l) => l.includes('recovered')).length, 1, 'exactly one recovery line');
    assert.equal(cap.errors.length, 1, 'no new error line after recovery');
  } finally {
    cap.restore();
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a hook file replaced while its read fails: the next good poll still drops the old events (reset not lost)', () => {
  const { dir, opts } = makeEnv();
  const cap = captureConsole();
  const realOpen = fs.openSync;
  let ctx = null;
  try {
    const rec = (prompt) => `${JSON.stringify({ ts: '2026-10-13T10:00:00.000Z', event: 'UserPromptSubmit', agent_type: 'secretary', prompt })}\n`;
    fs.writeFileSync(opts.eventsFile, rec('old-one') + rec('old-two'));
    ctx = openHub(opts);

    // Replacement file (new inode, larger); the first read of it fails
    const next = path.join(dir, 'next.jsonl');
    fs.writeFileSync(next, rec('new-one') + rec('new-two') + rec('new-three'));
    fs.renameSync(next, opts.eventsFile);
    fs.openSync = (p, ...rest) => {
      if (p === opts.eventsFile) throw Object.assign(new Error('EACCES: test'), { code: 'EACCES' });
      return realOpen(p, ...rest);
    };
    assert.throws(() => ctx.hub.poll(), /EACCES/);
    fs.openSync = realOpen;
    assert.doesNotThrow(() => ctx.hub.poll());

    // A client that connects now must replay only the NEW file, not the old events mixed in
    const chunks = [];
    ctx.hub.attach({ on() {} }, { write: (c) => chunks.push(c), on() {}, end() {} });
    const replay = chunks.filter((c) => c.startsWith('data: ')).map((c) => c.slice(6));
    assert.equal(replay.length, 3, `3 events from the new file only (got ${replay.length})`);
    assert.equal(replay.some((l) => l.includes('old-')), false, 'no event of the old file is left in the buffer');
  } finally {
    fs.openSync = realOpen;
    cap.restore();
    if (ctx) ctx.hub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
