#!/usr/bin/env node
'use strict';
/**
 * server.js
 * Local dashboard server (Node.js built-ins only, no dependencies).
 *
 *   GET /                       Multi-Agent Workspace page (Stellar Universe, public/workspace/)
 *   GET /workspace              alias of / (kept so old links keep working)
 *
 * Multi-Agent Workspace (lib/workspace.js, page at /):
 *   GET  /api/events            SSE stream of workspace events { ts, agent, status, message, pipelineStep? }
 *                               (converted hook records from data/events.jsonl + data/workspace-events.jsonl)
 *   GET  /api/agents            Model and effort of every team member, read from the frontmatter of
 *                               .claude/agents/*.md on each request: { agents: { <agent id>: { name, model, effort, suffix } } }.
 *                               suffix is "Sonnet-High" (null when model or effort is missing). No paths, read-only.
 *   POST /api/events            Add one event (JSON). Used for testing without hooks.
 *   POST /api/command           Submit a command + files (JSON, base64 files). Writes one queue file
 *                               (status pending_approval) to data/secretary-queue/ (see README).
 *   GET  /api/queue             Open queue items for the owner (pending_approval and approved): id, timestamp,
 *                               text, status, attachment names and sizes. No file contents, no paths.
 *   POST /api/queue/approve     Owner approves an item (JSON { id }): pending_approval -> approved.
 *                               404 unknown id, 409 when the item is not pending_approval.
 *   POST /api/queue/reject      Owner rejects an item (JSON { id }): moves it to data/secretary-queue/rejected/.
 *   POST /api/queue/done        Mark an APPROVED item done (JSON { id }): moves it to data/secretary-queue/done/.
 *                               409 when the item is still pending_approval.
 *                               All POST routes need Content-Type: application/json.
 *                               All POST routes ALSO need "Authorization: Bearer <token>": 401 when the header
 *                               is missing, 403 when the token is wrong. The token is WORKSPACE_TOKEN (env,
 *                               trimmed) or, when that is not set, a random one generated at each server start
 *                               and embedded in the served page as <meta name="workspace-token">.
 *                               The Origin and Host checks apply to every route, GET included.
 *
 * The workspace SSE stream is /api/events (see above). The events file is read incrementally by
 * lib/store.js (EventTail, inside lib/workspace.js); it is never re-read or re-parsed on a timer or per client.
 *
 * Security: bound to 127.0.0.1 only. Requests whose Host header is not localhost on THIS server's port are
 * rejected (DNS-rebinding guard; localhost, 127.0.0.1 and [::1] are the accepted names). A WORKSPACE_TOKEN with
 * characters outside printable ASCII makes the server refuse to start; the token is also HTML-escaped in the page. Requests with an Origin header must come from localhost on THIS server's
 * port (the dashboard's own origin); any other Origin gets 403. Every POST route also requires a token
 * (see above), so a request without an Origin header (curl, a script) is not enough on its own.
 * This blocks blind local requests and browser CSRF; it does NOT stop a same-user local process that
 * deliberately GETs the page and reads the token (see README, Security).
 * Hooks are unaffected: hook-logger.js appends to the events file directly and never calls the server.
 * Responses carry a strict Content-Security-Policy.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const config = require('./lib/config');
const { createWorkspaceHub } = require('./lib/workspace');
const { readAgentModels } = require('./lib/agent-models');

const PUBLIC_DIR = path.join(config.ROOT, 'public');
// Whitelist of served files. Anything not listed here gets 404 (no path traversal possible).
const STATIC_FILES = {
  // Main page: Multi-Agent Workspace (public/workspace/)
  '/': { file: path.join(PUBLIC_DIR, 'workspace', 'index.html'), type: 'text/html; charset=utf-8' },
  // Workspace page assets (public/workspace/). /workspace is an alias of /.
  '/workspace': { file: path.join(PUBLIC_DIR, 'workspace', 'index.html'), type: 'text/html; charset=utf-8' },
  '/workspace/': { file: path.join(PUBLIC_DIR, 'workspace', 'index.html'), type: 'text/html; charset=utf-8' },
  '/workspace/app.js': { file: path.join(PUBLIC_DIR, 'workspace', 'app.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/style.css': { file: path.join(PUBLIC_DIR, 'workspace', 'style.css'), type: 'text/css; charset=utf-8' },
  // Stellar Universe modules (public/workspace/stellar/): ES modules imported by scene.js (no CDN, no bundler)
  '/workspace/stellar/model.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'model.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/comet.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'comet.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/store.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'store.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/hud.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'hud.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/backdrop.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'backdrop.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/bodies.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'bodies.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/shaders.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'shaders.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/dynamic.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'dynamic.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/sky-pass.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'sky-pass.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/quality.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'quality.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/hover.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'hover.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/moons.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'moons.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/activity.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'activity.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/stellar/effects.js': { file: path.join(PUBLIC_DIR, 'workspace', 'stellar', 'effects.js'), type: 'text/javascript; charset=utf-8' },
  // Workspace 3D scene (public/workspace/scene.js) and its vendored Three.js r170 files (no CDN)
  '/workspace/scene.js': { file: path.join(PUBLIC_DIR, 'workspace', 'scene.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/vendor/three/three.module.min.js': { file: path.join(PUBLIC_DIR, 'workspace', 'vendor', 'three', 'three.module.min.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/vendor/three/addons/postprocessing/EffectComposer.js': { file: path.join(PUBLIC_DIR, 'workspace', 'vendor', 'three', 'addons', 'postprocessing', 'EffectComposer.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/vendor/three/addons/postprocessing/RenderPass.js': { file: path.join(PUBLIC_DIR, 'workspace', 'vendor', 'three', 'addons', 'postprocessing', 'RenderPass.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/vendor/three/addons/postprocessing/UnrealBloomPass.js': { file: path.join(PUBLIC_DIR, 'workspace', 'vendor', 'three', 'addons', 'postprocessing', 'UnrealBloomPass.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/vendor/three/addons/postprocessing/OutputPass.js': { file: path.join(PUBLIC_DIR, 'workspace', 'vendor', 'three', 'addons', 'postprocessing', 'OutputPass.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/vendor/three/addons/postprocessing/ShaderPass.js': { file: path.join(PUBLIC_DIR, 'workspace', 'vendor', 'three', 'addons', 'postprocessing', 'ShaderPass.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/vendor/three/addons/postprocessing/MaskPass.js': { file: path.join(PUBLIC_DIR, 'workspace', 'vendor', 'three', 'addons', 'postprocessing', 'MaskPass.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/vendor/three/addons/postprocessing/Pass.js': { file: path.join(PUBLIC_DIR, 'workspace', 'vendor', 'three', 'addons', 'postprocessing', 'Pass.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/vendor/three/addons/shaders/CopyShader.js': { file: path.join(PUBLIC_DIR, 'workspace', 'vendor', 'three', 'addons', 'shaders', 'CopyShader.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/vendor/three/addons/shaders/LuminosityHighPassShader.js': { file: path.join(PUBLIC_DIR, 'workspace', 'vendor', 'three', 'addons', 'shaders', 'LuminosityHighPassShader.js'), type: 'text/javascript; charset=utf-8' },
  '/workspace/vendor/three/addons/shaders/OutputShader.js': { file: path.join(PUBLIC_DIR, 'workspace', 'vendor', 'three', 'addons', 'shaders', 'OutputShader.js'), type: 'text/javascript; charset=utf-8' },
};
const MAX_EVENT_BODY = 16 * 1024;          // POST /api/events and /api/queue/done body limit
const MAX_COMMAND_BODY = 20 * 1024 * 1024; // POST /api/command body limit (base64 files, 12 MB raw total)
const TOKEN_BYTES = 32;                    // random per-start token: 32 bytes = 64 hex chars
const TOKEN_MIN_ENV_LENGTH = 16;           // a WORKSPACE_TOKEN shorter than this triggers a startup warning
// Page routes that carry the token. The HTML holds this placeholder, replaced per request (see servePage()).
const PAGE_ROUTES = new Set(['/', '/workspace', '/workspace/']);
const TOKEN_PLACEHOLDER = '__WORKSPACE_TOKEN__';
// Host header: a localhost name, optionally with a port. The port is compared with the real listening port in hostOk().
const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/;
const LOCAL_NAME_OK = /^(127\.0\.0\.1|localhost|\[::1\])$/;   // Origin hostname: localhost only (port checked separately)
// A WORKSPACE_TOKEN from the environment may use printable ASCII without spaces only (no control chars, no whitespace,
// no non-ASCII). It is also sent in an Authorization header, so anything else could not round-trip anyway.
const TOKEN_CHARS_OK = /^[\x21-\x7e]+$/;
// Every state-changing route: all of them need the token, plus the Origin/Host checks
const POST_ROUTES = new Set(['/api/events', '/api/command', '/api/queue/approve', '/api/queue/reject', '/api/queue/done']);

// Content-Security-Policy: only same-origin scripts/styles/connections, no framing, no inline code.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Headers sent on every response. */
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * True when the Host header names localhost (localhost, 127.0.0.1 or [::1]) AND carries the port this server
 * really listens on. The same rule as the Origin check, so `Host: localhost:1` (another local port) is refused.
 * A Host without a port means port 80 (HTTP default), accepted only when the server listens on 80.
 * @param {string|undefined} host  the Host header
 * @param {number} port            the port this server listens on (req.socket.localPort)
 */
