'use strict';
/**
 * test/helpers/fake-clock.js
 * A tiny fake clock for timer-based code (lib/stop-hold.js, lib/workspace.js `timing` option).
 *
 *   fakeClock()            returns { now, setTimer, clearTimer, advance, pending }
 *     now()                current fake time in ms (starts at 0)
 *     setTimer(fn, ms)     queues fn to run at now + ms. Returns a handle with unref() (like a Node Timeout)
 *     clearTimer(handle)   cancels a queued timer (ignores unknown handles)
 *     advance(ms)          moves the time forward and runs every timer that is due, in due-time order
 *     pending()            number of timers still queued (a leak check: it must be 0 after the code cleaned up)
 *
 * No real timers are created, so a test that uses it cannot leave a timer behind.
 */

/** Create a fake clock at time 0 with no timers. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { due, fn }
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { due: now + ms, fn });
      return { id, unref() {} };
    },
    clearTimer(handle) {
      if (handle) timers.delete(handle.id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        // The earliest timer that is due by the target time runs first, at its own due time
        let best = null;
        for (const [id, t] of timers) {
          if (t.due <= target && (best === null || t.due < best.t.due)) best = { id, t };
        }
        if (!best) break;
        now = best.t.due;
        timers.delete(best.id);
        best.t.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

module.exports = { fakeClock };
