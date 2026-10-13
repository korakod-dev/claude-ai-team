'use strict';
/**
 * test/helpers/guard.js (LOW-A)
 * Loaded before EVERY test file by `npm test`:
 *   node --require ./test/helpers/guard.js --test test/*.test.js
 *
 * Points every DASHBOARD_* env override (read by lib/config.js) at a fresh temp folder, so a test
 * file that forgets isolateEnv() still cannot write to the project data/ folder.
 *   - FAIL CLOSED: if any DASHBOARD_* variable is set to an empty string, the run fails.
 *     An empty value is never silently replaced; the owner must unset it or set a real value.
 *   - An UNSET DASHBOARD_* path override is replaced with a temp path (as before).
 *   - If the shell already sets a path override that resolves inside data/, the run fails.
 *   - After the overrides are set, all five are checked again: temp only, never inside data/.
 *
 * This file does NOT load lib/config.js, so config.js reads the temp paths on its first load.
 * The temp folder is removed when the process exits.
 * Limit: it covers the paths lib/config.js provides. A test that hardcodes a data/ path is not covered.
 * Only plain fs/path/os calls (plus the helper functions in temp-paths.js) are used here.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tempWorkspaceOpts, assertNotInProjectData } = require('./temp-paths');

// Env override name for each workspace path (same five paths as temp-paths.js PATH_KEYS)
const ENV_BY_KEY = {
  eventsFile: 'DASHBOARD_EVENTS_FILE',
  workspaceEventsFile: 'DASHBOARD_WORKSPACE_EVENTS_FILE',
  commandsFile: 'DASHBOARD_COMMANDS_FILE',
  uploadsDir: 'DASHBOARD_UPLOADS_DIR',
  secretaryQueueDir: 'DASHBOARD_SECRETARY_QUEUE_DIR',
};

// 1a. Fail closed: any DASHBOARD_* variable set to an empty string stops the run.
//     Checks every DASHBOARD_* name (including DASHBOARD_PORT), not only the five paths.
for (const [envName, value] of Object.entries(process.env)) {
  if (envName.startsWith('DASHBOARD_') && value === '') {
    throw new Error(`test guard: ${envName} is empty; refusing to run (unset it or give it a real value)`);
  }
}

// 1b. Refuse to run if the shell already points a path override into the project data/ folder.
//     Only non-empty values reach here (empty values were rejected above), so unset is the only skip case.
for (const envName of Object.values(ENV_BY_KEY)) {
  const value = process.env[envName];
  if (value !== undefined) assertNotInProjectData(value, envName);
}

// 2. Create a fresh temp folder and point every override at it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-guard-'));
const opts = tempWorkspaceOpts(dir); // throws if any computed path is not temp-only
for (const [key, envName] of Object.entries(ENV_BY_KEY)) {
  process.env[envName] = opts[key];
}

// 3. Remove the temp folder when this test process exits.
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
