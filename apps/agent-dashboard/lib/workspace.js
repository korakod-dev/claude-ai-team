'use strict';
/**
 * lib/workspace.js
 * Server side of the Multi-Agent Workspace (/workspace).
 *
 * createWorkspaceHub() owns:
 *   - two incremental file readers (lib/store.js EventTail):
 *       hook records   data/events.jsonl           (converted with convertHookRecord)
 *       workspace      data/workspace-events.jsonl (already in the event shape)
 *   - the SSE clients of GET /api/events. Each SSE message is ONE workspace event (default event type).
 *   - POST /api/events          -> validate + append one line to the workspace file
 *   - POST /api/command         -> validate, store uploaded files, write one queue file (pending_approval),
 *                                  write a command record, and emit events
 *   - GET  /api/queue           -> listQueue(): open items (pending_approval and approved), no file contents
 *   - POST /api/queue/approve   -> approveItem (pending_approval -> approved), one "approved:" event
 *   - POST /api/queue/reject    -> rejectItem (move to rejected/), one "rejected:" event
 *   - POST /api/queue/done      -> markDone (approved only, moved to done/), one "done:" event
 *   - syncQueueState()          -> the Secretary node state is DERIVED from the open queue:
 *                                  open (pending_approval + approved) > 0 = PROCESSING, open = 0 = COMPLETED.
 *                                  It runs after a new command and on a timer, so a change made outside HTTP
 *                                  (module or CLI) is also picked up and the node cannot stay stuck.
 *
 * Event rules: approve, reject and done each write exactly ONE secretary event (the action event). The timer
 * does not write a second event for the same change, because lastKey is updated with the action event.
 *
 * Sync sub-agent runs: their SubagentStop arrives before PostToolUse(Agent) (which carries the tool_use_id). The hub
 * holds such a stop for at most TOOL_USE_WAIT_MS (lib/stop-hold.js) and releases it WITH the id when the PostToolUse
 * arrives. If no id comes in time, it is released without one (FIFO in the browser, marked approximate). Other events
 * are not held: they keep their order, and only the held stop is released later.
 * Failed Agent calls (PostToolUseFailure): the ERROR closes the task by its id. The stop of that same run is dropped
 * (a held one at once, a later one through a failure marker for TOOL_USE_WAIT_MS), so it cannot close another task or
 * flip the agent back to COMPLETED. This is only done when the run is known EXACTLY (per-instance binding). When the match is by
 * agent TYPE (a hint: the stop may belong to a sibling that really succeeded) the stop is held as SUSPECT instead: the exact
 * PostToolUse(agent_ref) releases it with its id (a failed run never gets one), and the end of the wait drops it.
 * PARALLEL RUNS of one agent type (several instances at once, shown as moons in the browser): the run of a failure and the
 * run of a stop are told apart per instance. The hub binds agent_ref -> tool_use_id: a SubagentStart is matched to the oldest
 * PreToolUse(Agent) of the same session and type that has no start yet (FIFO), and PostToolUse(Agent) then sets the exact
 * link. A FIFO binding is only trusted when it was the ONLY candidate. When a start arrives while several Agent calls of that
 * session and type wait, the starts may come in a different order than the calls, so the binding is a GUESS (ambiguous; the
 * remaining candidates of the group are tainted too). Only trusted bindings (exact or sole candidate) get per-instance
 * treatment: a failure drops/marks only the stop of ITS agent_ref. An ambiguous (or unknown) binding falls back to the agent
 * TYPE rule (lib/stop-hold.js failed()) and never causes a drop by id (shouldRelease). The same type fallback is used when the
 * log has no SubagentStart at all. A held stop whose wait ends without an id is released, unless the task it is TRUSTED to
 * belong to was already closed by id (then its COMPLETED would only flip the agent); it is never dropped just because a
 * sibling started.
 *
 * Both sources feed the same stream, so the pipeline and the log update from one event stream.
 * Auth (Origin, optional token) is checked in server.js before these functions are called.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventTail } = require('./store');
const { convertHookRecord, convertToolActivity, validateEvent, shorten, resolveAgent } = require('./workspace-adapter');
const { isDelegationTool } = require('./delegation');
const { createStopHold } = require('./stop-hold');
const {
  forwardToSecretary, markDone, approveItem, rejectItem, listOpenItems, STATUS,
} = require('./secretary-adapter');

const WATCH_INTERVAL_MS = 700;   // file poll interval (fs.watchFile)
const DEBOUNCE_MS = 150;         // coalesce bursts of writes into one read
const PING_MS = 15000;           // SSE keep-alive comment interval
const QUEUE_CHECK_MS = 2000;     // how often the queue folder is re-counted (catches changes made outside HTTP)
const BUFFER_SIZE = 200;         // events kept in memory for new SSE clients
const REPLAY_COUNT = 100;        // events sent to a client right after it connects
// How long a SubagentStop of a SYNC run waits for its PostToolUse(Agent), which carries the tool_use_id (lib/stop-hold.js).
// Measured on data/events.jsonl (2026-10-12, 82 sync stops): p50 38 ms, p90 48 ms, p99 4.0 s, max 4.0 s.
// 8 s gives about 2x the largest gap seen. A stop whose PostToolUse does not come in time is released without an id (FIFO, `~`).
const TOOL_USE_WAIT_MS = 8000;
// Instance links (tool_use_id <-> agent_ref, closed ids): upper bound of each map/set, oldest entries are dropped first.
const MAX_INSTANCE_LINKS = 500;
// An Agent call that has no SubagentStart after this long (event time) is forgotten by the start matching. In the log a start
// follows its PreToolUse within about a second; 30 s is far above that and keeps a lost start from capturing a later one.
const PENDING_START_MAX_MS = 30000;
// Life of a failure marker that has no agent_ref (type rule: no reliable instance data). Longer than TOOL_USE_WAIT_MS so the
// late stop of a failed run does not escape the marker and FIFO-close a newer task. Not measured: failure -> stop gaps are not in
// the log data; 60 s is an estimate. A stop caught by a type marker is only HELD as suspect (TOOL_USE_WAIT_MS) and released with
// its id when its PostToolUse comes, so a legit stop of ANOTHER run of the same type inside the window is no longer lost: the
// cost is a delay of at most TOOL_USE_WAIT_MS (and, when no PostToolUse comes, one missing close). So the long window is cheap.
const TYPE_FAILURE_MARKER_MS = 60000;
// How long after the end of its wait a DROPPED suspect stop (matched a failure by type, no Post in TOOL_USE_WAIT_MS) still accepts a
// late exact PostToolUse(agent_ref) and is then closed by its id (lib/stop-hold.js LATE POST). Equal to the type marker life: an
// estimate, not measured. Memory is bounded (32 stops) and counted in event time.
const LATE_POST_MS = 60000;

// Command limits (checked on the server; the browser checks the same limits first)
const MAX_FILES = 10;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 20000;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// Warning text when an action was saved but its workspace event could not be written
const EVENT_WARNING = 'The change is saved, but the workspace event could not be written (see server log).';

/**
 * Make a file name safe to store: base name only, no path parts, limited characters and length.
 * Letters, combining marks (\p{M}, needed for Thai vowels and tone marks) and digits are kept.
 */
