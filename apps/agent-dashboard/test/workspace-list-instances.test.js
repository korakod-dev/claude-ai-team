'use strict';
/**
 * workspace-list-instances.test.js - the list view of public/workspace/app.js with several instances of one agent
 * (finding H; it works without WebGL). app.js runs in a vm with a small fake DOM. The store factory that scene.js publishes
 * (window.createWorkspaceStore) is the real stellar/store.js, so the list and the 3D planets use the same rules.
 *   - the card shows the instance count from 2 on ("Dev-ไอ้เก่ง ×3") and plain again with one instance
 *   - card, pipeline node and the 3D hook keep PROCESSING until the LAST instance has finished (finding A)
 *   - the status falls back to idle by itself when an end event is missed (timer), count and status follow
 *   - the clear button resets the count; without the factory the old latest-event status is used
 * No browser, no network. The clock is injected as Date, and setInterval is captured, so nothing waits.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const appCode = fs.readFileSync(path.join(WORKSPACE_DIR, 'app.js'), 'utf8');

/** Minimal element stub: enough for app.js (classList, dataset, textContent, children, listeners). */
function fakeEl(selectors = {}) {
  return {
    _text: '', children: [], dataset: {}, listeners: {}, className: '', title: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0,
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
}

const STEP_OF = { secretary: 'router', pm: 'pm', 'app-dev': 'appdev', 'qa-reviewer': 'qa', 'study-writer': 'study', 'portfolio-writer': 'portfolio' };

/** Load app.js. withStore = publish the real store factory (as scene.js does). Returns pushes, the clock and the elements. */
async function loadPage({ withStore = true } = {}) {
  const { createStore } = await import(pathToFileURL(path.join(WORKSPACE_DIR, 'stellar', 'store.js')).href);
  const clock = { ms: Date.parse('2026-10-13T09:00:00.000Z') };
  class FakeDate extends Date { static now() { return clock.ms; } }

  const steps = ['user', 'router', 'pm', 'appdev', 'qa', 'study', 'portfolio'];
  const nodes = steps.map((step) => {
    const badge = fakeEl(); badge.dataset.kind = 'badge';
    const node = fakeEl({ '[data-badge]': badge, '[data-msg]': fakeEl() });
    node.dataset.step = step;
    node.badge = badge;
    return node;
  });
  const agents = ['secretary', 'pm', 'app-dev', 'qa-reviewer', 'study-writer', 'portfolio-writer'];
  const baseNames = { 'app-dev': 'Dev-ไอ้เก่ง', 'qa-reviewer': 'QA-คุณละเอียด' };
  const cards = agents.map((agent) => {
    const pill = fakeEl(); pill.dataset.kind = 'pill';
    const name = fakeEl(); name.textContent = baseNames[agent] || agent;
    const card = fakeEl({ '[data-pill]': pill, '[data-name]': name });
    card.dataset.agent = agent; card.pill = pill; card.name = name;
    return card;
  });
  const clear = fakeEl();
  const byId = { 'status-badge': fakeEl(), 'status-text': fakeEl(), log: fakeEl(), 'clear-view-btn': clear };
  const streams = [];
  class FakeEventSource { constructor() { this.readyState = 0; streams.push(this); } }
  FakeEventSource.CLOSED = 2;
  const sceneCalls = [];
  const intervals = [];
  const sandbox = {
    document: {
      readyState: 'complete',
      getElementById: (id) => byId[id] || fakeEl(),
      querySelectorAll: (sel) => (sel === '.node[data-step]' ? nodes : sel === '#agent-list .agent-card[data-agent]' ? cards : []),
      createElement: () => fakeEl(),
    },
    window: {
      workspaceScene: {
        setNodeStatus: (step, status) => sceneCalls.push([step, status]),
        handoff() {}, reset() {},
      },
      ...(withStore ? { createWorkspaceStore: createStore } : {}),
    },
    EventSource: FakeEventSource,
    Date: FakeDate,
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: (fn) => { intervals.push(fn); return 0; },
  };
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox, { filename: 'app.js' });
  const es = streams[0];
  es.onopen();
  const iso = (offsetMs = 0) => new Date(clock.ms + offsetMs).toISOString();
  let n = 0;
  return {
    clock, sceneCalls,
    card: (agent) => cards.find((c) => c.dataset.agent === agent),
    node: (step) => nodes.find((x) => x.dataset.step === step),
    /** One event at the fake "now" (+1 ms per event so the dedupe key never repeats). */
    push(agent, status, message, toolUseId) {
      n += 1;
      // The adapter adds pipelineStep to every event of a registered agent
      const pipelineStep = STEP_OF[agent];
      es.onmessage({
        data: JSON.stringify({ ts: iso(n), agent, status, message, ...(pipelineStep ? { pipelineStep } : {}), ...(toolUseId ? { toolUseId } : {}) }),
      });
    },
    tick() { intervals.forEach((fn) => fn()); },
    clickClear() { clear.listeners.click.forEach((fn) => fn({ preventDefault() {} })); },
  };
}

