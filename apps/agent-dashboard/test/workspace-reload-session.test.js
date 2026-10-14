'use strict';
/**
 * workspace-reload-session.test.js - regression tests for two owner-visible bugs:
 *   1. "Refreshing the browser wiped the dashboard data and turned a PROCESSING agent to IDLE while it was still working,
 *       although the Claude session had not changed."
 *   2. (QA Medium) "Concurrent Claude sessions wipe each other: the start of session B cleared A's view, dropped A's held stops
 *       (A stuck PROCESSING) and A's later events were shown again (the screen flipped)."
 *
 * Contract tested here:
 *   Server (lib/workspace.js hub, temp files, fake clock) - the EPOCH model (see the SESSIONS header in lib/workspace.js)
 *     - a new SSE client gets "event: session" first, then the WHOLE buffer of the current epoch
 *     - a SessionStart while another session of the epoch is live JOINS the epoch: no clear, no session message, held stops kept
 *     - a SessionStart when every member has ended (also /clear) or been idle for SESSION_IDLE_MS opens a NEW epoch
 *     - late records of an old session are buffered and never change the key; the session becomes a member
 *     - a batch with several epochs writes exactly one session message per client, and equals a line-by-line read
 *     - SESSION_IDLE_MS is much longer than the stop-hold windows (the new-epoch clear is only safe because of that)
 *   Page (public/workspace/app.js in a vm, fake DOM and fake EventSource)
 *     - a reload (new page, same replay) restores log + node/card status + PROCESSING of an open task
 *     - an EventSource reconnect (same session key) keeps the view and does not duplicate log lines
 *     - a different session key clears the view; the replay that follows draws no beam and no comet
 *     - the clear button still hides older events, also across a reconnect replay
 *     - a stale task (open > staleMs) reads the same live and after a reload replay
 * No real data: every file is in a temp folder (test/helpers/temp-paths.js). Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const { isolateEnv, tempWorkspaceOpts } = require('./helpers/temp-paths');
isolateEnv();
const {
  createWorkspaceHub, SESSION_IDLE_MS, TOOL_USE_WAIT_MS, TYPE_FAILURE_MARKER_MS, LATE_POST_MS,
} = require('../lib/workspace');
const { fakeClock } = require('./helpers/fake-clock');

const WORKSPACE_DIR = path.join(__dirname, '..', 'public', 'workspace');
const APP_JS = fs.readFileSync(path.join(WORKSPACE_DIR, 'app.js'), 'utf8');
const STORE_URL = pathToFileURL(path.join(WORKSPACE_DIR, 'stellar', 'store.js')).href;

// ---------------------------------------------------------------------------------------------------------------------------
// Hub side
// ---------------------------------------------------------------------------------------------------------------------------

const BASE_MS = Date.parse('2026-10-14T08:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
/** ISO time of a record: BASE + ms. Records below take their time as a millisecond offset. */
const T = (ms) => new Date(BASE_MS + ms).toISOString();
/** The opaque key the hub shows for a session id (a hash of the FIRST session id of an epoch). */
const keyOf = (sid) => crypto.createHash('sha256').update(sid).digest('hex').slice(0, 12);

const sessionStart = (ms, sid, reason = 'startup') => ({ ts: T(ms), event: 'SessionStart', session_id: sid, agent_type: 'secretary', reason });
const sessionEnd = (ms, sid) => ({ ts: T(ms), event: 'SessionEnd', session_id: sid, agent_type: 'secretary' });
const prompt = (ms, sid) => ({ ts: T(ms), event: 'UserPromptSubmit', session_id: sid, agent_type: 'secretary' });
const dispatch = (ms, sid, toolUseId, sub, desc) => ({
  ts: T(ms), event: 'PreToolUse', session_id: sid, agent_type: 'secretary', tool_name: 'Agent', tool_use_id: toolUseId, subagent_type: sub, description: desc,
});
const subStart = (ms, sid, ref) => ({ ts: T(ms), event: 'SubagentStart', session_id: sid, agent_type: 'app-dev', agent_id: ref });
const subStop = (ms, sid, ref, msg = 'done') => ({
  ts: T(ms), event: 'SubagentStop', session_id: sid, agent_type: 'app-dev', agent_id: ref, last_message: msg,
});
const postAgent = (ms, sid, toolUseId, ref) => ({
  ts: T(ms), event: 'PostToolUse', session_id: sid, agent_type: 'secretary', tool_name: 'Agent', tool_use_id: toolUseId, agent_ref: ref, response_status: 'completed',
});

/**
 * Temp folder + hub on it, with a fake clock that follows the record time (so a held stop expires like in a live run).
 * Records in `initialRecords` are in the hook file BEFORE the hub starts; add() appends later records and reads them now.
 */
