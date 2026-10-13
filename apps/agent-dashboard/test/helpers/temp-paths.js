'use strict';
/**
 * test/helpers/temp-paths.js
 * Shared by test/server.test.js and test/workspace.test.js (LOW-3). Keeps every test off the
 * project data/ folder.
 *
 *   isolateEnv()            sets the DASHBOARD_* env overrides (lib/config.js) to a temp folder.
 *                           Must run BEFORE ../server or ../lib/* are required, because config.js
 *                           reads the env when it is first loaded. It also checks that config
 *                           really points to temp paths, so a late load fails the test run.
 *   tempWorkspaceOpts(dir)  returns all five workspace paths under dir: eventsFile, workspaceEventsFile
 *                           (the log), commandsFile, uploadsDir, secretaryQueueDir (its done/ folder
 *                           is inside it). Use the result for every createServer / createWorkspaceHub call.
 *   assertTempPaths(opts)   throws if one of the five paths is missing, is inside project data/,
 *                           or is outside the OS temp folder.
 *
 * Only plain fs/path/os calls here, so the guard does not depend on the code under test.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');   // apps/agent-dashboard
const PROJECT_DATA = path.join(ROOT, 'data');        // the owner's real data folder: never a test target
// Option names used by createServer / createWorkspaceHub, in one list so no path can be forgotten
const PATH_KEYS = ['eventsFile', 'workspaceEventsFile', 'commandsFile', 'uploadsDir', 'secretaryQueueDir'];

/** Real (symlink-resolved) absolute path. A path that does not exist yet is resolved via its nearest existing parent. */
function realOf(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

/** True when child is parent itself or somewhere below it. */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Throws if p resolves inside the project data/ folder (symlinks resolved).
 * @param {string} p
 * @param {string} label  name used in the error message
 * @param {string} [dataDir]  the folder treated as "data/". Default: the real project data/. Only test/guard.test.js
 *                            passes another folder (a fake one in temp), so its symlink cases also run on a clean
 *                            checkout where data/ does not exist yet.
 */
function assertNotInProjectData(p, label, dataDir = PROJECT_DATA) {
  const real = realOf(p);
  if (isInside(real, realOf(dataDir)) || isInside(path.resolve(p), dataDir)) {
    throw new Error(`test guard: ${label} points into the project data/ folder: ${p}`);
  }
}

/** Throws unless one path is under the OS temp folder and not under the project data/ folder. */
function assertTempPath(p, label) {
  assertNotInProjectData(p, label);
  if (!isInside(realOf(p), realOf(os.tmpdir()))) {
    throw new Error(`test guard: ${label} is outside the OS temp folder: ${p}`);
  }
}

/** Throws unless all five workspace paths are present and temp-only. */
function assertTempPaths(opts) {
  for (const key of PATH_KEYS) {
    if (typeof opts[key] !== 'string' || !opts[key]) {
      throw new Error(`test guard: option ${key} is missing; every test must pass all five temp paths`);
    }
    assertTempPath(opts[key], key);
  }
}

/** The five workspace paths under dir, checked by assertTempPaths. */
function tempWorkspaceOpts(dir) {
  const opts = {
    eventsFile: path.join(dir, 'events.jsonl'),
    workspaceEventsFile: path.join(dir, 'workspace-events.jsonl'),
    commandsFile: path.join(dir, 'commands.jsonl'),
    uploadsDir: path.join(dir, 'uploads'),
    secretaryQueueDir: path.join(dir, 'secretary-queue'),
  };
  assertTempPaths(opts);
  return opts;
}

/**
 * Check the paths that lib/config.js resolved (the defaults used when no option is passed).
 * A test that forgets an option then fails here instead of writing to data/.
 */
function assertConfigIsolated() {
  const config = require('../../lib/config');
  assertTempPaths({
    eventsFile: config.EVENTS_FILE,
    workspaceEventsFile: config.WORKSPACE_EVENTS_FILE,
    commandsFile: config.COMMANDS_FILE,
    uploadsDir: config.UPLOADS_DIR,
    secretaryQueueDir: config.SECRETARY_QUEUE_DIR,
  });
}

let envDir = null;

/**
 * Point the DASHBOARD_* env overrides at a fresh temp folder (once per test process) and verify them.
 * The folder is removed when the test process exits.
 * @returns {string} the temp folder
 */
function isolateEnv() {
  if (envDir) return envDir;
  envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-env-'));
  const opts = tempWorkspaceOpts(envDir);
  process.env.DASHBOARD_EVENTS_FILE = opts.eventsFile;
  process.env.DASHBOARD_WORKSPACE_EVENTS_FILE = opts.workspaceEventsFile;
  process.env.DASHBOARD_COMMANDS_FILE = opts.commandsFile;
  process.env.DASHBOARD_UPLOADS_DIR = opts.uploadsDir;
  process.env.DASHBOARD_SECRETARY_QUEUE_DIR = opts.secretaryQueueDir;
  assertConfigIsolated(); // fails if lib/config.js was already loaded before this call
  const dir = envDir;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return envDir;
}

module.exports = {
  isolateEnv, tempWorkspaceOpts, assertTempPaths, assertConfigIsolated, assertNotInProjectData, PATH_KEYS,
};
