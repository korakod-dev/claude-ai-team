/**
 * app.js - Multi-Agent Workspace (browser side, /workspace).
 *
 * One SSE stream (GET /api/events) drives everything on the page:
 *   - pipeline node status + last message (HTML labels that scene.js moves over the 3D bodies)
 *   - the 3D scene status hooks: window.workspaceScene.setNodeStatus / handoff / reset (see scene.js).
 *     If the 3D scene is not running (no WebGL), window.workspaceScene is missing and only the list view updates.
 *   - agent list pills
 *   - the live log (newest line at the bottom, auto-scroll)
 *   - the "ล้างหน้าจอ" (clear view) button: resets the view only, server history is not touched
 * The owner approval queue (approve / reject / copy command) was removed from this page.
 * This page does not call /api/queue and does not send anything to the server (no POST, no token).
 * The queue API and its files stay on the server; only the page UI was removed.
 *
 * Model labels: on load the page makes ONE read-only GET /api/agents request (the model and effort in the frontmatter
 * of .claude/agents/*.md, read by the server). Every team member name then shows "Name (Model-Effort)", for example
 * "Dev-ไอ้เก่ง (Sonnet-High)": pipeline labels, agent list, live log. The owner gets no suffix. A missing value, or a failed
 * request, leaves the plain name. In the 3D scene the compact label shows the suffix (the .node-model chip), or the member
 * name when no suffix is known (never an empty chip); hover / focus shows the full name (style.css). The result is also published for scene.js (HUD): window.workspaceModels and the
 * window event 'workspace:models'.
 *
 * Stellar layer: every event goes to scene.js as 'workspace:event' (HUD store, comets). Events that come before scene.js
 * is ready are buffered and sent on 'workspace:scene-ready'. The replayed history goes to the HUD store only.
 *
 * Concurrent instances of one agent (several Agent tool calls of the same type at once): the status of a pipeline node and of an
 * agent card is DERIVED from the open instances, not from the latest event (one instance completing while another still runs
 * must stay PROCESSING), and a card shows the instance count from 2 on ("Dev-ไอ้เก่ง ×3"). This list view works without
 * WebGL, so it keeps its own store, built by window.createWorkspaceStore (scene.js publishes stellar/store.js there; the same
 * rules as the 3D planets and moons). Without that factory the status of the latest event is used, as before.
 *
 * Tool activity (effects + text state): the server sends every tool call (start / end / error) as the named SSE event "activity"
 * (lib/workspace.js, live only, not replayed, not logged). This page forwards it to scene.js as 'workspace:activity' (beams and
 * the thinking pulse) and feeds its own tracker (window.workspaceActivity, stellar/activity.js) for the small text under each agent
 * in the list: "คิดอยู่" (a live instance is thinking) or "กำลังใช้ tool: Read". The text works without WebGL and with
 * prefers-reduced-motion (it does not animate). It needs a live instance (the same store as the cards) for "คิดอยู่".
 *
 * Security: event data is only ever written with textContent (never innerHTML).
 * Plain JavaScript, no build step, no dependencies.
 */
