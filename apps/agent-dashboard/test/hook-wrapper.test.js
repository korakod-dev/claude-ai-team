'use strict';
/**
 * hook-wrapper.test.js - bin/hook.sh (POSIX wrapper that finds node and runs hook-logger.js).
 * Every case runs the script in a child /bin/sh with an explicit, minimal env and a fake HOME, so the real nvm folder, the
 * real PATH and the real data/ folder are never involved (events and the failure log go to a temp folder; port 4317 unused).
 *   - node is found on PATH
 *   - node is found through the nvm default alias (exact version, major only), and the NEWEST install wins when the alias
 *     is a name ("lts/*"), absent, or points to a version that is not installed
 *   - the common fixed paths (step 4) are tried last, from DASHBOARD_NODE_FALLBACKS in the tests
 *   - PATH safety: an empty / unset / "." PATH never runs ./node from the current folder; relative fallback entries are ignored
 *   - always exit 0 and never write to stdout / stderr: node missing, node crashing, node printing, hook-logger.js missing
 *   - stdin reaches hook-logger.js unchanged (the record is written)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WRAPPER = path.join(__dirname, '..', 'bin', 'hook.sh');
const PAYLOAD = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'wrapper-test' });

/** Temp sandbox: fake HOME with optional nvm tree, an events file path, a wrapper-log path. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-wrapper-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    dir,
    home,
    events: path.join(dir, 'events.jsonl'),
    log: path.join(dir, 'wrapper.log'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Install a fake nvm version whose node is the real node, wrapped so we can tell which version ran. */
function installNvmNode(home, version, { body } = {}) {
  const bin = path.join(home, '.nvm', 'versions', 'node', version, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const node = path.join(bin, 'node');
  // The fake node records its version name, then runs the real node with the same arguments (stdin is inherited)
  fs.writeFileSync(node, body || `#!/bin/sh\necho "${version}" >> "$WRAPPER_TEST_TRACE"\nexec "${process.execPath}" "$@"\n`);
  fs.chmodSync(node, 0o755);
  return node;
}

function setDefaultAlias(home, value) {
  const dir = path.join(home, '.nvm', 'alias');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'default'), `${value}\n`);
}

/** Run the wrapper. PATH is minimal and has no node (system tools only), unless `pathExtra` is given. */
// pathValue: undefined = the default minimal PATH, null = PATH not set at all, any string = that exact PATH (may be empty).
// cwd: working folder of the wrapper process.
function run(sb, { pathExtra = '', input = PAYLOAD, wrapper = WRAPPER, fallbacks, pathValue, cwd } = {}) {
  const trace = path.join(sb.dir, 'trace.txt');
  const pathEnv = pathValue === null ? {} : { PATH: pathValue === undefined ? `${pathExtra ? `${pathExtra}:` : ''}/usr/bin:/bin` : pathValue };
  const result = spawnSync('/bin/sh', [wrapper], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    cwd,
    env: {
      ...pathEnv,
      HOME: sb.home,
      DASHBOARD_EVENTS_FILE: sb.events,
      DASHBOARD_WRAPPER_LOG: sb.log,
      DASHBOARD_NODE_FALLBACKS: fallbacks === undefined ? NO_FALLBACK : fallbacks,
      WRAPPER_TEST_TRACE: trace,
    },
  });
  const traced = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean) : [];
  return { result, traced };
}

const readEvents = (sb) => (fs.existsSync(sb.events) ? fs.readFileSync(sb.events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// The fixed-path step (4) is pointed at a path that does not exist, so a Homebrew / system node on this machine cannot
// change the result of the cases below. Step 4 itself has its own test.
const NO_FALLBACK = '/nonexistent/dash-test/node';

test('wrapper: node on PATH is used, the record is written, stdout is empty, exit 0', () => {
  const sb = sandbox();
  try {
    // A PATH dir with a "node" (a symlink to the running node)
    const binDir = path.join(sb.dir, 'pathbin');
    fs.mkdirSync(binDir);
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
    const { result } = run(sb, { pathExtra: binDir });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    const recs = readEvents(sb);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].session_id, 'wrapper-test');
    assert.equal(recs[0].event, 'SessionStart');
  } finally {
    sb.cleanup();
  }
});

