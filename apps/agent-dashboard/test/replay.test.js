'use strict';
/**
 * replay.test.js - runs scripts/replay.js as a child process against a temp events file.
 * Checks: events appended with a replay session id, --reset clears the file, bad args fail.
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPLAY = path.join(__dirname, '..', 'scripts', 'replay.js');
const SAMPLE = path.join(__dirname, '..', 'samples', 'sample-session.jsonl');

/** Temp dir with an events file path; the replay script is pointed at it via env. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-replay-'));
  return { dir, file: path.join(dir, 'events.jsonl') };
}

/** Run replay.js with the given args against the temp events file. */
function runReplay(file, args) {
  return spawnSync(process.execPath, [REPLAY, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, DASHBOARD_EVENTS_FILE: file },
  });
}

test('replay appends every sample event under one new replay session id', () => {
  const { dir, file } = setup();
  try {
    const res = runReplay(file, ['--delay', '0', '--file', SAMPLE]);
    assert.equal(res.status, 0, res.stderr);
    const sampleCount = fs.readFileSync(SAMPLE, 'utf8').split('\n').filter((l) => l.trim()).length;
    const recs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(recs.length, sampleCount);
    const ids = new Set(recs.map((r) => r.session_id));
    assert.equal(ids.size, 1);
    assert.ok([...ids][0].startsWith('replay-'));
    assert.match(res.stdout, /Replayed \d+ events/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replay twice gives two different session ids (runs do not mix)', () => {
  const { dir, file } = setup();
  try {
    runReplay(file, ['--delay', '0']);
    runReplay(file, ['--delay', '0']);
    const ids = new Set(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l).session_id));
    assert.equal(ids.size, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replay --reset deletes the old events first', () => {
  const { dir, file } = setup();
  try {
    fs.writeFileSync(file, '{"ts":"2026-01-01T00:00:00.000Z","event":"OLD","session_id":"old"}\n');
    const res = runReplay(file, ['--reset', '--delay', '0', '--file', SAMPLE]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.readFileSync(file, 'utf8').includes('"session_id":"old"'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replay rejects unknown flags and a negative delay', () => {
  const { dir, file } = setup();
  try {
    const unknown = runReplay(file, ['--nope']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown argument/);
    const negative = runReplay(file, ['--delay', '-5']);
    assert.equal(negative.status, 1);
    assert.match(negative.stderr, /--delay must be/);
    assert.equal(fs.existsSync(file), false, 'failed runs must not write events');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