function makeHubEnv(initialRecords = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-reload-'));
  const opts = tempWorkspaceOpts(dir);
  fs.mkdirSync(path.dirname(opts.eventsFile), { recursive: true });
  const write = (records) => fs.appendFileSync(opts.eventsFile, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const clock = fakeClock();
  /** Move the fake clock to the time of the last record (never back). */
  const follow = (records) => {
    const last = records.length ? Date.parse(records[records.length - 1].ts) : BASE_MS;
    if (last > clock.now()) clock.advance(last - clock.now());
  };
  follow(initialRecords);
  if (initialRecords.length) write(initialRecords);
  const hub = createWorkspaceHub({
    timing: {
      watchIntervalMs: 50, queueCheckMs: 100, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    },
    eventsFile: opts.eventsFile,
    workspaceFile: opts.workspaceEventsFile,
    commandsFile: opts.commandsFile,
    uploadsDir: opts.uploadsDir,
    secretaryQueueDir: opts.secretaryQueueDir,
  });
  return {
    hub,
    opts,
    clock,
    /** Append hook records and read them now (one poll), with the clock at the last record. */
    add(records) { follow(records); write(records); hub.poll(); },
    /** Replace the whole hook file (a reset: the file is shorter than before) and read it now. */
    replaceFile(records) { fs.writeFileSync(opts.eventsFile, records.map((r) => `${JSON.stringify(r)}\n`).join('')); follow(records); hub.poll(); },
    cleanup() { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Attach a fake SSE client. Returns the raw chunks and parsed views of them. */
function connect(hub) {
  const chunks = [];
  hub.attach({ on() {} }, { write: (c) => chunks.push(c), on() {}, end() {} });
  return {
    chunks,
    /** Messages in arrival order: { type: 'session'|'message', data } (activity and comments are left out). */
    messages: () => chunks
      .map((c) => {
        const session = /^event: session\ndata: (.*)\n\n$/s.exec(c);
        if (session) return { type: 'session', data: JSON.parse(session[1]) };
        const msg = /^data: (.*)\n\n$/s.exec(c);
        return msg ? { type: 'message', data: JSON.parse(msg[1]) } : null;
      })
      .filter(Boolean),
    events: () => chunks.filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice('data: '.length))),
    /** The "session" messages only, in order. */
    sessions: () => chunks
      .map((c) => /^event: session\ndata: (.*)\n\n$/s.exec(c))
      .filter(Boolean)
      .map((m) => JSON.parse(m[1])),
  };
}

/** Short comparable form of an event list: "agent:status:toolUseId". */
const brief = (events) => events.map((e) => `${e.agent}:${e.status}:${e.toolUseId || ''}`);
/** The events a client got AFTER its last "session" message (= the replay of the epoch it was told about). */
function afterLastSession(client) {
  const msgs = client.messages();
  let last = -1;
  msgs.forEach((m, i) => { if (m.type === 'session') last = i; });
  return msgs.slice(last + 1).filter((m) => m.type === 'message').map((m) => m.data);
}

test('hub: a new client gets the session event first, then the WHOLE current session (more than the old 100-event replay)', () => {
  const sid = 'sess-A';
  const records = [sessionStart(0, sid)];
  // 150 prompts: more than the old REPLAY_COUNT of 100
  for (let i = 1; i <= 150; i += 1) records.push(prompt(i * SEC, sid));
  const env = makeHubEnv(records);
  try {
    const client = connect(env.hub);
    const msgs = client.messages();
    assert.equal(msgs[0].type, 'session', 'the session event comes before any workspace event');
    assert.match(msgs[0].data.key, /^[0-9a-f]{12}$/, 'an opaque key');
    assert.equal(msgs[0].data.key, keyOf(sid));
    assert.equal(JSON.stringify(msgs[0].data).includes(sid), false, 'the raw session_id is never sent to the browser');
    assert.equal(msgs.filter((m) => m.type === 'message').length, 150, 'every event of the session is replayed');
  } finally {
    env.cleanup();
  }
});

test('hub: a task dispatched early in a long session is still replayed after a reload (agent stays PROCESSING until its end)', () => {
  const sid = 'sess-A';
  const records = [sessionStart(0, sid), dispatch(1 * SEC, sid, 'toolu_LONG', 'app-dev', 'long running task')];
  for (let i = 2; i <= 300; i += 1) records.push(prompt(i * SEC, sid));   // 299 later events: the dispatch is far beyond the last 100
  const env = makeHubEnv(records);
  try {
    const events = connect(env.hub).events();
    const start = events.find((e) => e.toolUseId === 'toolu_LONG');
    assert.ok(start, 'the dispatch of the still-running task is in the replay');
    assert.equal(start.status, 'PROCESSING');
    assert.equal(start.agent, 'app-dev');
  } finally {
    env.cleanup();
  }
});

test('hub: a second client (the reloaded page) gets exactly the same replay as the first one', () => {
  const sid = 'sess-A';
  const env = makeHubEnv([sessionStart(0, sid), prompt(1 * SEC, sid), dispatch(2 * SEC, sid, 'toolu_1', 'app-dev', 'work')]);
  try {
    const first = connect(env.hub).chunks.filter((c) => !c.startsWith('retry'));
    const second = connect(env.hub).chunks.filter((c) => !c.startsWith('retry'));
    assert.deepEqual(second, first);
    assert.equal(second.filter((c) => c.startsWith('data: ')).length, 2);
  } finally {
    env.cleanup();
  }
});

// ---- Epoch model: join, new epoch, held stops -------------------------------------------------------------------------------

test('epoch 1 - concurrent join: B starts 5 min after A -> no second session message, key stays A, replay = A and B events in time order', () => {
  const env = makeHubEnv([
    sessionStart(0, 'sess-A'), prompt(1 * SEC, 'sess-A'),
    dispatch(2 * SEC, 'sess-A', 'toolu_A', 'app-dev', 'A work'), subStart(3 * SEC, 'sess-A', 'agA'),
  ]);
  try {
    const live = connect(env.hub);
    assert.deepEqual(live.sessions(), [{ key: keyOf('sess-A') }]);
    const before = live.chunks.length;

    env.add([sessionStart(5 * MIN, 'sess-B'), prompt(5 * MIN + 1 * SEC, 'sess-B'), dispatch(5 * MIN + 2 * SEC, 'sess-B', 'toolu_B', 'qa-reviewer', 'B work')]);

    assert.deepEqual(live.sessions(), [{ key: keyOf('sess-A') }], 'B joined: the connected client is not told about a new session');
    assert.equal(live.chunks.slice(before).some((c) => c.startsWith('event: session')), false);
    assert.deepEqual(brief(live.events().slice(-2)), ['secretary:PROCESSING:', 'qa-reviewer:PROCESSING:toolu_B'], 'B events arrive live, nothing re-sent');

    const fresh = connect(env.hub);
    assert.deepEqual(fresh.sessions(), [{ key: keyOf('sess-A') }], 'a new page gets the key of A');
    assert.deepEqual(brief(fresh.events()), [
      'secretary:PROCESSING:',                // A prompt
      'app-dev:PROCESSING:toolu_A',           // A dispatch (the start of A's still-running task)
      'app-dev:WORKING:',                     // A SubagentStart
      'secretary:PROCESSING:',                // B prompt
      'qa-reviewer:PROCESSING:toolu_B',       // B dispatch
    ]);
  } finally {
    env.cleanup();
  }
});

test('epoch 2 - held stop across a SessionStart: A\'s held SubagentStop survives B joining and is closed by A\'s PostToolUse with the id', () => {
  const env = makeHubEnv([sessionStart(0, 'sess-A'), dispatch(1 * SEC, 'sess-A', 'toolu_A', 'app-dev', 'A work'), subStart(2 * SEC, 'sess-A', 'agA')]);
  try {
    const live = connect(env.hub);
    env.add([subStop(10 * SEC, 'sess-A', 'agA', 'A finished')]);          // sync stop: held for its PostToolUse id (8 s)
    assert.equal(live.events().some((e) => e.status === 'COMPLETED'), false, 'the stop is held');

    env.add([sessionStart(12 * SEC, 'sess-B')]);                         // inside the 8 s wait; A is live -> B joins, nothing cleared
    assert.equal(live.sessions().length, 1, 'no new session message');
    assert.equal(env.clock.pending(), 1, 'the hold of A\'s stop is still running');

    env.add([postAgent(13 * SEC, 'sess-A', 'toolu_A', 'agA')]);
    const done = live.events().filter((e) => e.status === 'COMPLETED');
    assert.equal(done.length, 1, 'A\'s task is closed exactly once');
    assert.equal(done[0].toolUseId, 'toolu_A', 'closed WITH the exact id, not lost and not a FIFO guess');
    assert.deepEqual(brief(connect(env.hub).events()).filter((b) => b.includes('COMPLETED')), ['app-dev:COMPLETED:toolu_A'], 'a reload sees it too');
  } finally {
    env.cleanup();
  }
});

test('epoch 2b - the opposite case: when A has ENDED before B starts, the new epoch clears the stop held for A (it cannot close a task of B)', () => {
  const env = makeHubEnv([sessionStart(0, 'sess-A'), dispatch(1 * SEC, 'sess-A', 'toolu_A', 'app-dev', 'A work'), subStart(2 * SEC, 'sess-A', 'agA')]);
  try {
    const live = connect(env.hub);
    env.add([subStop(10 * SEC, 'sess-A', 'agA', 'A finished'), sessionEnd(10 * SEC + 500, 'sess-A')]);
    env.add([sessionStart(11 * SEC, 'sess-B')]);                         // nobody is live: new epoch, the held stop is dropped
    assert.equal(env.clock.pending(), 0, 'no timer left for the dropped stop');
    env.add([postAgent(13 * SEC, 'sess-A', 'toolu_A', 'agA')]);
    assert.equal(live.events().some((e) => e.status === 'COMPLETED'), false, 'the old stop is gone');
    assert.equal(connect(env.hub).events().length, 0, 'the new epoch starts empty');
  } finally {
    env.cleanup();
  }
});

test('epoch 3 - late A records while B is active: all buffered (also one with an older time), no key change, no extra session message', () => {
  const env = makeHubEnv([sessionStart(0, 'sess-A'), prompt(10 * SEC, 'sess-A'), sessionStart(60 * SEC, 'sess-B')]);
  try {
    const live = connect(env.hub);
    env.add([
      prompt(120 * SEC, 'sess-A'), prompt(121 * SEC, 'sess-B'),
      dispatch(122 * SEC, 'sess-A', 'toolu_A', 'app-dev', 'A late'),
      prompt(30 * SEC, 'sess-A'),                                        // written late: its time is before B's start
      prompt(123 * SEC, 'sess-B'),
    ]);
    assert.deepEqual(live.sessions(), [{ key: keyOf('sess-A') }]);
    const fresh = connect(env.hub);
    assert.deepEqual(fresh.sessions(), [{ key: keyOf('sess-A') }]);
    assert.equal(fresh.events().length, 1 + 5, 'every hook event is buffered: the first prompt and the 5 new ones');
    const times = fresh.events().map((e) => Date.parse(e.ts));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'the replay is in time order');
  } finally {
    env.cleanup();
  }
});

test('epoch 4 - new epoch after idle: B starts later than SESSION_IDLE_MS -> exactly one session message, new key, nothing of A, no older workspace event', () => {
  const env = makeHubEnv([sessionStart(0, 'sess-A'), dispatch(1 * SEC, 'sess-A', 'toolu_A', 'app-dev', 'A work'), prompt(2 * SEC, 'sess-A')]);
  try {
    // Two workspace-file events (queue / POST): one in A's time, one after B's start
    env.hub.publish({ ts: T(30 * SEC), agent: 'secretary', status: 'COMPLETED', message: 'old queue note' });
    const live = connect(env.hub);
    assert.equal(live.events().some((e) => e.message === 'old queue note'), true, 'the note is in the replay of epoch A');

    const startB = 2 * SEC + SESSION_IDLE_MS + 1 * MIN;
    env.add([sessionStart(startB, 'sess-B'), prompt(startB + 1 * SEC, 'sess-B')]);
    env.hub.publish({ ts: T(startB + 2 * SEC), agent: 'secretary', status: 'COMPLETED', message: 'new queue note' });

    assert.deepEqual(live.sessions(), [{ key: keyOf('sess-A') }, { key: keyOf('sess-B') }], 'exactly one session message for the change');
    const replayed = afterLastSession(live);
    assert.deepEqual(brief(replayed).slice(0, 1), ['secretary:PROCESSING:'], 'the connected client gets the buffer of B right after the session message');

    const fresh = connect(env.hub);
    assert.deepEqual(fresh.sessions(), [{ key: keyOf('sess-B') }]);
    assert.equal(fresh.events().some((e) => e.toolUseId === 'toolu_A'), false, 'nothing of A');
    assert.equal(fresh.events().some((e) => e.message === 'old queue note'), false, 'no workspace event older than the new epoch');
    assert.equal(fresh.events().some((e) => e.message === 'new queue note'), true, 'a newer workspace event is kept');
  } finally {
    env.cleanup();
  }
});

test('epoch 5 - new epoch after SessionEnd, also /clear (End and Start less than 1 s apart); a session joining a live member never clears', () => {
  const env = makeHubEnv([sessionStart(0, 'sess-A'), prompt(1 * SEC, 'sess-A'), sessionEnd(10 * SEC, 'sess-A')]);
  try {
    const live = connect(env.hub);
    env.add([sessionStart(11 * SEC, 'sess-B'), prompt(12 * SEC, 'sess-B')]);       // A ended -> new epoch
    assert.deepEqual(live.sessions(), [{ key: keyOf('sess-A') }, { key: keyOf('sess-B') }]);

    // /clear: SessionEnd and SessionStart of the NEW id at (almost) the same time
    env.add([sessionEnd(20 * SEC, 'sess-B'), sessionStart(20 * SEC + 300, 'sess-C'), prompt(21 * SEC, 'sess-C')]);
    assert.deepEqual(live.sessions().map((k) => k.key), [keyOf('sess-A'), keyOf('sess-B'), keyOf('sess-C')]);
    assert.equal(connect(env.hub).events().length, 1, 'only the prompt of C is left');

    // D starts while C is live (joins); C ends; E starts while D is live (joins). Only when all have ended does F open an epoch.
    env.add([sessionStart(30 * SEC, 'sess-D'), sessionEnd(31 * SEC, 'sess-C'), sessionStart(32 * SEC, 'sess-E')]);
    assert.equal(live.sessions().length, 3, 'D joined C; E joined D (C ended, D live)');
    env.add([sessionEnd(40 * SEC, 'sess-D'), sessionEnd(41 * SEC, 'sess-E'), sessionStart(42 * SEC, 'sess-F')]);
    assert.equal(live.sessions().length, 4, 'all ended -> F opens a new epoch');
    assert.equal(live.sessions()[3].key, keyOf('sess-F'));
  } finally {
    env.cleanup();
  }
});

test('epoch 6 - boundary: a gap of SESSION_IDLE_MS - 1 ms joins, a gap of SESSION_IDLE_MS opens a new epoch', () => {
  for (const [gap, expectNew] of [[SESSION_IDLE_MS - 1, false], [SESSION_IDLE_MS, true]]) {
    const env = makeHubEnv([sessionStart(0, 'sess-A')]);
    try {
      const live = connect(env.hub);
      env.add([sessionStart(gap, 'sess-B')]);
      assert.equal(live.sessions().length, expectNew ? 2 : 1, `gap ${gap} ms`);
      assert.equal(connect(env.hub).sessions()[0].key, keyOf(expectNew ? 'sess-B' : 'sess-A'));
    } finally {
      env.cleanup();
    }
  }
});

test('epoch 7 - resume keeps the key: the same session_id again (resume / compact, also after its SessionEnd) clears nothing and sends nothing', () => {
  const env = makeHubEnv([sessionStart(0, 'sess-A'), dispatch(1 * SEC, 'sess-A', 'toolu_run', 'app-dev', 'still running')]);
  try {
    const live = connect(env.hub);
    const before = live.chunks.length;
    env.add([sessionStart(50 * SEC, 'sess-A', 'compact')]);
    assert.equal(live.chunks.length, before, 'nothing is sent to the connected client');
    env.add([sessionEnd(60 * SEC, 'sess-A'), sessionStart(70 * SEC, 'sess-A', 'resume')]);
    assert.equal(live.chunks.length, before, 'End then Start of the same id (resume) is not a new epoch either');
    const events = connect(env.hub).events();
    assert.equal(events.some((e) => e.toolUseId === 'toolu_run'), true, 'the running task is still replayed');
  } finally {
    env.cleanup();
  }
});

test('epoch 8 - a revived old session after an epoch change: its records are buffered, the key does not change, and it becomes a member', () => {
  const startB = SESSION_IDLE_MS + 5 * MIN;
  const env = makeHubEnv([sessionStart(0, 'sess-A'), prompt(1 * SEC, 'sess-A'), sessionStart(startB, 'sess-B')]);   // A idle -> epoch B
  try {
    const live = connect(env.hub);
    assert.deepEqual(live.sessions(), [{ key: keyOf('sess-B') }]);
    env.add([dispatch(startB + 1 * MIN, 'sess-A', 'toolu_A2', 'app-dev', 'A is back')]);
    assert.deepEqual(live.sessions(), [{ key: keyOf('sess-B') }], 'no key change');
    assert.equal(connect(env.hub).events().some((e) => e.toolUseId === 'toolu_A2'), true, 'buffered and replayed');

    // A is a member now: with B ended, A still counts as live, so C joins instead of clearing
    env.add([sessionEnd(startB + 2 * MIN, 'sess-B'), sessionStart(startB + 3 * MIN, 'sess-C')]);
    assert.equal(live.sessions().length, 1, 'C joined (A is live)');
  } finally {
    env.cleanup();
  }
});

test('epoch - a SessionStart without a usable session_id is ignored (empty or "unknown" never opens an epoch or clears)', () => {
  const env = makeHubEnv([sessionStart(0, 'sess-A'), prompt(1 * SEC, 'sess-A'), sessionEnd(2 * SEC, 'sess-A')]);
  try {
    const live = connect(env.hub);
    env.add([sessionStart(5 * SEC, 'unknown'), sessionStart(6 * SEC, ''), { ts: T(7 * SEC), event: 'SessionStart', agent_type: 'secretary' }]);
    assert.equal(live.sessions().length, 1);
    assert.equal(connect(env.hub).events().length, 1, 'nothing was cleared');
  } finally {
    env.cleanup();
  }
});

test('epoch - a file reset forgets the epoch; the re-read file defines the new one', () => {
  const env = makeHubEnv([sessionStart(0, 'sess-A'), prompt(1 * SEC, 'sess-A'), prompt(2 * SEC, 'sess-A'), prompt(3 * SEC, 'sess-A')]);
  try {
    const live = connect(env.hub);
    env.replaceFile([sessionStart(10 * SEC, 'sess-B')]);                  // shorter file = reset
    assert.deepEqual(live.sessions(), [{ key: keyOf('sess-A') }, { key: keyOf('sess-B') }]);
    assert.equal(connect(env.hub).events().length, 0);
  } finally {
    env.cleanup();
  }
});

// ---- Batches, restart, size -------------------------------------------------------------------------------------------------

/** Records of a busy scenario: A, a concurrent B, an idle gap, then a /clear to D. Final epoch = D. */
function scenario() {
  const HOUR2 = 2 * 60 * MIN;
  return [
    sessionStart(0, 'sess-A'), prompt(1 * SEC, 'sess-A'), dispatch(2 * SEC, 'sess-A', 'toolu_A', 'app-dev', 'A work'),
    sessionStart(5 * SEC, 'sess-B'), prompt(6 * SEC, 'sess-B'),
    subStart(7 * SEC, 'sess-A', 'agA'), subStop(8 * SEC, 'sess-A', 'agA', 'A done'), postAgent(9 * SEC, 'sess-A', 'toolu_A', 'agA'),
    sessionStart(HOUR2, 'sess-C'), prompt(HOUR2 + 1 * SEC, 'sess-C'),                   // everything idle for 2 h -> new epoch (C)
    sessionEnd(HOUR2 + 10 * SEC, 'sess-C'), sessionStart(HOUR2 + 10 * SEC + 200, 'sess-D'),   // /clear -> new epoch (D)
    dispatch(HOUR2 + 12 * SEC, 'sess-D', 'toolu_D', 'qa-reviewer', 'D work'), prompt(HOUR2 + 13 * SEC, 'sess-D'),
  ];
}

test('epoch 9 - a reset batch with several epochs: exactly ONE session write per client, final key and buffer equal a fresh hub', () => {
  const records = scenario();
  const empty = makeHubEnv();
  const fresh = makeHubEnv(records);
  try {
    const c1 = connect(empty.hub);
    const c2 = connect(empty.hub);
    assert.deepEqual(c1.sessions(), [{ key: null }], 'no session known yet');
    empty.add(records);                                                    // ONE poll with A, B, C and D inside

    for (const c of [c1, c2]) {
      assert.equal(c.sessions().length, 2, 'the initial message and exactly one more');
      assert.equal(c.sessions()[1].key, keyOf('sess-D'));
    }
    const ref = connect(fresh.hub);
    assert.deepEqual(ref.sessions(), [{ key: keyOf('sess-D') }]);
    assert.deepEqual(afterLastSession(c1), ref.events(), 'what the live client holds after the session message = a fresh page');
    assert.deepEqual(afterLastSession(c2), ref.events());
    assert.deepEqual(brief(ref.events()), ['qa-reviewer:PROCESSING:toolu_D', 'secretary:PROCESSING:']);
  } finally {
    empty.cleanup();
    fresh.cleanup();
  }
});

test('epoch 9b - a dead client is dropped while the session message is flushed; the others still get it', () => {
  const env = makeHubEnv([sessionStart(0, 'sess-A'), sessionEnd(1 * SEC, 'sess-A')]);
  try {
    let dead = false;
    let ended = 0;
    env.hub.attach({ on() {} }, {
      write: (c) => { if (dead && c.startsWith('event: session')) throw new Error('socket closed'); },
      on() {},
      end() { ended += 1; },
    });
    const ok = connect(env.hub);
    dead = true;
    env.add([sessionStart(10 * SEC, 'sess-B'), prompt(11 * SEC, 'sess-B')]);   // A ended -> new epoch -> flush
    assert.equal(ended, 1, 'the dead client was ended and removed');
    assert.deepEqual(ok.sessions(), [{ key: keyOf('sess-A') }, { key: keyOf('sess-B') }]);
    assert.equal(afterLastSession(ok).length, 1);
  } finally {
    env.cleanup();
  }
});

test('epoch 10 - one batch and a line-by-line read give the same key and the same replay', () => {
  const records = scenario();
  const batch = makeHubEnv();
  const lines = makeHubEnv();
  try {
    batch.add(records);
    records.forEach((r) => lines.add([r]));
    const a = connect(batch.hub);
    const b = connect(lines.hub);
    assert.deepEqual(a.sessions(), b.sessions());
    assert.deepEqual(a.events(), b.events());
    assert.equal(a.sessions()[0].key, keyOf('sess-D'));
  } finally {
    batch.cleanup();
    lines.cleanup();
  }
});

test('hub: after a server restart (events re-read from the file) the last epoch is replayed, earlier ones are not', () => {
  const env = makeHubEnv([
    sessionStart(0, 'sess-A'), dispatch(1 * SEC, 'sess-A', 'toolu_A', 'app-dev', 'a'), sessionEnd(50 * SEC, 'sess-A'),
    sessionStart(100 * SEC, 'sess-B'), dispatch(101 * SEC, 'sess-B', 'toolu_B', 'qa-reviewer', 'b'),
  ]);
  try {
    const events = connect(env.hub).events();
    assert.deepEqual(events.map((e) => e.toolUseId), ['toolu_B']);
  } finally {
    env.cleanup();
  }
});

test('hub: after a restart, concurrent sessions are one epoch: both are replayed', () => {
  const env = makeHubEnv([
    sessionStart(0, 'sess-A'), dispatch(1 * SEC, 'sess-A', 'toolu_A', 'app-dev', 'a'),
    sessionStart(100 * SEC, 'sess-B'), dispatch(101 * SEC, 'sess-B', 'toolu_B', 'qa-reviewer', 'b'),
  ]);
  try {
    const client = connect(env.hub);
    assert.deepEqual(client.events().map((e) => e.toolUseId), ['toolu_A', 'toolu_B']);
    assert.deepEqual(client.sessions(), [{ key: keyOf('sess-A') }]);
  } finally {
    env.cleanup();
  }
});

test('epoch 11 - two concurrent sessions x 900 events: nothing is lost, the start of A\'s task is still in the replay', () => {
  const records = [sessionStart(0, 'sess-A'), dispatch(1 * SEC, 'sess-A', 'toolu_A_LONG', 'app-dev', 'A long task'), sessionStart(2 * SEC, 'sess-B')];
  for (let i = 0; i < 899; i += 1) records.push(prompt(10 * SEC + i * SEC, 'sess-A'));     // + the dispatch = 900 events of A
  for (let i = 0; i < 900; i += 1) records.push(prompt(10 * SEC + i * SEC + 500, 'sess-B'));
  const env = makeHubEnv(records);
  try {
    const client = connect(env.hub);
    const events = client.events();
    assert.equal(events.length, 1800, 'both sessions fit in the buffer');
    assert.equal(events[0].toolUseId, 'toolu_A_LONG', 'the dispatch of A is the oldest event and is still there');
    assert.deepEqual(client.sessions(), [{ key: keyOf('sess-A') }]);
  } finally {
    env.cleanup();
  }
});

test('invariant - SESSION_IDLE_MS is much longer than every stop-hold window (a new epoch clears held stops and markers)', () => {
  const longestWindow = Math.max(TOOL_USE_WAIT_MS, TYPE_FAILURE_MARKER_MS, LATE_POST_MS);
  assert.ok(SESSION_IDLE_MS >= 10 * longestWindow, `SESSION_IDLE_MS ${SESSION_IDLE_MS} must be at least 10x ${longestWindow}`);
  assert.ok(SESSION_IDLE_MS >= 30 * MIN, 'at least the idle time that was measured around long sub-agent runs');
});

// ---------------------------------------------------------------------------------------------------------------------------
// Page side
// ---------------------------------------------------------------------------------------------------------------------------

/** Minimal element stub with the parts of the DOM that app.js touches. */
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
    set textContent(v) { this._text = String(v); if (v === '') this.children = []; },
    get firstChild() { return this.children[0] || null; },
    append(...nodes) { nodes.forEach((n) => this.appendChild(n)); },
    appendChild(n) { this.children.push(n); return n; },
    removeChild(n) { this.children = this.children.filter((c) => c !== n); return n; },
    querySelector(sel) { return selectors[sel] || null; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  };
}

