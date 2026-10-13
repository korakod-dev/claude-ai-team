'use strict';
/**
 * lib/stop-hold.js
 * Bounded hold for SubagentStop events of SYNC sub-agent runs (used by lib/workspace.js).
 *
 * Why: in a sync run Claude Code sends SubagentStop BEFORE PostToolUse(Agent). The PostToolUse carries the
 * tool_use_id and tool_response.agentId (stored as agent_ref, equal to SubagentStop.agent_id). So a stop can be
 * closed by its exact id only if it waits for that PostToolUse. Async runs never need this (their PostToolUse
 * comes first and the id is already linked).
 *
 * Rules:
 *   hold(event, agentRef, eventTimeMs)  keep the event for at most `waitMs`.
 *   resolve(agentRef, toolUseId)        a PostToolUse with that agent_ref arrived: release every held event with
 *                                       that agentRef WITH the id (exact pairing).
 *   expireDue(nowMs)                    release every held event whose wait is over (dueMs <= nowMs) WITHOUT an id.
 *                                       The store then matches it by FIFO and marks it approximate (`~`).
 *                                       If shouldRelease(event) returns false, the event is DROPPED instead
 *                                       (nothing is sent).
 *   failed(agentId, eventTimeMs, agentRef?)
 *                                       a PostToolUseFailure(Agent) of that sub-agent arrived. Its ERROR event closes the
 *                                       task itself, so the stop of the same run must not close (or flip) anything.
 *                                       PER INSTANCE when the caller knows the agent_ref of the failed run (lib/workspace.js
 *                                       binds tool_use_id -> agent_ref from SubagentStart / PostToolUse):
 *                                       - the held stop with THAT agentRef is DROPPED, other stops of the same agent type
 *                                         (parallel runs) are left alone;
 *                                       - if it is not held yet, a marker for THAT agentRef is kept for `waitMs`.
 *                                       WITHOUT an agentRef (the log has no SubagentStart, or the binding is only a guess) it
 *                                       falls back to the agent TYPE. A type match is a HINT, never proof: the stop may belong to
 *                                       a sibling that really succeeded. So the stop is not dropped outright, it is held as
 *                                       SUSPECT: an exact PostToolUse(agent_ref) releases it WITH its id (a failed run never gets
 *                                       PostToolUse(Agent), a successful one does), and if none arrives within `waitMs` it is
 *                                       DROPPED (never released without an id, that would FIFO-close a wrong task).
 *                                       failed() marks the oldest held stop of that agent as suspect, or keeps a type marker.
 *                                       A type marker lives `typeMarkerMs` (default = waitMs; the hub passes a longer value) so
 *                                       the late stop of the failed run is still caught; since a caught stop is only held for
 *                                       confirmation, a long marker costs a sibling at most a delay, not a lost close.
 *   consumeFailure(agentId, eventTimeMs, agentRef?)
 *                                       the marker is used up and the result says what the caller must do with the sync stop:
 *                                       'instance' = per-instance marker (exact agent_ref match): drop the stop;
 *                                       'type'     = type marker (a hint only): hold the stop with hold(..., { suspect: true });
 *                                       false      = no live marker: hold it normally.
 *                                       RESTORE: a type marker is a hint, so when an exact PostToolUse(agent_ref) confirms a suspect stop
 *                                       (it was a successful sibling, not the failed run), the marker that made it suspect is put back
 *                                       with its ORIGINAL untilMs. The real failed run's stop may still come, and it must find the
 *                                       marker (else it would be released as a FIFO `~` close of a wrong task).
 *                                       If a non-suspect stop of that agent is ALREADY held (it was held before the failure, so the marker
 *                                       can not catch it), the oldest such stop becomes the suspect and takes the marker instead
 *                                       (so the failed run's own stop is not released as a FIFO `~` close of a newer task).
 *   LATE POST: a suspect stop that was dropped (no Post within `waitMs`) is remembered for `lateMs` after its wait ended
 *                                       (bounded by `lateCap`, oldest dropped). An exact PostToolUse(agent_ref) that arrives later still
 *                                       releases that stop WITH its id (release(event, { late: true })), once. A failed run never
 *                                       gets such a Post, so the id is exact. A Post that finds a held stop of the same agent_ref
 *                                       resolves that one and clears the memory of the ref (never two completions for one id).
 *   Each held event has at most one timer. The timer is cleared on every release or drop, and clear() drops them all,
 *   so no timer outlives its event.
 *   Held events do not block other events: the caller keeps emitting the others in their own order. Only the
 *   held event itself is released later than its arrival position.
 *
 * Time: the wait is measured in EVENT time (the record `ts`) when the caller passes it to expireDue(), so reading
 * the history file in one batch gives the same result as reading it live. The timer covers the live case where no
 * later record arrives. Clock and timers are injected, so the tests use a fake clock.
 */

