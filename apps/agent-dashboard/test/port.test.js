'use strict';
/**
 * port.test.js - the HTTP port comes from DASHBOARD_PORT only (default 4317); a generic PORT env var is ignored.
 *   - lib/config.js is checked in child processes (config is read once at load). DASHBOARD_PORT=0 means "ephemeral";
 *     anything that is not a whole number 0-65535 is an error (no silent fallback to 4317).
 *   - One real `node server.js` child is started on DASHBOARD_PORT=0 (the OS picks the port, so there is no
 *     check-then-listen race); the real port is read from the startup banner. This checks that the banner shows the real
 *     port and that the Host/Origin guard follows the port the server actually listens on.
 *   - `node server.js` with an invalid DASHBOARD_PORT exits 1 with one clear line (no stack trace).
 * Every child gets temp DASHBOARD_* paths, so nothing is written to data/. Listens on 127.0.0.1 only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { tempWorkspaceOpts } = require('./helpers/temp-paths');

const ROOT = path.join(__dirname, '..');

/** True once the child process has ended (normal exit or killed by a signal). */
function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Stop a child and wait until it is really gone: SIGTERM first, SIGKILL after termMs, and give up waiting
 * (rejecting) after killMs more. Never hangs; leaves no process behind unless SIGKILL itself fails.
 */
function stopChild(child, termMs = 3000, killMs = 3000) {
  return new Promise((resolve, reject) => {
    if (hasExited(child)) return resolve();
    let killTimer;
    let giveUpTimer;
    const done = () => { clearTimeout(killTimer); clearTimeout(giveUpTimer); resolve(); };
    child.once('exit', done);
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (hasExited(child)) return done();
      child.kill('SIGKILL');
      giveUpTimer = setTimeout(() => {
        if (hasExited(child)) return done();
        reject(new Error(`child ${child.pid} still alive after SIGKILL`));
      }, killMs);
    }, termMs);
  });
}

/** Child env: temp paths for the five data overrides, plus the given port variables (undefined = unset). */
function childEnv(dir, extra) {
  const o = tempWorkspaceOpts(dir);
  const env = {
    ...process.env,
    DASHBOARD_EVENTS_FILE: o.eventsFile,
    DASHBOARD_WORKSPACE_EVENTS_FILE: o.workspaceEventsFile,
    DASHBOARD_COMMANDS_FILE: o.commandsFile,
    DASHBOARD_UPLOADS_DIR: o.uploadsDir,
    DASHBOARD_SECRETARY_QUEUE_DIR: o.secretaryQueueDir,
  };
  delete env.DASHBOARD_PORT;
  delete env.PORT;
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) env[k] = v;
  return env;
}