const STEPS = ['user', 'router', 'pm', 'appdev', 'qa', 'study', 'portfolio'];
const AGENTS = ['secretary', 'app-dev', 'qa-reviewer'];

/**
 * Load the real app.js into a vm, as a freshly opened (or reloaded) page. Nothing is shared between two calls, exactly like a
 * browser reload: no variable, no DOM. The real stellar store is published as window.createWorkspaceStore (what scene.js does),
 * so the derived status of the cards and nodes is the production one.
 */
async function openPage(nowMs, { scene = false } = {}) {
  const { createStore } = await import(STORE_URL);
  const clock = { now: nowMs };
  class FakeDate extends Date { static now() { return clock.now; } }
  const win = (() => {
    const listeners = new Map();
    class FakeCustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
    return {
      CustomEvent: FakeCustomEvent,
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
      dispatchEvent(ev) { (listeners.get(ev.type) || []).forEach((fn) => fn(ev)); return true; },
    };
  })();
  win.createWorkspaceStore = (...args) => createStore({ ...args[0], now: () => clock.now });
  // Optional 3D scene stub: records every beam (handoff) and every event the Stellar layer is given (with its replay flag)
  const handoffs = [];
  const sceneEvents = [];
  if (scene) {
    win.workspaceScene = { handoff: (from, to) => handoffs.push([from, to]), setNodeStatus() {}, reset() {} };
    win.addEventListener('workspace:event', (e) => sceneEvents.push(e.detail));
  }

  const elements = new Map([['log', fakeEl('ol')]]);
  const getEl = (id) => { if (!elements.has(id)) elements.set(id, fakeEl(id)); return elements.get(id); };
  const nodes = STEPS.map((step) => {
    const badge = fakeEl('span');
    const msg = fakeEl('div');
    const node = fakeEl('div', { '[data-badge]': badge, '[data-msg]': msg });
    node.dataset.step = step;
    node.badge = badge;
    node.msg = msg;
    return node;
  });
  const cards = AGENTS.map((agent) => {
    const pill = fakeEl('span');
    const name = fakeEl('span');
    const card = fakeEl('li', { '[data-pill]': pill, '[data-name]': name });
    card.dataset.agent = agent;
    card.pill = pill;
    return card;
  });
  const streams = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.readyState = 0; this.handlers = {}; streams.push(this); }
    addEventListener(type, fn) { this.handlers[type] = fn; }
  }
  FakeEventSource.CLOSED = 2;
  const sandbox = {
    window: win,
    document: {
      readyState: 'complete',
      getElementById: getEl,
      querySelectorAll(selector) {
        if (selector === '.node[data-step]') return nodes;
        if (selector === '#agent-list .agent-card[data-agent]') return cards;
        return [];
      },
      createElement: fakeEl,
      addEventListener() {},
    },
    EventSource: FakeEventSource,
    Date: FakeDate,
    fetch: async () => ({ ok: false }),
    setTimeout: (fn) => { fn(); return 0; },   // the replay grace timer ends at once; replay is decided by event time
    clearTimeout() {},
    setInterval: () => 0,
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(APP_JS, sandbox, { filename: 'app.js' });
  const es = () => streams[streams.length - 1];
  const logText = () => el(getEl('log'));
  return {
    clock,
    handoffs,
    sceneEvents,
    /** scene.js announces that it is ready (events buffered before are sent now). */
    sceneReady() { win.dispatchEvent(new win.CustomEvent('workspace:scene-ready', { detail: { active: true } })); },
    nodes: Object.fromEntries(nodes.map((n) => [n.dataset.step, n])),
    cards: Object.fromEntries(cards.map((c) => [c.dataset.agent, c])),
    log: getEl('log'),
    /** Text of every log line, oldest first. */
    logLines: () => getEl('log').children.map((line) => el(line)),
    logText,
    /** SSE (re)connected: the replay follows. */
    open() { es().onopen(); },
    /** A "session" SSE message with this key. */
    session(key) { es().handlers.session({ data: JSON.stringify({ key }) }); },
    /** One workspace event as the server sends it. */
    push(ev) { es().onmessage({ data: JSON.stringify(ev) }); },
    clickClear() { getEl('clear-view-btn').listeners.click[0]({ preventDefault() {} }); },
  };
}