(function () {
  'use strict';

  const MAX_LOG_LINES = 300;      // older lines are removed from the DOM
  const SEEN_LIMIT = 1000;        // remembered event keys, used to skip replays after a reconnect
  const REPLAY_GRACE_MS = 800;    // no handoff beams while the first replay burst arrives
  const NODE_MSG_MAX = 140;       // characters shown in a node's message box
  const DERIVED_REFRESH_MS = 5000; // how often the derived status is re-read (an instance times out without any event)
  const ACTIVITY_TEXT_MS = 1000;   // how often the activity text under each agent is re-read (a call ends or times out without an event)

  // Handoffs that a pipeline node receives: [from, to] pairs of pipeline steps.
  // The 3D scene draws one light beam per pair. qa: the event does not say which one handed over,
  // so both the router -> qa beam and the appdev -> qa chain are drawn.
  const HANDOFF_INTO = {
    router: [['user', 'router']],
    pm: [['router', 'pm']],
    appdev: [['router', 'appdev']],
    qa: [['router', 'qa'], ['appdev', 'qa']],
    study: [['router', 'study']],
    portfolio: [['router', 'portfolio']],
    advisor: [['router', 'advisor']],
  };

  // Short names used in the log. Keys match the agent ids in lib/workspace-adapter.js
  // Fix: the secretary is shown as เลขาคนสวย everywhere (not เลขา).
  const LABEL = {
    'user': 'User Prompt',
    'secretary': 'เลขาคนสวย',
    'pm': 'PM-Professor-X',
    'app-dev': 'Dev-ไอ้เก่ง',
    'qa-reviewer': 'QA-คุณละเอียด',
    'study-writer': 'Writer-ยัยแว่นหนา',
    'portfolio-writer': 'Content Director',
    'advisor': 'Advisor',
  };

  // Pipeline step -> agent id (the same mapping as stellar/model.js STEP_AGENT; 'user' = the owner, no model suffix)
  const STEP_AGENT = {
    router: 'secretary',
    pm: 'pm',
    appdev: 'app-dev',
    qa: 'qa-reviewer',
    study: 'study-writer',
    portfolio: 'portfolio-writer',
    advisor: 'advisor',
  };
  const SUFFIX_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // "Model-Effort": letters, digits, dot, dash

  const STATUS_CLASS = {
    COMPLETED: 's-done',
    PROCESSING: 's-working',
    WORKING: 's-working',
    IDLE: 's-idle',
    ERROR: 's-error',
  };
  const ALL_STATUS_CLASSES = ['s-done', 's-working', 's-idle', 's-error'];
  const CONN_TEXT = { live: 'LIVE', reconnecting: 'RECONNECTING', offline: 'OFFLINE', connecting: 'CONNECTING' };

  const $ = (id) => document.getElementById(id);
  const el = {
    badge: $('status-badge'),
    badgeText: $('status-text'),
    log: $('log'),
    clear: $('clear-view-btn'),
  };

  const nodes = new Map();   // pipeline step id -> node element
  const cards = new Map();   // agent id -> agent card element
  const seenKeys = new Set();
  const seenOrder = [];
  let suppressFlash = true;  // true during the replay burst right after (re)connect
  // Events for the Stellar layer that arrived before scene.js announced it is ready (see publishEvent)
  const PENDING_LIMIT = 1000;
  let sceneReady = false;
  const pending = [];        // { ev, replay }, oldest first
  // Registered now, while this classic script runs: scene.js (a module) runs BEFORE DOMContentLoaded, so it can announce
  // 'workspace:scene-ready' before init() runs. A listener added inside init() would miss that signal.
  if (typeof window.addEventListener === 'function') window.addEventListener('workspace:scene-ready', onSceneReady);
  // Only events with ts >= showSince are shown. Set to the page-open time on load, and to the
  // clear time by the "ล้างหน้าจอ" button. The server replays its last events to every new SSE
  // client, so older events (history) are skipped here by their ts instead of being shown.
  let showSince = Date.now();
  let modelSuffix = Object.create(null); // agent id -> "Sonnet-High" (from GET /api/agents; empty until it answers)
  // Instance tracking for the list view (see the header). Created lazily: the factory comes from scene.js (a module).
  let tracker = null;                    // stellar/store.js instance, or null when the factory is not there
  const touched = new Set();             // agents that had a LIVE event since the view was opened / cleared (they get re-read)
  const instanceCount = new Map();       // agent id -> live instances last drawn on its card (from 2 on a "xN" is shown)
  let actTracker = null;                 // stellar/activity.js tracker for the text state (null when scene.js did not publish it)
  const actText = new Map();             // agent id -> text last written under its card ('' = none)

  /* ---------- small helpers ---------- */

  /** Create an element with a class and text (textContent only). */
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Map an event status to a CSS class (unknown status = idle). */
  function statusClass(status) {
    return STATUS_CLASS[status] || 's-idle';
  }

  /** Apply the status class to a node or card element and remember the status in data-status. */
  function setStatusClass(elm, status) {
    elm.classList.remove(...ALL_STATUS_CLASSES);
    elm.classList.add(statusClass(status));
    elm.dataset.status = status;
  }

  /** Local HH:MM from an ISO timestamp. */
  function hhmm(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '--:--';
    const pad = (n) => (n < 10 ? `0${n}` : String(n));
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Cut text to max characters and add "…" when it is longer. */
  function shortText(text, max) {
    if (typeof text !== 'string') return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  /** "Sonnet-High" for an agent id, or '' when unknown (and always '' for the owner). */
  function suffixOf(agent) {
    return agent !== 'user' && Object.prototype.hasOwnProperty.call(modelSuffix, agent) ? modelSuffix[agent] : '';
  }

  /** A name followed by the agent's model suffix: "Dev-ไอ้เก่ง (Sonnet-High)". The plain name when there is none. */
  function withModel(name, agent) {
    const suffix = suffixOf(agent);
    return suffix ? `${name} (${suffix})` : name;
  }

  /* ---------- instances (derived status and count) ---------- */

  /** The instance tracker, created on first use. null when scene.js did not publish the store factory. */
  function getTracker() {
    if (!tracker && typeof window.createWorkspaceStore === 'function') tracker = window.createWorkspaceStore();
    return tracker;
  }

  /** Feed one event (live or history) to the tracker, so the open instances are right for every later live event. */
  function trackEvent(ev) {
    const t = getTracker();
    if (!t) return;
    t.ingest(ev);
    // A task that this event closed: its running tool calls are forgotten (the text must not say "using Read" for a finished run)
    const closed = t.takeClose();
    const a = getActivityTracker();
    if (closed && a) a.release(closed.agent, closed.id);
  }

  /** The activity tracker of this page, created on first use. null when scene.js did not publish the activity rules. */
  function getActivityTracker() {
    if (!actTracker && window.workspaceActivity) actTracker = window.workspaceActivity.createActivityTracker();
    return actTracker;
  }

  /** { status, count } of an agent: the status derived from its open instances and its number of live instances. */
  function instanceOf(agent, fallbackStatus) {
    const t = getTracker();
    if (!t) return { status: fallbackStatus, count: 0 };
    const inst = t.instanceState(agent, Date.now());
    return { status: inst.status, count: inst.count };
  }

  /** " ×3" when two or more instances of the agent run at once, else ''. */
  function countSuffix(agent) {
    const n = instanceCount.get(agent) || 0;
    return n >= 2 ? ` ×${n}` : '';
  }

  /** The 3D scene hooks, or null when the scene is not running (no WebGL, or it failed to start). */
  function getScene() {
    return window.workspaceScene || null;
  }

  /* ---------- connection status (header badge) ---------- */

  function setConnection(state) {
    el.badge.dataset.state = state;
    el.badgeText.textContent = CONN_TEXT[state] || state;
  }

  /* ---------- event handling: the single path for pipeline, agents and log ---------- */

  /** True when the object has the workspace event fields. */
  function isEvent(ev) {
    return !!ev
      && typeof ev.ts === 'string'
      && typeof ev.agent === 'string'
      && typeof ev.status === 'string'
      && typeof ev.message === 'string';
  }

  /**
   * True when the event happened before this view was opened or cleared (old history).
   * An event whose ts cannot be parsed is also skipped: its time is unknown, so it cannot be shown as new.
   */
  function isBeforeView(ev) {
    const time = Date.parse(ev.ts);
    return Number.isNaN(time) || time < showSince;
  }

  /** Skip events already shown (the server replays recent events after every reconnect). */
  function isDuplicate(ev) {
    const key = [ev.ts, ev.agent, ev.status, ev.message].join('|');
    if (seenKeys.has(key)) return true;
    seenKeys.add(key);
    seenOrder.push(key);
    if (seenOrder.length > SEEN_LIMIT) seenKeys.delete(seenOrder.shift());
    return false;
  }

  /**
   * Send one event to the Stellar layer as a window event ('workspace:event', detail { event, replay }).
   * Guarded: a no-op where CustomEvent is missing (the test sandbox).
   */
  function sendEvent(ev, replay) {
    if (typeof window.CustomEvent !== 'function' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new window.CustomEvent('workspace:event', { detail: { event: ev, replay } }));
  }

  /** Send one tool activity message to scene.js ('workspace:activity', detail { activity }). Only once the scene is ready. */
  function sendActivity(act) {
    if (!sceneReady) return;
    if (typeof window.CustomEvent !== 'function' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new window.CustomEvent('workspace:activity', { detail: { activity: act } }));
  }

  /**
   * One message of the "activity" SSE channel (a tool call started, ended or failed). Old starts and failures (history after a reconnect, a
   * file read in one batch) are ignored, so a beam is always a live call. The text state and the scene both get it.
   */
  function onActivity(msg) {
    const lib = window.workspaceActivity;
    let act;
    try {
      act = JSON.parse(msg.data);
    } catch (_err) {
      return;
    }
    if (!lib || !lib.isActivity(act)) return;
    if (act.phase !== 'end' && (lib.isStale(act, Date.now()) || Date.parse(act.ts) < showSince)) return;
    const a = getActivityTracker();
    if (a) a.ingest(act, Date.now());
    sendActivity(act);
    paintActivity();
  }

  /**
   * Write the small activity text under each agent card: "คิดอยู่" / "กำลังใช้ tool: Read" / nothing. Only changes are written
   * (textContent). "Thinking" needs a live instance, so it comes from the same store as the cards; the main agent has no instance
   * and shows only the tool it is using.
   */
  function paintActivity() {
    const a = getActivityTracker();
    const t = getTracker();
    const lib = window.workspaceActivity;
    if (!a || !lib) return;
    cards.forEach((card, agent) => {
      const slot = card.querySelector('[data-act]');
      if (!slot) return;
      const live = t && agent !== 'secretary' ? t.instanceState(agent, Date.now()).live.map((x) => x.id) : [];
      const text = lib.activityLabel(a.agentActivity(agent, live, Date.now()));
      if ((actText.get(agent) || '') === text) return;
      actText.set(agent, text);
      slot.textContent = text;
    });
  }

  /**
   * Publish one event for the Stellar layer (scene.js: HUD store, result and failure comets).
   * replay = true during the replay burst after a (re)connect (or for the history), so it draws no comets.
   * Before scene.js is ready its 'workspace:event' listener does not exist yet, so the event is buffered here and
   * sent by onSceneReady(). Without this, the early replayed events were lost. The buffer is bounded.
   */
  function publishEvent(ev, replay = suppressFlash) {
    if (!sceneReady) {
      pending.push({ ev, replay });
      if (pending.length > PENDING_LIMIT) pending.shift();
      return;
    }
    sendEvent(ev, replay);
  }

  /** scene.js has registered its listener and reset its store: send the buffered events in order, then go live. */
  function onSceneReady() {
    sceneReady = true;
    pending.splice(0, pending.length).forEach(({ ev, replay }) => sendEvent(ev, replay));
  }

  /** Draw one handoff as a light beam in the 3D scene (not during the replay burst). */
  function handoff(fromStep, toStep) {
    if (suppressFlash) return;
    const scene = getScene();
    if (scene) scene.handoff(fromStep, toStep);
  }

  /** Append one line to the log: "HH:MM | agent: message". Auto-scroll only if the user is at the bottom. */
  function appendLog(ev) {
    const list = el.log;
    const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;

    const agentName = make('span', 'log-agent', withModel(LABEL[ev.agent] || ev.agent, ev.agent));
    agentName.dataset.agent = ev.agent;

    const line = make('li', 'log-line');
    line.append(
      make('span', 'log-time', hhmm(ev.ts)),
      make('span', 'log-sep', ' | '),
      agentName,
      make('span', 'log-sep', ': '),
      make('span', `log-msg ${statusClass(ev.status)}`, ev.message),
    );
    list.appendChild(line);

    while (list.children.length > MAX_LOG_LINES) list.removeChild(list.firstChild);
    if (stick) list.scrollTop = list.scrollHeight;
  }

  /** Set the text and color class of a badge (node) or pill (agent card). */
  function setLabel(elm, status) {
    elm.textContent = status;
    elm.className = `${elm.dataset.kind} ${statusClass(status)}`;
  }

  /** Apply one event to the pipeline node, the 3D body, the agent card, the beams and the log. */
  function applyEvent(ev) {
    const active = ev.status === 'PROCESSING' || ev.status === 'WORKING';
    publishEvent(ev); // Stellar layer (scene.js): HUD store and result / failure comets
    // Status to show: derived from the open instances of the agent (the event status is the fallback), see the header
    const inst = instanceOf(ev.agent, ev.status);
    touched.add(ev.agent);

    // 1. Pipeline node (only when the event names a node)
    if (ev.pipelineStep && nodes.has(ev.pipelineStep)) {
      const node = nodes.get(ev.pipelineStep);
      setStatusClass(node, inst.status);
      setLabel(node.querySelector('[data-badge]'), inst.status);
      const msg = node.querySelector('[data-msg]');
      if (msg) msg.textContent = shortText(ev.message, NODE_MSG_MAX);

      // 3D body: glow / pulse for the status (the sun and the owner star; planets derive theirs from the same instances)
      const scene = getScene();
      if (scene) scene.setNodeStatus(ev.pipelineStep, inst.status);

      // Work handed over to this node: draw the beam(s) that feed it
      if (active && HANDOFF_INTO[ev.pipelineStep]) {
        HANDOFF_INTO[ev.pipelineStep].forEach(([fromStep, toStep]) => handoff(fromStep, toStep));
      }
    }

    // 2. Agent list pill
    const card = cards.get(ev.agent);
    if (card) {
      setStatusClass(card, inst.status);
      setLabel(card.querySelector('[data-pill]'), inst.status);
      card.title = ev.message;
      paintCount(ev.agent, inst.count);
    }

    // 3. Log
    appendLog(ev);
  }

  /** Write the instance count of an agent into its card name ("Dev-ไอ้เก่ง ×3" from 2 instances on). */
  function paintCount(agent, count) {
    if ((instanceCount.get(agent) || 0) === count) return;
    instanceCount.set(agent, count);
    const card = cards.get(agent);
    if (card) setName(card.querySelector('[data-name]'), agent);
  }

  /**
   * Re-read the derived status and count of every agent that had a live event. An instance times out (or becomes stale)
   * with no event to say so, so the nodes and cards are refreshed on a timer. Only changes are written.
   */
  function refreshDerived() {
    touched.forEach((agent) => {
      const inst = instanceOf(agent, null);
      if (inst.status === null) return;   // no tracker: nothing is derived, the events keep their own status
      const card = cards.get(agent);
      if (card && card.dataset.status !== inst.status) {
        setStatusClass(card, inst.status);
        setLabel(card.querySelector('[data-pill]'), inst.status);
      }
      if (card) paintCount(agent, inst.count);
      nodes.forEach((node, step) => {
        if (STEP_AGENT[step] !== agent || node.dataset.status === inst.status) return;
        setStatusClass(node, inst.status);
        setLabel(node.querySelector('[data-badge]'), inst.status);
        const scene = getScene();
        if (scene) scene.setNodeStatus(step, inst.status);
      });
    });
  }

  /**
   * Reset the view to a clean state, as if nothing ran before: pipeline nodes and agent pills back to
   * IDLE, node messages and card tooltips cleared, 3D bodies idle and beams off, log emptied.
   * Only events after now are shown from here on. Used on page load and by the clear button.
   * The server history and its files are not touched.
   */
  function resetView() {
    showSince = Date.now();
    tracker = null;                 // the instances start from zero as well (a new store is made on the next event)
    touched.clear();
    instanceCount.clear();
    if (actTracker) actTracker.clear();
    actText.clear();
    cards.forEach((card) => { const slot = card.querySelector('[data-act]'); if (slot) slot.textContent = ''; });

    nodes.forEach((node) => {
      setStatusClass(node, 'IDLE');
      setLabel(node.querySelector('[data-badge]'), 'IDLE');
      const msg = node.querySelector('[data-msg]');
      if (msg) msg.textContent = '';
    });

    cards.forEach((card, agent) => {
      setStatusClass(card, 'IDLE');
      setLabel(card.querySelector('[data-pill]'), 'IDLE');
      card.title = '';
      setName(card.querySelector('[data-name]'), agent);   // drops a "xN" suffix
    });

    // Stop every 3D body glow and every beam still running from before the reset
    const scene = getScene();
    if (scene) scene.reset();

    el.log.textContent = ''; // empty the log (textContent only)
  }

  /* ---------- model labels (GET /api/agents) ---------- */

  /**
   * Write a name element: the base name (kept in data-base the first time) plus the model suffix of the agent.
   * textContent only. Does nothing for a missing element.
   */
  function setName(elm, agent) {
    if (!elm) return;
    if (elm.dataset.base === undefined) elm.dataset.base = elm.textContent;
    elm.textContent = `${withModel(elm.dataset.base, agent)}${countSuffix(agent)}`;
  }

  /**
   * Write a compact 3D label chip: the "Model-Effort" suffix, or the member's display name (the base name kept in
   * data-base of the sibling name element) when the suffix is unknown, so the chip is never empty.
   */
  function setModel(elm, agent, baseName) {
    if (!elm) return;
    elm.textContent = modelSuffix[agent] || baseName || '';
  }

  /** Refresh every name on the page that shows a team member: pipeline labels, agent list and the log lines so far. */
  function renderNames() {
    nodes.forEach((node, step) => {
      if (!STEP_AGENT[step]) return;
      const nameEl = node.querySelector('.node-name');
      setName(nameEl, STEP_AGENT[step]);
      setModel(node.querySelector('.node-model'), STEP_AGENT[step], nameEl ? nameEl.dataset.base : '');
    });
    cards.forEach((card, agent) => setName(card.querySelector('[data-name]'), agent));
    Array.from(el.log.children).forEach((line) => {
      const nameEl = Array.from(line.children || []).find((c) => c.className === 'log-agent');
      if (nameEl && nameEl.dataset.agent) {
        nameEl.textContent = withModel(LABEL[nameEl.dataset.agent] || nameEl.dataset.agent, nameEl.dataset.agent);
      }
    });
  }

  /**
   * Take the answer of GET /api/agents: { agents: { <agent id>: { suffix: "Sonnet-High" | null, ... } } }.
   * Only safe string suffixes are kept. Updates the names and tells scene.js (HUD) through window.workspaceModels and
   * the 'workspace:models' event.
   */
  function applyModels(body) {
    const next = Object.create(null);
    const agents = body && typeof body === 'object' ? body.agents : null;
    if (agents && typeof agents === 'object') {
      Object.keys(agents).forEach((agent) => {
        const info = agents[agent];
        const suffix = info && typeof info === 'object' ? info.suffix : null;
        if (agent !== 'user' && typeof suffix === 'string' && SUFFIX_OK.test(suffix)) next[agent] = suffix;
      });
    }
    modelSuffix = next;
    renderNames();
    window.workspaceModels = agents && typeof agents === 'object' ? agents : {};
    if (typeof window.CustomEvent === 'function' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new window.CustomEvent('workspace:models', { detail: window.workspaceModels }));
    }
  }

  /** One GET /api/agents on load. A failure keeps the plain names (labels are cosmetic, nothing else depends on it). */
  function loadModels() {
    if (typeof fetch !== 'function') return;
    fetch('/api/agents', { headers: { Accept: 'application/json' } })
      .then((res) => (res && res.ok ? res.json() : null))
      .then((body) => { if (body) applyModels(body); else renderNames(); })
      .catch(() => { renderNames(); /* keep the plain names; the 3D chips show the names */ });
  }

  /* ---------- SSE connection ---------- */

  function connect() {
    const es = new EventSource('/api/events');

    es.onopen = () => {
      setConnection('live');
      suppressFlash = true;
      setTimeout(() => { suppressFlash = false; }, REPLAY_GRACE_MS);
    };

    // Default SSE message = one workspace event
    es.onmessage = (msg) => {
      let ev;
      try {
        ev = JSON.parse(msg.data);
      } catch (_err) {
        return; // not JSON: ignore
      }
      if (!isEvent(ev) || isDuplicate(ev)) return;
      trackEvent(ev);   // history too: an instance that started before this view opened must still be closed by its end event
      // History (before this view was opened or cleared): only the HUD store takes it, as a replay (no comets).
      // The log, the pipeline and the agent cards start clean and show only what happens after the page is open.
      if (isBeforeView(ev)) {
        publishEvent(ev, true);
        return;
      }
      applyEvent(ev);
    };

    // Tool activity: its own named channel (not a workspace event, so it never reaches the log, the store or the replay)
    if (typeof es.addEventListener === 'function') es.addEventListener('activity', onActivity);

    // EventSource retries by itself. CLOSED means the browser gave up.
    es.onerror = () => {
      setConnection(es.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
    };
  }

  /* ---------- init ---------- */

  function init() {
    // Register nodes and agent cards, and give every badge/pill its initial IDLE style
    document.querySelectorAll('.node[data-step]').forEach((node) => {
      nodes.set(node.dataset.step, node);
      setStatusClass(node, 'IDLE');
      setLabel(node.querySelector('[data-badge]'), 'IDLE');
    });
    document.querySelectorAll('#agent-list .agent-card[data-agent]').forEach((card) => {
      cards.set(card.dataset.agent, card);
      // Small activity text under the scope line (empty = hidden by CSS). textContent only.
      const info = card.querySelector('.agent-info');
      if (info && !card.querySelector('[data-act]')) {
        const slot = make('div', 'agent-act');
        slot.dataset.act = '';   // data-act attribute: paintActivity finds the slot with [data-act]
        info.appendChild(slot);
      }
    });
    // Clean start: IDLE everywhere, empty log, and only events after this moment are shown
    resetView();

    // "ล้างหน้าจอ" (clear view): same reset as page load, without reloading the page
    el.clear.addEventListener('click', resetView);

    if (typeof setInterval === 'function') {
      setInterval(refreshDerived, DERIVED_REFRESH_MS);
      setInterval(paintActivity, ACTIVITY_TEXT_MS);
    }
    setConnection('connecting');
    renderNames();   // 3D chips start with the member names (no blank label); the model suffix replaces them when it arrives
    loadModels();
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