function hostOk(host, port) {
  // Host names are case-insensitive (RFC 9110): LOCALHOST:4317 must pass like the Origin check (URL lowercases it)
  const match = HOST_OK.exec(String(host || '').toLowerCase());
  if (!match) return false;
  return (match[2] === undefined ? '80' : match[2]) === String(port);
}

/** Escape text for use inside a double- or single-quoted HTML attribute value (defense in depth for the token). */
function escapeHtmlAttr(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * True when an Origin header is missing, or is exactly this dashboard's origin:
 * plain http, host localhost or 127.0.0.1, and the SAME port the server listens on.
 * Other localhost ports (other local web apps) are rejected.
 * @param {string|undefined} origin  the Origin header
 * @param {number} port              the port this server listens on
 */
function originOk(origin, port) {
  if (origin === undefined) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOCAL_NAME_OK.test(u.hostname) && u.port === String(port);
  } catch (_err) {
    return false;
  }
}

/**
 * Check "Authorization: Bearer <token>" against the server token.
 * Both sides are hashed first, then compared with timingSafeEqual, so the check does not leak
 * the token length or a matching prefix. The client value is trimmed (the server token is trimmed
 * when it is resolved, see resolveToken()).
 * @param {import('http').IncomingMessage} req
 * @param {string} token  the server token (never empty here)
 * @returns {'ok'|'missing'|'wrong'}  missing = no usable Bearer header (401), wrong = does not match (403)
 */