function safeFileName(name) {
  const base = path.basename(String(name).replace(/\\/g, '/'));
  const cleaned = base.replace(/[^\p{L}\p{M}\p{N}._ -]+/gu, '_').replace(/^\.+/, '').slice(0, 120);
  return cleaned.trim() || 'file';
}

/**
 * Validate a command body. Returns { value: { text, files: [{name, type, data: Buffer}] } } or { error }.
 */
function validateCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'body must be a JSON object' };
  }
  const text = body.text === undefined ? '' : body.text;
  if (typeof text !== 'string') return { error: 'text must be a string' };
  if (text.length > MAX_TEXT_CHARS) return { error: `text must be at most ${MAX_TEXT_CHARS} characters` };

  const rawFiles = body.files === undefined ? [] : body.files;
  if (!Array.isArray(rawFiles)) return { error: 'files must be an array' };
  if (rawFiles.length > MAX_FILES) return { error: `at most ${MAX_FILES} files per command` };

  const files = [];
  let total = 0;
  for (const f of rawFiles) {
    if (!f || typeof f.name !== 'string' || !f.name.trim() || typeof f.data !== 'string') {
      return { error: 'each file needs a name and base64 data' };
    }
    if (!BASE64_RE.test(f.data)) return { error: `file "${f.name}" is not valid base64` };
    const data = Buffer.from(f.data, 'base64');
    if (data.length > MAX_FILE_BYTES) return { error: `file "${f.name}" is larger than 5 MB` };
    total += data.length;
    if (total > MAX_TOTAL_BYTES) return { error: 'total upload is larger than 12 MB' };
    files.push({
      name: f.name.slice(0, 200),
      type: typeof f.type === 'string' ? f.type.slice(0, 100) : 'application/octet-stream',
      data,
    });
  }

  if (!text.trim() && files.length === 0) return { error: 'send some text or at least one file' };
  return { value: { text: text.trim(), files } };
}

/**
 * Map a queue error code (from lib/secretary-adapter.js) to an HTTP answer.
 * @returns {{ status: number, body: object }|null}  null = unknown code (the caller rethrows it)
 */
function queueErrorResponse(err) {
  switch (err.code) {
    case 'EINVAL_ID':
      return { status: 400, body: { error: 'id must be a command id (letters, digits, "-" and "_")' } };
    case 'ENOENT_QUEUE':
      return { status: 404, body: { error: 'queue item not found' } };
    case 'ENOT_PENDING':
      return { status: 409, body: { error: `item status is "${err.status}"; only a pending_approval item can be approved`, status: err.status } };
    case 'ENOT_APPROVED':
      return { status: 409, body: { error: 'item must be approved before it is done', status: err.status } };
    case 'EUNREADABLE':
      return { status: 409, body: { error: 'item file is not valid JSON; reject it instead' } };
    default:
      return null;
  }
}

/** The "id" field of a request body (undefined when the body is not an object). */
function idFromBody(body) {
  return body && typeof body === 'object' ? body.id : undefined;
}

/**
 * Create the workspace hub.
 * @param {object} opts
 * @param {string} opts.eventsFile      hook records file (data/events.jsonl)
 * @param {string} opts.workspaceFile   workspace events file (data/workspace-events.jsonl)
 * @param {string} opts.commandsFile    command records file (data/commands.jsonl)
 * @param {string} opts.uploadsDir      folder for uploaded files
 * @param {string} opts.secretaryQueueDir  folder for the Secretary queue files (one JSON per command)
 * @param {object} [opts.timing]        test hook: { now, setTimer, clearTimer, waitMs, watchIntervalMs, queueCheckMs } (defaults:
 *                                      the real clock and timers, waitMs = TOOL_USE_WAIT_MS, watchIntervalMs = WATCH_INTERVAL_MS,
 *                                      queueCheckMs = QUEUE_CHECK_MS). Tests pass a fake clock and / or small intervals.
 */
