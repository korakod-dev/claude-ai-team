'use strict';
/**
 * store.js
 * Incremental reader for the JSONL events file (QA M2).
 *
 * The file is read ONCE. After that, each refresh() reads only the bytes appended since the
 * last call (tracked by a byte offset) and parses only those new lines. Parsed records are
 * kept in memory, so no client or timer ever re-reads or re-parses the whole file.
 *
 *  - Missing file = no records (not an error).
 *  - Corrupt complete lines are skipped (same behaviour as the old full reader).
 *  - A trailing partial line (writer still writing) is kept in a carry buffer until its
 *    newline arrives. If it already parses as a JSON object it is accepted at once.
 *  - Truncated or deleted file (size < offset) = reset: records are reloaded from the start.
 *  - Replaced file = reset, detected in two ways:
 *      1. the device/inode changed (file replaced by rename, or deleted and created again);
 *      2. the first complete line changed while the size stayed >= offset (file rewritten in
 *         place, for example with `>`, and grown past the old offset). The bytes of the first
 *         line (+ newline) are cached once they exist; each refresh reads only that many bytes
 *         from the start of the file and compares them with the cache. The first line is looked
 *         for in the head window (max FINGERPRINT_BYTES), so lines up to that size are covered.
 *    On reset, refresh() re-reads from byte 0 and reports `reset: true` so the caller sends a
 *    full state.
 */

const fs = require('fs');

const NEWLINE = 0x0a;
const MAX_CARRY_BYTES = 1024 * 1024; // an unfinished line bigger than this is treated as corrupt
// Head window used to find the first complete line (replacement check). 64 KB, so a first line
// up to about 64 KB still works as a fingerprint (a 4 KB window missed longer first lines).
const FINGERPRINT_BYTES = 64 * 1024;

/** Parse one line. Returns the object, or undefined for blank, corrupt or non-object lines. */
function parseLine(text) {
  if (!text.trim()) return undefined;
  try {
    const value = JSON.parse(text);
    // Only plain objects are hook records; null, numbers, strings and arrays are skipped.
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch (_err) {
    return undefined; // corrupt or partially written line: skip it
  }
}

/** fs.statSync that returns null for a missing file (not an error). */
function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Read up to `length` bytes starting at `position`.
 * Returns fewer bytes (possibly none) if the file shrank or vanished in the meantime.
 */
function readRange(file, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  let bytes = 0;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    bytes = fs.readSync(fd, buf, 0, length, position);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // file vanished between stat and open: nothing to read
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return buf.subarray(0, bytes);
}

/**
 * Bytes of the first COMPLETE line of the file (including its newline), or null when the file
 * has no complete first line inside the head window yet. An append-only file never changes that
 * line, so these bytes work as a fingerprint of the file's identity. A copy is returned so the
 * large head window buffer is not kept alive.
 */
function captureHead(file, size) {
  const head = readRange(file, 0, Math.min(size, FINGERPRINT_BYTES));
  const nl = head.indexOf(NEWLINE);
  return nl >= 0 ? Buffer.from(head.subarray(0, nl + 1)) : null;
}

class EventTail {
  /** @param {string} file  path to the JSONL events file */
  constructor(file) {
    this.file = file;
    this.offset = 0;                // bytes already consumed from the file
    this.carry = Buffer.alloc(0);   // bytes after the last newline (unfinished line)
    this.records = [];              // all parsed records, in file order
    this.dev = null;                // device id of the file being read (null = no file seen)
    this.ino = null;                // inode of the file being read
    this.head = null;               // cached bytes of the first complete line + newline (null until it exists)
    // True from the moment a replacement/truncation is detected until a refresh() has read the new file
    // successfully and reported `reset: true`. If the read throws in between, dev/ino are already updated and
    // wasReplaced() would no longer notice the change, so this flag alone keeps the caller's reset pending.
    this.pendingReset = false;
  }

  /** Forget everything and start again from byte 0 (used on truncation, deletion or replacement). */
  reset() {
    this.offset = 0;
    this.carry = Buffer.alloc(0);
    this.records = [];
    this.head = null;
  }

  /**
   * True when the file we were reading is no longer the same file: truncated, deleted,
   * replaced (new inode or device) or rewritten in place (first line changed).
   * @param {fs.Stats|null} st  current stat of the file (null = missing)
   * @param {number} size       current size (0 when missing)
   */
  wasReplaced(st, size) {
    if (size < this.offset) return true;   // truncated or deleted (for example by `npm run replay:reset`)
    if (!st) return false;
    // New inode or device = the path now points to a different file (rename, recreate).
    if (this.ino !== null && (st.ino !== this.ino || st.dev !== this.dev)) return true;
    // Same inode, first line changed = rewritten in place and grown past our offset.
    // Read only as many bytes as the cached first line and compare (a shorter read = changed).
    if (this.head !== null && size > 0 && !readRange(this.file, 0, this.head.length).equals(this.head)) return true;
    return false;
  }

  /**
   * Read only the bytes appended since the last call.
   * @returns {{ added: object[], reset: boolean }}
   *   added: records parsed in this call (in file order; after a reset, all records of the file)
   *   reset: true when the file was truncated, deleted or replaced, so `records` was reloaded from scratch
   */
  refresh() {
    const st = statOrNull(this.file);
    const size = st ? st.size : 0;

    if (this.wasReplaced(st, size)) {
      this.reset();
      this.pendingReset = true;   // stays set until the read below has succeeded (see constructor)
    }
    // Remember which file we are reading now (checked again on the next call).
    this.dev = st ? st.dev : null;
    this.ino = st ? st.ino : null;

    // Cache the first line's bytes as soon as it is complete (used by wasReplaced on later calls).
    if (this.head === null && size > 0) this.head = captureHead(this.file, size);

    if (size <= this.offset) {
      return { added: [], reset: this.takeReset() };
    }

    // Read only the new byte range [offset, size).
    const buf = readRange(this.file, this.offset, size - this.offset);
    this.offset += buf.length;

    // Split into complete lines and an unfinished tail.
    const chunk = Buffer.concat([this.carry, buf]);
    const lastNewline = chunk.lastIndexOf(NEWLINE);
    const complete = lastNewline >= 0 ? chunk.subarray(0, lastNewline) : Buffer.alloc(0);
    let rest = lastNewline >= 0 ? chunk.subarray(lastNewline + 1) : chunk;

    const added = [];
    if (complete.length) {
      for (const line of complete.toString('utf8').split('\n')) {
        const rec = parseLine(line);
        if (rec) added.push(rec);
      }
    }

    // Unfinished tail: accept it if it is already a complete JSON object, otherwise keep waiting.
    if (rest.length) {
      const rec = parseLine(rest.toString('utf8'));
      if (rec) {
        added.push(rec);
        rest = Buffer.alloc(0);
      } else if (rest.length > MAX_CARRY_BYTES) {
        rest = Buffer.alloc(0); // never-finished garbage: drop it
      }
    }
    this.carry = rest;

    for (const rec of added) this.records.push(rec);
    return { added, reset: this.takeReset() };
  }

  /** Report (and clear) a pending reset. Called only on the success paths of refresh(). */
  takeReset() {
    const reset = this.pendingReset;
    this.pendingReset = false;
    return reset;
  }
}

module.exports = { EventTail, parseLine, FINGERPRINT_BYTES };