function checkToken(req, token) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (!match || !match[1].trim()) return 'missing';
  const given = crypto.createHash('sha256').update(match[1].trim()).digest();
  const expected = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(given, expected) ? 'ok' : 'wrong';
}

/**
 * Decide the token for one server: a configured value (trimmed) or, when none is set, a fresh random one.
 * @param {string|undefined|null} configured  value from createServer opts or config (WORKSPACE_TOKEN)
 * @returns {{ token: string, generated: boolean }}
 * @throws {Error}  when the configured token has characters outside printable ASCII (see TOKEN_CHARS_OK)
 */
function resolveToken(configured) {
  const given = typeof configured === 'string' ? configured.trim() : '';
  if (given) {
    // Fail fast on a token that could break the page or the Authorization header. The value is not echoed.
    if (!TOKEN_CHARS_OK.test(given)) {
      throw new Error('WORKSPACE_TOKEN is invalid: use printable ASCII characters only (no spaces, no control or '
        + 'non-ASCII characters), for example: openssl rand -hex 24. Leave it unset to get a random token at each start.');
    }
    return { token: given, generated: false };
  }
  return { token: crypto.randomBytes(TOKEN_BYTES).toString('hex'), generated: true };
}

/**
 * Warnings to print at startup (empty when everything is fine).
 * An auto-generated token needs no warning. A short WORKSPACE_TOKEN from the environment is weak.
 * @param {string} envToken  the WORKSPACE_TOKEN env value ('' when not set)
 * @returns {string[]}
 */
function startupWarnings(envToken) {
  const warnings = [];
  const given = typeof envToken === 'string' ? envToken.trim() : '';
  if (given && given.length < TOKEN_MIN_ENV_LENGTH) {
    warnings.push(`WORKSPACE_TOKEN is only ${given.length} characters long: use at least ${TOKEN_MIN_ENV_LENGTH} `
      + '(for example: openssl rand -hex 24), or leave it unset to get a random token at each start.');
  }
  return warnings;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendText(res, status, text) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/**
 * Read a JSON request body with a size limit, then call done(err, value) exactly once.
 * err.status is 415 (wrong Content-Type), 413 (too large) or 400 (invalid JSON).
 */
function readJsonBody(req, limitBytes, done) {
  const type = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(type)) {
    return done(Object.assign(new Error('Content-Type must be application/json'), { status: 415 }));
  }
  const chunks = [];
  let size = 0;
  let finished = false;
  req.on('data', (chunk) => {
    if (finished) return;
    size += chunk.length;
    if (size > limitBytes) {
      finished = true;
      done(Object.assign(new Error('Payload too large'), { status: 413 }));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (finished) return;
    finished = true;
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_err) {
      return done(Object.assign(new Error('Invalid JSON'), { status: 400 }));
    }
    return done(null, value);
  });
  req.on('error', () => { finished = true; });
}

