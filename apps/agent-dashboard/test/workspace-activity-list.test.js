'use strict';
/**
 * workspace-activity-list.test.js - the browser page (public/workspace/app.js) and the "activity" SSE channel:
 *   - the small text state under each agent card: "คิดอยู่" (a live instance, no tool running) / "กำลังใช้ tool: Read"
 *     (a tool call is running) / nothing; it works without WebGL (it only needs the activity rules scene.js publishes)
 *   - an activity message is forwarded to the 3D scene as the window event 'workspace:activity', only after the scene is ready
 *   - old messages (history, before the page was opened) and invalid ones are ignored; a finished instance clears its text;
 *     the clear button resets it; nothing throws without the activity rules
 *   - an activity message never reaches the log or the default `message` handler
 * app.js runs in a vm with a small fake DOM and the real stellar/store.js and stellar/activity.js. No browser, no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const appCode = fs.readFileSync(path.join(WORKSPACE_DIR, 'app.js'), 'utf8');
const imp = (...parts) => import(pathToFileURL(path.join(WORKSPACE_DIR, ...parts)).href);

/** Minimal element stub (same shape as the other app.js tests). */
function fakeEl(selectors = {}) {
  return {
    _text: '', children: [], dataset: {}, listeners: {}, className: '', title: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: { _set: new Set(), add(...c) { c.forEach((x) => this._set.add(x)); }, remove(...c) { c.forEach((x) => this._set.delete(x)); } },
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
}

const STEP_OF = { secretary: 'router', pm: 'pm', 'app-dev': 'appdev', 'qa-reviewer': 'qa', 'study-writer': 'study', 'portfolio-writer': 'portfolio' };

/**
 * Load app.js. withActivity = publish the activity rules (window.workspaceActivity) like scene.js does.
 * Returns helpers: pushEvent (default SSE message), pushActivity (named "activity" message), the card texts and the window events.
 */
async function loadPage({ withActivity = true, sceneReady = true } = {}) {
  const { createStore } = await imp('stellar', 'store.js');
  const activityLib = await imp('stellar', 'activity.js');
  const clock = { ms: Date.parse('2026-10-13T09:00:00.000Z') };
  class FakeDate extends Date { static now() { return clock.ms; } }

  const nodes = ['user', 'router', 'pm', 'appdev', 'qa', 'study', 'portfolio'].map((step) => {
    const badge = fakeEl(); badge.dataset.kind = 'badge';
    const node = fakeEl({ '[data-badge]': badge, '[data-msg]': fakeEl() });
    node.dataset.step = step;
    return node;
  });
  const agents = ['secretary', 'pm', 'app-dev', 'qa-reviewer', 'study-writer', 'portfolio-writer'];
  const cards = agents.map((agent) => {
    const pill = fakeEl(); pill.dataset.kind = 'pill';
    const name = fakeEl(); name.textContent = agent;
    const act = fakeEl();                                   // the [data-act] slot app.js writes into
    const card = fakeEl({ '[data-pill]': pill, '[data-name]': name, '[data-act]': act, '.agent-info': fakeEl() });
    card.dataset.agent = agent; card.act = act;
    return card;
  });
  const clear = fakeEl();
  const byId = { 'status-badge': fakeEl(), 'status-text': fakeEl(), log: fakeEl(), 'clear-view-btn': clear };
  const streams = [];
  class FakeEventSource {
    constructor() { this.readyState = 0; this.named = {}; streams.push(this); }
    addEventListener(type, fn) { this.named[type] = fn; }
  }
  FakeEventSource.CLOSED = 2;

  const winListeners = new Map();
  const sent = [];   // window events dispatched by app.js: { type, detail }
  const intervals = [];
  class FakeCustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
  const win = {
    CustomEvent: FakeCustomEvent,
    addEventListener(type, fn) { if (!winListeners.has(type)) winListeners.set(type, []); winListeners.get(type).push(fn); },
    dispatchEvent(ev) { sent.push({ type: ev.type, detail: ev.detail }); (winListeners.get(ev.type) || []).forEach((fn) => fn(ev)); return true; },
    workspaceScene: { setNodeStatus() {}, handoff() {}, reset() {} },
    createWorkspaceStore: createStore,
    ...(withActivity ? { workspaceActivity: activityLib } : {}),
  };
  const sandbox = {
    document: {
      readyState: 'complete',
      getElementById: (id) => byId[id] || fakeEl(),
      querySelectorAll: (sel) => (sel === '.node[data-step]' ? nodes : sel === '#agent-list .agent-card[data-agent]' ? cards : []),
      createElement: () => fakeEl(),
    },
    window: win,
    EventSource: FakeEventSource,
    Date: FakeDate,
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: (fn) => { intervals.push(fn); return 0; },
  };
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox, { filename: 'app.js' });
  const es = streams[0];
  es.onopen();
  if (sceneReady) win.dispatchEvent(new FakeCustomEvent('workspace:scene-ready', { detail: { active: true } }));
  sent.length = 0;

  const iso = (offsetMs = 0) => new Date(clock.ms + offsetMs).toISOString();
  let n = 0;
  return {
    clock, sent, es,
    text: (agent) => cards.find((c) => c.dataset.agent === agent).act.textContent,
    /** One default SSE message (a workspace event). */
    pushEvent(agent, status, message, toolUseId) {
      n += 1;
      es.onmessage({ data: JSON.stringify({ ts: iso(n), agent, status, message, ...(STEP_OF[agent] ? { pipelineStep: STEP_OF[agent] } : {}), ...(toolUseId ? { toolUseId } : {}) }) });
    },
    /** One "activity" SSE message at the fake now (+offsetMs). */
    pushActivity(agent, phase, tool, extra = {}, offsetMs = 0) {
      es.named.activity({ data: JSON.stringify({ ts: iso(offsetMs), agent, phase, tool, ...extra }) });
    },
    rawActivity(data) { es.named.activity({ data }); },
    tick() { intervals.forEach((fn) => fn()); },
    clickClear() { clear.listeners.click.forEach((fn) => fn({ preventDefault() {} })); },
    activityEvents: () => sent.filter((s) => s.type === 'workspace:activity').map((s) => s.detail.activity),
    logLines: () => byId.log.children.length,
  };
}