/**
 * @param {object} opts
 * @param {(event: object, info?: { late?: boolean }) => void} opts.release  called once for every released event, in release
 *                                                order. info.late = true: released by a Post that came after the wait (see LATE POST).
 * @param {number} opts.waitMs                    how long a held event may wait (named constant in lib/workspace.js)
 * @param {() => number} [opts.now]               wall clock in ms (default Date.now); used when a record has no ts
 * @param {Function} [opts.setTimer]              default setTimeout
 * @param {Function} [opts.clearTimer]            default clearTimeout
 * @param {number} [opts.typeMarkerMs]            life of a failure marker WITHOUT an agentRef (type marker). Default: waitMs.
 *                                                Per-instance markers always live waitMs.
 * @param {(event: object) => boolean} [opts.shouldRelease]  asked when a wait ends without an id. false = drop the
 *                                                event (the caller knows it was superseded). Default: always release.
 * @param {number} [opts.lateMs]                  how long after the end of its wait a dropped suspect stop still accepts a late Post
 *                                                (event time). Default 60000. 0 disables the late release.
 * @param {number} [opts.lateCap]                 max number of remembered dropped suspect stops. Default 32.
 * @returns {{ hold, resolve, expireDue, failed, consumeFailure, clear, size, failureMarkers, lateMemory }}
 */
