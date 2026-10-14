'use strict';
/**
 * stellar-wiring.test.js - Wiring of the Stellar Universe view (Phase 1):
 *   - HTTP: the four stellar modules are served as JavaScript (whitelisted, with the CSP header)
 *   - index.html: the planet HUD exists, hidden, and has every data-hud part that stellar/hud.js looks up
 *   - app.js: every applied event is published as 'workspace:event' (guarded for the test sandbox)
 *   - scene.js: imports only same-origin modules, black hole on the right side, comet pool, store and HUD wired
 *   - the pure stellar modules (model, comet, store) have no DOM and no THREE; hud.js and scene.js never use innerHTML
 *   - style.css: the HUD is hidden without WebGL and when [hidden]
 * Uses a temporary server (127.0.0.1 only, temp files only). Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { isolateEnv, tempWorkspaceOpts, assertTempPaths } = require('./helpers/temp-paths');
isolateEnv();
const { createServer } = require('../server');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const STELLAR_DIR = path.join(WORKSPACE_DIR, 'stellar');
const STELLAR_URLS = [
  '/workspace/stellar/model.js',
  '/workspace/stellar/comet.js',
  '/workspace/stellar/store.js',
  '/workspace/stellar/hud.js',
  '/workspace/stellar/quality.js',   // quality presets and the pixel ratio rule (scene.js imports it)
  '/workspace/stellar/hover.js',     // hover state and the pointer clear (scene.js imports it)
];

const read = (rel) => fs.readFileSync(path.join(WORKSPACE_DIR, rel), 'utf8');

/** Start the server on a random port with temp files only. */
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellar-wiring-'));
  const opts = { ...tempWorkspaceOpts(dir), workspaceToken: '' };
  assertTempPaths(opts);
  fs.writeFileSync(opts.eventsFile, '');
  const server = createServer(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    cleanup: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** GET a path on the test server. */
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('HTTP: every stellar module is served as JavaScript with the CSP header', async () => {
  const srv = await startServer();
  try {
    for (const url of STELLAR_URLS) {
      const res = await get(srv.port, url);
      assert.equal(res.status, 200, `${url} is served`);
      assert.match(res.headers['content-type'], /^text\/javascript/, `${url} is JavaScript`);
      assert.ok(res.headers['content-security-policy'], `${url} has the CSP header`);
    }
    // The module folder marker is not served (only whitelisted routes are)
    assert.equal((await get(srv.port, '/workspace/stellar/package.json')).status, 404);
  } finally {
    await srv.cleanup();
  }
});

test('index.html: the planet HUD is present and hidden, and has every data-hud part that hud.js looks up', () => {
  const html = read('index.html');
  assert.match(html, /<aside id="planet-hud" class="planet-hud" hidden/, 'HUD is a hidden aside');
  const hud = read('stellar/hud.js');
  const parts = [...hud.matchAll(/part\('(\w+)'\)/g)].map((m) => m[1]);
  assert.ok(parts.length >= 6, 'hud.js looks up its parts');
  for (const part of parts) {
    assert.match(html, new RegExp(`data-hud="${part}"`), `index.html has data-hud="${part}"`);
  }
  assert.equal(/<script>/.test(html), false, 'no inline script (strict CSP)');
});

test('app.js: every applied event is published as workspace:event with the replay flag, guarded for the sandbox', () => {
  const code = read('app.js');
  assert.match(code, /function publishEvent\(ev, replay\)/, 'publishEvent takes the replay flag');
  assert.match(code, /function sendEvent\(ev, replay\)/);
  assert.match(code, /typeof window\.CustomEvent !== 'function'/, 'no-op when CustomEvent is missing');
  assert.match(code, /new window\.CustomEvent\('workspace:event', \{ detail: \{ event: ev, replay \} \}\)/);
  assert.match(code, /function applyEvent\(ev, replay\) \{\n\s+const active = [^\n]+\n\s+publishEvent\(ev, replay\);/, 'applyEvent publishes first');
  // Phase 2 fix: events before scene.js is ready are buffered and flushed on 'workspace:scene-ready'
  assert.match(code, /window\.addEventListener\('workspace:scene-ready', onSceneReady\)/, 'the ready signal flushes the buffer');
  assert.match(code, /if \(!sceneReady\) \{\n\s+pending\.push\(\{ ev, replay \}\);/, 'events are buffered before the scene is ready');
  assert.equal(/\.innerHTML\s*=/.test(code), false, 'app.js still never assigns innerHTML');
});

test('scene.js: imports only same-origin stellar modules and the vendored Three.js, and wires store, HUD and comets', () => {
  const code = read('scene.js');
  const specs = [...code.matchAll(/from\s+'(\.\/[^']+)'/g)].map((m) => m[1]);
  for (const spec of specs) {
    assert.ok(fs.existsSync(path.join(WORKSPACE_DIR, spec)), `${spec} exists`);
  }
  assert.ok(specs.includes('./stellar/model.js') && specs.includes('./stellar/store.js') && specs.includes('./stellar/hud.js'));
  assert.match(code, /window\.addEventListener\('workspace:event', onWorkspaceEvent\)/, 'scene listens to the event bus');
  assert.match(code, /document\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key === 'Escape'\) release\(\);/, 'Esc releases the focus');
  assert.match(code, /document\.getElementById\('planet-hud'\)/, 'HUD root is looked up by id');
  assert.match(code, /const BLACK_HOLE_HOME = new THREE\.Vector3\(1\d\.\d, [\d.-]+, [\d.-]+\);/, 'black hole on the right side (x between 10 and 20)');
  // boot() calls buildScene() (which registers the listener) before announceReady(true)
  assert.ok(code.indexOf('    buildScene();') < code.indexOf('announceReady(true);'),
    'boot builds the scene (listener registered) before it announces ready');
  assert.ok(code.indexOf("window.addEventListener('workspace:event', onWorkspaceEvent)") < code.indexOf('\nboot();'),
    'the event listener is registered inside buildScene, which runs from boot');
  assert.match(code, /const MAX_COMETS = 8;/);
  assert.match(code, /if \(!detail\.replay\) \{/, 'result and failure comets skip the replay burst');
  assert.equal(/\.innerHTML\s*=/.test(code), false, 'no innerHTML in scene.js');
});

test('pure stellar modules have no DOM and no THREE; hud.js and scene.js never use innerHTML', () => {
  for (const file of ['model.js', 'comet.js', 'store.js']) {
    const code = fs.readFileSync(path.join(STELLAR_DIR, file), 'utf8');
    assert.equal(/\bdocument\b|\bwindow\b|three/i.test(code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')), false, `${file} is pure (no DOM, no THREE)`);
    assert.equal(/\.innerHTML\s*=/.test(code), false, `${file} never assigns innerHTML`);
  }
  assert.equal(/\.innerHTML\s*=/.test(fs.readFileSync(path.join(STELLAR_DIR, 'hud.js'), 'utf8')), false, 'hud.js never assigns innerHTML');
});

test('style.css: the HUD respects [hidden] and is removed in the list layout (no WebGL)', () => {
  const css = read('style.css');
  assert.match(css, /\.planet-hud\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.stage\.no-webgl \.planet-hud \{ display: none; \}/);
});
