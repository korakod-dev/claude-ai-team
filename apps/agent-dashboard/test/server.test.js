'use strict';
/**
/**
 * server.test.js - HTTP tests: API, static assets, Host/Origin guards, CSP, 404 (removed views stay 404).
 * Every test passes all five temp paths (never data/), and the guards in test/helpers/temp-paths.js
 * fail the test if a path points into data/. Listens on 127.0.0.1 only.
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
// Must run before ../server and ../lib/config are loaded: points the DASHBOARD_* env overrides at temp (LOW-3)
const { isolateEnv, tempWorkspaceOpts, assertConfigIsolated } = require('./helpers/temp-paths');
isolateEnv();
const { createServer, originOk, hostOk, escapeHtmlAttr, startupWarnings, resolveToken } = require('../server');
const { normalize } = require('../lib/normalize');

const SAMPLE = path.join(__dirname, '..', 'samples', 'sample-session.jsonl');
const SESSION = 'test-session';

/** Start the server on a random port with a temp events file containing the sample. */
async function startWithSample() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
  const opts = tempWorkspaceOpts(dir); // all five paths, temp only (checked)
  const file = opts.eventsFile;
  const lines = fs.readFileSync(SAMPLE, 'utf8').split('\n').filter((l) => l.trim());
  const out = lines.map((line, i) => {
    const raw = JSON.parse(line);
    raw.session_id = SESSION;
    return JSON.stringify(normalize(raw, new Date(Date.parse('2026-10-11T09:00:00Z') + i * 1000)));
  });
  // One deliberately corrupt line to check that the reader skips it
  fs.writeFileSync(file, `${out.join('\n')}\n{not json\n`);

  const server = createServer(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    port,
    file,
    sampleCount: lines.length,
    cleanup: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Simple GET helper returning { status, headers, body } (no fetch, so Host/Origin can be set). */
function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

test('GET / serves the Workspace page (main page); /workspace is an alias; the removed graph/office pages are 404', async () => {
  const ctx = await startWithSample();
  try {
    const main = await get(ctx.port, '/');
    assert.equal(main.status, 200);
    assert.match(main.body, /MULTI-AGENT WORKSPACE/);
    // /workspace is kept as an alias of /
    const alias = await get(ctx.port, '/workspace');
    assert.equal(alias.status, 200);
    assert.match(alias.body, /MULTI-AGENT WORKSPACE/);
    // The pipeline graph and Virtual Office views (and their assets / SSE / snapshot routes) were removed
    for (const gone of ['/graph', '/office', '/office/', '/app.js', '/style.css', '/reducer.js', '/selection.js',
      '/office/app.js', '/api/state', '/events']) {
      assert.equal((await get(ctx.port, gone)).status, 404, `${gone} is gone`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('responses carry a strict Content-Security-Policy and nosniff', async () => {
  const ctx = await startWithSample();
  try {
    const page = await get(ctx.port, '/');
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['x-frame-options'], undefined); // frame control is in CSP frame-ancestors
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    const api = await get(ctx.port, '/api/queue');
    assert.match(api.headers['content-security-policy'], /default-src 'self'/);
  } finally {
    await ctx.cleanup();
  }
});

test('unknown path and path traversal return 404', async () => {
  const ctx = await startWithSample();
  try {
    assert.equal((await get(ctx.port, '/nope')).status, 404);
    assert.equal((await get(ctx.port, '/..%2fpackage.json')).status, 404);
    assert.equal((await get(ctx.port, '/lib/store.js')).status, 404); // only whitelisted files
  } finally {
    await ctx.cleanup();
  }
});

test('non-localhost Host header is rejected (DNS-rebinding guard)', async () => {
  const ctx = await startWithSample();
  try {
    const res = await get(ctx.port, '/api/queue', { Host: 'evil.example.com' });
    assert.equal(res.status, 403);
  } finally {
    await ctx.cleanup();
  }
});

test('non-localhost Origin header is rejected, the dashboard own origin is allowed', async () => {
  const ctx = await startWithSample();
  try {
    const evil = await get(ctx.port, '/api/queue', { Origin: 'http://evil.example.com' });
    assert.equal(evil.status, 403);
    const nullOrigin = await get(ctx.port, '/api/queue', { Origin: 'null' });
    assert.equal(nullOrigin.status, 403);
    // Only the port this server listens on is the dashboard origin (not every localhost port)
    const otherPort = await get(ctx.port, '/api/queue', { Origin: `http://localhost:${ctx.port + 1}` });
    assert.equal(otherPort.status, 403);
    const local = await get(ctx.port, '/api/queue', { Origin: `http://127.0.0.1:${ctx.port}` });
    assert.equal(local.status, 200);
  } finally {
    await ctx.cleanup();
  }
});

test('originOk unit cases', () => {
  assert.equal(originOk(undefined, 4317), true);
  assert.equal(originOk('http://localhost:4317', 4317), true);
  assert.equal(originOk('http://127.0.0.1:4317', 4317), true);
  assert.equal(originOk('http://localhost:9999', 4317), false); // another local app on another port
  assert.equal(originOk('http://localhost', 4317), false); // no port means port 80
  assert.equal(originOk('https://localhost:4317', 4317), false); // only plain http is served
  assert.equal(originOk('http://example.com', 4317), false);
  assert.equal(originOk('not a url', 4317), false);
});

test('startupWarnings: silent when no env token is set (a random one is generated) or the env token is long enough, warns on a short one', () => {
  assert.deepEqual(startupWarnings(''), []);
  assert.deepEqual(startupWarnings('   '), []);
  assert.deepEqual(startupWarnings('0123456789abcdef0123456789abcdef'), []);
  const short = startupWarnings('abc');
  assert.equal(short.length, 1);
  assert.match(short[0], /WORKSPACE_TOKEN/);
  assert.equal(short[0].includes('abc '), false, 'the token value itself is never part of the warning');
});

test('resolveToken: env value is trimmed; empty/blank/missing generates a random 64-hex token each time', () => {
  assert.deepEqual(resolveToken('  my-env-token-1234  '), { token: 'my-env-token-1234', generated: false });
  for (const empty of ['', '   ', undefined, null]) {
    const a = resolveToken(empty);
    const b = resolveToken(empty);
    assert.equal(a.generated, true);
    assert.match(a.token, /^[0-9a-f]{64}$/, '32 random bytes as hex');
    assert.notEqual(a.token, b.token, 'a new token every time');
  }
});

// ---- LOW-3 guard: no default path may point into data/ ----

test('LOW-3 guard: every default path (env overrides) points to a temp folder, never to data/', () => {
  assertConfigIsolated(); // throws if lib/config.js resolves any path into data/
});

// ---- Owner approval routes: GET /api/queue, POST approve / reject / done, token and Origin ----

// Fixed token for the queue tests; postJson() sends it unless a test passes its own Authorization header
// (or { Authorization: undefined } to send none).
const TEST_TOKEN = 'queue-test-token-0123456789abcdef0123456789';

/** Start a server on temp paths for every workspace path (token = TEST_TOKEN unless a test overrides it). */
async function startQueueServer(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-queue-'));
  const opts = { ...tempWorkspaceOpts(dir), workspaceToken: TEST_TOKEN, ...overrides };
  fs.writeFileSync(opts.eventsFile, '');
  const server = createServer(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    opts,
    server,
    cleanup: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** POST a JSON object with optional extra headers. Returns { status, headers, body (text) }. */
function postJson(port, urlPath, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: 'POST',
      headers: Object.fromEntries(Object.entries({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: `Bearer ${TEST_TOKEN}`,
        ...headers,
      }).filter(([, value]) => value !== undefined)),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('GET /api/queue returns text, status and attachment names and sizes only: never file contents or paths', async () => {
  const ctx = await startQueueServer();
  try {
    const secret = 'SECRET-FILE-BODY-9f3a';
    const made = await postJson(ctx.port, '/api/command', {
      text: 'งานมีไฟล์',
      files: [{ name: 'data.txt', type: 'text/plain', data: Buffer.from(secret).toString('base64') }],
    });
    assert.equal(made.status, 201);
    const id = JSON.parse(made.body).id;

    const list = await get(ctx.port, '/api/queue');
    assert.equal(list.status, 200);
    assert.match(list.headers['content-type'], /application\/json/);
    assert.equal(list.body.includes(secret), false, 'file contents are never returned');
    assert.equal(list.body.includes(ctx.opts.uploadsDir), false, 'no absolute path is returned');

    const body = JSON.parse(list.body);
    assert.equal(body.items.length, 1);
    const item = body.items[0];
    assert.deepEqual(Object.keys(item).sort(), ['attachments', 'id', 'status', 'text', 'timestamp', 'unreadable']);
    assert.equal(item.id, id);
    assert.equal(item.status, 'pending_approval');
    assert.equal(item.text, 'งานมีไฟล์');
    assert.deepEqual(item.attachments, [{ name: 'data.txt', size: secret.length }]);
  } finally {
    await ctx.cleanup();
  }
});

test('approve, reject and done need the Bearer token (401 missing, 403 wrong); a foreign Origin is refused even with the token', async () => {
  const ctx = await startQueueServer({ workspaceToken: 'queue-token-456' });
  try {
    const auth = { Authorization: 'Bearer queue-token-456' };
    const made = await postJson(ctx.port, '/api/command', { text: 'งาน token' }, auth);
    assert.equal(made.status, 201);
    const id = JSON.parse(made.body).id;

    for (const route of ['/api/queue/approve', '/api/queue/reject', '/api/queue/done']) {
      assert.equal((await postJson(ctx.port, route, { id }, { Authorization: undefined })).status, 401, `${route} without a token`);
      assert.equal((await postJson(ctx.port, route, { id }, { Authorization: 'Bearer wrong' })).status, 403,
        `${route} with a wrong token`);
    }
    // The rejected calls changed nothing
    assert.ok(fs.existsSync(path.join(ctx.opts.secretaryQueueDir, `${id}.json`)));
    assert.equal(fs.existsSync(path.join(ctx.opts.secretaryQueueDir, 'rejected')), false);

    // Origin is checked before the token: another localhost port is refused
    const foreign = await postJson(ctx.port, '/api/queue/approve', { id },
      { ...auth, Origin: `http://localhost:${ctx.port + 1}` });
    assert.equal(foreign.status, 403);

    // The right token and the own origin work
    assert.equal((await postJson(ctx.port, '/api/queue/done', { id }, auth)).status, 409, 'pending item: done is refused');
    assert.equal((await postJson(ctx.port, '/api/queue/approve', { id }, auth)).status, 200);
    assert.equal((await postJson(ctx.port, '/api/queue/reject', { id: 'cmd-nope' }, auth)).status, 404);
  } finally {
    await ctx.cleanup();
  }
});

/** Pull the token out of the served page (what a browser client would do). */
function tokenFromPage(html) {
  const match = /<meta name="workspace-token" content="([^"]*)">/.exec(html);
  return match ? match[1] : null;
}

test('with no configured token the server generates a random one: it is embedded in the page, never in a URL, and the page flow approves an item', async () => {
  // '' = not set -> random per-start token. No fixed token is passed.
  const ctx = await startQueueServer({ workspaceToken: '' });
  const other = await startQueueServer({ workspaceToken: '' });
  try {
    const page = await get(ctx.port, '/');
    assert.equal(page.status, 200);
    const token = tokenFromPage(page.body);
    assert.match(token, /^[0-9a-f]{64}$/, 'a 32-byte hex token is in the page');
    assert.equal(page.body.includes('__WORKSPACE_TOKEN__'), false, 'the placeholder is replaced');
    assert.equal(page.headers['cache-control'], 'no-store', 'the page with a token is not cached');
    assert.equal(token, ctx.server.workspaceToken);
    // /workspace and /workspace/ carry the same token; the other server instance has a different one
    assert.equal(tokenFromPage((await get(ctx.port, '/workspace')).body), token);
    assert.equal(tokenFromPage((await get(ctx.port, '/workspace/')).body), token);
    assert.notEqual(tokenFromPage((await get(other.port, '/')).body), token, 'a different server = a different token');
    // Static assets and API responses never contain it
    for (const asset of ['/workspace/app.js', '/api/queue', '/api/agents']) {
      assert.equal((await get(ctx.port, asset)).body.includes(token), false, `${asset} does not contain the token`);
    }
    // The token is never accepted in the query string
    const made = await postJson(ctx.port, '/api/command', { text: 'page flow' }, { Authorization: `Bearer ${token}` });
    assert.equal(made.status, 201);
    const id = JSON.parse(made.body).id;
    assert.equal((await postJson(ctx.port, `/api/queue/approve?token=${token}`, { id }, { Authorization: undefined })).status, 401);

    // Blind requests (curl-like: no Origin, no token, or a guessed token) are rejected and change nothing
    assert.equal((await postJson(ctx.port, '/api/queue/approve', { id }, { Authorization: undefined })).status, 401);
    assert.equal((await postJson(ctx.port, '/api/queue/approve', { id }, { Authorization: 'Bearer guess' })).status, 403);
    assert.equal((await postJson(ctx.port, '/api/events', { agent: 'x', status: 'IDLE', message: 'm' },
      { Authorization: undefined })).status, 401);
    assert.equal((await get(ctx.port, '/api/queue')).body.includes('"pending_approval"'), true, 'still pending');

    // The page flow: read the token from the page, then approve with it (own Origin, like a browser)
    const approved = await postJson(ctx.port, '/api/queue/approve', { id },
      { Authorization: `Bearer ${token}`, Origin: `http://localhost:${ctx.port}` });
    assert.equal(approved.status, 200);
    assert.equal(JSON.parse((await get(ctx.port, '/api/queue')).body).items[0].status, 'approved');
    // The token of the other server does not work here
    assert.equal((await postJson(ctx.port, '/api/queue/reject', { id }, { Authorization: `Bearer ${other.server.workspaceToken}` })).status, 403);
  } finally {
    await ctx.cleanup();
    await other.cleanup();
  }
});

test('an env-provided token (trimmed) works, appears in the page, and is not replaced by a random one', async () => {
  const ctx = await startQueueServer({ workspaceToken: '  env-token-0123456789abcdef  ' });
  try {
    assert.equal(ctx.server.workspaceToken, 'env-token-0123456789abcdef', 'the env token is trimmed like the client value');
    assert.equal(tokenFromPage((await get(ctx.port, '/')).body), 'env-token-0123456789abcdef');
    assert.equal((await postJson(ctx.port, '/api/command', { text: 'env' },
      { Authorization: 'Bearer env-token-0123456789abcdef' })).status, 201);
    assert.equal((await postJson(ctx.port, '/api/command', { text: 'env' },
      { Authorization: 'Bearer  env-token-0123456789abcdef ' })).status, 201, 'client value trimmed too');
    assert.equal((await postJson(ctx.port, '/api/command', { text: 'env' }, { Authorization: undefined })).status, 401);
    assert.equal((await postJson(ctx.port, '/api/command', { text: 'env' }, { Authorization: 'Bearer env-token' })).status, 403);
  } finally {
    await ctx.cleanup();
  }
});

test('GET /api/queue and the new POST routes refuse a foreign Origin and a non-localhost Host', async () => {
  const ctx = await startQueueServer();
  try {
    assert.equal((await get(ctx.port, '/api/queue', { Origin: `http://localhost:${ctx.port + 1}` })).status, 403);
    assert.equal((await get(ctx.port, '/api/queue', { Host: 'evil.example' })).status, 403);
    assert.equal((await postJson(ctx.port, '/api/queue/approve', { id: 'cmd-1' }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await postJson(ctx.port, '/api/queue/reject', { id: 'cmd-1' }, { Origin: 'http://evil.example' })).status, 403);
    // The own origin is accepted (no item here, so 404)
    assert.equal((await postJson(ctx.port, '/api/queue/approve', { id: 'cmd-1' },
      { Origin: `http://localhost:${ctx.port}` })).status, 404);
  } finally {
    await ctx.cleanup();
  }
});

// ---- Host header must carry the real listening port (consistent with the Origin check) ----

test('hostOk unit cases: localhost names need the listening port; other ports, names and a missing port are refused', () => {
  for (const name of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(hostOk(`${name}:4317`, 4317), true, name);
    assert.equal(hostOk(`${name}:1`, 4317), false, `${name} on another port`);
    assert.equal(hostOk(`${name}:43170`, 4317), false, `${name} with a longer port`);
    assert.equal(hostOk(name, 4317), false, `${name} without a port means port 80`);
    assert.equal(hostOk(name, 80), true, `${name} without a port is fine when listening on 80`);
  }
  // Host names are case-insensitive: the same input originOk accepts (URL lowercases the hostname)
  assert.equal(hostOk('LOCALHOST:4317', 4317), true, 'upper case name');
  assert.equal(hostOk('LocalHost:4317', 4317), true, 'mixed case name');
  assert.equal(hostOk('LOCALHOST:1', 4317), false, 'case does not bypass the port check');
  assert.equal(hostOk('EVIL.example:4317', 4317), false);
  assert.equal(hostOk('evil.example:4317', 4317), false);
  assert.equal(hostOk('localhost.evil.example:4317', 4317), false);
  assert.equal(hostOk('[::2]:4317', 4317), false);
  assert.equal(hostOk('', 4317), false);
  assert.equal(hostOk(undefined, 4317), false);
});

test('HTTP: Host: localhost:1 (wrong port) gets 403 and no page; the real port is accepted for localhost, 127.0.0.1 and [::1]', async () => {
  const ctx = await startWithSample();
  try {
    const wrong = await get(ctx.port, '/', { Host: 'localhost:1' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.includes(ctx.server.workspaceToken), false, 'the token is not leaked to a wrong-port Host');
    assert.equal((await get(ctx.port, '/', { Host: '127.0.0.1:1' })).status, 403);
    assert.equal((await get(ctx.port, '/', { Host: '[::1]:1' })).status, 403);
    assert.equal((await get(ctx.port, '/api/queue', { Host: 'localhost' })).status, 403, 'no port = port 80, not this server');
    for (const name of ['localhost', '127.0.0.1', '[::1]']) {
      assert.equal((await get(ctx.port, '/', { Host: `${name}:${ctx.port}` })).status, 200, name);
    }
    // Case-insensitive Host (matches originOk, which lowercases through URL)
    assert.equal((await get(ctx.port, '/', { Host: `LOCALHOST:${ctx.port}` })).status, 200, 'upper-case Host');
    assert.equal((await get(ctx.port, '/', { Host: 'LOCALHOST:1' })).status, 403, 'upper-case Host, wrong port');
  } finally {
    await ctx.cleanup();
  }
});

test('originOk accepts the [::1] origin on the listening port only', () => {
  assert.equal(originOk('http://[::1]:4317', 4317), true);
  assert.equal(originOk('http://[::1]:9999', 4317), false);
});

// ---- Env token validation and HTML escaping ----

test('resolveToken: an env token with spaces, control or non-ASCII characters is rejected with a clear error that does not echo it', () => {
  for (const bad of ['has space inside', 'tab\tinside', 'bell\x07x', 'ไทยโทเคน', 'caf\u00e9-token', 'new\nline']) {
    assert.throws(() => resolveToken(bad), (err) => {
      assert.match(err.message, /WORKSPACE_TOKEN is invalid/);
      assert.equal(err.message.includes(bad), false, 'the token value is not echoed');
      return true;
    }, JSON.stringify(bad));
  }
  // Printable ASCII passes, including characters that need HTML escaping (those are escaped on insert)
  assert.deepEqual(resolveToken('a"b<c>&\'d~!'), { token: 'a"b<c>&\'d~!', generated: false });
  // Surrounding whitespace is still trimmed first
  assert.equal(resolveToken('  ok-token  ').token, 'ok-token');
});

test('createServer fails fast on an invalid token option (nothing is started)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-badtoken-'));
  try {
    assert.throws(() => createServer({ ...tempWorkspaceOpts(dir), workspaceToken: 'bad token' }), /WORKSPACE_TOKEN is invalid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('node server.js with an invalid WORKSPACE_TOKEN exits 1 with a clear message and never prints the token', () => {
  const { spawnSync } = require('child_process');
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, WORKSPACE_TOKEN: 'secret with space' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /WORKSPACE_TOKEN is invalid/);
  assert.equal(`${res.stdout}${res.stderr}`.includes('secret with space'), false);
});

test('escapeHtmlAttr escapes & < > " and \'', () => {
  assert.equal(escapeHtmlAttr('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&#39;f');
  assert.equal(escapeHtmlAttr('plain-token_123'), 'plain-token_123');
});

test('a token with quote, angle brackets and ampersand is HTML-escaped in the page: the meta tag stays intact and the decoded value works', async () => {
  const token = 'tok"><script>x</script>&\'end-0123456789';
  const ctx = await startQueueServer({ workspaceToken: token });
  try {
    const page = await get(ctx.port, '/');
    assert.equal(page.status, 200);
    assert.equal(page.body.includes(token), false, 'the raw token is not in the page');
    assert.equal(page.body.includes('<script>x</script>'), false, 'no injected markup');
    const meta = /<meta name="workspace-token" content="([^"]*)">/.exec(page.body);
    assert.ok(meta, 'the meta tag is well-formed (the value contains no raw double quote)');
    // What the browser puts into meta.content: the attribute value with entities decoded
    const decoded = meta[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    assert.equal(decoded, token);
    assert.equal((await postJson(ctx.port, '/api/command', { text: 'escaped' }, { Authorization: `Bearer ${decoded}` })).status, 201);
  } finally {
    await ctx.cleanup();
  }
});