/** Read config.PORT and config.PORT_ERROR in a fresh process. Loading config never throws. */
function runConfig(dir, extra) {
  const res = spawnSync(process.execPath, ['-e',
    "const c = require('./lib/config'); process.stdout.write(JSON.stringify({ port: c.PORT, error: c.PORT_ERROR }))"], {
    cwd: ROOT, env: childEnv(dir, extra), encoding: 'utf8',
  });
  assert.equal(res.status, 0, `config must load even with a bad value: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

/** config.PORT in a fresh process (must be valid). */
function configPort(dir, extra) {
  const res = runConfig(dir, extra);
  assert.equal(res.error, null);
  return res.port;
}

/** GET / with an optional Origin header; resolves to the status code. */
function get(port, origin) {
  return new Promise((resolve, reject) => {
    const headers = origin ? { Origin: origin } : {};
    http.get({ host: '127.0.0.1', port, path: '/', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

test('config.PORT: default 4317, DASHBOARD_PORT is honored, a generic PORT is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-port-'));
  try {
    assert.equal(configPort(dir, {}), 4317, 'default');
    assert.equal(configPort(dir, { PORT: '5555' }), 4317, 'PORT alone does not change the port');
    assert.equal(configPort(dir, { DASHBOARD_PORT: '6123' }), 6123, 'DASHBOARD_PORT works');
    assert.equal(configPort(dir, { DASHBOARD_PORT: '6123', PORT: '5555' }), 6123, 'DASHBOARD_PORT wins over PORT');
    assert.equal(configPort(dir, { DASHBOARD_PORT: '' }), 4317, 'an empty value means "not set"');
    assert.equal(configPort(dir, { DASHBOARD_PORT: ' 6123 ' }), 6123, 'surrounding spaces are ignored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config.PORT: DASHBOARD_PORT=0 is ephemeral (kept as 0, not replaced by 4317); the range edges 1 and 65535 are valid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-port-'));
  try {
    assert.equal(configPort(dir, { DASHBOARD_PORT: '0' }), 0);
    assert.equal(configPort(dir, { DASHBOARD_PORT: '1' }), 1);
    assert.equal(configPort(dir, { DASHBOARD_PORT: '65535' }), 65535);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config.PORT: an invalid DASHBOARD_PORT is reported in PORT_ERROR with PORT null (text, decimal, negative, out of range, hex, trailing text)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-port-'));
  try {
    for (const bad of ['abc', '43.17', '-1', '65536', '99999', '100000', '0x10', '1e3', '4317abc', '12 34']) {
      const res = runConfig(dir, { DASHBOARD_PORT: bad });
      assert.equal(res.port, null, `"${bad}" must be rejected (no fallback to 4317)`);
      assert.match(res.error, /DASHBOARD_PORT must be a whole number from 0 to 65535/, `"${bad}" gives a clear message`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('node server.js with an invalid DASHBOARD_PORT exits 1 with one clear line and no stack trace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-port-'));
  try {
    const res = spawnSync(process.execPath, ['server.js'], {
      cwd: ROOT, env: childEnv(dir, { DASHBOARD_PORT: '70000' }), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /^\[error\] DASHBOARD_PORT must be a whole number from 0 to 65535/);
    assert.equal(/\n\s+at /.test(res.stderr), false, `no stack trace: ${res.stderr}`);
    assert.equal(res.stdout, '', 'nothing was started');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hook-logger.js is not affected by a bad DASHBOARD_PORT: exit 0, no output, the event is still written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-port-'));
  try {
    const env = childEnv(dir, { DASHBOARD_PORT: 'not-a-port' });
    const res = spawnSync(process.execPath, ['hook-logger.js'], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: dir, prompt: 'hi' }),
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.equal(res.stderr, '');
    const lines = fs.readFileSync(env.DASHBOARD_EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'one event line was written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('node server.js on DASHBOARD_PORT=0 listens on an OS-picked port, the banner shows it, and the Origin/Host guard follows it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-port-'));
  const other = 5555; // value of the ignored generic PORT; never connected to, only used as a (rejected) Origin
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: childEnv(dir, { DASHBOARD_PORT: '0', PORT: String(other) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // Wait for the startup banner (it prints the real port; the first banner line ends with a newline)
    const banner = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 10000);
      child.stdout.on('data', (d) => {
        out += d;
        if (/Workspace \(main\): http:\/\/127\.0\.0\.1:\d+\/\n/.test(out)) { clearTimeout(timer); resolve(out); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}): ${out}`)); });
    });
    const port = Number(/Workspace \(main\): http:\/\/127\.0\.0\.1:(\d+)\//.exec(banner)[1]);
    assert.ok(port > 0 && port <= 65535, `banner shows a real port, not 0: ${banner}`);
    assert.notEqual(port, 4317, 'DASHBOARD_PORT=0 must not fall back to the default port');
    assert.notEqual(port, other, 'the generic PORT is ignored');
    assert.equal(await get(port), 200, 'no Origin header');
    assert.equal(await get(port, `http://127.0.0.1:${port}`), 200, 'own origin is accepted');
    assert.equal(await get(port, `http://localhost:${port}`), 200, 'own origin (localhost) is accepted');
    assert.equal(await get(port, `http://127.0.0.1:${other}`), 403, 'the ignored PORT value is not an accepted origin');
    assert.equal(await get(port, 'http://127.0.0.1:4317'), 403, 'the old default port is not an accepted origin');
  } finally {
    try {
      await stopChild(child); // SIGTERM -> SIGKILL, bounded wait
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
