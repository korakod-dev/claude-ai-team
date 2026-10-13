/**
 * stellar/activity.js - Pure rules of the activity effects: a thinking pulse, one beam per tool call, a burst when an instance
 * finishes. No DOM, no THREE. Used by scene.js (the effects), app.js (the text state in the agent list) and the tests.
 *
 * Where the data comes from:
 *   Tool activity arrives as the named SSE event "activity" (lib/workspace-adapter.js convertToolActivity), one message per
 *   PreToolUse ('start') and per PostToolUse / PostToolUseFailure ('end' / 'error') of a tool call. Each message says WHO made
 *   the call: `agent` (the agent type, always) and `instance` (the task id of the sub-agent run, only when the hook carried
 *   agent_id and the server holds a trusted link for it). Without `instance` the call is attributed to the agent (planet) only.
 *   The Agent tool is not activity (its dispatch is a comet).
 *
 * State machine (per actor = one instance, or the planet itself for calls without an instance):
 *   thinking  the instance has started (it is a live task of the store) or a tool just finished, and no tool call is running
 *   acting    between 'start' and 'end' / 'error' of a tool call made BY that actor (at least one call is running)
 *   idle      no live instance (and no running call)
 * A planet is  acting   when any of its actors acts,
 *              thinking when a live instance exists that is not acting,
 *              idle     otherwise.
 * A call that never ends (a lost PostToolUse) stops counting as running after CALL_TIMEOUT_MS.
 *
 * Failed tool call (phase 'error'): ends the call like 'end' AND returns a red beam for that actor (FAILURE_BEAM_COLOR, `failed: true`).
 * It is the only visible effect of an ordinary tool failure; planet / moon status is untouched (the server sends no ERROR event).
 *
 * Caps: MAX_BEAMS beams at once and MAX_BURSTS bursts at once (pickSlot reuses the oldest slot), at most one beam per actor
 * every BEAM_MIN_GAP_MS (a Grep storm does not flood the pool), at most MAX_ACTORS actors and MAX_CALLS_PER_ACTOR calls in memory.
 */

/* ---------- tool groups and colours ---------- */

// Beam colours by tool group (hex). Read-like tools cyan, writes orange, shell red, web purple, everything else white.
export const BEAM_COLORS = Object.freeze({
  read: 0x22d3ee,
  write: 0xfb923c,
  shell: 0xef4444,
  web: 0xa855f7,
  other: 0xffffff,
});

// Beam colour of a FAILED tool call (PostToolUseFailure of an ordinary tool): a hotter red than the Bash beam, so a failure is
// told apart from a normal shell call. A failed tool is only a beam: it never changes a planet status or draws a black hole.
export const FAILURE_BEAM_COLOR = 0xff1e1e;

// Tool names per group (compared lower-case). Unknown tools (including MCP tools) are 'other'.
const TOOL_GROUPS = new Map([
  ['read', 'read'], ['grep', 'read'], ['glob', 'read'], ['ls', 'read'], ['notebookread', 'read'],
  ['edit', 'write'], ['write', 'write'], ['multiedit', 'write'], ['notebookedit', 'write'],
  ['bash', 'shell'], ['bashoutput', 'shell'], ['killshell', 'shell'], ['powershell', 'shell'],
  ['websearch', 'web'], ['webfetch', 'web'],
]);

/** Group of a tool name: 'read' | 'write' | 'shell' | 'web' | 'other'. Not a string or unknown = 'other'. */
export function toolGroup(tool) {
  if (typeof tool !== 'string') return 'other';
  return TOOL_GROUPS.get(tool.trim().toLowerCase()) || 'other';
}

/** Beam colour (0xRRGGBB) of a tool name. */
export function beamColor(tool) {
  return BEAM_COLORS[toolGroup(tool)];
}

/* ---------- finish bursts ---------- */

// Burst colours: green when an instance completes, red when it fails.
export const BURST_COLORS = Object.freeze({ complete: 0x4ade80, error: 0xff4d4d });

