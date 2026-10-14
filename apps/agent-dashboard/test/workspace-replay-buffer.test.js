'use strict';
/**
 * workspace-replay-buffer.test.js - Early-events fix (Phase 2, review finding "Med"):
 *   app.js connects SSE before scene.js (a module) has registered its 'workspace:event' listener, and the scene
 *   resets its store at boot. Without a buffer, the replayed events were lost and the HUD showed "No open task".
 *
 * Runs the real public/workspace/app.js in a vm with a fake DOM, a fake EventSource and a fake window
 * (addEventListener / dispatchEvent / CustomEvent). The "scene" is simulated the same way scene.js boots:
 *   1. its 'workspace:event' listener is registered (feeds the real stellar/store.js),
 *   2. its store is reset,
 *   3. 'workspace:scene-ready' is dispatched.
 * Checks: events before the ready signal are buffered and sent in order after it (nothing lost), replayed history
 * reaches the store as a replay (no comets) AND is shown in the log (a reload restores the session), duplicates
 * are sent once, live events after the ready signal go straight through, and the buffer is bounded.
 * No server, no files, no real data. Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const APP_JS = fs.readFileSync(path.join(WORKSPACE_DIR, 'app.js'), 'utf8');
const STORE_URL = pathToFileURL(path.join(WORKSPACE_DIR, 'stellar', 'store.js')).href;

/** Minimal element stub: what app.js touches (classList, dataset, textContent, children, listeners). */
function fakeEl(tag, selectors = {}) {
  return {
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
  };
}

/** Fake window: a tiny event bus, so window.addEventListener / dispatchEvent behave like the browser for these events. */
function fakeWindow() {
  const listeners = new Map();
  class FakeCustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }
  return {
    CustomEvent: FakeCustomEvent,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      (listeners.get(ev.type) || []).forEach((fn) => fn(ev));
      return true;
    },
  };
}

/** Load app.js in a vm. Returns the page handle and the fake window (to attach a fake scene). */
function loadPage({ readyState = 'complete' } = {}) {
  const win = fakeWindow();
  const docListeners = {};
  const log = fakeEl('ol');
  const byId = {
    'status-badge': fakeEl('span'),
    'status-text': fakeEl('span'),
    log,
    'clear-view-btn': fakeEl('button'),
  };
  const streams = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.readyState = 0; streams.push(this); }
  }
  FakeEventSource.CLOSED = 2;
  const sandbox = {
    window: win,
    document: {
      readyState,
      getElementById: (id) => byId[id] || fakeEl('div'),
      querySelectorAll: () => [],
      createElement: (tag) => fakeEl(tag),
      addEventListener: (type, fn) => { docListeners[type] = fn; },
    },
    EventSource: FakeEventSource,
    Date,
    // The replay-grace timer runs at once, so the live events after open() are not replays
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  const before = Date.now();
  vm.runInContext(APP_JS, sandbox, { filename: 'app.js' });
  // The stream exists once app.js init() has run (DOMContentLoaded), so it is looked up at call time
  return {
    win,
    log,
    /** SSE connected: the replay burst starts (the grace timer then clears it, at once in this sandbox). */
    open() { streams[0].onopen(); },
    /** One SSE message (one workspace event). */
    push(ev) { streams[0].onmessage({ data: JSON.stringify(ev) }); },
    pageOpenedAt: before,
    /** DOMContentLoaded: runs app.js init() (connects SSE). */
    domContentLoaded() { if (docListeners.DOMContentLoaded) docListeners.DOMContentLoaded(); },
  };
}

/** A live event: ts after the page was opened. */
const live = (ms, agent, status, message, pipelineStep) => ({
  ts: new Date(Date.now() + ms).toISOString(), agent, status, message, ...(pipelineStep ? { pipelineStep } : {}),
});
/** A history event: ts well before the page was opened (it arrives in the server replay). */
const history = (agent, status, message, minutesAgo) => ({
  ts: new Date(Date.now() - minutesAgo * 60000).toISOString(), agent, status, message,
});