/** All text under a stub element. */
function el(node) { return [node._text, ...node.children.map(el)].join(''); }

/** Workspace events as the hub sends them for one running session: the owner prompt, then a dispatch to app-dev that is not finished. */
const evAt = (sec, agent, status, message, pipelineStep, toolUseId) => ({
  ts: T(sec * SEC), agent, status, message, ...(pipelineStep ? { pipelineStep } : {}), ...(toolUseId ? { toolUseId } : {}),
});
const SESSION_A = [
  evAt(1, 'secretary', 'PROCESSING', 'รับคำสั่งงานจากผู้ใช้แล้ว', 'router'),
  evAt(2, 'app-dev', 'PROCESSING', 'รับงานจาก secretary: build it', 'appdev', 'toolu_run'),
  evAt(3, 'app-dev', 'WORKING', 'เริ่มทำงาน', 'appdev'),
];
// Page-open time: 2 minutes after the events (the instance is well inside the 10 minute moon timeout)
const RELOAD_AT = BASE_MS + 5 * 60 * 1000;

test('page reload mid-task: log, nodes and cards are rebuilt from the replay and the open task stays PROCESSING', async () => {
  // The first page (before the reload) sees the events live
  const before = await openPage(BASE_MS);
  before.open();
  before.session('key-A');
  SESSION_A.forEach((ev) => before.push(ev));
  assert.equal(before.nodes.appdev.dataset.status, 'PROCESSING');

  // F5: a brand new page, same server replay (the server buffer is the same session)
  const after = await openPage(RELOAD_AT);
  after.open();
  after.session('key-A');
  SESSION_A.forEach((ev) => after.push(ev));

  assert.equal(after.logLines().length, 3, 'the log is not wiped by the reload');
  assert.match(after.logLines()[1], /build it/);
  assert.equal(after.nodes.appdev.dataset.status, 'PROCESSING', 'the pipeline node is still PROCESSING (was IDLE before the fix)');
  assert.equal(after.nodes.appdev.badge.textContent, 'PROCESSING');
  assert.equal(after.cards['app-dev'].dataset.status, 'PROCESSING', 'the agent card is still PROCESSING');
  assert.equal(after.cards['app-dev'].pill.textContent, 'PROCESSING');
  assert.equal(after.nodes.router.dataset.status, 'PROCESSING', 'the secretary (main turn still running) is PROCESSING too');
  assert.match(after.nodes.appdev.msg.textContent, /เริ่มทำงาน/, 'the last message of the node is back');
});

