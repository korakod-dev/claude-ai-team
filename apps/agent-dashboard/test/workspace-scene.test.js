'use strict';
/**
 * workspace-scene.test.js - Tests for the 3D workspace view (public/workspace/scene.js + vendored Three.js r170):
 *   - vendor layout: the core file exists, every relative import in the vendored addons resolves, no bare 'three' import
 *   - HTTP: scene.js and every vendored file are served (whitelisted, JavaScript MIME type, CSP header),
 *           the removed workspace image is no longer served
 *   - index.html: the image, the SVG edge layer and inline scripts are gone; the 3D stage and the seven labels are there
 *   - scene.js: only same-origin imports (no CDN), no innerHTML
 *   - app.js: the status hooks (window.workspaceScene) are called for status, handoffs and "ล้างหน้าจอ",
 *             and the page still works when the 3D scene is missing
 * Uses temporary files only (never data/). Listens on 127.0.0.1 only. Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
// Must run before ../server and ../lib/config are loaded: points the DASHBOARD_* env overrides at temp
const { isolateEnv, tempWorkspaceOpts, assertTempPaths } = require('./helpers/temp-paths');
isolateEnv();
const { createServer } = require('../server');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const VENDOR_DIR = path.join(WORKSPACE_DIR, 'vendor', 'three');

// Every file the page loads from the vendor folder, as served URLs
const VENDORED_URLS = [
  '/workspace/vendor/three/three.module.min.js',
  '/workspace/vendor/three/addons/postprocessing/EffectComposer.js',
  '/workspace/vendor/three/addons/postprocessing/RenderPass.js',
  '/workspace/vendor/three/addons/postprocessing/UnrealBloomPass.js',
  '/workspace/vendor/three/addons/postprocessing/OutputPass.js',
  '/workspace/vendor/three/addons/postprocessing/ShaderPass.js',
  '/workspace/vendor/three/addons/postprocessing/MaskPass.js',
  '/workspace/vendor/three/addons/postprocessing/Pass.js',
  '/workspace/vendor/three/addons/shaders/CopyShader.js',
  '/workspace/vendor/three/addons/shaders/LuminosityHighPassShader.js',
  '/workspace/vendor/three/addons/shaders/OutputShader.js',
];

// ---------- helpers ----------

/** Read a file under public/workspace as text. */
function readWorkspaceFile(rel) {
  return fs.readFileSync(path.join(WORKSPACE_DIR, rel), 'utf8');
}