test('early events: nothing is sent before the scene is ready, then everything is sent in order (none lost)', async () => {
  const { createStore } = await import(STORE_URL);
  const page = loadPage();
  const store = createStore();
  const received = [];
  page.win.addEventListener('workspace:event', (e) => {
    received.push({ replay: e.detail.replay, agent: e.detail.event.agent, status: e.detail.event.status });
    store.ingest(e.detail.event);
  });

  page.open();
  // The SSE replay arrives before the scene is ready (this is the bug: it used to be dropped)
  page.push(history('app-dev', 'PROCESSING', 'old task', 45));
  page.push(live(1000, 'app-dev', 'PROCESSING', 'new task', 'appdev'));
  page.push(live(2000, 'qa-reviewer', 'WORKING', 'review', 'qa'));
  assert.equal(received.length, 0, 'buffered: the scene has no listener yet, so nothing is sent');

  // scene.js boot: listener registered (above), store reset, then the ready signal
  store.reset();
  page.win.dispatchEvent(new page.win.CustomEvent('workspace:scene-ready', { detail: { active: true } }));

  assert.deepEqual(received.map((r) => r.agent), ['app-dev', 'app-dev', 'qa-reviewer'], 'buffered events are sent in order');
  assert.equal(received[0].replay, true, 'history is a replay (no comets)');
  assert.equal(received[1].replay, false, 'a live event after the page is open is not a replay');

  const snap = store.snapshot('app-dev');
  // Both PROCESSING events opened a task (oldest first). The 45-minute-old one is stale (no end event), the new one is not.
  assert.deepEqual(snap.currentTasks.map((t) => t.text), ['old task', 'new task'], 'the open tasks from the buffer are in the HUD store');
  assert.deepEqual(snap.currentTasks.map((t) => t.stale), [true, false], 'the old open task is marked stale');
  assert.equal(snap.recentTasks.length, 0);
  assert.equal(store.snapshot('qa-reviewer').status, 'WORKING', 'the other agent is in the store too');
});

test('history (the server replay of the current session) reaches the HUD store AND the log', async () => {
  const { createStore } = await import(STORE_URL);
  const page = loadPage();
  const store = createStore();
  page.win.addEventListener('workspace:event', (e) => store.ingest(e.detail.event));
  page.win.dispatchEvent(new page.win.CustomEvent('workspace:scene-ready', { detail: { active: true } }));
  page.open();
  page.push(history('study-writer', 'COMPLETED', 'done earlier', 5));
  assert.equal(page.log.children.length, 1, 'the replayed line is in the log: a reload must not wipe the session data');
  assert.equal(store.snapshot('study-writer').logs.length, 1, 'but the HUD store has the history line');
});

test('duplicates: the same event replayed twice is sent once', async () => {
  const page = loadPage();
  const received = [];
  page.win.addEventListener('workspace:event', (e) => received.push(e.detail.event.message));
  page.open();
  const ev = live(3000, 'app-dev', 'WORKING', 'once');
  page.push(ev);
  page.push(ev);
  page.win.dispatchEvent(new page.win.CustomEvent('workspace:scene-ready', { detail: { active: true } }));
  page.push(ev);
  assert.deepEqual(received, ['once'], 'sent once, before and after the ready signal');
});

test('live events after the ready signal go straight through (no buffering delay)', () => {
  const page = loadPage();
  const received = [];
  page.win.addEventListener('workspace:event', (e) => received.push(e.detail.event.message));
  page.win.dispatchEvent(new page.win.CustomEvent('workspace:scene-ready', { detail: { active: false } }));
  page.open();
  page.push(live(4000, 'qa-reviewer', 'WORKING', 'now'));
  assert.deepEqual(received, ['now'], 'delivered at once');
});

test('the buffer is bounded: at most 1000 buffered events are kept (the oldest are dropped)', () => {
  const page = loadPage();
  const received = [];
  page.win.addEventListener('workspace:event', (e) => received.push(e.detail.event.message));
  page.open();
  for (let i = 0; i < 1100; i++) page.push(live(5000 + i, 'app-dev', 'WORKING', `m${i}`));
  page.win.dispatchEvent(new page.win.CustomEvent('workspace:scene-ready', { detail: { active: true } }));
  assert.equal(received.length, 1000, 'bounded at PENDING_LIMIT');
  assert.equal(received[0], 'm100', 'the 100 oldest were dropped');
  assert.equal(received[999], 'm1099');
});

test('real load order: scene.js announces ready BEFORE DOMContentLoaded, and the buffered events still reach the store', async () => {
  // scene.js is a module (deferred): it runs before DOMContentLoaded, while app.js init() has not run yet.
  const { createStore } = await import(STORE_URL);
  const page = loadPage({ readyState: 'loading' });
  assert.equal(typeof page.domContentLoaded, 'function');
  const store = createStore();
  page.win.addEventListener('workspace:event', (e) => store.ingest(e.detail.event));
  // 1. the scene announces ready before init() (the SSE is not connected yet)
  store.reset();
  page.win.dispatchEvent(new page.win.CustomEvent('workspace:scene-ready', { detail: { active: true } }));
  // 2. DOMContentLoaded: init() runs and the SSE connects; the history arrives
  page.domContentLoaded();
  page.open();
  page.push(history('app-dev', 'PROCESSING', 'history task', 10));
  page.push(live(6000, 'app-dev', 'PROCESSING', 'live task', 'appdev'));
  assert.deepEqual(store.snapshot('app-dev').currentTasks.map((t) => t.text), ['history task', 'live task'],
    'with the early ready signal the store is fed (the old code kept everything buffered forever)');
});