test('page reload after the task ended: the agent shows COMPLETED, not PROCESSING (status follows the end event)', async () => {
  const events = [...SESSION_A, evAt(4, 'app-dev', 'COMPLETED', 'ทำงานเสร็จแล้ว', 'appdev', 'toolu_run')];
  const page = await openPage(RELOAD_AT);
  page.open();
  page.session('key-A');
  events.forEach((ev) => page.push(ev));
  assert.equal(page.cards['app-dev'].dataset.status, 'COMPLETED');
  assert.equal(page.nodes.appdev.dataset.status, 'COMPLETED');
  assert.equal(page.logLines().length, 4);
});

test('EventSource reconnect (same session key): the view is kept and the replay adds no duplicate lines', async () => {
  const page = await openPage(BASE_MS);
  page.open();
  page.session('key-A');
  SESSION_A.forEach((ev) => page.push(ev));
  assert.equal(page.logLines().length, 3);

  // Connection drops and comes back: the server replays the same session, plus one event written in the gap
  page.open();
  page.session('key-A');
  SESSION_A.forEach((ev) => page.push(ev));
  page.push(evAt(10, 'qa-reviewer', 'PROCESSING', 'รับงานจาก secretary: review', 'qa', 'toolu_qa'));

  assert.equal(page.logLines().length, 4, 'the three known lines are not repeated, the missed one is added');
  assert.equal(page.cards['app-dev'].dataset.status, 'PROCESSING', 'status unchanged by the reconnect');
  assert.equal(page.nodes.qa.dataset.status, 'PROCESSING');
});