test('wrapper: PATH wins over nvm (step 1 before step 2)', () => {
  const sb = sandbox();
  try {
    installNvmNode(sb.home, 'v22.1.0');
    setDefaultAlias(sb.home, 'v22.1.0');
    const binDir = path.join(sb.dir, 'pathbin');
    fs.mkdirSync(binDir);
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
    const { result, traced } = run(sb, { pathExtra: binDir });
    assert.equal(result.status, 0);
    assert.deepEqual(traced, [], 'the nvm node was not used');
    assert.equal(readEvents(sb).length, 1);
  } finally {
    sb.cleanup();
  }
});

test('wrapper: nvm default alias with an exact version picks that install (not the newest)', () => {
  const sb = sandbox();
  try {
    installNvmNode(sb.home, 'v20.19.5');
    installNvmNode(sb.home, 'v22.22.2');
    setDefaultAlias(sb.home, 'v20.19.5');
    const { result, traced } = run(sb);
    assert.equal(result.status, 0);
    assert.deepEqual(traced, ['v20.19.5']);
    assert.equal(readEvents(sb).length, 1);
  } finally {
    sb.cleanup();
  }
});

test('wrapper: nvm default alias "22" (major only) picks the newest v22.x, numerically (v22.10 > v22.9)', () => {
  const sb = sandbox();
  try {
    for (const v of ['v20.19.5', 'v22.9.0', 'v22.10.1', 'v22.2.0']) installNvmNode(sb.home, v);
    setDefaultAlias(sb.home, '22');
    const { result, traced } = run(sb);
    assert.equal(result.status, 0);
    assert.deepEqual(traced, ['v22.10.1']);
    assert.equal(readEvents(sb).length, 1);
  } finally {
    sb.cleanup();
  }
});

test('wrapper: after an nvm update the old pinned version is gone and the new one is found (the original problem)', () => {
  const sb = sandbox();
  try {
    installNvmNode(sb.home, 'v22.23.0');   // v22.22.2 no longer exists
    setDefaultAlias(sb.home, '22');
    const { result, traced } = run(sb);
    assert.equal(result.status, 0);
    assert.deepEqual(traced, ['v22.23.0']);
    assert.equal(readEvents(sb).length, 1);
  } finally {
    sb.cleanup();
  }
});

test('wrapper: alias is a name ("lts/*"), missing, or not installed -> the newest nvm install is used', () => {
  for (const alias of ['lts/*', 'node', null, '18']) {
    const sb = sandbox();
    try {
      installNvmNode(sb.home, 'v20.19.5');
      installNvmNode(sb.home, 'v22.22.2');
      if (alias !== null) setDefaultAlias(sb.home, alias);
      const { result, traced } = run(sb);
      assert.equal(result.status, 0, `alias ${alias}`);
      assert.deepEqual(traced, ['v22.22.2'], `alias ${alias}`);
      assert.equal(readEvents(sb).length, 1, `alias ${alias}`);
    } finally {
      sb.cleanup();
    }
  }
});