/**
 * Burst to draw for a closed task (store.takeClose()), or null. COMPLETED -> 'complete' (green), ERROR -> 'error' (red).
 * `id` is the task id (the moon of that instance when it has one), null when the failure had no open task (planet only).
 * Anything else (no close, another status) draws nothing. The scene only calls it for live events (never for the replay).
 * @param {{ agent: string, id: string|null, status: string }|null} close
 * @returns {{ kind: 'complete'|'error', agent: string, id: string|null, color: number }|null}
 */
export function burstFor(close) {
  if (!close || typeof close.agent !== 'string' || !close.agent) return null;
  let kind = null;
  if (close.status === 'COMPLETED') kind = 'complete';
  else if (close.status === 'ERROR') kind = 'error';
  if (!kind) return null;
  return { kind, agent: close.agent, id: typeof close.id === 'string' && close.id ? close.id : null, color: BURST_COLORS[kind] };
}

/* ---------- limits ---------- */

export const MAX_BEAMS = 12;              // beams alive at once (the pool size in scene.js)
export const MAX_BURSTS = 6;              // bursts alive at once
export const BEAM_MIN_GAP_MS = 120;       // one actor draws at most one beam per this time
export const CALL_TIMEOUT_MS = 120000;    // a call without an end event stops counting as running after this (lost PostToolUse)
export const MAX_CALLS_PER_ACTOR = 32;    // running calls kept per actor (the oldest is dropped)
export const MAX_ACTORS = 64;             // actors kept (the oldest is dropped)
export const ACTIVITY_MAX_AGE_MS = 15000; // an activity message older than this (by its ts) is history: no beam, no state

/**
 * Index of the slot to use in a pool: the first inactive one, else (steal = true) the OLDEST active one (smallest `start`), else -1.
 * The pool never grows, so the number of live effects is capped by the pool size. Slots are { active, start, ... }.
 */
export function pickSlot(slots, steal = true) {
  let oldest = -1;
  for (let i = 0; i < slots.length; i++) {
    if (!slots[i].active) return i;
    if (oldest === -1 || slots[i].start < slots[oldest].start) oldest = i;
  }
  return steal ? oldest : -1;
}

/* ---------- thinking pulse ---------- */

const bump = (x, centre, width) => Math.exp(-(((x - centre) / width) ** 2));

/**
 * Heartbeat curve, 0..1: two soft beats ("lub-dub", the second weaker) in each period, then a rest. Pure and bounded.
 * @param {number} t       time in seconds
 * @param {number} period  length of one heartbeat in seconds (default 1.8, slow)
 */
export function heartbeat(t, period = 1.8) {
  const p = (((t % period) + period) % period) / period;
  return Math.min(1, bump(p, 0.12, 0.07) + 0.6 * bump(p, 0.34, 0.08));
}

/* ---------- activity messages ---------- */

const PHASES = new Set(['start', 'end', 'error']);

/** True when the object is a usable activity message: { agent, phase, tool } as non-empty strings with a known phase. */
export function isActivity(a) {
  return !!a && typeof a === 'object'
    && typeof a.agent === 'string' && a.agent.length > 0
    && typeof a.phase === 'string' && PHASES.has(a.phase)
    && typeof a.tool === 'string' && a.tool.length > 0;
}

/**
 * True when a 'start' message is too old to draw (by its ts). A message with an unreadable ts is treated as old. End messages
 * are always applied (they only remove a running call).
 */
export function isStale(a, nowMs, maxAgeMs = ACTIVITY_MAX_AGE_MS) {
  const t = Date.parse(a.ts);
  return Number.isNaN(t) || nowMs - t > maxAgeMs;
}

/** Short text for the agent list: "คิดอยู่", "กำลังใช้ tool: Read", or '' when idle. summary = agentActivity() result. */
export function activityLabel(summary) {
  if (!summary) return '';
  if (summary.state === 'acting') return summary.tool ? `กำลังใช้ tool: ${summary.tool}` : 'กำลังใช้ tool';
  if (summary.state === 'thinking') return 'คิดอยู่';
  return '';
}