test('a genuinely new session (different key) clears the old data and status, and shows only the new session', async () => {
  const page = await openPage(BASE_MS);
  page.open();
  page.session('key-A');
  SESSION_A.forEach((ev) => page.push(ev));
  assert.equal(page.cards['app-dev'].dataset.status, 'PROCESSING');

  // The server announces session B, then the events of session B (one of them has the SAME text as an old line: not a duplicate)
  page.session('key-B');
  assert.equal(page.logLines().length, 0, 'the log is cleared at once');
  assert.equal(page.cards['app-dev'].dataset.status, 'IDLE', 'the old PROCESSING is gone');
  assert.equal(page.nodes.appdev.dataset.status, 'IDLE');
  assert.equal(page.nodes.router.dataset.status, 'IDLE');

  page.push(evAt(1, 'secretary', 'PROCESSING', 'รับคำสั่งงานจากผู้ใช้แล้ว', 'router'));   // same key fields as an old event
  assert.equal(page.logLines().length, 1, 'an event equal to an old one is shown again in the new session');
  assert.equal(page.nodes.router.dataset.status, 'PROCESSING');
  assert.equal(page.cards['app-dev'].dataset.status, 'IDLE', 'app-dev was not part of the new session');
});

test('the first session event of a page only records the key (a reload with a different key than the previous page is not a reset)', async () => {
  const page = await openPage(RELOAD_AT);
  page.open();
  page.push(evAt(1, 'secretary', 'PROCESSING', 'x', 'router'));     // an event before any session event does not break anything
  page.session('key-whatever');
  assert.equal(page.logLines().length, 1, 'the first session event does not clear the page');
});