test('wrapper: no node anywhere -> exit 0, silent, nothing logged as an event, one line in the wrapper log', () => {
  const sb = sandbox();
  try {
    const { result } = run(sb);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(readEvents(sb).length, 0);
    const log = fs.readFileSync(sb.log, 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
    assert.match(log[0], /node not found; hook skipped$/);
  } finally {
    sb.cleanup();
  }
});

test('wrapper: fixed-path fallback is used when PATH and nvm have no node, but only after nvm', () => {
  const sb = sandbox();
  try {
    const fixed = path.join(sb.dir, 'fixed', 'node');
    fs.mkdirSync(path.dirname(fixed));
    fs.writeFileSync(fixed, `#!/bin/sh\necho fixed >> "$WRAPPER_TEST_TRACE"\nexec "${process.execPath}" "$@"\n`);
    fs.chmodSync(fixed, 0o755);
    // a missing first entry, then the real one (list order and skipping of missing entries)
    let { result, traced } = run(sb, { fallbacks: `/nonexistent/a/node:${fixed}` });
    assert.equal(result.status, 0);
    assert.deepEqual(traced, ['fixed']);
    assert.equal(readEvents(sb).length, 1);
    // with an nvm install present, nvm wins over the fixed path
    installNvmNode(sb.home, 'v22.22.2');
    ({ result, traced } = run(sb, { fallbacks: fixed }));
    assert.equal(result.status, 0);
    assert.deepEqual(traced.slice(1), ['v22.22.2'], 'nvm node ran, not the fixed one');
  } finally {
    sb.cleanup();
  }
});

test('wrapper: node that crashes (exit 3) or prints to stdout/stderr -> still exit 0 and silent', () => {
  const sb = sandbox();
  try {
    const binDir = path.join(sb.dir, 'pathbin');
    fs.mkdirSync(binDir);
    const fake = path.join(binDir, 'node');
    fs.writeFileSync(fake, '#!/bin/sh\necho "noise on stdout"\necho "noise on stderr" >&2\nexit 3\n');
    fs.chmodSync(fake, 0o755);
    const { result } = run(sb, { pathExtra: binDir });
    assert.equal(result.status, 0, 'exit status of node is ignored');
    assert.equal(result.stdout, '', 'node output is discarded');
    assert.equal(result.stderr, '');
  } finally {
    sb.cleanup();
  }
});

test('wrapper: hook-logger.js missing -> exit 0 and silent (a copy of the wrapper in a folder without the logger)', () => {
  const sb = sandbox();
  try {
    const appDir = path.join(sb.dir, 'app');
    fs.mkdirSync(path.join(appDir, 'bin'), { recursive: true });
    const copy = path.join(appDir, 'bin', 'hook.sh');
    fs.copyFileSync(WRAPPER, copy);
    const binDir = path.join(sb.dir, 'pathbin');
    fs.mkdirSync(binDir);
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
    const { result } = run(sb, { pathExtra: binDir, wrapper: copy });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(readEvents(sb).length, 0);
  } finally {
    sb.cleanup();
  }
});

test('wrapper: works when started by relative path from its own folder and from a path with spaces', () => {
  const sb = sandbox();
  try {
    const appDir = path.join(sb.dir, 'my app');
    fs.mkdirSync(path.join(appDir, 'bin'), { recursive: true });
    fs.copyFileSync(WRAPPER, path.join(appDir, 'bin', 'hook.sh'));
    fs.copyFileSync(path.join(__dirname, '..', 'hook-logger.js'), path.join(appDir, 'hook-logger.js'));
    fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(appDir, 'lib'), { recursive: true });
    const binDir = path.join(sb.dir, 'pathbin');
    fs.mkdirSync(binDir);
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
    const env = { PATH: `${binDir}:/usr/bin:/bin`, HOME: sb.home, DASHBOARD_NODE_FALLBACKS: NO_FALLBACK, DASHBOARD_EVENTS_FILE: sb.events, DASHBOARD_WRAPPER_LOG: sb.log };
    // absolute path with a space
    let res = spawnSync('/bin/sh', [path.join(appDir, 'bin', 'hook.sh')], { input: PAYLOAD, encoding: 'utf8', env, timeout: 15000 });
    assert.equal(res.status, 0);
    // relative: cwd = bin/, script name only (no slash in $0)
    res = spawnSync('/bin/sh', ['hook.sh'], { input: PAYLOAD, encoding: 'utf8', env, cwd: path.join(appDir, 'bin'), timeout: 15000 });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
    assert.equal(readEvents(sb).length, 2, 'both runs wrote a record');
  } finally {
    sb.cleanup();
  }
});

