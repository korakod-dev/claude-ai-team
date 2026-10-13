/**
 * stellar/store.js - Pure per-agent state for the planet HUD. No DOM, no THREE.
 * Feed it every workspace event with ingest(); read it with snapshot(agent). reset() clears everything.
 *
 * Per agent it keeps:
 *   status     last status seen (IDLE when the agent has not been seen). snapshot().status is DERIVED from the open tasks,
 *              see "STATUS" below.
 *   open       current tasks: dispatched (PROCESSING) and not finished yet, oldest first. One open task = one running
 *              INSTANCE of the agent (one Agent tool call). Several at once are shown as moons (stellar/moons.js).
 *   recent     finished tasks (COMPLETED or ERROR), newest first
 *   logs       the last log lines (every event of that agent), oldest first
 *
 * Task rules (the adapter sends one PROCESSING per dispatch, see convertHookRecord in lib/workspace-adapter.js):
 *   PROCESSING from a sub-agent      -> opens a task (with toolUseId when the event carries one)
 *   COMPLETED / ERROR with toolUseId -> closes the open task with the SAME id (any agent). Exact.
 *   COMPLETED / ERROR without an id  -> closes the OLDEST open task of its agent (FIFO). Approximate, marked approx.
 *   ERROR with nothing to close      -> recorded as a failed task on its own (not approximate)
 *   COMPLETED with an id but no open task of that id -> ignored (the start event was not seen; no other task is taken)
 * The main agent (secretary) and the user never open tasks, so their Stop / prompt events do not open one.
 *
 * MATCHING STATE:
 *   Exact: a task opened with a toolUseId is closed only by the event with the same id. The hook gives an id on the
 *          Agent PreToolUse and PostToolUseFailure, and on the SubagentStop of async runs (see the adapter).
 *   FIFO (approximate): a close without an id is matched to the oldest open task of its agent. This applies to sync
 *          sub-agent runs (their id is not on the stop event) and to events from POST /api/events. Such a match is
 *          marked `approx: true` on the finished task, and an open task without an id shows `approx: true` too.
 *   STALE: a task still open after `staleMs` (default 30 min) is marked `stale: true` in snapshot(). That is an age
 *          check, not a match check: a task that is open that long is genuinely old (its end event may be missing).
 *   TIMED OUT: an open task older than `moonTimeoutMs` (default 10 min, stellar/moons.js) is no longer a live instance:
 *          it has no moon. It stays open (HUD list, FIFO matching) until it is closed or becomes stale.
 *
 * TASK AGE: taken from the event `ts`. When the `ts` cannot be parsed, the RECEIVE time of the dispatch event (options.now, default
 *          Date.now()) is used instead, so such a task still times out as a moon and becomes stale; ageMs is never null.
 *
 * STATUS (planet status with several instances of one agent): the status of a task agent is derived from its open
 * tasks, not from the latest event. Otherwise instance A completing while instance B still runs would flip the planet to
 * COMPLETED / idle.
 *   at least one open task that is not stale  -> PROCESSING (active), whatever the latest event says
 *   no such task                              -> the latest event's status (COMPLETED flash, ERROR, ...), except that a
 *                                                PROCESSING / WORKING with no running task behind it after every task was
 *                                                closed or became stale reads as IDLE
 * An agent with exactly one instance therefore behaves as before. The main agent (secretary) and the user keep the
 * latest-event status, they have no tasks.
 *
 * LAST CLOSE: ingest() remembers the task that the event just closed (takeClose()), so the scene can draw a finish burst: the
 * agent, the task id (null when the close had no open task behind it, e.g. a failure on its own) and the end status.
 *
 * LIMITS: maxOpen = 16 open tasks per agent. It is far above the moon cap (4) plus any "+N" a person would read, so the
 * oldest open task is only dropped in a runaway case. A dropped task cannot be closed by its id later (that end event is
 * ignored); the planet status and the moons stay correct for the remaining tasks.
 */
import { labelOf, metricRows } from './model.js';
import { MOON_TIMEOUT_MS, liveInstances, moonView } from './moons.js';

const KNOWN_STATUSES = ['IDLE', 'PROCESSING', 'WORKING', 'COMPLETED', 'ERROR'];
const NO_TASK_AGENTS = ['secretary', 'user'];
// Limits. staleMs: a task open longer than this is shown as stale (30 min: a sub-agent run is normally shorter).
const DEFAULTS = Object.freeze({
  maxLogs: 40, maxOpen: 16, maxRecent: 6, logsShown: 6, staleMs: 30 * 60 * 1000, moonTimeoutMs: MOON_TIMEOUT_MS,
});