test('the page listens to the named "activity" channel next to the default message handler', async () => {
  const p = await loadPage();
  assert.equal(typeof p.es.named.activity, 'function');
  assert.equal(typeof p.es.onmessage, 'function');
});

test('text state: a live instance is "คิดอยู่"; a running tool shows its name; the end of the call goes back to "คิดอยู่"', async () => {
  const p = await loadPage();
  assert.equal(p.text('app-dev'), '', 'idle: no text');
  p.pushEvent('app-dev', 'PROCESSING', 'task A', 'toolu_A');
  p.tick();
  assert.equal(p.text('app-dev'), 'คิดอยู่', 'the instance has started and no tool runs');

  p.pushActivity('app-dev', 'start', 'Read', { callId: 'c1', instance: 'toolu_A' });
  assert.equal(p.text('app-dev'), 'กำลังใช้ tool: Read');
  p.pushActivity('app-dev', 'end', 'Read', { callId: 'c1', instance: 'toolu_A' });
  assert.equal(p.text('app-dev'), 'คิดอยู่', 'a tool just finished');

  p.pushActivity('app-dev', 'start', 'Bash', { callId: 'c2', instance: 'toolu_A' });
  p.pushActivity('app-dev', 'error', 'Bash', { callId: 'c2', instance: 'toolu_A' });
  assert.equal(p.text('app-dev'), 'คิดอยู่', 'a failed tool call ends the call as well');
});