/** Recursively list the .js files under a folder. */
function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJs(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/** Start the server on a random port with temp files for every workspace path. */
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scene-test-'));
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

/** GET a path on the test server. Resolves with status, headers and body. */
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

// ---------- vendor layout ----------

test('vendor: the Three.js core file is r170 and every vendored file exists', () => {
  const core = fs.readFileSync(path.join(VENDOR_DIR, 'three.module.min.js'), 'utf8');
  assert.match(core, /="170"/, 'three.module.min.js is Three.js r170');
  assert.ok(fs.existsSync(path.join(VENDOR_DIR, 'LICENSE')), 'the MIT licence file is vendored next to the library');
  for (const url of VENDORED_URLS) {
    const file = path.join(WORKSPACE_DIR, url.replace('/workspace/', ''));
    assert.ok(fs.existsSync(file), `${url} exists on disk`);
  }
});

test('vendor: addons use only relative imports, and every relative import resolves (no CDN, no bare "three")', () => {
  for (const file of listJs(path.join(VENDOR_DIR, 'addons'))) {
    const code = fs.readFileSync(file, 'utf8');
    assert.equal(/from\s+'three'/.test(code), false, `${path.basename(file)} must not import bare 'three'`);
    assert.equal(/from\s+'https?:\/\//.test(code), false, `${path.basename(file)} must not import from a URL`);
    const specs = [...code.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
    for (const spec of specs) {
      const target = path.resolve(path.dirname(file), spec);
      assert.ok(fs.existsSync(target), `${path.basename(file)} imports ${spec}, which must exist`);
    }
  }
});

// ---------- HTTP ----------

test('HTTP: scene.js and every vendored file are served as JavaScript with the CSP header', async () => {
  const ctx = await startServer();
  try {
    for (const url of ['/workspace/scene.js', ...VENDORED_URLS]) {
      const res = await get(ctx.port, url);
      assert.equal(res.status, 200, `${url} returns 200`);
      assert.match(res.headers['content-type'], /^text\/javascript/, `${url} has a JavaScript MIME type`);
      assert.match(res.headers['content-security-policy'], /script-src 'self'/, `${url} keeps the strict CSP`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('HTTP: the old workspace image is no longer served (whitelist, 404)', async () => {
  const ctx = await startServer();
  try {
    assert.equal((await get(ctx.port, '/workspace/assets/workspace-solar.jpg')).status, 404);
    assert.equal((await get(ctx.port, '/workspace/vendor/three/../../../server.js')).status, 404, 'no path traversal');
    assert.equal((await get(ctx.port, '/workspace/vendor/three/addons/postprocessing/NotThere.js')).status, 404);
  } finally {
    await ctx.cleanup();
  }
});

// ---------- page markup and scene module ----------

test('index.html: no image, no SVG edge layer, no inline script; the 3D stage, labels and module script are present', () => {
  const html = readWorkspaceFile('index.html');
  assert.equal(/<img\b/i.test(html), false, 'no image on the page');
  assert.equal(/<svg\b/i.test(html), false, 'no flat SVG diagram');
  assert.equal(/workspace-solar/.test(html), false, 'the old image is not referenced');
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, 'no inline script (CSP)');
  assert.match(html, /<script type="module" src="\/workspace\/scene\.js"><\/script>/);
  assert.match(html, /id="scene"/);
  assert.match(html, /id="label-layer"/);
  const layer = html.slice(html.indexOf('id="label-layer"'), html.indexOf('</main>'));
  for (const step of ['user', 'router', 'pm', 'appdev', 'qa', 'study', 'portfolio']) {
    assert.match(layer, new RegExp(`class="node" data-step="${step}"`), `label for ${step} is in the label layer`);
  }
});

test('scene.js: imports only same-origin vendored files, has no CDN URL and never uses innerHTML', () => {
  const code = readWorkspaceFile('scene.js');
  const specs = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(specs.length >= 4, 'scene.js imports Three.js and the addons');
  // Same-origin only: vendored Three.js (./vendor/three/) or the Stellar Universe modules (./stellar/, Phase 1)
  for (const spec of specs) assert.match(spec, /^\.\/(vendor\/three\/|stellar\/)/, `${spec} is a same-origin module`);
  assert.equal(/https?:\/\//.test(code), false, 'no URL in scene.js');
  assert.equal(/\.innerHTML\s*=/.test(code), false, 'no innerHTML in scene.js');
  assert.match(code, /window\.workspaceScene = Object\.freeze\(\{ setNodeStatus, handoff, reset \}\)/);
});

// ---------- app.js status hooks (run in a vm with a fake DOM) ----------

/** Minimal element stub: enough for app.js (classList, dataset, textContent, children, listeners). */
function fakeEl(tag, selectors = {}) {
  const node = {
    tagName: tag,
    _text: '',
    children: [],
    dataset: {},
    listeners: {},
    className: '',
    title: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
    },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); this.children = []; },
    get firstChild() { return this.children[0] || null; },
    append(...nodes) { nodes.forEach((n) => this.appendChild(n)); },
    appendChild(n) { this.children.push(n); return n; },
    removeChild(n) { this.children = this.children.filter((c) => c !== n); return n; },
    querySelector(sel) { return selectors[sel] || null; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    set innerHTML(_v) { throw new Error('innerHTML is not allowed in app.js'); },
  };
  return node;
}

/** Load app.js into a vm with a fake DOM, an EventSource stub and the given window.workspaceScene (or none). */
function loadPage({ scene, immediateTimers = false }) {
  const code = readWorkspaceFile('app.js');
  const badge = fakeEl('span');
  const text = fakeEl('span');
  const log = fakeEl('ol');
  const clear = fakeEl('button');
  const byId = { 'status-badge': badge, 'status-text': text, log, 'clear-view-btn': clear };
  const steps = ['user', 'router', 'pm', 'appdev', 'qa', 'study', 'portfolio'];
  const nodes = steps.map((step) => {
    const b = fakeEl('span');
    b.dataset.kind = 'badge';
    const m = fakeEl('div');
    const node = fakeEl('div', { '[data-badge]': b, '[data-msg]': m });
    node.dataset.step = step;
    return node;
  });
  const agents = ['secretary', 'pm', 'app-dev', 'qa-reviewer', 'study-writer', 'portfolio-writer'].map((agent) => {
    const p = fakeEl('span');
    p.dataset.kind = 'pill';
    const card = fakeEl('li', { '[data-pill]': p });
    card.dataset.agent = agent;
    return card;
  });
  const streams = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.readyState = 0; streams.push(this); }
  }
  FakeEventSource.CLOSED = 2;
  const sandbox = {
    document: {
      readyState: 'complete',
      getElementById: (id) => byId[id] || fakeEl('div'),
      querySelectorAll: (sel) => {
        if (sel === '.node[data-step]') return nodes;
        if (sel === '#agent-list .agent-card[data-agent]') return agents;
        return [];
      },
      createElement: (tag) => fakeEl(tag),
    },
    window: scene ? { workspaceScene: scene } : {},
    EventSource: FakeEventSource,
    Date,
    // Real timers would keep the test process alive; app.js only needs the replay-grace timer to run
    setTimeout: immediateTimers ? (fn) => { fn(); return 0; } : () => 0,
    clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
  if (scene) scene.calls.length = 0; // app.js calls scene.reset() on load; tests start from a clean record
  const es = streams[0];
  return {
    nodes: Object.fromEntries(nodes.map((n) => [n.dataset.step, n])),
    log,
    open() { es.onopen(); },
    push(ev) { es.onmessage({ data: JSON.stringify(ev) }); },
    clickClear() { clear.listeners.click.forEach((fn) => fn({ preventDefault() {} })); },
  };
}

/** A scene stub that records every hook call. */
function recordingScene() {
  const calls = [];
  return {
    calls,
    setNodeStatus: (step, status) => calls.push(['status', step, status]),
    handoff: (from, to) => calls.push(['handoff', from, to]),
    reset: () => calls.push(['reset']),
  };
}

/** An event time in the future of the page open, so it is never filtered as history. */
function eventAt(offsetMs) {
  return new Date(Date.now() + offsetMs).toISOString();
}

test('app.js: a PROCESSING event drives the 3D body and draws the router -> appdev beam (after the replay burst)', () => {
  const scene = recordingScene();
  const page = loadPage({ scene, immediateTimers: true });
  page.open(); // replay grace ends immediately in this stub
  page.push({ ts: eventAt(1000), agent: 'app-dev', status: 'PROCESSING', message: 'กำลังเขียน', pipelineStep: 'appdev' });
  assert.deepEqual(scene.calls, [['status', 'appdev', 'PROCESSING'], ['handoff', 'router', 'appdev']]);
  assert.equal(page.nodes.appdev.dataset.status, 'PROCESSING');
});

test('app.js: a PM-Professor-X event drives the pm body and draws the router -> pm beam', () => {
  const scene = recordingScene();
  const page = loadPage({ scene, immediateTimers: true });
  page.open();
  page.push({ ts: eventAt(1000), agent: 'pm', status: 'PROCESSING', message: 'planning', pipelineStep: 'pm' });
  assert.deepEqual(scene.calls, [['status', 'pm', 'PROCESSING'], ['handoff', 'router', 'pm']]);
  assert.equal(page.nodes.pm.dataset.status, 'PROCESSING');
});

test('PM-Professor-X wiring: pm.md is read-only (Read, Glob, Grep), Opus-High, and the agent list, planet config and secretary routing know PM-Professor-X', () => {
  const agentsDir = path.join(__dirname, '..', '..', '..', '.claude', 'agents');
  const pm = fs.readFileSync(path.join(agentsDir, 'pm.md'), 'utf8').split(/\r?\n---\r?\n/)[0];
  assert.match(pm, /^name: PM-Professor-X$/m);
  assert.match(pm, /^model: opus$/m);
  assert.match(pm, /^effort: high$/m);
  assert.match(pm, /^tools: Read, Glob, Grep$/m, 'no Write / Edit / Bash');
  const secretary = fs.readFileSync(path.join(agentsDir, 'secretary.md'), 'utf8');
  assert.match(secretary, /^tools: Agent\(PM-Professor-X, /m, 'the secretary may dispatch PM-Professor-X');
  assert.match(secretary, /\| Plan \/ split a medium-to-large coding task into parallel sub-tasks \| PM-Professor-X \|/);
  const html = readWorkspaceFile('index.html');
  assert.match(html, /class="agent-card" data-agent="pm"/, 'PM-Professor-X is in the agent list (fallback list)');
  const code = readWorkspaceFile('scene.js');
  const config = code.match(/const SATELLITE_CONFIG = \{[\s\S]*?\n\};/)[0];
  assert.match(config, /^\s+pm:\s+\{ color: 0xf472b6,/m, 'PM-Professor-X planet colour (rose pink, not used by the other planets)');
  assert.match(code, /const SATELLITE_ORBIT_ORDER = \['pm', /, 'PM-Professor-X is the innermost orbit');
  assert.match(code, /^\s+pm: 'above',$/m, 'PM-Professor-X label side');
  assert.match(code, /const LABEL_ORDER = \['router', 'user', 'pm', /);
});

test('app.js: QA working draws both beams into qa (router -> qa and appdev -> qa chain)', () => {
  const scene = recordingScene();
  const page = loadPage({ scene, immediateTimers: true });
  page.open();
  page.push({ ts: eventAt(1000), agent: 'qa-reviewer', status: 'WORKING', message: 'ตรวจ', pipelineStep: 'qa' });
  assert.deepEqual(scene.calls, [
    ['status', 'qa', 'WORKING'],
    ['handoff', 'router', 'qa'],
    ['handoff', 'appdev', 'qa'],
  ]);
});

test('app.js: COMPLETED sets the body status but draws no beam', () => {
  const scene = recordingScene();
  const page = loadPage({ scene, immediateTimers: true });
  page.open();
  page.push({ ts: eventAt(1000), agent: 'portfolio-writer', status: 'COMPLETED', message: 'เสร็จ', pipelineStep: 'portfolio' });
  assert.deepEqual(scene.calls, [['status', 'portfolio', 'COMPLETED']]);
});

test('app.js: events during the replay burst update the body but draw no beam', () => {
  const scene = recordingScene();
  const page = loadPage({ scene, immediateTimers: false }); // no open(): suppressFlash stays true
  page.push({ ts: eventAt(1000), agent: 'study-writer', status: 'WORKING', message: 'เขียน', pipelineStep: 'study' });
  assert.deepEqual(scene.calls, [['status', 'study', 'WORKING']]);
});

test('app.js: "ล้างหน้าจอ" calls scene.reset(), and the page resets its own state', () => {
  const scene = recordingScene();
  const page = loadPage({ scene, immediateTimers: true });
  page.open();
  page.push({ ts: eventAt(1000), agent: 'app-dev', status: 'WORKING', message: 'x', pipelineStep: 'appdev' });
  scene.calls.length = 0;
  page.clickClear();
  assert.deepEqual(scene.calls, [['reset']]);
  assert.equal(page.nodes.appdev.dataset.status, 'IDLE');
  assert.equal(page.log.children.length, 0);
});

test('app.js: without the 3D scene (no WebGL) the list view still updates and nothing throws', () => {
  const page = loadPage({ scene: null, immediateTimers: true });
  page.open();
  page.push({ ts: eventAt(1000), agent: 'app-dev', status: 'WORKING', message: 'ทำงาน', pipelineStep: 'appdev' });
  assert.equal(page.nodes.appdev.dataset.status, 'WORKING');
  assert.equal(page.log.children.length, 1);
  page.clickClear(); // reset without a scene
  assert.equal(page.nodes.appdev.dataset.status, 'IDLE');
});