test('clear button: older events stay hidden after a reconnect replay, new ones show', async () => {
  const page = await openPage(BASE_MS + 10 * 1000);
  page.open();
  page.session('key-A');
  SESSION_A.forEach((ev) => page.push(ev));
  page.clickClear();   // clear time = BASE_MS + 10 s
  assert.equal(page.logLines().length, 0);
  assert.equal(page.cards['app-dev'].dataset.status, 'IDLE');

  // Reconnect replays the same session: everything is older than the clear time (and already seen), so it stays hidden
  page.open();
  page.session('key-A');
  SESSION_A.forEach((ev) => page.push(ev));
  assert.equal(page.logLines().length, 0, 'cleared lines do not come back');

  page.push(evAt(20, 'qa-reviewer', 'COMPLETED', 'ผ่าน', 'qa'));
  assert.equal(page.logLines().length, 1);
  assert.equal(page.nodes.qa.dataset.status, 'COMPLETED');
});

test('browser 12 - a key change followed by the replay draws no beam and no comet; a live event afterwards does', async () => {
  const page = await openPage(BASE_MS + 2 * MIN, { scene: true });
  page.sceneReady();
  page.open();                                   // replay cutoff = 2 min
  page.session('key-A');
  page.push(evAt(130, 'secretary', 'PROCESSING', 'live in A', 'router'));   // newer than the cutoff: live
  assert.deepEqual(page.handoffs, [['user', 'router']], 'a live event draws its beam');
  assert.equal(page.sceneEvents[page.sceneEvents.length - 1].replay, false);

  // 8 minutes later the hub announces a new epoch and re-sends its buffer: these events are NEWER than the first cutoff (2 min),
  // so only a cutoff moved by the session message tells the page that they are history
  page.clock.now = BASE_MS + 10 * MIN;
  page.handoffs.length = 0;
  page.sceneEvents.length = 0;
  page.session('key-B');
  page.push(evAt(300, 'app-dev', 'PROCESSING', 'replayed start', 'appdev', 'toolu_B'));
  page.push(evAt(301, 'app-dev', 'COMPLETED', 'replayed end', 'appdev', 'toolu_B'));
  assert.deepEqual(page.handoffs, [], 'no beam for the replay');
  assert.deepEqual(page.sceneEvents.map((d) => d.replay), [true, true], 'no comet: both events reach the scene as replay');
  assert.equal(page.logLines().length, 2, 'the replay is in the log (the old view was cleared first)');

  page.push(evAt(601, 'app-dev', 'PROCESSING', 'live in B', 'appdev', 'toolu_B2'));
  assert.deepEqual(page.handoffs, [['router', 'appdev']], 'a live event after the replay draws its beam again');
  assert.equal(page.sceneEvents[page.sceneEvents.length - 1].replay, false);
});

