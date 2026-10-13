'use strict';
/**
 * workspace-model-labels.test.js - the 3D planet labels show ONLY "Model-Effort" (no member names).
 *
 * Static checks (the page needs WebGL and a browser, so the markup, the CSS and the scene.js wiring are read as text):
 *   - index.html: every team node has an empty .node-model chip; the owner node has none (it keeps its name chip)
 *   - style.css: compact 3D label hides .node-name for team nodes; hover / focus (.is-expanded) shows the full name and hides
 *     .node-model; an empty .node-model is hidden (no model known: no chip); the no-WebGL list keeps the full name
 *   - scene.js: dynamic planet labels get a .node-model chip too, and applyModels() refreshes it
 * Behavior tests: chipTextOf() (stellar/model.js) and the real createDynamicLabel() / applyModels() source of scene.js run in a
 * vm with a fake DOM: the chip shows Model-Effort, or the member's display name when no suffix is known, and switches later.
 * The runtime part (app.js writes the chip text) is covered in workspace.test.js ("model labels").
 * Names elsewhere (HUD, cards, log, hover detail) are covered by agent-models.test.js / workspace.test.js.
 * No files written, no network. Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const dir = path.join(__dirname, '..', 'public', 'workspace');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

/** The HTML of one <div class="node" data-step="..."> block (up to the next node or the end of the label layer). */
function nodeBlock(html, step) {
  const start = html.indexOf(`<div class="node" data-step="${step}"`);
  assert.ok(start >= 0, `index.html has the ${step} node`);
  const next = html.indexOf('<div class="node" data-step=', start + 10);
  return html.slice(start, next < 0 ? undefined : next);
}

test('index.html: every team node has an empty .node-model chip; the owner node has none', () => {
  const html = read('index.html');
  for (const step of ['router', 'pm', 'appdev', 'qa', 'study', 'portfolio']) {
    const block = nodeBlock(html, step);
    assert.match(block, /<span class="node-model"><\/span>/, `${step}: empty .node-model (app.js fills it)`);
    assert.match(block, /class="node-name"/, `${step}: the full name chip is still there (hover, HUD-free fallback list)`);
  }
  const owner = nodeBlock(html, 'user');
  assert.ok(!owner.includes('node-model'), 'the owner has no model chip');
  assert.match(owner, /<span class="node-name">คุณกฎ<\/span>/, 'the owner keeps its name chip');
});

test('style.css: compact 3D label = model chip only; hover / focus = full name; empty chip hidden; list layout keeps names', () => {
  const css = read('style.css');
  assert.match(css, /\.node:not\(\[data-step="user"\]\) \.node-name \{ display: none; \}/, 'team names are hidden in the compact label');
  assert.match(css, /\.node\.is-expanded \.node-name \{ display: inline-block; \}/, 'hover / focus shows the full name');
  assert.match(css, /\.node\.is-expanded \.node-model \{ display: none; \}/, 'hover / focus replaces the model chip');
  assert.match(css, /\.node-model:empty \{ display: none; \}/, 'nothing to show at all: no chip');
  assert.match(css, /\.node-model \{ max-width: \d+px; overflow: hidden; text-overflow: ellipsis; \}/, 'a long fallback name is clipped');
  assert.match(css, /\.stage\.no-webgl \.node \.node-name \{ display: inline-block; \}/, 'list layout shows the full name');
  assert.match(css, /\.stage\.no-webgl \.node \.node-model \{ display: none; \}/, 'list layout does not need the model chip');
  // The owner name chip is never hidden by the compact rule (it is the only label of that star)
  assert.ok(!/\.node\[data-step="user"\] \.node-name \{ display: none/.test(css));
});

test('scene.js: dynamic planet labels have a .node-model chip that applyModels() refreshes', () => {
  const code = read('scene.js');
  const label = code.match(/function createDynamicLabel[\s\S]*?\n}\n/);
  assert.ok(label, 'createDynamicLabel found');
  assert.match(label[0], /className = 'node-model'/);
  assert.match(label[0], /chipTextOf\(agent, agent\)/, 'suffix, or the name when the agent has no suffix');
  assert.match(label[0], /info\.append\(name, model,/, 'the chip is part of the label');
  const apply = code.match(/function applyModels[\s\S]*?\n}\n/);
  assert.ok(apply, 'applyModels found');
  assert.match(apply[0], /querySelector\('\.node-model'\)/);
  assert.match(apply[0], /chipTextOf\(agent, agent\)/);
});

// ---------- behavior ----------

