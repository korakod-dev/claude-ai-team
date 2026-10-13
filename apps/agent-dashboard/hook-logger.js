#!/usr/bin/env node
'use strict';
/**
 * hook-logger.js
 * Claude Code hook handler (command hook, configured in HOOKS-SETUP.md).
 *
 * Reads ONE hook payload (JSON) from stdin, normalizes it, and appends one line
 * to the local events file (JSONL). Designed to never affect the agent:
 *   - every error is swallowed,
 *   - there is a hard 5 s guard,
 *   - stdin is read up to MAX_STDIN_BYTES (1 MiB) only. With the matcher "*", PostToolUse of Read / WebFetch can carry a
 *     huge tool_response. Past the cap nothing more is stored (the rest of stdin is drained and dropped, so Claude Code
 *     never gets a broken pipe) and a compact record is logged from the head of the payload, with "truncated": true,
 *   - it always exits with code 0 and writes nothing to stdout
 *     (so Claude Code never receives a decision or extra context from it).
 */

const fs = require('fs');
const path = require('path');
const { EVENTS_FILE } = require('./lib/config');
const { normalize } = require('./lib/normalize');
const { scanPartialPayload } = require('./lib/partial-json');

// Read cap for stdin. A normal payload is a few KB; 1 MiB leaves a wide margin.
const MAX_STDIN_BYTES = 1024 * 1024;

/**
 * Read stdin up to MAX_STDIN_BYTES.
 * Resolves with { text, truncated }. On a stream error it resolves with what was read so far (or '').
 * When the cap is hit it resolves AT ONCE (the record can be written without waiting for the sender), and keeps
 * draining stdin without storing anything, so the sender is never blocked on a full pipe.
 */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let truncated = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated });
    };
    process.stdin.on('data', (chunk) => {
      if (truncated) return;                       // draining: drop everything past the cap
      const room = MAX_STDIN_BYTES - size;
      if (chunk.length <= room) {
        chunks.push(chunk);
        size += chunk.length;
        return;
      }
      if (room > 0) chunks.push(chunk.subarray(0, room));
      size = MAX_STDIN_BYTES;
      truncated = true;
      finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/** Build the record to log from what was read, or null when there is nothing to log. */
function buildRecord({ text, truncated }) {
  if (!truncated) return normalize(JSON.parse(text));
  // Cut payload: it cannot be parsed. Take the small identifying fields from its head.
  const record = normalize(scanPartialPayload(text));
  if (record) record.truncated = true;
  return record;
}

async function main() {
  // Hard guard: never keep Claude Code waiting on this process.
  setTimeout(() => process.exit(0), 5000).unref();

  try {
    const record = buildRecord(await readStdin());
    if (record) {
      fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
      // Single appendFileSync of one short line; O_APPEND keeps concurrent writes line-based.
      fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(record)}\n`);
    }
  } catch (_err) {
    // Swallow everything: a logging failure must not disturb the Claude Code session.
  }
  process.exitCode = 0;
}

main();
