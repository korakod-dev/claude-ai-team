/**
 * stellar/moons.js - Pure rules of the "moons" of a planet: one small moon per CONCURRENT instance of the same agent.
 * No DOM, no THREE. Used by stellar/store.js (which instances are live), scene.js (what to draw) and the tests.
 *
 * What a moon means (owner-approved spec):
 *   1 running instance      no moon; the planet shows its status as always
 *   2 or more instances     one moon per instance orbits the planet
 *   instance finished       its moon disappears (the store closes the task by id, or by FIFO when the end event has no id)
 *   missed end event        a moon disappears by itself after MOON_TIMEOUT_MS (the task is still "open" in the store)
 *   more than MAX_MOONS     MAX_MOONS moons are drawn and a "+N" chip counts the rest
 *
 * An instance = one open task of the store = one Agent tool call (key: tool_use_id when the events carry one).
 * Moons are NOT metrics: they show instances that the event stream really reports. Nothing is invented.
 */

// A moon (instance) older than this is treated as a missed end event and removed. Measured on data/events.jsonl
// (2026-10-12, 220 sub-agent runs, PreToolUse -> SubagentStop): p50 52 s, p90 6.4 min, p95 12.1 min, max 28.4 min.
// 10 minutes covers about 94 % of the runs (15 min: 97 %) and is well below the 30 min `staleMs` of the store. A longer run loses its moon
// (it stays in the open-task list of the HUD, and the planet stays active until staleMs). A longer timeout would
// keep a ghost moon longer when an end event is missed.
export const MOON_TIMEOUT_MS = 10 * 60 * 1000;

// At most this many moons are drawn per planet; the rest is counted in the "+N" chip.
export const MAX_MOONS = 4;

// Moons appear from this many live instances on (a single instance has no moon).
export const MIN_INSTANCES_FOR_MOONS = 2;

/**
 * Which tasks are LIVE instances: open and not older than the moon timeout.
 * tasks = snapshot.currentTasks entries ({ ageMs, ... }). The store always gives a number (it falls back to the receive time when
 * a ts cannot be parsed), so the store never produces an unknown age. A caller that passes ageMs null/undefined (no clock at all) gets
 * that task counted as live: the pure rule cannot time out what it cannot date.
 * Pure; returns a new array in the same (oldest first) order.
 */
export function liveInstances(tasks, timeoutMs = MOON_TIMEOUT_MS) {
  return tasks.filter((t) => t.ageMs === null || t.ageMs === undefined || t.ageMs <= timeoutMs);
}

/**
 * What to draw for a planet. `live` = liveInstances() result (oldest first).
 *   fewer than MIN_INSTANCES_FOR_MOONS  -> { shown: [], extra: 0, total: live.length }
 *   otherwise                           -> the OLDEST maxMoons instances are drawn, so a moon keeps its place when a newer
 *                                          instance starts; extra = the number of newer ones, shown as "+N".
 */
export function moonView(live, maxMoons = MAX_MOONS) {
  if (live.length < MIN_INSTANCES_FOR_MOONS) return { shown: [], extra: 0, total: live.length };
  const shown = live.slice(0, maxMoons);
  return { shown, extra: live.length - shown.length, total: live.length };
}

/**
 * Even start angles (radians) of n moons on their orbit, rotated by `phase`. Moons never share an angle, so two moons of one
 * planet are always at least 2*pi/MAX_MOONS apart on the orbit (the orbit is wide enough for that: see scene.js MOON_ORBIT).
 */
export function moonAngle(index, count, phase = 0) {
  return phase + (index / Math.max(1, count)) * Math.PI * 2;
}

/**
 * Hover text of one moon: what the instance is doing. Task text when there is one, else a neutral line; plus its age.
 * text = the task text (the dispatch message of the event), ageMs = how long it runs (null = unknown).
 */
export function moonTip(task) {
  const what = typeof task.text === 'string' && task.text.trim() ? task.text.trim() : 'running (no task text)';
  if (task.ageMs === null || task.ageMs === undefined) return what;
  const s = Math.floor(task.ageMs / 1000);
  const age = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${what} (${age})`;
}