/**
 * Create the HTTP server. Exported so tests can start it on a random port.
 * @param {object} [opts]
 * @param {string} [opts.eventsFile]        JSONL file to read (default from config)
 * @param {string} [opts.agentsDir]         folder of the agent definition files (default from config)
 * @param {object} [opts.timing]            hub timing overrides for tests (watchIntervalMs, queueCheckMs, ...)
 * @param {string} [opts.workspaceToken]    shared secret for POST routes (trimmed). Not set or empty = a random
 *                                          token is generated for this server (default from config WORKSPACE_TOKEN)
 * @returns {http.Server}  with a read-only `workspaceToken` property (for in-process callers such as tests)
 */
function createServer(opts = {}) {
  const eventsFile = opts.eventsFile || config.EVENTS_FILE;
  const agentsDir = opts.agentsDir || config.AGENTS_DIR;
  // Token for every POST route. Only an undefined option falls back to the env-based config; an empty
  // value never means "no auth": a random token is generated instead (32 bytes, hex).
  const { token: workspaceToken, generated: tokenGenerated } = resolveToken(
    opts.workspaceToken !== undefined ? opts.workspaceToken : config.WORKSPACE_TOKEN);

  // Multi-Agent Workspace hub (see lib/workspace.js). Tests pass temp paths for all four options.
  const hub = createWorkspaceHub({
    eventsFile,
    workspaceFile: opts.workspaceEventsFile || config.WORKSPACE_EVENTS_FILE,
    commandsFile: opts.commandsFile || config.COMMANDS_FILE,
    uploadsDir: opts.uploadsDir || config.UPLOADS_DIR,
    secretaryQueueDir: opts.secretaryQueueDir || config.SECRETARY_QUEUE_DIR,
    timing: opts.timing,   // tests only: small watcher / queue intervals (see createWorkspaceHub)
  });

  /**
   * Serve an HTML page with the server token injected into <meta name="workspace-token">.
   * The token goes into the page body only (never a URL or query string). no-store keeps it out of caches.
   */
  function servePage(res, asset) {
    fs.readFile(asset.file, 'utf8', (err, html) => {
      if (err) return sendText(res, 500, 'Asset missing');
      // HTML-escaped on insert, so a token can never break out of the meta attribute (the browser decodes it again)
      const body = Buffer.from(html.split(TOKEN_PLACEHOLDER).join(escapeHtmlAttr(workspaceToken)), 'utf8');
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': asset.type,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    });
  }

  /** POST /api/events, /api/command, /api/queue/* (token already checked by the caller). */
  function handleWorkspacePost(req, res, pathname) {
    const limit = pathname === '/api/command' ? MAX_COMMAND_BODY : MAX_EVENT_BODY;
    return readJsonBody(req, limit, (err, body) => {
      if (err) {
        res.setHeader('Connection', 'close'); // do not keep reading a rejected upload
        return sendJson(res, err.status, { error: err.message });
      }
      try {
        let result;
        if (pathname === '/api/command') result = hub.submitCommand(body);
        else if (pathname === '/api/queue/approve') result = hub.approveQueueItem(body);
        else if (pathname === '/api/queue/reject') result = hub.rejectQueueItem(body);
        else if (pathname === '/api/queue/done') result = hub.markQueueDone(body);
        else result = hub.publish(body);
        return sendJson(res, result.status, result.body);
      } catch (error) {
        console.error(`[workspace] ${pathname} failed: ${error.message}`);
        return sendJson(res, 500, { error: 'Internal error while saving' });
      }
    });
  }

  const server = http.createServer((req, res) => {
    // DNS-rebinding guard: only accept requests addressed to localhost on THIS server's port.
    if (!hostOk(req.headers.host, req.socket.localPort)) {
      return sendText(res, 403, 'Forbidden');
    }
    // Cross-site guard: an Origin header must be this dashboard's own origin (localhost + this port).
    if (!originOk(req.headers.origin, req.socket.localPort)) {
      return sendText(res, 403, 'Forbidden');
    }
    const url = new URL(req.url, 'http://localhost');

    // Workspace POST endpoints. Only these paths accept POST; everything else stays GET-only.
    if (req.method === 'POST' && POST_ROUTES.has(url.pathname)) {
      // Shared secret, checked before the body is read. Missing header = 401, wrong token = 403.
      const auth = checkToken(req, workspaceToken);
      if (auth !== 'ok') {
        res.setHeader('Connection', 'close');
        if (auth === 'missing') {
          res.setHeader('WWW-Authenticate', 'Bearer realm="workspace"');
          return sendJson(res, 401, { error: 'Unauthorized: send Authorization: Bearer <token> (see the workspace page)' });
        }
        return sendJson(res, 403, { error: 'Forbidden: wrong token' });
      }
      return handleWorkspacePost(req, res, url.pathname);
    }
    if (req.method !== 'GET') {
      return sendText(res, 405, 'Method Not Allowed');
    }

    // Workspace SSE stream (one workspace event per message)
    if (url.pathname === '/api/events') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      hub.attach(req, res);
      return undefined;
    }

    // Model + effort per team member (frontmatter of the agent definition files), used for the name labels
    if (url.pathname === '/api/agents') {
      try {
        return sendJson(res, 200, { agents: readAgentModels(agentsDir) });
      } catch (err) {
        console.error(`[workspace] /api/agents failed: ${err.message}`);
        return sendJson(res, 500, { error: 'Could not read the agent definitions' });
      }
    }

    // Open queue items for the owner (no file contents, no paths)
    if (url.pathname === '/api/queue') {
      try {
        const result = hub.listQueue();
        return sendJson(res, result.status, result.body);
      } catch (err) {
        console.error(`[workspace] /api/queue failed: ${err.message}`);
        return sendJson(res, 500, { error: 'Could not read the secretary queue' });
      }
    }

    const asset = STATIC_FILES[url.pathname];
    if (asset && PAGE_ROUTES.has(url.pathname)) {
      servePage(res, asset);
      return undefined;
    }
    if (asset) {
      fs.readFile(asset.file, (err, data) => {
        if (err) return sendText(res, 500, 'Asset missing');
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type });
        return res.end(data);
      });
      return undefined;
    }

    return sendText(res, 404, 'Not Found');
  });

  // Close the workspace hub (its file watchers and open SSE streams) when the server closes.
  server.on('close', () => {
    hub.close();
  });

  // In-process access to the token (tests). Not enumerable and read-only; nothing prints or serves it
  // except the page meta tag. Whether it was generated is only used for the startup log line.
  Object.defineProperty(server, 'workspaceToken', { value: workspaceToken, enumerable: false });
  Object.defineProperty(server, 'tokenGenerated', { value: tokenGenerated, enumerable: false });

  return server;
}