test('browser 12b - the first session event of a page never clears; a later one with the SAME key (reconnect) does not either', async () => {
  const page = await openPage(BASE_MS + 5 * MIN);
  page.open();
  page.push(evAt(10, 'secretary', 'PROCESSING', 'before the session message', 'router'));
  page.session('key-A');
  assert.equal(page.logLines().length, 1, 'first session message: the view is kept');
  page.open();
  page.session('key-A');
  assert.equal(page.logLines().length, 1, 'same key again: the view is kept');
});

test('stale 13 - a task open longer than staleMs reads the same live and after a reload replay (age comes from the event time)', async () => {
  const { createStore } = await import(STORE_URL);
  const events = [
    evAt(1, 'app-dev', 'PROCESSING', 'old task', 'appdev', 'toolu_old'),
    evAt(2, 'qa-reviewer', 'PROCESSING', 'second task', 'qa', 'toolu_qa'),
    evAt(3, 'qa-reviewer', 'COMPLETED', 'second done', 'qa', 'toolu_qa'),
  ];
  const live = createStore({ now: () => BASE_MS + 1 * SEC });                  // the events were received when they happened
  events.forEach((ev) => live.ingest(ev));
  const reload = createStore({ now: () => BASE_MS + 45 * MIN });                // the page was reloaded 45 min later
  events.forEach((ev) => reload.ingest(ev));
  const nowMs = BASE_MS + 45 * MIN;                                             // older than the default staleMs of 30 min
  for (const agent of ['app-dev', 'qa-reviewer', 'secretary']) {
    assert.deepEqual(reload.snapshot(agent, nowMs), live.snapshot(agent, nowMs), `${agent}: same snapshot`);
  }
  const old = reload.snapshot('app-dev', nowMs);
  assert.equal(old.currentTasks[0].stale, true, 'the task is stale, not running');
  assert.equal(old.status, 'IDLE', 'a stale task does not keep the planet PROCESSING');
});