test('wrapper: the file is executable, starts with a POSIX sh shebang and passes `sh -n`', () => {
  const st = fs.statSync(WRAPPER);
  assert.ok(st.mode & 0o111, 'executable bit set');
  assert.equal(fs.readFileSync(WRAPPER, 'utf8').split('\n')[0], '#!/bin/sh');
  const res = spawnSync('/bin/sh', ['-n', WRAPPER], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
});

/** A "node" in a folder that the wrapper must NOT run: it only leaves a marker line in the trace file. */
function plantDecoyNode(dir, name = 'node') {
  fs.mkdirSync(dir, { recursive: true });
  const decoy = path.join(dir, name);
  fs.writeFileSync(decoy, '#!/bin/sh\necho DECOY >> "$WRAPPER_TEST_TRACE"\nexit 0\n');
  fs.chmodSync(decoy, 0o755);
  return decoy;
}

test('wrapper PATH safety: unset PATH, empty PATH or a "." entry never runs ./node from the current folder', () => {
  // null = PATH unset, '' = empty, '.:/usr/bin:/bin' and ':/usr/bin' = current folder named in PATH explicitly / by an empty entry
  for (const pathValue of [null, '', '.:/usr/bin:/bin', ':/usr/bin:/bin']) {
    const sb = sandbox();
    try {
      const cwd = path.join(sb.dir, 'cwd');
      plantDecoyNode(cwd);
      const { result, traced } = run(sb, { pathValue, cwd });
      const label = `PATH=${pathValue === null ? '<unset>' : JSON.stringify(pathValue)}`;
      assert.equal(result.status, 0, label);
      assert.equal(result.stdout, '', label);
      assert.equal(result.stderr, '', label);
      assert.deepEqual(traced, [], `${label}: ./node was not run`);
    } finally {
      sb.cleanup();
    }
  }
});

test('wrapper PATH safety: with an empty PATH the safe default is used and node is still found when the machine has one', () => {
  // Skipped when none of the default PATH folders has a node (nothing to find; the other tests cover the not-found case).
  const hasNode = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].some((d) => fs.existsSync(path.join(d, 'node')));
  if (!hasNode) return;
  const sb = sandbox();
  try {
    const cwd = path.join(sb.dir, 'cwd');
    plantDecoyNode(cwd);
    const { result, traced } = run(sb, { pathValue: '', cwd });
    assert.equal(result.status, 0);
    assert.deepEqual(traced, [], './node was not run');
    assert.equal(readEvents(sb).length, 1, 'the real node from the default PATH ran the logger');
  } finally {
    sb.cleanup();
  }
});

test('wrapper PATH safety: relative (and empty) DASHBOARD_NODE_FALLBACKS entries are ignored, absolute ones still work', () => {
  const sb = sandbox();
  try {
    const cwd = path.join(sb.dir, 'cwd');
    plantDecoyNode(cwd, 'node');                       // ./node
    plantDecoyNode(path.join(cwd, 'rel'), 'node');     // rel/node
    for (const fallbacks of ['node', './node', 'rel/node', ':node:', 'rel/node:./node']) {
      const { result, traced } = run(sb, { cwd, fallbacks });
      assert.equal(result.status, 0, fallbacks);
      assert.deepEqual(traced, [], `${fallbacks}: no relative fallback was run`);
      assert.equal(readEvents(sb).length, 0, fallbacks);
    }
    assert.match(fs.readFileSync(sb.log, 'utf8'), /node not found; hook skipped/, 'the miss is logged');
    // A relative entry first does not stop the search: the absolute entry after it is used
    const abs = path.join(sb.dir, 'abs', 'node');
    fs.mkdirSync(path.dirname(abs));
    fs.writeFileSync(abs, `#!/bin/sh\necho ABS >> "$WRAPPER_TEST_TRACE"\nexec "${process.execPath}" "$@"\n`);
    fs.chmodSync(abs, 0o755);
    const { result, traced } = run(sb, { cwd, fallbacks: `node:rel/node:${abs}` });
    assert.equal(result.status, 0);
    assert.deepEqual(traced, ['ABS']);
    assert.equal(readEvents(sb).length, 1);
  } finally {
    sb.cleanup();
  }
});