// Start only when run directly: node server.js
if (require.main === module) {
  // Invalid DASHBOARD_PORT: one clear line, exit 1 (no stack trace, never a silent fallback to the default port)
  if (config.PORT_ERROR) {
    console.error(`[error] ${config.PORT_ERROR}`);
    process.exit(1);
  }
  let server;
  try {
    server = createServer();
  } catch (err) {
    // Invalid configuration (for example a WORKSPACE_TOKEN with illegal characters): clear message, no stack trace
    console.error(`[error] ${err.message}`);
    process.exit(1);
  }
  server.listen(config.PORT, config.HOST, () => {
    // server.address().port is the real port (differs from config.PORT when DASHBOARD_PORT=0)
    console.log(`Workspace (main): http://${config.HOST}:${server.address().port}/`);
    console.log(`Events file:     ${config.EVENTS_FILE}`);
    console.log(`Workspace log:   ${config.WORKSPACE_EVENTS_FILE}`);
    console.log(`Secretary queue: ${config.SECRETARY_QUEUE_DIR}`);
    console.log(`Agent configs:   ${config.AGENTS_DIR}`);
    // Never print the token itself (a log can end up in a shared terminal or a bug report)
    console.log(`Token auth:      on for all POST routes (${server.tokenGenerated
      ? 'random token for this run, embedded in the page; restart = new token'
      : 'WORKSPACE_TOKEN from the environment'})`);
    for (const warning of startupWarnings(config.WORKSPACE_TOKEN)) console.warn(`[warning] ${warning}`);
  });
}

module.exports = { createServer, originOk, hostOk, escapeHtmlAttr, startupWarnings, checkToken, resolveToken, CSP };