test('text state: other agents are not touched; two instances: acting while any call runs, thinking when none', async () => {
  const p = await loadPage();
  p.pushEvent('app-dev', 'PROCESSING', 'task A', 'toolu_A');
  p.pushEvent('app-dev', 'PROCESSING', 'task B', 'toolu_B');
  p.pushEvent('qa-reviewer', 'PROCESSING', 'qa', 'toolu_Q');
  p.pushActivity('app-dev', 'start', 'Edit', { callId: 'c1', instance: 'toolu_A' });
  assert.equal(p.text('app-dev'), 'กำลังใช้ tool: Edit');
  assert.equal(p.text('qa-reviewer'), 'คิดอยู่', 'another agent keeps thinking');
  assert.equal(p.text('pm'), '');
  p.pushActivity('app-dev', 'end', 'Edit', { callId: 'c1', instance: 'toolu_A' });
  assert.equal(p.text('app-dev'), 'คิดอยู่');
});

test('text state: the main agent shows only the tool it uses (it has no instance), and goes blank when the call ends', async () => {
  const p = await loadPage();
  p.pushActivity('secretary', 'start', 'Bash', { callId: 's1' });
  assert.equal(p.text('secretary'), 'กำลังใช้ tool: Bash');
  p.pushActivity('secretary', 'end', 'Bash', { callId: 's1' });
  assert.equal(p.text('secretary'), '');
});

test('a tool call of an agent without a live instance shows no "thinking" and a finished instance clears its text', async () => {
  const p = await loadPage();
  p.pushActivity('pm', 'start', 'Read', { callId: 'c1' });
  assert.equal(p.text('pm'), 'กำลังใช้ tool: Read', 'a call at planet level is still a tool in use');
  p.pushActivity('pm', 'end', 'Read', { callId: 'c1' });
  assert.equal(p.text('pm'), '', 'no live instance: not thinking');

  p.pushEvent('app-dev', 'PROCESSING', 'task A', 'toolu_A');
  p.pushActivity('app-dev', 'start', 'Grep', { callId: 'c2', instance: 'toolu_A' });
  assert.equal(p.text('app-dev'), 'กำลังใช้ tool: Grep');
  p.pushEvent('app-dev', 'COMPLETED', 'done', 'toolu_A');   // the instance finished while a call was still marked running
  p.tick();
  assert.equal(p.text('app-dev'), '', 'no live instance');
  // Forgotten, not just hidden: an instance that comes back with the same id starts thinking, not "using Grep"
  p.pushEvent('app-dev', 'PROCESSING', 'task A again', 'toolu_A');
  p.tick();
  assert.equal(p.text('app-dev'), 'คิดอยู่', 'the call of the finished run was released');
});

test('forwarding: a live activity message goes to the scene as the window event workspace:activity (unchanged payload)', async () => {
  const p = await loadPage();
  p.pushActivity('app-dev', 'start', 'Edit', { callId: 'c1', instance: 'toolu_A' });
  p.pushActivity('app-dev', 'end', 'Edit', { callId: 'c1', instance: 'toolu_A' });
  const got = p.activityEvents();
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((a) => [a.agent, a.phase, a.tool, a.instance]), [['app-dev', 'start', 'Edit', 'toolu_A'], ['app-dev', 'end', 'Edit', 'toolu_A']]);
});

test('forwarding waits for the scene: before workspace:scene-ready nothing is sent, but the text state already works', async () => {
  const p = await loadPage({ sceneReady: false });
  p.pushActivity('secretary', 'start', 'Read', { callId: 's1' });
  assert.equal(p.activityEvents().length, 0);
  assert.equal(p.text('secretary'), 'กำลังใช้ tool: Read');
});

test('old and invalid messages are ignored: a start older than the limit or than the page, bad JSON, wrong shape', async () => {
  const p = await loadPage();
  p.pushActivity('secretary', 'start', 'Read', { callId: 'old' }, -60000);   // a minute old: history, not a live call
  assert.equal(p.text('secretary'), '');
  assert.equal(p.activityEvents().length, 0);
  p.rawActivity('not json');
  p.rawActivity('{"agent":"secretary"}');
  p.rawActivity('null');
  p.rawActivity(JSON.stringify({ agent: 'secretary', phase: 'start', tool: 'Read', ts: 'garbage' }));
  assert.equal(p.text('secretary'), '');
  assert.equal(p.activityEvents().length, 0);
  // An END message is always applied (it only removes a call)
  p.pushActivity('secretary', 'start', 'Read', { callId: 'c1' });
  p.pushActivity('secretary', 'end', 'Read', { callId: 'c1' }, -60000);
  assert.equal(p.text('secretary'), '');
});