test('H: the card shows the instance count from 2 on, and the plain name again with one instance', async () => {
  const p = await loadPage();
  p.push('app-dev', 'PROCESSING', 'task A', 'toolu_A');
  assert.equal(p.card('app-dev').name.textContent, 'Dev-ไอ้เก่ง', 'one instance: the plain name');
  p.push('app-dev', 'PROCESSING', 'task B', 'toolu_B');
  assert.equal(p.card('app-dev').name.textContent, 'Dev-ไอ้เก่ง ×2');
  p.push('app-dev', 'PROCESSING', 'task C', 'toolu_C');
  assert.equal(p.card('app-dev').name.textContent, 'Dev-ไอ้เก่ง ×3');
  p.push('app-dev', 'COMPLETED', 'B done', 'toolu_B');
  assert.equal(p.card('app-dev').name.textContent, 'Dev-ไอ้เก่ง ×2');
  p.push('app-dev', 'COMPLETED', 'A done', 'toolu_A');
  assert.equal(p.card('app-dev').name.textContent, 'Dev-ไอ้เก่ง', 'one instance left: no count');
});

test('A/H: card, pipeline node and the 3D hook stay PROCESSING until the last instance has finished', async () => {
  const p = await loadPage();
  p.push('app-dev', 'PROCESSING', 'task A', 'toolu_A');
  p.push('app-dev', 'PROCESSING', 'task B', 'toolu_B');
  p.push('app-dev', 'COMPLETED', 'A done', 'toolu_A');
  assert.equal(p.card('app-dev').pill.textContent, 'PROCESSING', 'B still runs: the latest event (COMPLETED) must not decide');
  assert.equal(p.card('app-dev').dataset.status, 'PROCESSING');
  assert.equal(p.node('appdev').badge.textContent, 'PROCESSING');
  assert.deepEqual(p.sceneCalls[p.sceneCalls.length - 1], ['appdev', 'PROCESSING'], 'the scene hook gets the derived status');
  p.push('app-dev', 'COMPLETED', 'B done', 'toolu_B');
  assert.equal(p.card('app-dev').pill.textContent, 'COMPLETED');
  assert.equal(p.node('appdev').badge.textContent, 'COMPLETED');
});

test('the count and status are per agent: another agent is not affected', async () => {
  const p = await loadPage();
  p.push('app-dev', 'PROCESSING', 'A', 'toolu_A');
  p.push('app-dev', 'PROCESSING', 'B', 'toolu_B');
  p.push('qa-reviewer', 'PROCESSING', 'review', 'toolu_Q');
  assert.equal(p.card('qa-reviewer').name.textContent, 'QA-คุณละเอียด', 'a single QA run has no count');
  assert.equal(p.card('app-dev').name.textContent, 'Dev-ไอ้เก่ง ×2');
});

test('a missed end event: the timer lowers the count (moon timeout) and, later, the status (stale limit) without any event', async () => {
  const p = await loadPage();
  p.push('app-dev', 'PROCESSING', 'A (stop lost)', 'toolu_A');
  p.clock.ms += 9 * 60 * 1000;
  p.push('app-dev', 'PROCESSING', 'B', 'toolu_B');
  assert.equal(p.card('app-dev').name.textContent, 'Dev-ไอ้เก่ง ×2');

  p.clock.ms += 90 * 1000;              // 10.5 min after A: A timed out
  p.tick();
  assert.equal(p.card('app-dev').name.textContent, 'Dev-ไอ้เก่ง', 'one live instance: the count is gone');
  assert.equal(p.card('app-dev').pill.textContent, 'PROCESSING');

  p.clock.ms += 31 * 60 * 1000;         // both open tasks are stale
  p.tick();
  assert.equal(p.card('app-dev').pill.textContent, 'IDLE', 'nothing runs any more: the card goes idle by itself');
  assert.equal(p.node('appdev').badge.textContent, 'IDLE');
  assert.deepEqual(p.sceneCalls[p.sceneCalls.length - 1], ['appdev', 'IDLE']);
});

test('the secretary (no tasks) keeps the latest-event status', async () => {
  const p = await loadPage();
  p.push('secretary', 'PROCESSING', 'prompt');
  p.push('secretary', 'COMPLETED', 'answered');
  assert.equal(p.card('secretary').pill.textContent, 'COMPLETED');
  assert.equal(p.card('secretary').name.textContent, 'secretary', 'no count for the main agent');
});

test('the clear button forgets the instances and the count', async () => {
  const p = await loadPage();
  p.push('app-dev', 'PROCESSING', 'A', 'toolu_A');
  p.push('app-dev', 'PROCESSING', 'B', 'toolu_B');
  p.clickClear();
  assert.equal(p.card('app-dev').name.textContent, 'Dev-ไอ้เก่ง');
  assert.equal(p.card('app-dev').pill.textContent, 'IDLE');
  p.push('app-dev', 'COMPLETED', 'A done', 'toolu_A');   // an end event of a task from before the clear: nothing to close
  assert.equal(p.card('app-dev').pill.textContent, 'COMPLETED', 'no open task is known any more, so the latest event shows');
});

test('without the store factory the list view uses the status of the latest event, as before (nothing throws)', async () => {
  const p = await loadPage({ withStore: false });
  p.push('app-dev', 'PROCESSING', 'A', 'toolu_A');
  p.push('app-dev', 'PROCESSING', 'B', 'toolu_B');
  p.push('app-dev', 'COMPLETED', 'A done', 'toolu_A');
  assert.equal(p.card('app-dev').pill.textContent, 'COMPLETED');
  assert.equal(p.card('app-dev').name.textContent, 'Dev-ไอ้เก่ง', 'no count without instance data');
  assert.doesNotThrow(() => p.tick());
});