/* ---------- the tracker ---------- */

/**
 * Tracker of running tool calls per actor, and the thinking / acting state derived from them.
 * options: now (() => ms, tests pass a fake clock), callTimeoutMs, maxCalls, maxActors, beamGapMs.
 * Returns { ingest, instanceActivity, agentActivity, release, clear, size }.
 */
export function createActivityTracker(options = {}) {
  const cfg = {
    callTimeoutMs: CALL_TIMEOUT_MS, maxCalls: MAX_CALLS_PER_ACTOR, maxActors: MAX_ACTORS, beamGapMs: BEAM_MIN_GAP_MS, ...options,
  };
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const actors = new Map();   // key -> { agent, instance, calls: Map(callId -> { tool, atMs }), lastBeamMs, seq }
  let anon = 0;               // counter for calls that have no callId

  const keyOf = (agent, instance) => `${agent}\n${instance || ''}`;

  function actorFor(agent, instance, create) {
    const key = keyOf(agent, instance);
    let actor = actors.get(key);
    if (!actor && create) {
      actor = { agent, instance: instance || null, calls: new Map(), lastBeamMs: -Infinity, seq: 0 };
      actors.set(key, actor);
      while (actors.size > cfg.maxActors) actors.delete(actors.keys().next().value);   // bounded: the oldest actor goes
    }
    return actor || null;
  }

  /** Drop the calls of an actor that are older than the call timeout (a lost end event must not keep it acting). */
  function expire(actor, nowMs) {
    actor.calls.forEach((call, id) => {
      if (nowMs - call.atMs > cfg.callTimeoutMs) actor.calls.delete(id);
    });
  }

  /** Remove the call `callId` of this agent from whichever actor holds it (the instance link may have changed). */
  function removeById(agent, callId) {
    for (const actor of actors.values()) {
      if (actor.agent === agent && actor.calls.delete(callId)) return true;
    }
    return false;
  }

  /** End without a callId: remove the oldest call of the actor with the same tool name, else its oldest call. */
  function removeByTool(actor, tool) {
    let hit = null;
    for (const [id, call] of actor.calls) {
      if (call.tool === tool) { hit = id; break; }
    }
    if (hit === null && actor.calls.size > 0) hit = actor.calls.keys().next().value;
    if (hit !== null) actor.calls.delete(hit);
  }

  /**
   * Apply one activity message.
   *   start        a call begins; the actor is acting from now on
   *   end          the call ends; the actor is thinking again when no other call of it runs
   *   error        the same, plus a red failure beam ({ ..., group: 'error', failed: true }); not rate-limited by the beam gap
   *                (failures are rare, and the pool reuses its oldest slot anyway)
   * Returns { beam } where beam is the beam to draw for a 'start' or 'error' ({ agent, instance, tool, group, color, seq }), else null.
   * `seq` counts the beams of the actor (the scene fans them out by it). A start inside the BEAM_MIN_GAP_MS of the previous
   * beam of the same actor still counts as a running call but draws no beam. Invalid messages are ignored (beam null).
   * @param {object} act  { agent, phase, tool, callId?, instance? }
   * @param {number} [nowMs]  receive time (default: the clock)
   */
  function ingest(act, nowMs = clock()) {
    if (!isActivity(act)) return { beam: null };
    const instance = typeof act.instance === 'string' && act.instance ? act.instance : null;
    const callId = typeof act.callId === 'string' && act.callId ? act.callId : null;

    if (act.phase === 'start') {
      const actor = actorFor(act.agent, instance, true);
      expire(actor, nowMs);
      actor.calls.set(callId || `anon-${anon++}`, { tool: act.tool, atMs: nowMs });
      while (actor.calls.size > cfg.maxCalls) actor.calls.delete(actor.calls.keys().next().value);
      if (nowMs - actor.lastBeamMs < cfg.beamGapMs) return { beam: null };
      actor.lastBeamMs = nowMs;
      const group = toolGroup(act.tool);
      return { beam: { agent: act.agent, instance, tool: act.tool, group, color: BEAM_COLORS[group], seq: actor.seq++ } };
    }

    // end / error: by call id (any actor of the agent), else the oldest matching call of the actor the message names
    if (!(callId && removeById(act.agent, callId))) {
      const actor = actorFor(act.agent, instance, false) || actorFor(act.agent, null, false);
      if (actor) removeByTool(actor, act.tool);
    }
    if (act.phase !== 'error') return { beam: null };
    // Failed call: a red beam from the actor the message names (created when unknown, so the beam still has a source and a seq)
    const source = actorFor(act.agent, instance, true);
    source.lastBeamMs = nowMs;
    return {
      beam: {
        agent: act.agent, instance, tool: act.tool, group: 'error', color: FAILURE_BEAM_COLOR, failed: true, seq: source.seq++,
      },
    };
  }

  /**
   * Activity of ONE instance (a moon, or the only instance of a planet): acting when a call of it runs, else thinking.
   * The caller only asks for live instances. Returns { state: 'acting'|'thinking', tool } (tool = the newest running tool or null).
   */
  function instanceActivity(agent, instance, nowMs = clock()) {
    const actor = actorFor(agent, instance, false);
    if (actor) expire(actor, nowMs);
    return summarize(actor);
  }

  /** { state, tool } of one actor (null actor = no calls = thinking). */
  function summarize(actor) {
    if (actor && actor.calls.size > 0) {
      let tool = null;
      actor.calls.forEach((call) => { tool = call.tool; });   // the newest call is the last one inserted
      return { state: 'acting', tool };
    }
    return { state: 'thinking', tool: null };
  }

  /**
   * Activity of a planet (agent type): see the state machine in the header.
   *   state     'acting' | 'thinking' | 'idle'
   *   tool      newest running tool name (acting only), else null
   *   thinking  number of live instances that are thinking (the planet pulses when > 0)
   *   acting    number of actors that are acting
   * A call without an instance cannot say which instance made it: it is counted as one actor, and it takes one thinking
   * instance with it (with a single live instance that instance is the one acting).
   * @param {string} agent
   * @param {string[]} liveIds  task ids of the live instances of the agent (store.instanceState(agent).live)
   * @returns {{ state: string, tool: string|null, thinking: number, acting: number }}
   */
  function agentActivity(agent, liveIds, nowMs = clock()) {
    let thinking = 0;
    let acting = 0;
    let tool = null;
    let newest = -Infinity;
    for (const id of liveIds) {
      const actor = actorFor(agent, id, false);
      if (actor) expire(actor, nowMs);
      const s = summarize(actor);
      if (s.state === 'acting') {
        acting += 1;
        const at = lastAt(actor);
        if (at >= newest) { newest = at; tool = s.tool; }
      } else {
        thinking += 1;
      }
    }
    const planet = actorFor(agent, null, false);
    if (planet) expire(planet, nowMs);
    if (planet && planet.calls.size > 0) {
      acting += 1;
      thinking = Math.max(0, thinking - 1);
      const at = lastAt(planet);
      if (at >= newest) { newest = at; tool = summarize(planet).tool; }
    }
    const state = acting > 0 ? 'acting' : (thinking > 0 ? 'thinking' : 'idle');
    return { state, tool: acting > 0 ? tool : null, thinking, acting };
  }

  /** Start time of the newest call of an actor. */
  function lastAt(actor) {
    let at = -Infinity;
    actor.calls.forEach((call) => { if (call.atMs > at) at = call.atMs; });
    return at;
  }

  /** Forget an actor (an instance that finished). instance null = the planet-level actor. */
  function release(agent, instance) {
    actors.delete(keyOf(agent, instance));
  }

  /** Forget everything (the "ล้างหน้าจอ" button and page load). */
  function clear() {
    actors.clear();
  }

  return { ingest, instanceActivity, agentActivity, release, clear, size: () => actors.size };
}