test('activity never reaches the log or the workspace-event path', async () => {
  const p = await loadPage();
  p.pushActivity('app-dev', 'start', 'Read', { callId: 'c1' });
  assert.equal(p.logLines(), 0, 'no log line');
  assert.equal(p.sent.some((s) => s.type === 'workspace:event'), false, 'not a workspace event (the HUD store never sees it)');
});

test('the clear button forgets the running calls and clears the texts', async () => {
  const p = await loadPage();
  p.pushEvent('app-dev', 'PROCESSING', 'task A', 'toolu_A');
  p.pushActivity('app-dev', 'start', 'Bash', { callId: 'c1', instance: 'toolu_A' });
  assert.equal(p.text('app-dev'), 'กำลังใช้ tool: Bash');
  p.clickClear();
  assert.equal(p.text('app-dev'), '');
  p.tick();
  assert.equal(p.text('app-dev'), '');
  // Forgotten, not just hidden: the same instance id after the clear starts thinking, the old call is not running any more
  p.pushEvent('app-dev', 'PROCESSING', 'task A again', 'toolu_A');
  p.tick();
  assert.equal(p.text('app-dev'), 'คิดอยู่', 'the call from before the clear is gone');
});

test('without the activity rules (window.workspaceActivity missing) nothing throws and nothing is shown', async () => {
  const p = await loadPage({ withActivity: false });
  p.pushEvent('app-dev', 'PROCESSING', 'task A', 'toolu_A');
  assert.doesNotThrow(() => p.pushActivity('app-dev', 'start', 'Read', { callId: 'c1' }));
  assert.doesNotThrow(() => p.tick());
  assert.equal(p.text('app-dev'), '');
  assert.equal(p.activityEvents().length, 0);
});

test('app.js and scene.js wire the channel: named SSE listener, window event, publish of the rules, reduced motion, dispose', () => {
  assert.match(appCode, /es\.addEventListener\('activity', onActivity\)/);
  assert.match(appCode, /new window\.CustomEvent\('workspace:activity'/);
  assert.equal(/\.innerHTML\s*=/.test(appCode), false);

  const scene = fs.readFileSync(path.join(WORKSPACE_DIR, 'scene.js'), 'utf8');
  assert.match(scene, /from '\.\/stellar\/activity\.js'/);
  assert.match(scene, /from '\.\/stellar\/effects\.js'/);
  assert.match(scene, /window\.workspaceActivity = Object\.freeze\(/);
  assert.match(scene, /createEffects\(\{ parent: world, register: registerParticles, reducedMotion: REDUCED_MOTION \}\)/, 'reduced motion reaches the effects');
  assert.match(scene, /window\.addEventListener\('workspace:activity', onActivity\)/);
  assert.match(scene, /window\.addEventListener\('workspace:event', onEventEffects\)/);
  assert.ok(scene.indexOf("addEventListener('workspace:event', onWorkspaceEvent)") < scene.indexOf("addEventListener('workspace:event', onEventEffects)"),
    'the effects listener runs after the one that feeds the store (it reads the close that event caused)');
  assert.match(scene, /REDUCED_MOTION \? PULSE_STATIC : heartbeat\(/, 'reduced motion: a static glow instead of the pulse');
  assert.match(scene, /fx\.dispose\(\)/, 'the pools are freed on page hide');
  assert.match(scene, /if \(fx\) fx\.clear\(\);/, 'reset clears the effects');
  assert.equal(/\.innerHTML\s*=/.test(scene), false);
});