/** True when the object has the workspace event fields with usable values. */
function isWorkspaceEvent(ev) {
  return !!ev
    && typeof ev.ts === 'string'
    && typeof ev.agent === 'string' && ev.agent.length > 0
    && typeof ev.status === 'string' && KNOWN_STATUSES.includes(ev.status)
    && typeof ev.message === 'string';
}

/** The toolUseId of an event, or null when it has none (or it is not a non-empty string). */
function idOf(ev) {
  return typeof ev.toolUseId === 'string' && ev.toolUseId.trim() ? ev.toolUseId.trim() : null;
}

/**
 * Create a store. options override DEFAULTS (limits only); options.now (() => ms) is the receive clock (tests pass a fake one).
 * Returns { ingest, snapshot, instanceState, takeClose, reset, agents }.
 */
export function createStore(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const receiveNow = typeof options.now === 'function' ? options.now : Date.now;
  const entries = new Map(); // agent id -> { agent, status, open, recent, logs }
  let seq = 0;               // counter: the id of an open task that has no toolUseId
  let lastClose = null;      // { agent, id, status } of the task closed by the latest ingest(), see takeClose()

  function entryFor(agent) {
    if (!entries.has(agent)) entries.set(agent, { agent, status: 'IDLE', open: [], recent: [], logs: [] });
    return entries.get(agent);
  }

  /**
   * Move a task to the recent list of its agent (newest first) with its end status and message.
   * approx = true when the task was closed by FIFO (no id on the closing event).
   */
  function finish(entry, task, ev, approx) {
    // Same id the task had while open (see tasksOf): toolUseId, or "task-<n>"; null for a failure that had no open task
    const id = task.toolUseId || (task.seq ? `task-${task.seq}` : null);
    lastClose = { agent: entry.agent, id, status: ev.status };
    entry.recent.unshift({
      ts: task.ts,
      text: task.text,
      status: ev.status,
      endTs: ev.ts,
      endText: ev.message,
      approx: !!approx,
    });
    if (entry.recent.length > cfg.maxRecent) entry.recent.length = cfg.maxRecent;
  }

  /** Find and remove the open task with this toolUseId, in any agent. Returns { entry, task } or null. */
  function takeOpenById(id) {
    for (const entry of entries.values()) {
      const i = entry.open.findIndex((t) => t.toolUseId === id);
      if (i !== -1) return { entry, task: entry.open.splice(i, 1)[0] };
    }
    return null;
  }

  /**
   * Apply one workspace event. Returns true when it was used, false when it was not a workspace event.
   * Invalid events are ignored, never thrown.
   */
  function ingest(ev) {
    if (!isWorkspaceEvent(ev)) return false;
    lastClose = null;
    const entry = entryFor(ev.agent);
    entry.status = ev.status;
    entry.logs.push({ ts: ev.ts, status: ev.status, message: ev.message });
    if (entry.logs.length > cfg.maxLogs) entry.logs.splice(0, entry.logs.length - cfg.maxLogs);

    const canOpenTask = !NO_TASK_AGENTS.includes(ev.agent);
    const id = idOf(ev);
    if (ev.status === 'PROCESSING' && canOpenTask) {
      seq += 1;
      entry.open.push({
        ts: ev.ts, text: ev.message, status: 'PROCESSING', toolUseId: id, seq, seenMs: receiveNow(),
      });
      if (entry.open.length > cfg.maxOpen) entry.open.splice(0, entry.open.length - cfg.maxOpen);
    } else if (ev.status === 'COMPLETED' || ev.status === 'ERROR') {
      if (id) {
        // Exact: the task with the same tool_use_id (it may belong to another agent, e.g. a failure reported by the caller)
        const hit = takeOpenById(id);
        if (hit) {
          finish(hit.entry, hit.task, ev, false);
        } else if (ev.status === 'ERROR') {
          finish(entry, { ts: ev.ts, text: ev.message }, ev, false);   // failure with no open task: a failed task on its own
        }
        // COMPLETED with an id and no open task: nothing to close. Another task is NOT taken by FIFO here.
      } else if (entry.open.length > 0) {
        finish(entry, entry.open.shift(), ev, true);                 // FIFO fallback: approximate match
      } else if (ev.status === 'ERROR') {
        finish(entry, { ts: ev.ts, text: ev.message }, ev, false);
      }
    }
    return true;
  }

  /** Age of an open task in ms at nowMs: from its event ts, or from its receive time when the ts cannot be parsed. */
  function ageOf(task, nowMs) {
    const parsed = Date.parse(task.ts);
    const started = Number.isNaN(parsed) ? task.seenMs : parsed;
    return Math.max(0, nowMs - started);
  }

  /** The open tasks of an entry as snapshot objects (copies, oldest first). id = toolUseId, or "task-<n>" without one. */
  function tasksOf(entry, nowMs) {
    return entry.open.map((t) => {
      const ageMs = ageOf(t, nowMs);
      return {
        id: t.toolUseId || `task-${t.seq}`,
        ts: t.ts,
        text: t.text,
        status: t.status,
        ageMs,
        stale: ageMs > cfg.staleMs,                                    // genuinely old open task
        timedOut: ageMs > cfg.moonTimeoutMs,                           // past the moon timeout: not a live instance any more
        approx: t.toolUseId === null,                                  // no id: its end event will be matched by FIFO
      };
    });
  }

  /**
   * Instance view of one agent: the status and the counts that the scene (planet glow, energy ring, moons) and the
   * list view use. Cheap (no log or recent copies), so a caller may ask for it a few times per second.
   *   status    derived status (see STATUS in the header)
   *   running   open tasks that are not stale: what keeps the planet active, and the width of the energy ring
   *   live      live instances (open and not timed out), oldest first: { id, ts, text, ageMs, ... }
   *   moons     { shown, extra, total } for live (stellar/moons.js moonView): at most 4 moons, extra = "+N"
   *   count     number of live instances (the list view shows "x3" from 2 on)
   */
  function instanceState(agent, nowMs = Date.now()) {
    const entry = entries.get(agent);
    if (!entry) return { agent, status: 'IDLE', running: 0, live: [], moons: moonView([]), count: 0 };
    const tasks = tasksOf(entry, nowMs);
    const running = tasks.filter((t) => !t.stale).length;
    const live = liveInstances(tasks.filter((t) => !t.timedOut));
    let status = entry.status;
    if (!NO_TASK_AGENTS.includes(agent)) {
      if (running > 0) status = 'PROCESSING';
      else if (status === 'PROCESSING' || (status === 'WORKING' && entry.open.length > 0)) status = 'IDLE';
    }
    return { agent, status, running, live, moons: moonView(live), count: live.length };
  }

  /**
   * HUD data for one agent. nowMs is the clock used for the task age (default: Date.now()).
   * Unknown agents get an IDLE snapshot with empty lists. Copies only (no shared state).
   * Each current task has id, ageMs (from the receive time when its timestamp cannot be read), stale (open longer than cfg.staleMs),
   * timedOut (open longer than cfg.moonTimeoutMs, so it has no moon) and approx (no toolUseId, so its end will be matched by
   * FIFO). status is the derived status (header, STATUS). instances = number of live instances, moons = { shown, extra, total }.
   */
  function snapshot(agent, nowMs = Date.now()) {
    const entry = entries.get(agent) || { status: 'IDLE', open: [], recent: [], logs: [] };
    const inst = instanceState(agent, nowMs);
    return {
      agent,
      label: labelOf(agent),
      status: inst.status,
      currentTasks: tasksOf(entry, nowMs),                                   // oldest first
      instances: inst.count,
      moons: inst.moons,
      recentTasks: entry.recent.map((t) => ({ ...t })),                      // newest first
      logs: entry.logs.slice(-cfg.logsShown).map((l) => ({ ...l })),         // oldest first, newest at the bottom
      // The only metric the event data supports is the moon count (concurrent instances), shown from 2 instances on.
      metrics: metricRows(inst.moons.shown.length > 0 ? { moons: inst.count } : {}),
    };
  }

  /**
   * The task that the latest ingest() closed, as { agent, id, status } (status COMPLETED or ERROR), or null when that event
   * closed nothing (it was not an end event, or a COMPLETED had no open task behind it). Read once: it is cleared here.
   * id is the task id as in snapshot().currentTasks, or null for a failure that had no open task (a failed task on its own).
   */
  function takeClose() {
    const close = lastClose;
    lastClose = null;
    return close;
  }

  /** Forget every agent (used by the "ล้างหน้าจอ" button and page load). */
  function reset() {
    entries.clear();
    lastClose = null;
  }

  /** Agent ids seen since the last reset. */
  function agents() {
    return Array.from(entries.keys());
  }

  return { ingest, snapshot, instanceState, takeClose, reset, agents };
}