function createWorkspaceHub(opts) {
  const { eventsFile, workspaceFile, commandsFile, uploadsDir, secretaryQueueDir } = opts;
  const timing = opts.timing || {};
  const nowMs = timing.now || Date.now;
  // File watcher poll interval and queue-timer period. Injectable so tests with real timers can run in milliseconds.
  const watchIntervalMs = timing.watchIntervalMs !== undefined ? timing.watchIntervalMs : WATCH_INTERVAL_MS;
  const queueCheckMs = timing.queueCheckMs !== undefined ? timing.queueCheckMs : QUEUE_CHECK_MS;
  const hookTail = new EventTail(eventsFile);
  const wsTail = new EventTail(workspaceFile);
  // agent_ref -> tool_use_id, filled by PostToolUse(Agent) records and read by the SubagentStop that follows.
  // Kept for the life of the hub so a stop in a later read still finds its link (bounded inside the adapter).
  const hookLinks = new Map();
  const buffer = [];   // { src: 'hook' | 'ws', event } - the last BUFFER_SIZE events
  const clients = new Set(); // { res }
  // Instance links (one Agent tool call = one instance). Needed when several instances of one agent type run at once.
  //   pendingStarts: PreToolUse(Agent) records whose SubagentStart has not been seen yet, oldest first:
  //                  { toolUseId, agentId, sessionId, atMs, tainted }. Starts are matched within session_id + agent type.
  //   startBind:     agent_ref (SubagentStart / SubagentStop agent_id) -> { id: tool_use_id, ambiguous }. FIFO by start order;
  //                  ambiguous = true when it is a guess (see trackInstance). Replaced by the exact link of PostToolUse(Agent)
  //                  (ambiguous = false) when that arrives. One tool_use_id has at most one agent_ref. Bounded like hookLinks.
  //   sawStart:      true once the log has shown a SubagentStart. Without any, no instance link can exist (type fallback).
  //   closedIds:     tool_use_ids that a COMPLETED / ERROR event with that id was already emitted for (bounded, oldest dropped).
  const pendingStarts = [];
  const startBind = new Map();
  let sawStart = false;
  const closedIds = new Set();
  const heldRef = new WeakMap();   // held stop event -> its agent_ref (the binding is read when the wait ends)
  let timer = null;
  // Sync-run stops waiting for their PostToolUse id (lib/stop-hold.js). Released events go through emit().
  const stopHold = createStopHold({
    // info.late = released by a Post that came after the wait: never emit a second close for a task already closed by id
    release: (event, info) => {
      if (info && info.late && event.toolUseId && closedIds.has(event.toolUseId)) return;
      emit('hook', event);
    },
    waitMs: timing.waitMs !== undefined ? timing.waitMs : TOOL_USE_WAIT_MS,
    now: nowMs,
    setTimer: timing.setTimer || setTimeout,
    clearTimer: timing.clearTimer || clearTimeout,
    // Released without an id (FIFO in the browser), except when the task this stop is TRUSTED to belong to is already closed
    // by id: then the stop belongs to a finished run and would only flip the agent. An ambiguous binding (a guess) never
    // causes a drop, and a sibling instance starting does NOT drop it either.
    shouldRelease: (event) => {
      const bound = startBind.get(heldRef.get(event));
      return !(bound && !bound.ambiguous && closedIds.has(bound.id));
    },
    typeMarkerMs: timing.typeMarkerMs !== undefined ? timing.typeMarkerMs : TYPE_FAILURE_MARKER_MS,
    lateMs: timing.lateMs !== undefined ? timing.lateMs : LATE_POST_MS,
  });

  // Queue state last written to the stream for the Secretary node, as a key "pending|approved" (see keyOf).
  // null = nothing written yet (for example the queue could not be read at start).
  let lastKey = null;
  // Explicit success flag of the LAST Secretary state write (LOW-2). false = the stream may not show
  // lastKey, so the next timer tick retries the write even when the counts have not changed.
  let writeOk = true;
  // Key of the failure that was already written to the server log (LOW-1). null = no open failure.
  // While the same failure stays open, it is not logged again on every timer tick.
  // Two SEPARATE channels, so one kind of success can never close the other kind of failure:
  //   openFailure     = secretary queue read / state write failures ('read:*', 'write:*')
  //   openPollFailure = event file read failures ('poll:*'), closed only by a poll that really succeeds
  let openFailure = null;
  let openPollFailure = null;
  let startOpen = 0;   // open items at start (a forced state write is needed when > 0)

  // Start from the real queue so a restart does not report a change that did not happen.
  try {
    const counts = countQueue();
    lastKey = keyOf(counts);
    startOpen = counts.open;
  } catch (err) {
    reportFailure(`read:${err.code}`, `[workspace] could not read the secretary queue at start: ${err.message}`);
  }

  /** Keep the event in the replay buffer (bounded). */
  function remember(src, event) {
    buffer.push({ src, event });
    if (buffer.length > BUFFER_SIZE) buffer.splice(0, buffer.length - BUFFER_SIZE);
  }

  /**
   * Log a failure once. The same failure key is not logged again until a different failure or a
   * recovery happens, so a broken disk or queue folder does not write a line on every timer tick.
   * Keys starting with 'poll:' use the poll channel, all other keys the queue channel (see above).
   * @param {string} key      identifies the failure (kind + error code, and the open count for writes)
   * @param {string} message  the line written to the server log (stderr) the first time
   */
  function reportFailure(key, message) {
    if (key.startsWith('poll:')) {
      if (openPollFailure === key) return;
      openPollFailure = key;
    } else {
      if (openFailure === key) return;
      openFailure = key;
    }
    console.error(message);
  }

  /** Log one recovery line when a queue/write failure was open. Does NOT touch the poll channel. */
  function reportRecovered() {
    if (openFailure === null) return;
    openFailure = null;
    console.log('[workspace] secretary queue and event log are working again (recovered)');
  }

  /** Log one recovery line when a poll failure was open. Call it ONLY right after a poll() that succeeded. */
  function reportPollRecovered() {
    if (openPollFailure === null) return;
    openPollFailure = null;
    console.log('[workspace] event files can be read again (recovered)');
  }

  /** Write one SSE message (default event type, JSON on one line). */
  function sseSend(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  /** Send one event to every connected client. Dead clients are removed. */
  function broadcast(event) {
    for (const client of [...clients]) {
      try {
        sseSend(client.res, event);
      } catch (_err) {
        clients.delete(client);
        client.res.end();
      }
    }
  }

  /**
   * Send one tool activity message (lib/workspace-adapter.js convertToolActivity) to every client as the named SSE event
   * "activity". Live only: it is NOT kept in the replay buffer (a busy session makes two per tool call and would push the real
   * history out), and the default `onmessage` handler of the browser never sees it. A dead client is dropped like in broadcast().
   */
  function broadcastActivity(activity) {
    if (clients.size === 0) return;
    const chunk = `event: activity\ndata: ${JSON.stringify(activity)}\n\n`;
    for (const client of [...clients]) {
      try {
        client.res.write(chunk);
      } catch (_err) {
        clients.delete(client);
        client.res.end();
      }
    }
  }

  /** agent_id (hook field) -> task id of its instance, for a TRUSTED link only (a FIFO guess is not used for attribution). */
  function trustedInstanceOf(agentRef) {
    const bound = startBind.get(agentRef);
    return bound && !bound.ambiguous ? bound.id : undefined;
  }

  /**
   * Keep one event in the buffer and send it to every client (the single output path of the hub).
   * ephemeral = send it live but do not keep it for the replay of later clients (see isToolStartLog).
   */
  function emit(src, event, ephemeral = false) {
    if (event.toolUseId && (event.status === 'COMPLETED' || event.status === 'ERROR')) rememberClosed(event.toolUseId);
    if (!ephemeral) remember(src, event);
    broadcast(event);
  }

  /**
   * True for the log line of a plain tool start (PreToolUse of any tool except Agent: "ใช้เครื่องมือ Read"). With the hook matcher
   * widened to every tool there are two such records per tool call, so they would fill the 200-event replay buffer within a
   * minute and push out the events that matter (task starts and ends, which the moons need after a reconnect). They are still
   * sent live; only the replay skips them. The effects use the separate "activity" channel (broadcastActivity).
   */
  function isToolStartLog(rec) {
    return rec.event === 'PreToolUse' && !isDelegationTool(rec.tool_name);
  }

  /** Remember that the task with this tool_use_id was closed by an event (bounded to MAX_INSTANCE_LINKS ids). */
  function rememberClosed(toolUseId) {
    closedIds.add(toolUseId);
    while (closedIds.size > MAX_INSTANCE_LINKS) closedIds.delete(closedIds.values().next().value);
  }

  /**
   * Link agent_ref -> tool_use_id (re-inserted so the newest link is last; bounded to MAX_INSTANCE_LINKS).
   * ambiguous = true for a FIFO guess, false for an exact link or a sole candidate. A tool_use_id belongs to ONE agent_ref:
   * any other ref bound to it is removed (after a rebind two refs would otherwise point to the same id). A guess never
   * replaces a trusted link of another ref.
   */
  function bindInstance(agentRef, toolUseId, ambiguous) {
    for (const [ref, b] of [...startBind]) {
      if (ref === agentRef || b.id !== toolUseId) continue;
      if (ambiguous && !b.ambiguous) return;   // keep the trusted link
      startBind.delete(ref);
    }
    startBind.delete(agentRef);
    startBind.set(agentRef, { id: toolUseId, ambiguous: !!ambiguous });
    while (startBind.size > MAX_INSTANCE_LINKS) startBind.delete(startBind.keys().next().value);
  }

  /** The binding of a tool_use_id as { ref, ambiguous }, or null. Unique per id (see bindInstance), so it is deterministic. */
  function bindingOfId(toolUseId) {
    for (const [ref, b] of startBind) if (b.id === toolUseId) return { ref, ambiguous: b.ambiguous };
    return null;
  }

  /** Remove a tool_use_id from the list of Agent calls that are waiting for their SubagentStart. */
  function forgetPending(toolUseId) {
    const i = pendingStarts.findIndex((p) => p.toolUseId === toolUseId);
    if (i !== -1) pendingStarts.splice(i, 1);
  }

  /** session_id of a hook record ('' when it has none), part of the key of the start matching. */
  function sessionOf(rec) {
    return typeof rec.session_id === 'string' ? rec.session_id : '';
  }

  /**
   * Keep the instance links up to date from one hook record (see the header). Called for every record, in file order,
   * before the record is converted. atMs = event time of the record (null when it has none).
   */
  function trackInstance(rec, atMs) {
    if (rec.event === 'PreToolUse' && isDelegationTool(rec.tool_name)
      && typeof rec.tool_use_id === 'string' && typeof rec.subagent_type === 'string') {
      const target = resolveAgent(rec.subagent_type);
      if (!target) return;
      pendingStarts.push({
        toolUseId: rec.tool_use_id, agentId: target.id, sessionId: sessionOf(rec), atMs, tainted: false,
      });
      while (pendingStarts.length > MAX_INSTANCE_LINKS) pendingStarts.shift();
    } else if (rec.event === 'SubagentStart' && typeof rec.agent_id === 'string' && rec.agent_id) {
      sawStart = true;
      const actor = resolveAgent(rec.agent_type);
      if (!actor || startBind.has(rec.agent_id)) return;
      // An Agent call whose start never came would otherwise capture the next start of its type: forget the old ones
      if (atMs !== null) {
        for (let i = pendingStarts.length - 1; i >= 0; i -= 1) {
          if (pendingStarts[i].atMs !== null && atMs - pendingStarts[i].atMs > PENDING_START_MAX_MS) pendingStarts.splice(i, 1);
        }
      }
      // Candidates: Agent calls of the SAME session and type without a start. The oldest is taken (FIFO).
      const sid = sessionOf(rec);
      const cand = [];
      pendingStarts.forEach((p, i) => { if (p.agentId === actor.id && p.sessionId === sid) cand.push(i); });
      if (cand.length === 0) return;
      const chosen = pendingStarts[cand[0]];
      // More than one candidate (or a candidate already put in doubt by an earlier guess): the start order may differ from the
      // call order under parallel dispatch, so this binding is a guess, and the candidates left are doubtful too.
      const ambiguous = cand.length > 1 || chosen.tainted;
      if (cand.length > 1) for (const k of cand.slice(1)) pendingStarts[k].tainted = true;
      pendingStarts.splice(cand[0], 1);
      bindInstance(rec.agent_id, chosen.toolUseId, ambiguous);
    } else if (rec.event === 'PostToolUse' && isDelegationTool(rec.tool_name)
      && typeof rec.agent_ref === 'string' && rec.agent_ref && typeof rec.tool_use_id === 'string') {
      bindInstance(rec.agent_ref, rec.tool_use_id, false);   // exact link, replaces a FIFO guess
      forgetPending(rec.tool_use_id);
    }
  }

  /** Drop the buffered events of one source (used when its file was truncated or replaced). */
  function forgetSource(src) {
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      if (buffer[i].src === src) buffer.splice(i, 1);
    }
  }

  /**
   * Read the new workspace lines (data/workspace-events.jsonl), convert them and emit them in file order.
   * If the file was truncated or replaced, the earlier events of this source are dropped from the
   * buffer first, and the re-read content is broadcast again (clients may see some repeats).
   */
  function pullWorkspace() {
    const { added, reset } = wsTail.refresh();
    wsTail.records.length = 0; // this hub keeps its own buffer; do not hold every raw record in memory
    if (reset) forgetSource('ws');
    for (const rec of added) {
      const event = validateEvent(rec).event || null;
      if (event) emit('ws', event);
    }
  }

  /** Event time of a hook record in ms, or null when its ts is missing or not a date. */
  function recordTimeMs(rec) {
    const t = typeof rec.ts === 'string' ? Date.parse(rec.ts) : NaN;
    return Number.isNaN(t) ? null : t;
  }

  /**
   * True for a SubagentStop that must wait for its PostToolUse id: a sub-agent stop (the main persona returns no
   * event), completed, with no id known yet (sync run, the PostToolUse(Agent) comes after it).
   */
  function isSyncStop(rec, event) {
    return rec.event === 'SubagentStop'
      && event.status === 'COMPLETED'
      && !event.toolUseId
      && typeof rec.agent_id === 'string'
      && rec.agent_id.length > 0;
  }

  /**
   * Read the new hook records (data/events.jsonl), convert them and emit them in file order, except that a sync
   * SubagentStop is held (lib/stop-hold.js) until its PostToolUse(Agent) id arrives or its wait is over.
   * Event time drives the expiry of held stops, so a history file read in one batch behaves like a live read.
   */
  function pullHook() {
    const { added, reset } = hookTail.refresh();
    hookTail.records.length = 0; // see pullWorkspace()
    if (reset) {
      stopHold.clear();            // held stops came from the old file content
      pendingStarts.length = 0;    // so did the Agent calls that waited for a start
      forgetSource('hook');
    }
    for (const rec of added) {
      const t = recordTimeMs(rec);
      const at = t === null ? undefined : t;
      if (t !== null) stopHold.expireDue(t);   // waits that ended before this record's time
      trackInstance(rec, t);                   // tool_use_id <-> agent_ref links (before the record is used below)
      // PostToolUse(Agent) links agent_ref -> tool_use_id inside convertHookRecord; it also closes any held stop of that agent
      if (rec.event === 'PostToolUse' && isDelegationTool(rec.tool_name)
        && typeof rec.agent_ref === 'string' && typeof rec.tool_use_id === 'string') {
        stopHold.resolve(rec.agent_ref, rec.tool_use_id, at);
      }
      // A failed Agent call: its sub-agent (subagent_type) will not finish normally. Its ERROR (below) closes the task,
      // so the stop of THAT run is dropped (lib/stop-hold.js failed()). Which run: the agent_ref bound to its tool_use_id.
      //   trusted binding (exact, or the sole candidate) -> per instance: only the stop with that agent_ref is dropped
      //   ambiguous binding (a FIFO guess), or the call is a doubtful pending one -> agent TYPE rule (the guess may be swapped)
      //   not bound, but the log has SubagentStart records -> the run never started, so no stop will come: nothing to drop
      //   not bound and no SubagentStart in the log        -> no instance data at all: fall back to the agent type
      if (rec.event === 'PostToolUseFailure' && isDelegationTool(rec.tool_name)) {
        const failedAgent = resolveAgent(rec.subagent_type);
        const failedId = typeof rec.tool_use_id === 'string' ? rec.tool_use_id : null;
        const bound = failedId ? bindingOfId(failedId) : null;
        const pend = failedId ? pendingStarts.find((p) => p.toolUseId === failedId) : null;
        if (failedId) forgetPending(failedId);
        if (failedAgent && bound) stopHold.failed(failedAgent.id, at, bound.ambiguous ? undefined : bound.ref);
        else if (failedAgent && pend && pend.tainted) stopHold.failed(failedAgent.id, at);   // its start may be bound elsewhere
        else if (failedAgent && !sawStart) stopHold.failed(failedAgent.id, at);
      }
      // Tool activity (effects only; a separate live channel, no log line, no replay buffer)
      const activity = convertToolActivity(rec, trustedInstanceOf);
      if (activity) broadcastActivity(activity);
      const event = convertHookRecord(rec, hookLinks);
      if (!event) continue;
      if (isSyncStop(rec, event)) {
        // The stop of a failed run is already covered by its ERROR. Per-instance marker (exact agent_ref): drop it.
        // Type marker (only a hint, the stop may be a sibling that really succeeded): hold it as SUSPECT. The exact
        // PostToolUse(agent_ref) releases it with its id (and puts the marker back, so the failed run's own stop is still
        // caught; the marker may also be handed to an already-held stop of the same agent, see stop-hold.js), otherwise it is dropped when the wait ends (a later exact Post still closes it, see LATE_POST_MS).
        const failure = stopHold.consumeFailure(event.agent, at, rec.agent_id);
        if (failure === 'instance') continue;
        stopHold.hold(event, rec.agent_id, at, { suspect: failure === 'type' });
        heldRef.set(event, rec.agent_id);
        continue;
      }
      emit('hook', event, isToolStartLog(rec));
    }
    stopHold.expireDue(nowMs());   // live case: no later record may come to end the wait
  }

  // True after a poll that threw (for example EACCES or EISDIR on an events file). Only used to label the queue timer's
  // poll as a "retry" in the log: the timer polls on EVERY tick anyway (see below), so a failed read is retried even
  // when the file does not change again (the watcher would stay silent).
  let pollFailed = false;

  /**
   * Read both sources once. Safe to call at any time (offsets make it incremental).
   * One failing source does not stop the other: both are tried, then the first error is re-thrown.
   * Callers that cannot let an error escape (timer, watcher, startup, publish) use pollQuiet() instead.
   */
  function poll() {
    let firstError = null;
    try {
      pullHook();
    } catch (err) {
      firstError = err;
    }
    try {
      pullWorkspace();
    } catch (err) {
      if (!firstError) firstError = err;
    }
    pollFailed = firstError !== null;
    if (firstError) throw firstError;
  }

  /**
   * poll() that never throws: a read failure (non-ENOENT errors of the EventTail, such as EACCES or EISDIR)
   * is logged once via reportFailure('poll:...') and the next timer tick retries. Used by the file watcher,
   * the initial load at startup and publish(), so an unreadable file can neither crash the process from a
   * timer nor block startup.
   * @param {string} context  where the poll came from (shown in the log line)
   * @returns {boolean}  true = both sources read, false = failed (logged)
   */
  function pollQuiet(context) {
    try {
      poll();
    } catch (err) {
      reportFailure(`poll:${err.code}`, `[workspace] could not read the event files (${context}): ${err.message}`);
      return false;
    }
    // Only a poll failure is closed here; queue read / state write failures have their own channel
    reportPollRecovered();
    return true;
  }

  // Watch both files. Polling is used because it works for files that do not exist yet.
  const onChange = (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    clearTimeout(timer);
    timer = setTimeout(() => pollQuiet('file watcher'), DEBOUNCE_MS);
  };
  fs.watchFile(eventsFile, { interval: watchIntervalMs }, onChange);
  fs.watchFile(workspaceFile, { interval: watchIntervalMs }, onChange);

  const pinger = setInterval(() => {
    for (const client of clients) client.res.write(': ping\n\n');
  }, PING_MS);
  pinger.unref();

  pollQuiet('startup'); // initial load so the first client gets history at once (an unreadable file is logged, not fatal)

  /**
   * Attach an SSE client. The caller has already written the 200 + event-stream headers.
   * The client first receives the last REPLAY_COUNT events, then live events.
   */
  function attach(req, res) {
    const client = { res };
    clients.add(client);
    res.on('error', () => clients.delete(client));
    res.write('retry: 2000\n\n');
    for (const item of buffer.slice(-REPLAY_COUNT)) sseSend(res, item.event);
    req.on('close', () => clients.delete(client));
  }

  /**
   * Validate and append one event (POST /api/events). Delivered at once, without waiting for the watcher.
   * @returns {{ status: number, body: object }}
   */
  function publish(input) {
    const result = validateEvent(input);
    if (result.error) return { status: 400, body: { error: result.error } };
    // An append error propagates (nothing was written: the caller reports a failure and a retry is safe).
    appendWorkspaceLine(result.event);
    // From here the event IS in the file. A failing poll must not turn this into a failed request (a client
    // retry would duplicate the event): it is logged, and the watcher / queue timer catches up on a later tick.
    pollQuiet('after publish');
    return { status: 201, body: { ok: true, event: result.event } };
  }

  /** Append one event as one JSON line to the workspace log file (creates the folder). Throws on failure. */
  function appendWorkspaceLine(event) {
    fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
    fs.appendFileSync(workspaceFile, `${JSON.stringify(event)}\n`);
  }

  /**
   * Publish an event for the log/pipeline WITHOUT letting a log failure change the command result.
   * Returns false (and logs the error) when the event could not be written (append failed). A failing poll after
   * a successful append is handled inside publish() and does not reach this catch, so the warning stays true.
   */
  function publishSafely(event) {
    try {
      publish(event);
      return true;
    } catch (err) {
      console.error(`[workspace] could not write event (${event.agent} ${event.status}): ${err.message}`);
      return false;
    }
  }

  /** Append one command record (one JSON line). Returns false (and logs) instead of throwing. */
  function writeCommandRecord(record) {
    try {
      fs.mkdirSync(path.dirname(commandsFile), { recursive: true });
      fs.appendFileSync(commandsFile, `${JSON.stringify(record)}\n`);
      return true;
    } catch (err) {
      console.error(`[workspace] command record write failed for ${record.id}: ${err.message}`);
      return false;
    }
  }

  /** Delete a folder, ignoring (but logging) any error. Used to clean up failed uploads. */
  function removeQuietly(target) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
      console.error(`[workspace] could not remove ${target}: ${err.message}`);
    }
  }

  /**
   * Write the uploaded files into dir (created if needed). Returns the stored list.
   * Throws on the first failed write; the caller removes the partial folder.
   */
  function saveUploads(dir, files) {
    fs.mkdirSync(dir, { recursive: true });
    return files.map((file, i) => {
      // The index prefix keeps names unique when two files share a name.
      const storedAs = `${String(i + 1).padStart(2, '0')}-${safeFileName(file.name)}`;
      fs.writeFileSync(path.join(dir, storedAs), file.data, { flag: 'wx' });
      return { name: file.name, storedAs, type: file.type, size: file.data.length };
    });
  }

  /**
   * Count the open queue items (pending_approval and approved). Throws when the queue cannot be read.
   * @returns {{ pending: number, approved: number, open: number }}
   */
  function countQueue() {
    let pending = 0;
    let approved = 0;
    for (const item of listOpenItems(secretaryQueueDir)) {
      if (item.status === STATUS.APPROVED) approved += 1;
      else pending += 1;
    }
    return { pending, approved, open: pending + approved };
  }

  /** Key used to detect a change of the queue counts. */
  function keyOf(counts) {
    return `${counts.pending}|${counts.approved}`;
  }

  /**
   * Derived Secretary state for the timer and for a new command (no action behind it):
   *   open = 0  -> secretary COMPLETED, message starts with "done:"
   *   open > 0  -> secretary PROCESSING, message starts with "queued:" (counts shown there)
   * @param {{ pending: number, approved: number, open: number }} counts
   * @param {string} id  the item this change is about ('' = none)
   */
  function derivedState(counts, id) {
    const idNote = id ? ` (${id})` : '';
    if (counts.open === 0) return { status: 'COMPLETED', message: `done: งานเสร็จแล้ว${idNote}` };
    return {
      status: 'PROCESSING',
      message: `queued: ค้างในคิว ${counts.open} งาน (รออนุมัติ ${counts.pending}, อนุมัติแล้ว ${counts.approved})${idNote}`,
    };
  }

  /**
   * Append one secretary state event. On success the state key is remembered (lastKey), so the timer does
   * not write the same state again. On failure writeOk is false and the timer retries on the next tick.
   * Write directly (not publishSafely) so the timer's repeated failures are logged once, not per tick.
   * @returns {boolean}  true = written, false = could not be written
   */
  function writeStateEvent(status, message, counts) {
    const event = { ts: new Date().toISOString(), agent: 'secretary', status, message };
    try {
      appendWorkspaceLine(event);
    } catch (err) {
      writeOk = false; // the stream may not show lastKey: the next tick retries
      reportFailure(`write:${counts.open}:${err.code}`,
        `[workspace] could not write the secretary state (${counts.open} open): ${err.message}`);
      return false;
    }
    writeOk = true;
    lastKey = keyOf(counts);

    try {
      poll();
    } catch (err) {
      // The event IS in the file; the file watcher reads it on a later poll. Only the read failed.
      reportFailure(`poll:${err.code}`, `[workspace] could not read the event files after a state write: ${err.message}`);
      return true;
    }
    // poll() succeeded here, so both the poll channel and the queue/write channel are healthy again
    reportPollRecovered();
    reportRecovered();
    return true;
  }

  /**
   * Derive the Secretary node state from the open queue and write it to the stream when it changed.
   * Without `force`, nothing is written when the counts equal the last written counts AND the last write
   * succeeded. A failed write is therefore retried on every timer tick (LOW-2). Failures are logged once
   * per failure (see reportFailure), and one recovery line is logged (LOW-1).
   * @param {{ force?: boolean, id?: string }} [opts]  id = the item this change is about (shown in the message)
   * @returns {boolean|null}  null = nothing to write; true = event written; false = could not read or write
   */
  function syncQueueState(opts = {}) {
    const { force = false, id = '' } = opts;
    let counts;
    try {
      counts = countQueue();
    } catch (err) {
      reportFailure(`read:${err.code}`, `[workspace] could not read the secretary queue: ${err.message}`);
      return false;
    }
    if (!force && keyOf(counts) === lastKey && writeOk) {
      reportRecovered();
      return null;
    }
    const { status, message } = derivedState(counts, id);
    return writeStateEvent(status, message, counts);
  }

  /**
   * Write the ONE event for an owner action (approve, reject, done). `build(counts)` gets the queue counts
   * AFTER the change and returns { status, message }. Returns false when the queue or the event could not be written.
   */
  function emitActionState(build) {
    let counts;
    try {
      counts = countQueue();
    } catch (err) {
      reportFailure(`read:${err.code}`, `[workspace] could not read the secretary queue: ${err.message}`);
      return false;
    }
    const { status, message } = build(counts);
    return writeStateEvent(status, message, counts) === true;
  }

  /**
   * Accept one command (POST /api/command):
   *   1. validate, 2. save files to uploadsDir/<id>/, 3. write the Secretary queue file (pending_approval, atomic),
   *   4. append a command record, 5. emit workspace events (user node, secretary "queued").
   *
   * Failure rules:
   *   - Upload write fails (step 2): the partial folder is removed, nothing is queued, the record says
   *     accepted=false, an ERROR event is emitted, response 500 "not queued".
   *   - Queue write fails (step 3): the record says accepted=false, ERROR event, response 500.
   *   - Record or event write fails AFTER the queue file exists (step 4-5): the command IS queued, so the
   *     response is 201 with a `warning`. We do NOT roll back the queue file: the owner may already have
   *     approved it, and a rollback would make the user resubmit and create a duplicate job.
   * @returns {{ status: number, body: object }}
   */
  function submitCommand(body) {
    const checked = validateCommand(body);
    if (checked.error) return { status: 400, body: { error: checked.error } };
    const { text, files } = checked.value;

    const now = new Date();
    const ts = now.toISOString();
    const id = `cmd-${ts.replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
    // Deterministic location for this command's files: <uploadsDir>/<id>/ (outside the queue folder)
    const dir = path.join(uploadsDir, id);

    // 2. Save uploaded files. Any failure: no partial folder, no queue file, clean error response.
    let stored = [];
    if (files.length) {
      try {
        stored = saveUploads(dir, files);
      } catch (err) {
        console.error(`[workspace] upload write failed for ${id}: ${err.message}`);
        removeQuietly(dir);
        writeCommandRecord({
          id, ts, text, files: [], forwarded: { accepted: false, mode: 'queue', error: 'upload write failed' },
        });
        publishSafely({
          ts,
          agent: 'secretary',
          status: 'ERROR',
          message: `บันทึกไฟล์แนบไม่สำเร็จ ยังไม่ได้เข้าคิว (${id})`,
        });
        return {
          status: 500,
          body: { error: 'Uploaded files could not be saved; the command was not queued', id },
        };
      }
    }

    // 3. Hand over to the Secretary via the file queue (status pending_approval). Errors are caught so the record and event still happen.
    let forwarded;
    let queueError = null;
    try {
      forwarded = forwardToSecretary(
        { id, timestamp: ts, text, dir, files: stored },
        { queueDir: secretaryQueueDir },
      );
    } catch (err) {
      queueError = err;
      console.error(`[workspace] secretary queue write failed for ${id}: ${err.message}`);
      forwarded = { accepted: false, mode: 'queue', error: 'queue write failed' };
    }

    // 4. Command record: one JSON line per command (failure is reported in the response, see below)
    const recorded = writeCommandRecord({ id, ts, text, files: stored, forwarded });

    // 5. Events for the pipeline and the log (same stream as everything else)
    const fileNote = stored.length ? ` (${stored.length} ไฟล์)` : '';
    const userOk = publishSafely({
      ts,
      agent: 'user',
      status: 'COMPLETED',
      message: `ส่งคำสั่งงาน${fileNote}: ${shorten(text, 120) || '(ไม่มีข้อความ)'}`,
    });
    if (queueError) {
      publishSafely({
        ts,
        agent: 'secretary',
        status: 'ERROR',
        message: `เข้าคิวของเลขาคนสวยไม่สำเร็จ (${id})`,
      });
      return { status: 500, body: { error: 'Secretary queue write failed', id } };
    }
    // "queued": the command is in data/secretary-queue/ and waits for the owner's approval.
    // Forced: this is a new item, so the state is written even if the counts look unchanged.
    const queueEventOk = syncQueueState({ force: true, id }) === true;

    const out = { ok: true, id, files: stored.length, forwarded };
    // Any log write that failed after the queue file exists is reported as a warning (README "Failure rules")
    const problems = [];
    if (!recorded) problems.push('the command log could not be written');
    if (!userOk || !queueEventOk) problems.push('the workspace log events could not be written');
    if (problems.length) {
      out.warning = `Command is queued, but ${problems.join(' and ')} (see server log). Do not resubmit.`;
    }
    return { status: 201, body: out };
  }

  /**
   * List the open queue items for the dashboard (GET /api/queue).
   * Only id, timestamp, text, status and attachment NAMES and SIZES are returned. No file contents, no paths.
   * @returns {{ status: number, body: { items: object[] } }}
   */
  function listQueue() {
    const items = listOpenItems(secretaryQueueDir).map((rec) => ({
      id: rec.id,
      timestamp: rec.timestamp,
      text: rec.text,
      status: rec.status,
      unreadable: rec.corrupt,
      attachments: rec.attachments.map((a) => ({ name: a.name, size: a.size })),
    }));
    return { status: 200, body: { items } };
  }

  /**
   * Owner approves one item (POST /api/queue/approve, body { id }).
   * pending_approval -> approved. Writes one "approved:" secretary event.
   * Approving again returns 409 (the item is no longer pending_approval).
   * @returns {{ status: number, body: object }}
   */
  function approveQueueItem(body) {
    const id = idFromBody(body);
    let result;
    try {
      result = approveItem(id, { queueDir: secretaryQueueDir });
    } catch (err) {
      const mapped = queueErrorResponse(err);
      if (mapped) return mapped;
      throw err; // unexpected fs error: the server answers 500
    }
    const out = { ok: true, id, status: result.status, approvedAt: result.approvedAt };
    const eventOk = emitActionState((counts) => ({
      status: 'PROCESSING',
      message: `approved: อนุมัติ ${id} แล้ว รอ Claude session หยิบงาน (ค้างในคิว ${counts.open} งาน)`,
    }));
    if (!eventOk) out.warning = EVENT_WARNING;
    return { status: 200, body: out };
  }

  /**
   * Owner rejects one item (POST /api/queue/reject, body { id }). The file is moved to rejected/, never deleted.
   * Writes one "rejected:" secretary event. The node is COMPLETED only when no open item is left.
   * @returns {{ status: number, body: object }}
   */
  function rejectQueueItem(body) {
    const id = idFromBody(body);
    let result;
    try {
      result = rejectItem(id, { queueDir: secretaryQueueDir });
    } catch (err) {
      const mapped = queueErrorResponse(err);
      if (mapped) return mapped;
      throw err; // unexpected fs error: the server answers 500
    }
    const out = { ok: true, id, status: result.status };
    if (!result.recordUpdated) {
      console.error(`[workspace] ${id} moved to rejected/, but its status field was not written: ${result.recordError}`);
    }
    const eventOk = emitActionState((counts) => (counts.open === 0
      ? { status: 'COMPLETED', message: `rejected: ปฏิเสธ ${id} แล้ว ไม่มีงานค้างในคิว` }
      : { status: 'PROCESSING', message: `rejected: ปฏิเสธ ${id} แล้ว (ค้างในคิว ${counts.open} งาน)` }));
    if (!eventOk) out.warning = EVENT_WARNING;
    return { status: 200, body: out };
  }

  /**
   * Mark one APPROVED item as done (POST /api/queue/done, body { id }).
   * The item is moved to done/ and one "done:" event is written. A pending_approval item gets 409.
   * A repeated call writes only if the open count changed since the last event (for example the item was
   * marked done through the module before this call), so the node cannot stay stuck.
   * @returns {{ status: number, body: object }}
   */
  function markQueueDone(body) {
    const id = idFromBody(body);
    let result;
    try {
      result = markDone(id, { queueDir: secretaryQueueDir });
    } catch (err) {
      const mapped = queueErrorResponse(err);
      if (mapped) return mapped;
      throw err; // unexpected fs error: the server answers 500
    }

    if (result.alreadyDone) {
      // Repeated call: no new event, unless the counts changed since the last written state
      const written = syncQueueState();
      const out = { ok: true, id, alreadyDone: true };
      if (written === false) out.warning = 'Item is done, but the event could not be written (see server log).';
      return { status: 200, body: out };
    }

    const out = { ok: true, id, alreadyDone: false, status: 'done' };
    if (!result.recordUpdated) {
      console.error(`[workspace] ${id} moved to done/, but its status field was not written: ${result.recordError}`);
    }
    const eventOk = emitActionState((counts) => (counts.open === 0
      ? { status: 'COMPLETED', message: `done: งานเสร็จแล้ว (${id})` }
      : { status: 'PROCESSING', message: `done: ${id} เสร็จแล้ว (ค้างในคิว ${counts.open} งาน)` }));
    if (!eventOk) out.warning = EVENT_WARNING;
    return { status: 200, body: out };
  }

  // Re-count the queue on a timer. This catches changes made outside HTTP (module or CLI).
  // The event files are polled on EVERY tick, not only after a failure. Reasons:
  //   - fs.watchFile takes its first stat asynchronously (libuv threadpool), so an append or a replacement between the
  //     startup poll and that first stat is never reported as a change by the watcher;
  //   - a failed read is retried even when the file does not change again.
  // Cost per tick: one stat per file plus a read of the new bytes only (EventTail), nothing when idle. No log spam:
  // pollQuiet() logs a failure once per failure key and a recovery once (reportFailure / reportPollRecovered).
  const queueTimer = setInterval(() => {
    pollQuiet(pollFailed ? 'retry' : 'queue timer');
    syncQueueState();
  }, queueCheckMs);
  queueTimer.unref();
  // After a restart with open items, show that state once (the node would otherwise look IDLE).
  // If this write fails, writeOk stays false and the timer above retries it on the next tick (LOW-2).
  if (startOpen > 0) syncQueueState({ force: true });

  /** Stop watchers and timers and end every SSE stream. Called when the HTTP server closes. */
  function close() {
    clearTimeout(timer);
    stopHold.clear();          // cancels the timers of held sync stops (no timer outlives the hub)
    clearInterval(pinger);
    clearInterval(queueTimer);
    fs.unwatchFile(eventsFile, onChange);
    fs.unwatchFile(workspaceFile, onChange);
    for (const client of clients) client.res.end();
    clients.clear();
  }

  return {
    attach,
    publish,
    submitCommand,
    listQueue,
    approveQueueItem,
    rejectQueueItem,
    markQueueDone,
    syncQueueState,
    poll,
    close,
    uploadsDir,
  };
}

module.exports = {
  createWorkspaceHub, validateCommand, safeFileName, MAX_FILE_BYTES, TOOL_USE_WAIT_MS, TYPE_FAILURE_MARKER_MS, LATE_POST_MS,
};
