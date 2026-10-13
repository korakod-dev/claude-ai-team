#!/usr/bin/env node
'use strict';
/**
 * replay.js
 * Feeds raw hook payloads (samples/*.jsonl, one JSON object per line) through the same
 * normalize() used by hook-logger.js, and appends the result to the events file.
 * Lets you test the dashboard without running Claude Code hooks.
 *
 * Usage:
 *   node scripts/replay.js                 append one replay session, 600 ms between events
 *   node scripts/replay.js --delay 0       no delay
 *   node scripts/replay.js --file <path>   use another raw-payload JSONL
 *   node scripts/replay.js --reset         DELETE the events file first (local data only)
 */

const fs = require('fs');
const path = require('path');
const { EVENTS_FILE, ROOT } = require('../lib/config');
const { normalize } = require('../lib/normalize');

/** Parse CLI flags. Throws on unknown flags so typos are not silently ignored. */
function parseArgs(argv) {
  const opts = {
    file: path.join(ROOT, 'samples', 'sample-session.jsonl'),
    delay: 600,
    reset: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--reset') opts.reset = true;
    else if (arg === '--delay') opts.delay = Number(argv[++i]);
    else if (arg === '--file') opts.file = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(opts.delay) || opts.delay < 0) throw new Error('--delay must be a number >= 0');
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const opts = parseArgs(process.argv);
  const lines = fs.readFileSync(opts.file, 'utf8').split('\n').filter((l) => l.trim());

  if (opts.reset && fs.existsSync(EVENTS_FILE)) fs.unlinkSync(EVENTS_FILE);
  fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });

  // One unique session id per replay so repeated runs do not mix in the UI.
  const sessionId = `replay-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let written = 0;

  for (const line of lines) {
    const raw = JSON.parse(line); // every sample line must be valid JSON
    raw.session_id = sessionId;
    const record = normalize(raw);
    if (record) {
      fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(record)}\n`);
      written += 1;
    }
    if (opts.delay > 0) await sleep(opts.delay);
  }

  console.log(`Replayed ${written} events into ${EVENTS_FILE} as session ${sessionId}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