/** Minimal fake DOM element: only what createDynamicLabel / applyModels use. */
function fakeEl(tag) {
  const el = {
    tag, className: '', textContent: '', dataset: {}, style: {}, children: [],
    append(...nodes) { el.children.push(...nodes); },
    appendChild(node) { el.children.push(node); return node; },
    querySelector(sel) { return el.children.find((c) => sel === `.${c.className}`) || null; },
  };
  return el;
}

/** Pull one top-level function out of scene.js (it imports three.js, so the file cannot be loaded in node). */
function fnSource(code, name) {
  const m = code.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`));
  assert.ok(m, `${name} found in scene.js`);
  return m[0];
}

/** The real createDynamicLabel + applyModels, wired to the real model.js and a fake DOM / body table. */
async function sceneLabelHarness() {
  const model = await import(pathToFileURL(path.join(dir, 'stellar', 'model.js')).href);
  const code = read('scene.js');
  const bodies = new Map();
  const dynamicKeys = [];
  const sandbox = {
    document: { createElement: fakeEl },
    cssHex: () => '#7dd3fc',
    withModel: model.withModel, chipTextOf: model.chipTextOf, setAgentModels: model.setAgentModels,
    agentOfBodyKey: model.agentOfBodyKey,
    bodies, dynamic: { keys: () => dynamicKeys.slice() },
    hud: null, store: null, focusStep: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fnSource(code, 'createDynamicLabel')}\n${fnSource(code, 'refreshHud')}\n${fnSource(code, 'applyModels')}\n` +
    'this.createDynamicLabel = createDynamicLabel; this.applyModels = applyModels;', sandbox);
  /** Add a dynamic planet label the way scene.js does and return its chip + name elements. */
  function addPlanet(agent) {
    const key = model.dynamicKeyOf(agent);
    const label = sandbox.createDynamicLabel(key, agent, { atmo: 0x7dd3fc });
    bodies.set(key, { info: label.info });
    dynamicKeys.push(key);
    return { chip: label.info.querySelector('.node-model'), name: label.info.querySelector('.node-name') };
  }
  return { model, sandbox, addPlanet };
}

test('chipTextOf: suffix when known, else the display name, else empty', async () => {
  const m = await import(pathToFileURL(path.join(dir, 'stellar', 'model.js')).href);
  m.setAgentModels({});
  assert.equal(m.chipTextOf('helper-x', 'helper-x'), 'helper-x', 'no suffix: the name');
  m.setAgentModels({ 'helper-x': { suffix: 'Opus-High' }, user: { suffix: 'Opus-High' } });
  assert.equal(m.chipTextOf('helper-x', 'helper-x'), 'Opus-High', 'suffix wins');
  assert.equal(m.chipTextOf('user', 'คุณกฎ'), 'คุณกฎ', 'the owner never gets a suffix');
  assert.equal(m.chipTextOf('nobody', undefined), '', 'no suffix and no name: empty');
  m.setAgentModels({});
});

test('dynamic planet label: no agent file -> chip shows the name; applyModels() switches to Model-Effort; hover name unchanged', async () => {
  const h = await sceneLabelHarness();
  h.model.setAgentModels({});   // /api/agents failed or has no entry
  const planet = h.addPlanet('data-miner');
  assert.equal(planet.chip.textContent, 'data-miner', 'chip falls back to the display name');
  assert.equal(planet.name.textContent, 'data-miner', 'full name chip (hover) is the plain name');
  // /api/agents answers later, with a suffix for this agent: the chip switches
  h.sandbox.applyModels({ 'data-miner': { suffix: 'Sonnet-Low' } });
  assert.equal(planet.chip.textContent, 'Sonnet-Low', 'chip switches to Model-Effort');
  assert.equal(planet.name.textContent, 'data-miner (Sonnet-Low)', 'hover / focus still shows the full name');
  // A later answer without it falls back to the name again
  h.sandbox.applyModels({});
  assert.equal(planet.chip.textContent, 'data-miner');
  h.model.setAgentModels({});
});

test('dynamic planet label: suffix known at creation -> Model-Effort from the start', async () => {
  const h = await sceneLabelHarness();
  h.model.setAgentModels({ 'known-agent': { suffix: 'Opus-Medium' } });
  const planet = h.addPlanet('known-agent');
  assert.equal(planet.chip.textContent, 'Opus-Medium');
  assert.equal(planet.name.textContent, 'known-agent (Opus-Medium)');
  h.model.setAgentModels({});
});
