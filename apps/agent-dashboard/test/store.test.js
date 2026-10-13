'use strict';
/**
 * store.test.js - incremental JSONL reader (QA M2): byte offset, delta only, partial lines,
 * corrupt lines, truncation, deletion, and replacement (new inode, or rewritten in place).
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventTail, parseLine, FINGERPRINT_BYTES } = require('../lib/store');

/** Fresh temp dir and events file path for one test. */
function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-store-'));
  return { file: path.join(dir, 'events.jsonl'), dir };
}

const line = (event) => `${JSON.stringify({ ts: '2026-10-11T09:00:00.000Z', event, session_id: 's' })}\n`;

test('first refresh loads the file; later refresh returns only appended records', () => {
  const { file, dir } = tempFile();
  try {
    fs.writeFileSync(file, line('A') + line('B'));
    const tail = new EventTail(file);
    const first = tail.refresh();
    assert.deepEqual(first.added.map((r) => r.event), ['A', 'B']);
    assert.equal(first.reset, false);

    const idle = tail.refresh();
    assert.equal(idle.added.length, 0);

    fs.appendFileSync(file, line('C'));
    const delta = tail.refresh();
    assert.deepEqual(delta.added.map((r) => r.event), ['C']);
    assert.equal(delta.reset, false, 'appending must not look like a replacement');
    assert.equal(tail.records.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh reads only the new bytes (no full re-read)', () => {
  const { file, dir } = tempFile();
  const originalReadSync = fs.readSync;
  try {
    const initial = line('A').repeat(50); // a big initial file
    fs.writeFileSync(file, initial);
    const tail = new EventTail(file);
    tail.refresh();

    const appended = line('NEW');
    fs.appendFileSync(file, appended);

    const reads = [];
    fs.readSync = function patched(fd, buffer, offset, length, position) {
      reads.push({ length, position });
      return originalReadSync.call(this, fd, buffer, offset, length, position);
    };
    tail.refresh();
    fs.readSync = originalReadSync;

    // The replacement check reads the file head (position 0, at most the cached first line) to compare it.
    // Every other read must be the appended bytes only, starting where the last read ended.
    const head = reads.filter((r) => r.position === 0);
    const delta = reads.filter((r) => r.position !== 0);
    assert.ok(head.every((r) => r.length <= FINGERPRINT_BYTES), 'head check is bounded');
    assert.deepEqual(delta, [{ length: Buffer.byteLength(appended), position: Buffer.byteLength(initial) }],
      'only the appended bytes may be read');
  } finally {
    fs.readSync = originalReadSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('partial last line is held until its newline arrives', () => {
  const { file, dir } = tempFile();
  try {
    const full = line('PARTIAL');
    const cut = full.indexOf('"event"') + 5; // cut in the middle of the JSON text
    fs.writeFileSync(file, full.slice(0, cut));
    const tail = new EventTail(file);
    assert.equal(tail.refresh().added.length, 0);

    fs.appendFileSync(file, full.slice(cut));
    const done = tail.refresh();
    assert.deepEqual(done.added.map((r) => r.event), ['PARTIAL']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('complete JSON object without trailing newline is accepted at once', () => {
  const { file, dir } = tempFile();
  try {
    fs.writeFileSync(file, JSON.stringify({ ts: '2026-10-11T09:00:00.000Z', event: 'NoNL', session_id: 's' }));
    const tail = new EventTail(file);
    assert.deepEqual(tail.refresh().added.map((r) => r.event), ['NoNL']);
    fs.appendFileSync(file, '\n'); // the newline later is a blank line and adds nothing
    assert.equal(tail.refresh().added.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt lines are skipped and do not stop later lines', () => {
  const { file, dir } = tempFile();
  try {
    fs.writeFileSync(file, `${line('A')}{not json\n\n[1,2]\n${line('B')}`);
    const tail = new EventTail(file);
    assert.deepEqual(tail.refresh().added.map((r) => r.event), ['A', 'B']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('truncated file resets the store and reloads from the start', () => {
  const { file, dir } = tempFile();
  try {
    fs.writeFileSync(file, line('OLD1') + line('OLD2') + line('OLD3'));
    const tail = new EventTail(file);
    tail.refresh();
    assert.equal(tail.records.length, 3);

    fs.writeFileSync(file, line('FRESH'));
    const res = tail.refresh();
    assert.equal(res.reset, true);
    assert.deepEqual(tail.records.map((r) => r.event), ['FRESH']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing file is not an error; file created later is picked up', () => {
  const { file, dir } = tempFile();
  try {
    const tail = new EventTail(file);
    assert.deepEqual(tail.refresh(), { added: [], reset: false });
    fs.writeFileSync(file, line('LATER'));
    assert.deepEqual(tail.refresh().added.map((r) => r.event), ['LATER']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleted file resets the store', () => {
  const { file, dir } = tempFile();
  try {
    fs.writeFileSync(file, line('A'));
    const tail = new EventTail(file);
    tail.refresh();
    fs.unlinkSync(file);
    const res = tail.refresh();
    assert.equal(res.reset, true);
    assert.equal(tail.records.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file replaced by rename (new inode) resets and reloads the new file from byte 0', () => {
  const { file, dir } = tempFile();
  try {
    fs.writeFileSync(file, line('OLD1') + line('OLD2'));
    const tail = new EventTail(file);
    tail.refresh();
    const oldIno = fs.statSync(file).ino;

    // Write the replacement next to the file, then rename it over the old one.
    // It is LARGER than the old file, so a size-only check would miss the change.
    const next = path.join(dir, 'next.jsonl');
    fs.writeFileSync(next, line('NEW1') + line('NEW2') + line('NEW3'));
    fs.renameSync(next, file);
    assert.notEqual(fs.statSync(file).ino, oldIno, 'precondition: the replacement has a new inode');

    const res = tail.refresh();
    assert.equal(res.reset, true, 'replacement must be reported as a reset');
    assert.deepEqual(res.added.map((r) => r.event), ['NEW1', 'NEW2', 'NEW3']);
    assert.deepEqual(tail.records.map((r) => r.event), ['NEW1', 'NEW2', 'NEW3']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file rewritten in place (same inode, grown past the old offset) is detected by the first-line fingerprint', () => {
  const { file, dir } = tempFile();
  try {
    fs.writeFileSync(file, line('OLD1') + line('OLD2'));
    const tail = new EventTail(file);
    tail.refresh();
    const ino = fs.statSync(file).ino;
    const oldSize = fs.statSync(file).size;

    // Control: a normal append keeps the first line, so it is NOT a replacement.
    fs.appendFileSync(file, line('OLD3'));
    assert.equal(tail.refresh().reset, false, 'control: append must not reset');

    // Rewrite in place: writeFileSync truncates the SAME inode and writes more bytes than before.
    fs.writeFileSync(file, line('NEW1') + line('NEW2') + line('NEW3') + line('NEW4'));
    assert.equal(fs.statSync(file).ino, ino, 'precondition: same inode');
    assert.ok(fs.statSync(file).size > oldSize, 'precondition: file grew past the old size');

    const res = tail.refresh();
    assert.equal(res.reset, true, 'first-line change must be reported as a reset');
    assert.deepEqual(tail.records.map((r) => r.event), ['NEW1', 'NEW2', 'NEW3', 'NEW4']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseLine accepts only JSON objects', () => {
  assert.deepEqual(parseLine('{"a":1}'), { a: 1 });
  assert.equal(parseLine('null'), undefined);
  assert.equal(parseLine('42'), undefined);
  assert.equal(parseLine('   '), undefined);
  assert.equal(parseLine('{oops'), undefined);
});

test('first line longer than 4 KB: an in-place rewrite that changes only bytes after 4 KB is detected', () => {
  const { file, dir } = tempFile();
  try {
    // The first line is about 5 KB. The two versions differ at byte ~4500, past the old 4 KB head window,
    // so a 4 KB fingerprint could not see the change.
    const bigLine = (mark) => `${JSON.stringify({
      ts: '2026-10-11T09:00:00.000Z',
      event: 'BIG',
      session_id: 's',
      pad: `${'a'.repeat(4500)}${mark}${'a'.repeat(500)}`,
    })}\n`;
    assert.ok(Buffer.byteLength(bigLine('x')) > 4096, 'precondition: first line is longer than 4 KB');

    fs.writeFileSync(file, bigLine('x') + line('OLD2'));
    const tail = new EventTail(file);
    assert.equal(tail.refresh().added.length, 2);
    const ino = fs.statSync(file).ino;
    const oldSize = fs.statSync(file).size;

    // Rewrite in place (same inode) with a larger file. Only the 5 KB first line differs.
    fs.writeFileSync(file, bigLine('y') + line('NEW2') + line('NEW3') + line('NEW4'));
    assert.equal(fs.statSync(file).ino, ino, 'precondition: same inode');
    assert.ok(fs.statSync(file).size > oldSize, 'precondition: file grew past the old offset');

    const res = tail.refresh();
    assert.equal(res.reset, true, 'a change after 4 KB of the first line must be reported as a reset');
    assert.deepEqual(tail.records.map((r) => r.event), ['BIG', 'NEW2', 'NEW3', 'NEW4']);
    assert.equal(tail.records[0].pad[4500], 'y', 'the new first line is the one that was read');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a read failure right after a reset keeps the reset pending: the next successful refresh still reports reset:true', () => {
  const { file, dir } = tempFile();
  const realOpen = fs.openSync;
  try {
    fs.writeFileSync(file, line('OLD1') + line('OLD2'));
    const tail = new EventTail(file);
    tail.refresh();

    // Replace the file by rename (new inode, larger), then make every open() of it fail once.
    const next = path.join(dir, 'next.jsonl');
    fs.writeFileSync(next, line('NEW1') + line('NEW2') + line('NEW3'));
    fs.renameSync(next, file);
    fs.openSync = (p, ...rest) => {
      if (p === file) throw Object.assign(new Error('EACCES: permission denied (test)'), { code: 'EACCES' });
      return realOpen(p, ...rest);
    };
    assert.throws(() => tail.refresh(), /EACCES/, 'the read after the reset fails');
    assert.equal(tail.records.length, 0, 'the old records are already gone');

    // The failure goes away. dev/ino were updated by the failed round, so only the pending flag can report the reset.
    fs.openSync = realOpen;
    const res = tail.refresh();
    assert.equal(res.reset, true, 'the reset is reported by the first successful refresh');
    assert.deepEqual(res.added.map((r) => r.event), ['NEW1', 'NEW2', 'NEW3'], 'only the new file content, no old records mixed in');
    assert.deepEqual(tail.records.map((r) => r.event), ['NEW1', 'NEW2', 'NEW3']);

    // And it is reported exactly once
    fs.appendFileSync(file, line('NEW4'));
    const later = tail.refresh();
    assert.equal(later.reset, false);
    assert.deepEqual(later.added.map((r) => r.event), ['NEW4']);
  } finally {
    fs.openSync = realOpen;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two failed refreshes in a row after a reset: the reset stays pending and is reported exactly once by the first good refresh', () => {
  const { file, dir } = tempFile();
  const realOpen = fs.openSync;
  try {
    fs.writeFileSync(file, line('OLD1') + line('OLD2'));
    const tail = new EventTail(file);
    tail.refresh();

    const next = path.join(dir, 'next.jsonl');
    fs.writeFileSync(next, line('NEW1') + line('NEW2') + line('NEW3'));
    fs.renameSync(next, file);
    fs.openSync = (p, ...rest) => {
      if (p === file) throw Object.assign(new Error('EACCES: permission denied (test)'), { code: 'EACCES' });
      return realOpen(p, ...rest);
    };
    // The first failure consumes the "replaced" signal (dev/ino are updated); the second one must not lose the flag
    assert.throws(() => tail.refresh(), /EACCES/, 'first failing refresh');
    assert.throws(() => tail.refresh(), /EACCES/, 'second failing refresh');
    assert.equal(tail.records.length, 0, 'old records stay gone while reads fail');

    fs.openSync = realOpen;
    const res = tail.refresh();
    assert.equal(res.reset, true, 'reset reported by the first good refresh');
    assert.deepEqual(res.added.map((r) => r.event), ['NEW1', 'NEW2', 'NEW3']);
    assert.equal(tail.refresh().reset, false, 'reported only once');
  } finally {
    fs.openSync = realOpen;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the file is replaced AGAIN while reads fail: after recovery only the newest file is loaded, with one reset', () => {
  const { file, dir } = tempFile();
  const realOpen = fs.openSync;
  try {
    fs.writeFileSync(file, line('OLD1') + line('OLD2'));
    const tail = new EventTail(file);
    tail.refresh();

    // Replacement #1 (new inode, larger) and a failing read
    const swap = (name, content) => {
      const tmp = path.join(dir, name);
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, file);
    };
    swap('r1.jsonl', line('MID1') + line('MID2') + line('MID3'));
    fs.openSync = (p, ...rest) => {
      if (p === file) throw Object.assign(new Error('EACCES: permission denied (test)'), { code: 'EACCES' });
      return realOpen(p, ...rest);
    };
    assert.throws(() => tail.refresh(), /EACCES/, 'read of replacement #1 fails');

    // Replacement #2 while still failing: yet another inode, different (and shorter) content
    swap('r2.jsonl', line('LAST1') + line('LAST2'));
    assert.throws(() => tail.refresh(), /EACCES/, 'read of replacement #2 fails too');
    assert.equal(tail.records.length, 0, 'nothing from any older file is kept');

    // Recovery: only the newest file, reported as ONE reset
    fs.openSync = realOpen;
    const res = tail.refresh();
    assert.equal(res.reset, true);
    assert.deepEqual(res.added.map((r) => r.event), ['LAST1', 'LAST2'], 'no record of OLD or MID files');
    assert.deepEqual(tail.records.map((r) => r.event), ['LAST1', 'LAST2']);

    // And appends continue normally afterwards (offset points into the newest file)
    fs.appendFileSync(file, line('LAST3'));
    const later = tail.refresh();
    assert.equal(later.reset, false);
    assert.deepEqual(later.added.map((r) => r.event), ['LAST3']);
  } finally {
    fs.openSync = realOpen;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
