'use strict';
/**
 * stop-hold.test.js - unit tests of lib/stop-hold.js with a FAKE clock (no real timers, no files):
 *   - resolve() releases the held event WITH the id, and cancels its timer (no timer left)
 *   - the timer releases the event WITHOUT an id after exactly waitMs (not earlier)
 *   - expireDue(eventTime) releases the events whose wait is over, in event time, without an id
 *   - only the matching agentRef is released by resolve()
 *   - clear() cancels every timer and releases nothing
 *   - every timer is cleared on release: no timer outlives its event
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createStopHold } = require('../lib/stop-hold');
const { fakeClock } = require('./helpers/fake-clock');

/** Build a hold with a fake clock and a list that records what was released. */
function setup(waitMs = 8000) {
  const clock = fakeClock();
  const released = [];
  const hold = createStopHold({
    release: (ev) => released.push({ ...ev }),
    waitMs,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, released, hold };
}

const stop = (msg) => ({ ts: '2026-10-12T10:00:00.000Z', agent: 'app-dev', status: 'COMPLETED', message: msg });

test('resolve() releases the event with the id and leaves no timer behind', () => {
  const { clock, released, hold } = setup();
  hold.hold(stop('A done'), 'agA', 0);
  assert.equal(clock.pending(), 1, 'one timer for the held event');
  assert.equal(hold.size(), 1);
  hold.resolve('agA', 'toolu_A');
  assert.equal(released.length, 1);
  assert.equal(released[0].toolUseId, 'toolu_A', 'released with the exact id');
  assert.equal(clock.pending(), 0, 'the timer is cancelled on release');
  assert.equal(hold.size(), 0);
  clock.advance(60000);
  assert.equal(released.length, 1, 'the cancelled timer does not release a second time');
});

test('resolve() only releases events of the same agent_ref', () => {
  const { released, hold } = setup();
  hold.hold(stop('A done'), 'agA', 0);
  hold.hold(stop('B done'), 'agB', 0);
  hold.resolve('agB', 'toolu_B');
  assert.deepEqual(released.map((e) => e.message), ['B done']);
  assert.equal(released[0].toolUseId, 'toolu_B');
  assert.equal(hold.size(), 1, 'A is still held');
});

test('the timer releases without an id after exactly waitMs (not earlier)', () => {
  const { clock, released, hold } = setup(8000);
  hold.hold(stop('late'), 'agX', 0);
  clock.advance(7999);
  assert.equal(released.length, 0, 'still held one millisecond before the wait ends');
  clock.advance(1);
  assert.equal(released.length, 1, 'released at the end of the wait');
  assert.equal('toolUseId' in released[0], false, 'no id: the store matches it by FIFO (approximate)');
  assert.equal(clock.pending(), 0);
});

test('a late PostToolUse after the timeout does not add an id to the released event', () => {
  const { clock, released, hold } = setup(1000);
  hold.hold(stop('late'), 'agX', 0);
  clock.advance(1000);
  hold.resolve('agX', 'toolu_LATE');
  assert.equal(released.length, 1);
  assert.equal('toolUseId' in released[0], false);
});

test('expireDue() uses event time: events whose wait ended are released without an id, the others stay', () => {
  const { clock, released, hold } = setup(8000);
  hold.hold(stop('old'), 'agOld', 1000);      // due at 9000
  hold.hold(stop('newer'), 'agNew', 5000);    // due at 13000
  hold.expireDue(8999);
  assert.equal(released.length, 0);
  hold.expireDue(9000);
  assert.deepEqual(released.map((e) => e.message), ['old']);
  assert.equal('toolUseId' in released[0], false);
  assert.equal(hold.size(), 1);
  hold.expireDue(13000);
  assert.deepEqual(released.map((e) => e.message), ['old', 'newer']);
  assert.equal(clock.pending(), 0, 'every timer was cancelled by the expiry');
});

test('without an event time, the wall clock is used for the due time', () => {
  const { clock, released, hold } = setup(8000);
  clock.advance(500);                          // the fake wall clock is at 500 ms
  hold.hold(stop('no ts'), 'agZ');             // no event time given
  hold.expireDue(8499);
  assert.equal(released.length, 0, 'due at 8500 = 500 + 8000');
  hold.expireDue(8500);
  assert.equal(released.length, 1);
});

test('expireDue() ignores a non-finite time (no release, no error)', () => {
  const { released, hold } = setup();
  hold.hold(stop('x'), 'agX', 0);
  hold.expireDue(NaN);
  hold.expireDue(undefined);
  assert.equal(released.length, 0);
  assert.equal(hold.size(), 1);
});

test('several held events of one agent_ref are all released by one PostToolUse', () => {
  const { clock, released, hold } = setup();
  hold.hold(stop('first'), 'agSame', 0);
  hold.hold(stop('second'), 'agSame', 0);
  hold.resolve('agSame', 'toolu_S');
  assert.equal(released.length, 2);
  assert.ok(released.every((e) => e.toolUseId === 'toolu_S'));
  assert.equal(clock.pending(), 0);
});

test('clear() cancels every timer and releases nothing', () => {
  const { clock, released, hold } = setup();
  hold.hold(stop('a'), 'agA', 0);
  hold.hold(stop('b'), 'agB', 0);
  hold.clear();
  assert.equal(hold.size(), 0);
  assert.equal(clock.pending(), 0, 'no timer left after clear()');
  clock.advance(60000);
  assert.equal(released.length, 0, 'clear() drops the events, it does not release them');
});

test('released events keep their arrival order when several are due together', () => {
  const { released, hold } = setup(8000);
  hold.hold(stop('one'), 'a1', 0);
  hold.hold(stop('two'), 'a2', 0);
  hold.hold(stop('three'), 'a3', 0);
  hold.expireDue(8000);
  assert.deepEqual(released.map((e) => e.message), ['one', 'two', 'three']);
});

test('the timer handle is unref()-ed so a pending wait does not keep the process alive', () => {
  let unrefCalls = 0;
  const hold = createStopHold({
    release: () => {},
    waitMs: 100,
    setTimer: () => ({ unref() { unrefCalls += 1; } }),
    clearTimer: () => {},
  });
  hold.hold(stop('x'), 'agX', 0);
  assert.equal(unrefCalls, 1);
});

// ---------- failure rules (failed / consumeFailure) and shouldRelease ----------

test('failed() (type rule) marks the oldest held stop of that agent SUSPECT: it stays held, is dropped at the end of its wait, never released', () => {
  const { clock, released, hold } = setup(8000);
  const first = stop('first');
  const second = stop('second');
  const other = { ...stop('other'), agent: 'qa-reviewer' };
  hold.hold(first, 'agA', 0);
  hold.hold(second, 'agB', 0);
  hold.hold(other, 'agQ', 0);
  assert.equal(hold.failed('app-dev', 0), 'suspect', 'the oldest held stop of app-dev becomes suspect');
  assert.equal(hold.size(), 3, 'nothing is dropped yet (a type match is only a hint)');
  assert.equal(hold.failureMarkers(), 0, 'no marker when a stop was held');
  clock.advance(8000);
  assert.deepEqual(released.map((e) => e.message), ['second', 'other'], 'the suspect stop is dropped at its timeout, never released');
  assert.equal(hold.size(), 0);
  assert.equal(clock.pending(), 0);
});

test('a suspect stop is released WITH its id by an exact resolve() (a successful sibling), and a second failure marks the next one', () => {
  const { clock, released, hold } = setup(8000);
  hold.hold(stop('first'), 'agA', 0);
  hold.hold(stop('second'), 'agB', 0);
  assert.equal(hold.failed('app-dev', 0), 'suspect');
  assert.equal(hold.failed('app-dev', 0), 'suspect', 'the already suspect stop is skipped');
  hold.resolve('agA', 'toolu_A');
  assert.equal(released.length, 1);
  assert.equal(released[0].toolUseId, 'toolu_A', 'released with the exact id');
  clock.advance(8000);
  assert.equal(released.length, 1, 'the other suspect stop is dropped');
  assert.equal(clock.pending(), 0);
});

test('hold(..., { suspect: true }) releases only by id; expireDue() drops it at its due time', () => {
  const { clock, released, hold } = setup(8000);
  hold.hold(stop('s1'), 'agS1', 0, { suspect: true });
  hold.hold(stop('s2'), 'agS2', 0, { suspect: true });
  hold.resolve('agS1', 'toolu_S1');
  hold.expireDue(8000);
  assert.deepEqual(released.map((e) => `${e.message}:${e.toolUseId}`), ['s1:toolu_S1']);
  assert.equal(hold.size(), 0);
  assert.equal(clock.pending(), 0);
});

test('failed() with no held stop keeps a failure marker; consumeFailure() uses it once, inside the wait', () => {
  const { released, hold } = setup(8000);
  assert.equal(hold.failed('app-dev', 1000), 'marked');
  assert.equal(hold.failureMarkers(), 1);
  assert.equal(hold.consumeFailure('qa-reviewer', 2000), false, 'a marker is per agent');
  assert.equal(hold.consumeFailure('app-dev', 9000), 'type', 'inside the wait (1000 + 8000): a type marker, the caller holds the stop as suspect');
  assert.equal(hold.consumeFailure('app-dev', 9000), false, 'the marker is used up by one stop');
  assert.equal(released.length, 0);
});

test('a failure marker is not used after its wait: expireDue() removes it, and consumeFailure() refuses it', () => {
  const { hold } = setup(8000);
  hold.failed('app-dev', 1000);                 // until 9000
  assert.equal(hold.consumeFailure('app-dev', 9001), false, 'too late for this marker');
  hold.failed('app-dev', 1000);
  hold.expireDue(9001);                         // a later record time prunes it
  assert.equal(hold.failureMarkers(), 0, 'the expired marker is removed');
});

test('failed() for an agent without a held stop and with no id does nothing harmful', () => {
  const { released, hold } = setup();
  assert.equal(hold.failed('', 0), 'none', 'no agent: nothing to match');
  hold.hold(stop('x'), 'agX', 0);
  assert.equal(hold.failed('someone-else', 0), 'marked', 'other agents are not dropped');
  assert.equal(hold.size(), 1);
  assert.equal(released.length, 0);
});

test('shouldRelease() false at the end of the wait: the event is dropped, nothing is released, no timer is left', () => {
  const clock = fakeClock();
  const released = [];
  const hold = createStopHold({
    release: (ev) => released.push(ev),
    waitMs: 1000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    shouldRelease: () => false,
  });
  hold.hold(stop('superseded'), 'agS', 0);
  clock.advance(1000);
  assert.equal(released.length, 0, 'not released');
  assert.equal(hold.size(), 0, 'dropped');
  assert.equal(clock.pending(), 0);
});

test('shouldRelease() is asked with the event: the caller decides per event at expiry', () => {
  const clock = fakeClock();
  const released = [];
  const hold = createStopHold({
    release: (ev) => released.push(ev.message),
    waitMs: 1000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    shouldRelease: (ev) => ev.message !== 'drop me',
  });
  hold.hold(stop('keep me'), 'a1', 0);
  hold.hold(stop('drop me'), 'a2', 0);
  clock.advance(1000);
  assert.deepEqual(released, ['keep me']);
});

test('clear() also removes the failure markers', () => {
  const { hold } = setup();
  hold.failed('app-dev', 0);
  hold.clear();
  assert.equal(hold.failureMarkers(), 0);
  assert.equal(hold.consumeFailure('app-dev', 1), false);
});

// ---------- per-instance failure rules (agentRef), for parallel runs of one agent type ----------

test('failed() with an agentRef drops only the held stop of THAT run; a sibling stop of the same agent stays', () => {
  const { clock, released, hold } = setup(8000);
  hold.hold(stop('A'), 'agA', 0);
  hold.hold(stop('B'), 'agB', 0);
  assert.equal(hold.failed('app-dev', 0, 'agB'), 'dropped', 'the stop of agB is dropped (not the oldest one)');
  assert.equal(hold.size(), 1);
  clock.advance(8000);
  assert.deepEqual(released.map((e) => e.message), ['A'], 'the stop of A is still released');
});

test('failed() with an agentRef and no held stop keeps a marker for THAT agentRef; another stop of the agent is not consumed', () => {
  const { hold } = setup(8000);
  assert.equal(hold.failed('app-dev', 1000, 'agA'), 'marked');
  assert.equal(hold.consumeFailure('app-dev', 2000, 'agB'), false, 'a sibling stop does not use the marker');
  assert.equal(hold.failureMarkers(), 1, 'the marker is still there');
  assert.equal(hold.consumeFailure('app-dev', 2000, 'agA'), 'instance', 'the stop of the failed run does (exact: the caller drops it)');
  assert.equal(hold.failureMarkers(), 0);
});

test('a type marker (no agentRef) still matches any stop of the agent, per-instance markers are not mixed into it', () => {
  const { hold } = setup(8000);
  hold.failed('app-dev', 0);                                   // legacy marker
  assert.equal(hold.consumeFailure('app-dev', 1, 'agZ'), 'type', 'matches a stop with any agent_id');
  hold.failed('app-dev', 0, 'agA');
  assert.equal(hold.consumeFailure('app-dev', 1), false, 'a call without agentRef cannot use a per-instance marker');
});

test('typeMarkerMs: a type marker (no agentRef) lives longer than waitMs, a per-instance marker still lives waitMs only', () => {
  const clock = fakeClock();
  const hold = createStopHold({
    release: () => {}, waitMs: 8000, typeMarkerMs: 60000, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  hold.failed('app-dev', 1000);                       // type marker: until 61000
  hold.failed('qa-reviewer', 1000, 'agQ');            // per-instance marker: until 9000
  assert.equal(hold.consumeFailure('qa-reviewer', 9001, 'agQ'), false, 'the per-instance marker ended at waitMs');
  assert.equal(hold.consumeFailure('app-dev', 30000, 'agX'), 'type', 'the type marker is still live after waitMs');
  assert.equal(hold.consumeFailure('app-dev', 30000, 'agX'), false, 'used up by one stop');
  hold.failed('app-dev', 1000);
  assert.equal(hold.consumeFailure('app-dev', 61001, 'agX'), false, 'but not beyond typeMarkerMs');
});

// ---------- restore of a consumed type marker, and late Post for a dropped suspect ----------

/** A hold with a type marker life of 60 s and a late-Post memory (lateMs 60 s, cap as given), on the fake clock. */
function setupLate(lateCap) {
  const clock = fakeClock();
  const released = [];
  const hold = createStopHold({
    release: (ev, info) => released.push({ ...ev, late: !!(info && info.late) }),
    waitMs: 8000,
    typeMarkerMs: 60000,
    lateMs: 60000,
    ...(lateCap ? { lateCap } : {}),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, released, hold };
}

test('restore: an exact resolve() of a suspect that consumed a type marker gives the marker back with its ORIGINAL untilMs', () => {
  const { released, hold } = setupLate();
  hold.failed('app-dev', 1000);                                  // type marker until 61000
  assert.equal(hold.consumeFailure('app-dev', 5000, 'agB'), 'type');
  assert.equal(hold.failureMarkers(), 0, 'used up');
  hold.hold(stop('B done'), 'agB', 5000, { suspect: true });
  hold.resolve('agB', 'toolu_B', 5050);                          // a real success: the marker was a wrong hint
  assert.deepEqual(released.map((e) => e.toolUseId), ['toolu_B']);
  assert.equal(hold.failureMarkers(), 1, 'the marker is back, so the stop of the real failed run is still caught');
  assert.equal(hold.consumeFailure('app-dev', 60999, 'agA'), 'type', 'the failed run stop finds it inside the original life');
  hold.failed('app-dev', 1000);
  hold.consumeFailure('app-dev', 5000, 'agB');
  hold.hold(stop('B2'), 'agB2', 5000, { suspect: true });
  hold.resolve('agB2', 'toolu_B2', 5050);
  assert.equal(hold.consumeFailure('app-dev', 61001, 'agA'), false, 'untilMs is NOT extended by the restore');
});

test('restore: the marker is given back once, and not at all when the suspect is dropped (it was the failed run)', () => {
  const { clock, released, hold } = setupLate();
  hold.failed('app-dev', 0);
  hold.consumeFailure('app-dev', 1000, 'agA');
  hold.hold(stop('A stray'), 'agA', 1000, { suspect: true });
  clock.advance(8000);                                           // dropped: nothing is restored
  assert.equal(hold.failureMarkers(), 0);
  assert.deepEqual(released, []);
  // Marker consumed by B: restored once even if resolve() is called twice
  hold.failed('app-dev', 20000);
  hold.consumeFailure('app-dev', 21000, 'agB');
  hold.hold(stop('B'), 'agB', 21000, { suspect: true });
  hold.resolve('agB', 'toolu_B', 21050);
  hold.resolve('agB', 'toolu_B', 21060);
  assert.equal(hold.failureMarkers(), 1, 'one marker back, not two');
  assert.equal(released.filter((e) => e.toolUseId === 'toolu_B').length, 1, 'released once');
});

test('restore: a suspect made by failed() on an already held stop also gives its marker back when an exact Post proves it a success', () => {
  const { released, hold } = setupLate();
  hold.hold(stop('B done'), 'agB', 1000);
  assert.equal(hold.failed('app-dev', 2000), 'suspect');
  assert.equal(hold.failureMarkers(), 0);
  hold.resolve('agB', 'toolu_B', 2100);
  assert.equal(released.length, 1);
  assert.equal(hold.failureMarkers(), 1, 'the real failed run is still to come: its stop must find a marker');
  assert.equal(hold.consumeFailure('app-dev', 3000, 'agA'), 'type');
});

test('restore: with a non-suspect stop of the same agent already held, the marker goes to THAT stop (suspect), not back to failures', () => {
  const { clock, released, hold } = setupLate();
  hold.hold(stop('B done'), 'agB', 1000);
  hold.hold(stop('A stray'), 'agA', 1100);                        // the failed run's stop, held before the failure
  assert.equal(hold.failed('app-dev', 2000), 'suspect');          // the oldest (B) is marked
  hold.resolve('agB', 'toolu_B', 2100);
  assert.deepEqual(released.map((e) => e.toolUseId), ['toolu_B']);
  assert.equal(hold.failureMarkers(), 0, 'not pushed back: it would only catch future stops');
  assert.equal(hold.size(), 1);
  clock.advance(8000);                                            // A is suspect now: dropped, never FIFO-released
  assert.deepEqual(released.map((e) => e.message), ['B done']);
  assert.equal(hold.size(), 0);
});

test('restore: a stop handed the marker is itself restorable (bounded chain), and the last one pushes the marker back', () => {
  const { clock, released, hold } = setupLate();
  hold.hold(stop('B'), 'agB', 1000);
  hold.hold(stop('C'), 'agC', 1000);
  hold.hold(stop('E'), 'agE', 1000);
  hold.failed('app-dev', 2000);                                   // B suspect with the marker
  hold.resolve('agB', 'toolu_B', 2100);                           // marker -> C
  hold.resolve('agC', 'toolu_C', 2200);                           // marker -> E
  assert.equal(hold.failureMarkers(), 0);
  hold.resolve('agE', 'toolu_E', 2300);                           // nothing left to hand it to: back to failures
  assert.deepEqual(released.map((e) => e.toolUseId), ['toolu_B', 'toolu_C', 'toolu_E']);
  assert.equal(hold.failureMarkers(), 1, 'exactly one marker, no loop');
  assert.equal(hold.size(), 0);
  assert.equal(clock.pending(), 0, 'no timer left');
});

test('restore: an expired marker is not handed to a held stop (pushed back, pruned by expireDue)', () => {
  const { released, hold } = setupLate();
  hold.hold(stop('B'), 'agB', 1000);
  hold.failed('app-dev', 2000);                                   // marker until 62000
  hold.hold(stop('X'), 'agX', 1000);
  hold.resolve('agB', 'toolu_B', 70000);                          // Post after the marker life
  assert.equal(released.length, 1);
  assert.equal(hold.failureMarkers(), 1);
  hold.expireDue(70000);
  assert.equal(hold.failureMarkers(), 0);
  assert.equal(hold.size(), 0, 'X was released by its own wait in expireDue, not turned suspect');
});

test('late Post: a dropped suspect stop is released WITH its id by an exact Post after the wait, once (a second Post adds nothing)', () => {
  const { clock, released, hold } = setupLate();
  hold.hold(stop('B done'), 'agB', 0, { suspect: true });
  clock.advance(8000);
  assert.equal(released.length, 0, 'dropped, nothing released');
  assert.equal(hold.lateMemory(), 1);
  hold.resolve('agB', 'toolu_B', 12000);                         // 4 s after the wait ended
  assert.deepEqual(released.map((e) => [e.toolUseId, e.late]), [['toolu_B', true]]);
  hold.resolve('agB', 'toolu_B', 12100);                         // the same Post again
  assert.equal(released.length, 1, 'no duplicate completion');
  assert.equal(hold.lateMemory(), 0);
});

test('late Post: only the exact agent_ref matches; a non-suspect release is not remembered', () => {
  const { clock, released, hold } = setupLate();
  hold.hold(stop('A'), 'agA', 0, { suspect: true });
  hold.hold(stop('plain'), 'agP', 0);                            // not suspect: released at its timeout, FIFO
  clock.advance(8000);
  assert.deepEqual(released.map((e) => e.message), ['plain']);
  assert.equal(hold.lateMemory(), 1, 'only the dropped suspect is remembered');
  hold.resolve('agP', 'toolu_P', 9000);
  hold.resolve('agOther', 'toolu_X', 9000);
  assert.equal(released.length, 1, 'no release for another agent_ref');
});

test('late Post: the memory ends lateMs after the wait (event time) and is pruned by expireDue()', () => {
  const { clock, released, hold } = setupLate();
  hold.hold(stop('A'), 'agA', 0, { suspect: true });
  hold.hold(stop('B'), 'agB', 0, { suspect: true });
  clock.advance(8000);
  assert.equal(hold.lateMemory(), 2);
  hold.resolve('agA', 'toolu_A', 8000 + 60000);                  // exactly at the limit: still accepted
  assert.deepEqual(released.map((e) => e.toolUseId), ['toolu_A']);
  hold.resolve('agB', 'toolu_B', 8000 + 60001);                  // one ms too late
  assert.equal(released.length, 1, 'too late: not released');
  assert.equal(hold.lateMemory(), 0, 'the expired entry is forgotten too');
  hold.hold(stop('C'), 'agC', 100000, { suspect: true });
  clock.advance(8000);
  assert.equal(hold.lateMemory(), 1);
  hold.expireDue(108000 + 60001);
  assert.equal(hold.lateMemory(), 0, 'expireDue() prunes it');
});

test('late Post: the memory is bounded (lateCap, oldest dropped), disabled by lateMs 0, and cleared by clear()', () => {
  const { clock, released, hold } = setupLate(3);
  for (let i = 0; i < 5; i += 1) hold.hold(stop(`s${i}`), `ag${i}`, 0, { suspect: true });
  clock.advance(8000);
  assert.equal(hold.lateMemory(), 3, 'capped at 3');
  hold.resolve('ag0', 'toolu_0', 9000);
  hold.resolve('ag1', 'toolu_1', 9000);
  assert.equal(released.length, 0, 'the two oldest were forgotten');
  hold.resolve('ag4', 'toolu_4', 9000);
  assert.deepEqual(released.map((e) => e.toolUseId), ['toolu_4']);
  hold.clear();
  assert.equal(hold.lateMemory(), 0);

  const clock2 = fakeClock();
  const rel2 = [];
  const off = createStopHold({
    release: (e) => rel2.push(e), waitMs: 8000, lateMs: 0, now: clock2.now, setTimer: clock2.setTimer, clearTimer: clock2.clearTimer,
  });
  off.hold(stop('x'), 'agX', 0, { suspect: true });
  clock2.advance(8000);
  off.resolve('agX', 'toolu_X', 9000);
  assert.equal(rel2.length, 0, 'lateMs 0 = the old behaviour');
  assert.equal(off.lateMemory(), 0);
});

test('late Post: a Post that finds a HELD stop of the same agent_ref takes it and clears the memory (never two completions)', () => {
  const { clock, released, hold } = setupLate();
  hold.hold(stop('first'), 'agB', 0, { suspect: true });
  clock.advance(8000);                                           // dropped, remembered
  hold.hold(stop('second'), 'agB', 9000);                        // the same agent_ref held again
  hold.resolve('agB', 'toolu_B', 9100);
  assert.deepEqual(released.map((e) => `${e.message}:${e.toolUseId}`), ['second:toolu_B'], 'one completion only');
  assert.equal(hold.lateMemory(), 0);
});

test('late Post: a late release also gives the consumed marker back', () => {
  const { clock, released, hold } = setupLate();
  hold.failed('app-dev', 0);
  hold.consumeFailure('app-dev', 1000, 'agB');
  hold.hold(stop('B'), 'agB', 1000, { suspect: true });
  clock.advance(8000);
  assert.equal(hold.failureMarkers(), 0);
  hold.resolve('agB', 'toolu_B', 12000);
  assert.equal(released.length, 1);
  assert.equal(hold.failureMarkers(), 1, 'the real failed run can still be caught');
});
