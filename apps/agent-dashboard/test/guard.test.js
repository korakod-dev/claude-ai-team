'use strict';
/**
 * test/guard.test.js
 * Permanent tests for the data/ protection:
 *   - test/helpers/guard.js          (loaded with --require by `npm test`)
 *   - test/helpers/temp-paths.js     (assertNotInProjectData and friends)
 *
 * Rules followed by this file:
 *   - Child processes get an explicit env. Every DASHBOARD_* variable is removed from the inherited
 *     env first, so values set by the parent `npm test` run (via the guard) never leak in.
 *   - No child process writes a real file under data/. Failing runs exit before any write.
 *   - Every temp dir created here is removed in an after() hook.
 *   - No server is started (port 4317 is never used).
 *   - data/ is only read (stat/readdir), never modified.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertNotInProjectData } = require('./helpers/temp-paths');

const ROOT = path.resolve(__dirname, '..');                 // apps/agent-dashboard
const DATA_DIR = path.join(ROOT, 'data');                   // the owner's real data folder (read-only here)
const GUARD = path.join(ROOT, 'test', 'helpers', 'guard.js');
const EVENTS_IN_DATA = path.join(DATA_DIR, 'events.jsonl');
const GUARD_MESSAGE = 'test guard:';                        // prefix of every guard error

// All five DASHBOARD_* names read by lib/config.js (same list as guard.js)
const DASHBOARD_KEYS = [
  'DASHBOARD_EVENTS_FILE',
  'DASHBOARD_WORKSPACE_EVENTS_FILE',
  'DASHBOARD_COMMANDS_FILE',
  'DASHBOARD_UPLOADS_DIR',
  'DASHBOARD_SECRETARY_QUEUE_DIR',
];

// Code run in the child after the guard is loaded: print the DASHBOARD_* values as JSON
const PRINT_DASHBOARD_ENV =
  'process.stdout.write(JSON.stringify(Object.fromEntries(' +
  'Object.entries(process.env).filter(([k]) => k.startsWith("DASHBOARD_")))))';

/**
 * Run `node --require guard.js -e <code>` in a child process with an explicit env.
 * @param {object} opts
 * @param {Record<string,string>} [opts.env]  DASHBOARD_* values to set for this child only
 * @param {string} [opts.cwd]                 working directory of the child (default: project root)
 * @param {string} [opts.code]                code to run after the guard loads (default: no-op)
 */
function runChild({ env = {}, cwd = ROOT, code = '0' } = {}) {
  // Start from the parent env but drop every DASHBOARD_* key, so nothing leaks from the parent shell
  const baseEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('DASHBOARD_')) baseEnv[key] = value;
  }
  return spawnSync(process.execPath, ['--require', GUARD, '-e', code], {
    cwd,
    env: { ...baseEnv, ...env },   // explicit values win over the (already stripped) inherited env
    encoding: 'utf8',
    timeout: 20000,                // a hung child must not hang the test run
  });
}

