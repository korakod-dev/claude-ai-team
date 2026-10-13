'use strict';
/**
 * config.js
 * Central place for runtime settings. Every value can be overridden by an env var.
 */
const path = require('path');

// Folder of the dashboard app (apps/agent-dashboard)
const ROOT = path.resolve(__dirname, '..');

const DEFAULT_PORT = 4317;

/**
 * Parse DASHBOARD_PORT. Unset or blank = DEFAULT_PORT. Otherwise it must be a whole number 0-65535
 * (0 = let the OS pick a free port; server.js prints the real one in the banner).
 * Anything else (text, decimals, negatives, > 65535) is invalid: no silent fallback to the default.
 * Never throws: config.js is also loaded by hook-logger.js, which must never fail because of a port setting.
 * @param {string|undefined} raw  the raw env value
 * @returns {{ port: number|null, error: string|null }}  port is null when invalid
 */
function parsePort(raw) {
  const text = String(raw === undefined ? '' : raw).trim();
  if (text === '') return { port: DEFAULT_PORT, error: null };
  const port = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(port) || port > 65535) {
    return {
      port: null,
      error: `DASHBOARD_PORT must be a whole number from 0 to 65535 (0 = pick a free port), got "${text}"`,
    };
  }
  return { port, error: null };
}

const PORT_RESULT = parsePort(process.env.DASHBOARD_PORT);

module.exports = {
  ROOT,
  // Local JSONL state file written by hook-logger.js. Owner can delete it at any time.
  EVENTS_FILE: process.env.DASHBOARD_EVENTS_FILE || path.join(ROOT, 'data', 'events.jsonl'),
  // Multi-Agent Workspace (/workspace): events posted to POST /api/events and written by the
  // command flow. Already in the workspace event shape (not hook records). Owner can delete it.
  WORKSPACE_EVENTS_FILE: process.env.DASHBOARD_WORKSPACE_EVENTS_FILE
    || path.join(ROOT, 'data', 'workspace-events.jsonl'),
  // One JSON line per command submitted from the workspace (POST /api/command)
  COMMANDS_FILE: process.env.DASHBOARD_COMMANDS_FILE || path.join(ROOT, 'data', 'commands.jsonl'),
  // Files uploaded with a command are stored under <UPLOADS_DIR>/<command id>/
  UPLOADS_DIR: process.env.DASHBOARD_UPLOADS_DIR || path.join(ROOT, 'data', 'uploads'),
  // Secretary file queue: one JSON file per command, read by the main Claude session.
  // Kept separate from UPLOADS_DIR so the session only has to watch this folder.
  SECRETARY_QUEUE_DIR: process.env.DASHBOARD_SECRETARY_QUEUE_DIR
    || path.join(ROOT, 'data', 'secretary-queue'),
  // Agent definition files (<repo>/.claude/agents/*.md). Their frontmatter `model` and `effort` give the label suffix
  // shown after each team member's name (lib/agent-models.js, GET /api/agents). Read-only.
  AGENTS_DIR: process.env.DASHBOARD_AGENTS_DIR || path.resolve(ROOT, '..', '..', '.claude', 'agents'),
  // Dashboard HTTP port (bound to 127.0.0.1 only). 0 = ephemeral (the OS picks; the banner shows the real port).
  // null when DASHBOARD_PORT is invalid: PORT_ERROR then holds the message and `node server.js` exits 1 with it.
  PORT: PORT_RESULT.port,
  PORT_ERROR: PORT_RESULT.error,
  parsePort,
  // Optional shared secret for every POST route (sent as "Authorization: Bearer <token>").
  // Trimmed here, so the env value and a client-sent value are compared the same way.
  // Empty = not set: server.js then generates a random token at each start (crypto.randomBytes) and
  // embeds it in the served workspace page. There is no way to turn token auth off. Never logged in full.
  WORKSPACE_TOKEN: (process.env.WORKSPACE_TOKEN || '').trim(),
  HOST: '127.0.0.1',
};