function createStopHold({
  release, waitMs, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, shouldRelease = () => true,
  typeMarkerMs = waitMs, lateMs = 60000, lateCap = 32,
}) {
  // Held entries in arrival order: { event, agentRef, dueMs, timer, suspect }
  // suspect = true: the stop matched a failure by agent TYPE only. It is released only by an exact id, else dropped.
  const held = [];
  // Failure markers: a failed Agent run whose stop may still come, live until untilMs.
  // { agentId, agentRef (string for a per-instance marker, null for a type marker), untilMs }
  const failures = [];
  // Dropped suspect stops that may still get a late exact Post: { event, agentRef, untilMs, marker }. Oldest first, bounded.
  const dropped = [];
  // The marker used up by the last consumeFailure() call. hold(..., { suspect: true }) takes it, so that a confirmed suspect
  // can give it back. The caller (lib/workspace.js) calls hold() right after consumeFailure().
  let lastConsumed = null;

  /** Remove one entry from the list and cancel its timer (if any). Nothing is released. */
  function drop(entry) {
    const i = held.indexOf(entry);
    if (i !== -1) held.splice(i, 1);
    if (entry.timer !== null) {
      clearTimer(entry.timer);
      entry.timer = null;
    }
  }

  /** Remove an entry and release its event, with the id when one is given. */
  function finish(entry, toolUseId) {
    drop(entry);
    if (toolUseId) entry.event.toolUseId = toolUseId;
    release(entry.event);
  }

  /**
   * The wait of an entry ended without an id: release it, or drop it when the caller says it was superseded.
   * A suspect entry (matched a failure by type, never confirmed by a PostToolUse) is always dropped.
   */
  function expire(entry) {
    if (!entry.suspect && shouldRelease(entry.event)) {
      finish(entry, null);
      return;
    }
    drop(entry);
    // A dropped SUSPECT stop may still be the stop of a successful run whose Post is late: remember it for a while
    if (entry.suspect && lateMs > 0) {
      dropped.push({ event: entry.event, agentRef: entry.agentRef, untilMs: entry.dueMs + lateMs, marker: entry.marker });
      while (dropped.length > lateCap) dropped.shift();
    }
  }

  /**
   * Give back the type marker a confirmed suspect had used up (same untilMs). Once per entry.
   * If a NON-suspect held stop of the same agent type already exists, that stop could be the stop of the failed run (it was held
   * before the failure arrived, so the marker cannot catch it any more). Then the marker is not pushed back into `failures`
   * (it only catches FUTURE stops): the oldest such stop becomes SUSPECT and takes the marker (an exact Post releases it with its
   * id, the end of its wait drops it). Bounded: a stop turns suspect at most once and only suspects hand markers on, so the
   * chain is at most as long as the number of held stops. Otherwise the marker goes back to `failures` as before.
   * @param {object|null} marker   the type marker to give back
   * @param {number} at            event time of the confirming Post (an expired marker is not handed to a held stop)
   * @param {string} exceptRef     agentRef just confirmed (its own entries are being released, never hand the marker to them)
   */
  function restoreMarker(marker, at, exceptRef) {
    if (!marker) return;
    if (at <= marker.untilMs) {
      const next = held.find((e) => !e.suspect && e.agentRef !== exceptRef && e.event.agent === marker.agentId);
      if (next) {
        next.suspect = true;
        next.marker = marker;
        return;
      }
    }
    failures.push(marker);
  }

  /** Event time in ms, or the wall clock when the caller gave none. */
  function timeOf(eventTimeMs) {
    return Number.isFinite(eventTimeMs) ? eventTimeMs : now();
  }

  /**
   * Keep one event until its PostToolUse arrives or its wait is over.
   * @param {object} event        the converted workspace event (COMPLETED, no toolUseId yet)
   * @param {string} agentRef     SubagentStop.agent_id (matched against PostToolUse.agent_ref)
   * @param {number} [eventTimeMs] the record's ts in ms (NaN or undefined -> the wall clock is used)
   * @param {{ suspect?: boolean }} [opts] suspect = the stop matched a failure by type: only an exact id releases it, else dropped
   */
  function hold(event, agentRef, eventTimeMs, opts) {
    const base = timeOf(eventTimeMs);
    const suspect = !!(opts && opts.suspect);
    // marker = the type marker this suspect used up (taken from consumeFailure), given back if an exact Post confirms the stop
    const entry = { event, agentRef, dueMs: base + waitMs, timer: null, suspect, marker: suspect ? lastConsumed : null };
    lastConsumed = null;
    held.push(entry);
    // Live case: no later record may arrive, so the timer releases the event itself after waitMs.
    const timer = setTimer(() => {
      entry.timer = null;
      expire(entry);
    }, waitMs);
    // Do not keep the process alive for this timer alone (the HTTP server holds it open anyway).
    if (timer && typeof timer.unref === 'function') timer.unref();
    entry.timer = timer;
  }

  /**
   * A PostToolUse(Agent) arrived with agent_ref and tool_use_id: release the matching held events with the id.
   * If none is held, a recently dropped suspect stop of that agent_ref is released late (see LATE POST).
   * @param {number} [eventTimeMs] the Post's ts in ms (the wall clock when missing); ends the memory of dropped stops
   */
  function resolve(agentRef, toolUseId, eventTimeMs) {
    if (!agentRef || !toolUseId) return;
    const at = timeOf(eventTimeMs);
    let matched = false;
    for (const entry of held.slice()) {
      if (entry.agentRef !== agentRef) continue;
      matched = true;
      // The exact Post proves this stop is a real success: the type marker only hinted wrongly, so give it back
      if (entry.suspect) restoreMarker(entry.marker, at, agentRef);
      finish(entry, toolUseId);
    }
    // Remembered dropped stops of this ref: forget them all (the memory must never release a second time),
    // and release the newest one WITH the id only when no held stop already took this Post.
    const late = [];
    for (let i = dropped.length - 1; i >= 0; i -= 1) {
      if (dropped[i].agentRef !== agentRef) continue;
      const [d] = dropped.splice(i, 1);
      if (d.untilMs >= at) late.push(d);
    }
    if (matched || late.length === 0) return;
    const d = late[0];   // newest first
    restoreMarker(d.marker, at, agentRef);
    d.event.toolUseId = toolUseId;
    release(d.event, { late: true });
  }

  /** Release (or drop, see shouldRelease) every held event whose wait is over at event time nowMs, without an id. */
  function expireDue(nowMs) {
    if (!Number.isFinite(nowMs)) return;
    for (const entry of held.slice()) {
      if (entry.dueMs <= nowMs) expire(entry);
    }
    // Failure markers whose wait is over can no longer match a stop
    for (let i = failures.length - 1; i >= 0; i -= 1) {
      if (failures[i].untilMs < nowMs) failures.splice(i, 1);
    }
    // Dropped suspect stops that can no longer get a late Post
    for (let i = dropped.length - 1; i >= 0; i -= 1) {
      if (dropped[i].untilMs < nowMs) dropped.splice(i, 1);
    }
  }

  /**
   * A PostToolUseFailure(Agent) of sub-agent agentId arrived. The failure's ERROR closes the task, so the stop of the failed
   * run must not close anything. Returns 'dropped', 'suspect', 'marked' or 'none'.
   * Pairing: with `agentRef` (the agent_id of the failed run) the match is per instance: that held stop is dropped, a parallel
   * run of the same agent type keeps its stop ('dropped'), or a per-instance marker is kept ('marked').
   * Without it the match is by sub-agent type only (a hint): the oldest held stop of that agent is marked SUSPECT ('suspect':
   * it stays held; an exact PostToolUse releases it, the end of its wait drops it), or a type marker is kept ('marked').
   */
  function failed(agentId, eventTimeMs, agentRef) {
    if (!agentId) return 'none';
    const at = timeOf(eventTimeMs);
    const ref = typeof agentRef === 'string' && agentRef ? agentRef : null;
    const entry = held.find((e) => (ref ? e.agentRef === ref : e.event.agent === agentId && !e.suspect));
    if (entry && ref) {
      drop(entry);
      return 'dropped';
    }
    const untilMs = at + (ref ? waitMs : Math.max(waitMs, typeMarkerMs));
    if (entry) {
      entry.suspect = true;
      // Remember the hint as a marker: if an exact Post proves this stop was a sibling's, the failed run's own stop is still to come
      entry.marker = { agentId, agentRef: null, untilMs };
      return 'suspect';
    }
    failures.push({ agentId, agentRef: ref, untilMs });
    return 'marked';
  }

  /**
   * Does a sync stop of agentId (agent_id = agentRef), at event time eventTimeMs, match a live failure marker?
   * Returns 'instance' (per-instance marker: matches only the stop with its agentRef, the caller drops the stop), 'type'
   * (type marker: matches any stop of the agent, only a hint, the caller holds the stop as suspect) or false.
   * The marker is used up by the match, so one failure affects at most one stop.
   */
  function consumeFailure(agentId, eventTimeMs, agentRef) {
    const at = timeOf(eventTimeMs);
    const i = failures.findIndex((f) => f.agentId === agentId && at <= f.untilMs
      && (f.agentRef === null || f.agentRef === agentRef));
    if (i === -1) return false;
    const kind = failures[i].agentRef === null ? 'type' : 'instance';
    lastConsumed = kind === 'type' ? failures[i] : null;   // hold(..., { suspect: true }) keeps it for a possible restore
    failures.splice(i, 1);
    return kind;
  }

  /** Drop every held event, every failure marker and every remembered dropped stop, cancelling all timers (file reset, hub close). Nothing is released. */
  function clear() {
    for (const entry of held.splice(0)) {
      if (entry.timer !== null) {
        clearTimer(entry.timer);
        entry.timer = null;
      }
    }
    failures.length = 0;
    dropped.length = 0;
    lastConsumed = null;
  }

  /** Number of events currently held (tests and diagnostics). */
  function size() {
    return held.length;
  }

  /** Number of live failure markers (tests and diagnostics). */
  function failureMarkers() {
    return failures.length;
  }

  /** Number of remembered dropped suspect stops (tests and diagnostics). */
  function lateMemory() {
    return dropped.length;
  }

  return { hold, resolve, expireDue, failed, consumeFailure, clear, size, failureMarkers, lateMemory };
}

module.exports = { createStopHold };