/** Recursively list every entry under dir as paths relative to data/ (dirs end with "/"). */
function listTree(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(DATA_DIR, full) + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * True when p is under the OS temp folder. On macOS os.tmpdir() (/var/folders/...) is a symlink to
 * /private/var/..., so both the raw and the real form are accepted.
 */
function isUnderOsTmp(p) {
  const resolved = path.resolve(p);
  const roots = [path.resolve(os.tmpdir()), fs.realpathSync(os.tmpdir())];
  return roots.some((root) => resolved.startsWith(root + path.sep));
}

// Temp folder for this test file (used by the pass case and the symlink case)
let workDir = null;
function getWorkDir() {
  if (!workDir) workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-guard-file-'));
  return workDir;
}

describe('guard: refuses values that point into data/', () => {
  // Case 1: an absolute path inside data/ must make the child fail
  it('fails when DASHBOARD_EVENTS_FILE points inside data/', () => {
    const res = runChild({ env: { DASHBOARD_EVENTS_FILE: EVENTS_IN_DATA } });
    assert.notEqual(res.status, 0, 'child must exit non-zero');
    assert.match(res.stderr, /test guard:/);
    assert.match(res.stderr, /DASHBOARD_EVENTS_FILE points into the project data\/ folder/);
  });

  // Case 2a: a relative path that resolves into data/ (cwd = project root)
  it('fails for a relative path that resolves into data/', () => {
    const res = runChild({ env: { DASHBOARD_EVENTS_FILE: 'data/events.jsonl' }, cwd: ROOT });
    assert.notEqual(res.status, 0, 'child must exit non-zero');
    assert.ok(res.stderr.includes(GUARD_MESSAGE), 'guard message missing from stderr');
    assert.match(res.stderr, /DASHBOARD_EVENTS_FILE points into the project data\/ folder/);
  });

  // Case 2b: a ../ path that climbs out of test/ and into data/ (cwd = test/)
  it('fails for a ../ path that reaches data/', () => {
    const res = runChild({
      env: { DASHBOARD_EVENTS_FILE: '../data/events.jsonl' },
      cwd: path.join(ROOT, 'test'),
    });
    assert.notEqual(res.status, 0, 'child must exit non-zero');
    assert.ok(res.stderr.includes(GUARD_MESSAGE), 'guard message missing from stderr');
    assert.match(res.stderr, /DASHBOARD_EVENTS_FILE points into the project data\/ folder/);
  });

  // Case 2c: empty string. The guard fails closed: it must exit non-zero with its own message.
  // An empty value must never be silently replaced with a temp path.
  it('fails when DASHBOARD_EVENTS_FILE is an empty string', () => {
    const res = runChild({
      env: { DASHBOARD_EVENTS_FILE: '' },
      code: PRINT_DASHBOARD_ENV,
    });
    assert.notEqual(res.status, 0, 'child must exit non-zero');
    assert.ok(res.stderr.includes(GUARD_MESSAGE), 'guard message missing from stderr');
    assert.match(res.stderr, /DASHBOARD_EVENTS_FILE is empty; refusing to run/);
  });

  // Case 2d: empty string on a non-path DASHBOARD_* variable (DASHBOARD_PORT). Also fails closed.
  it('fails when any DASHBOARD_* variable is an empty string (DASHBOARD_PORT)', () => {
    const res = runChild({
      env: { DASHBOARD_PORT: '' },
      code: PRINT_DASHBOARD_ENV,
    });
    assert.notEqual(res.status, 0, 'child must exit non-zero');
    assert.ok(res.stderr.includes(GUARD_MESSAGE), 'guard message missing from stderr');
    assert.match(res.stderr, /DASHBOARD_PORT is empty; refusing to run/);
  });
});

describe('guard: passes when every DASHBOARD_* points to temp', () => {
  // Case 3: all five variables set to a temp dir -> guard loads, child exits 0
  it('passes when all DASHBOARD_* variables point to a temp dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-guard-pass-'));
    try {
      const env = {
        DASHBOARD_EVENTS_FILE: path.join(dir, 'events.jsonl'),
        DASHBOARD_WORKSPACE_EVENTS_FILE: path.join(dir, 'workspace-events.jsonl'),
        DASHBOARD_COMMANDS_FILE: path.join(dir, 'commands.jsonl'),
        DASHBOARD_UPLOADS_DIR: path.join(dir, 'uploads'),
        DASHBOARD_SECRETARY_QUEUE_DIR: path.join(dir, 'secretary-queue'),
      };
      const res = runChild({ env, code: PRINT_DASHBOARD_ENV });
      assert.equal(res.status, 0, `child must exit 0, stderr: ${res.stderr}`);

      // The guard replaces the values with its own temp folder. Check all five are temp-only.
      const seen = JSON.parse(res.stdout);
      assert.equal(Object.keys(seen).length, DASHBOARD_KEYS.length, 'all five DASHBOARD_* must be set');
      for (const key of DASHBOARD_KEYS) {
        const p = path.resolve(seen[key]);
        assert.ok(isUnderOsTmp(p), `${key} must be under the OS temp folder: ${p}`);
        assert.ok(!p.startsWith(DATA_DIR + path.sep), `${key} must not be inside data/`);
      }

      // The guard's temp folder must be removed when the child exits (cleanup check)
      const guardDir = path.dirname(seen.DASHBOARD_EVENTS_FILE);
      assert.equal(fs.existsSync(guardDir), false, `guard temp folder not cleaned up: ${guardDir}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('assertNotInProjectData: symlinks', () => {
  // Case 4: the helper resolves symlinks (realOf uses realpathSync), so a link into data/ is rejected.
  // The real data/ folder may not exist (fresh clone), so these cases use a FAKE data folder in temp: the helper takes the
  // folder to protect as an optional 3rd argument. Only links are created; nothing is written under the real data/.
  let fakeData = null;
  let fakeEvents = null;
  before(() => {
    fakeData = path.join(getWorkDir(), 'fake-data');
    fs.mkdirSync(fakeData, { recursive: true });
    fakeEvents = path.join(fakeData, 'events.jsonl');
    fs.writeFileSync(fakeEvents, '');
  });

  it('rejects a symlink in temp that points to the data/ folder', () => {
    const link = path.join(getWorkDir(), 'link-to-data');
    fs.symlinkSync(fakeData, link, 'dir');
    assert.throws(
      () => assertNotInProjectData(link, 'DASHBOARD_EVENTS_FILE', fakeData),
      /points into the project data\/ folder/,
    );
  });

  it('rejects a symlink in temp that points to a file inside data/', () => {
    const link = path.join(getWorkDir(), 'link-to-events');
    fs.symlinkSync(fakeEvents, link, 'file');
    assert.throws(
      () => assertNotInProjectData(link, 'DASHBOARD_EVENTS_FILE', fakeData),
      /points into the project data\/ folder/,
    );
  });

  it('rejects a path below a symlinked folder, even when the file does not exist yet', () => {
    const link = path.join(getWorkDir(), 'link-to-data-2');
    fs.symlinkSync(fakeData, link, 'dir');
    assert.throws(
      () => assertNotInProjectData(path.join(link, 'new', 'events.jsonl'), 'DASHBOARD_EVENTS_FILE', fakeData),
      /points into the project data\/ folder/,
    );
  });

  it('rejects a path inside the real project data/ folder whether or not that folder exists', () => {
    assert.throws(() => assertNotInProjectData(EVENTS_IN_DATA, 'DASHBOARD_EVENTS_FILE'), /points into the project data\/ folder/);
  });

  it('accepts a plain temp path (control case)', () => {
    const plain = path.join(getWorkDir(), 'plain', 'events.jsonl');
    assert.doesNotThrow(() => assertNotInProjectData(plain, 'DASHBOARD_EVENTS_FILE'));
  });
});

describe('data/ is not changed by this test file', () => {
  // Case 5: snapshot the listing of data/ before this file's tests run.
  // Only the file list is compared. The size of events.jsonl is NOT asserted, because the real
  // Claude Code hook appends to it during normal sessions.
  let before_listing = [];
  let existedBefore = false;

  before(() => {
    before_listing = listTree(DATA_DIR);
    existedBefore = fs.existsSync(EVENTS_IN_DATA);
  });

  it('keeps data/events.jsonl in place', () => {
    if (existedBefore) {
      assert.ok(fs.existsSync(EVENTS_IN_DATA), 'data/events.jsonl disappeared during the test run');
      assert.ok(fs.statSync(EVENTS_IN_DATA).isFile(), 'data/events.jsonl is no longer a regular file');
    }
  });

  it('creates no new files or folders in data/', () => {
    const after_listing = listTree(DATA_DIR);
    const known = new Set(before_listing);
    const created = after_listing.filter((entry) => !known.has(entry));
    assert.deepEqual(created, [], `new entries appeared in data/: ${created.join(', ')}`);
  });
});

after(() => {
  // Clean up the temp folder created by this file
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});
