'use strict';
/**
 * lib/secretary-adapter.js
 *
 * File-queue adapter for the Secretary (เลขา). This is the single place where a command from
 * /workspace is handed over to the Secretary, and where the owner's approval is recorded.
 *
 * How it works (option b, owner-approved, format secretary-queue/v2):
 *   - forwardToSecretary() writes ONE JSON file per command into the queue folder
 *     (default: data/secretary-queue/, see lib/config.js SECRETARY_QUEUE_DIR), with status "pending_approval".
 *   - Nothing runs by itself. The owner approves an item on the dashboard (approveItem: status becomes
 *     "approved", the file stays in the queue folder). The main Claude Code session then reads the
 *     approved items (listApproved, or scripts/queue.js) and runs them only when the owner asks.
 *   - rejectItem() moves an item to rejected/ (no file is deleted).
 *   - markDone() moves an APPROVED item to done/ once the session has handled it.
 *   - This module never spawns `claude -p` and never calls any model.
 *   - Uploaded files are NOT copied into the queue. They stay in data/uploads/<id>/ and the queue
 *     file points to them by absolute path (keeps the queue small, no base64 inline).
 *
 * Folder layout:
 *   <queueDir>/<id>.json            pending_approval and approved items (the "open" items)
 *   <queueDir>/done/<id>.json       done items
 *   <queueDir>/rejected/<id>.json   rejected items
 *
 * Migration: v1 items (format "secretary-queue/v1", no "status" field) are read as pending_approval.
 * They are NOT rewritten or moved at startup. A file is only rewritten when the owner acts on it.
 *
 * Atomic writes: JSON is written to a temp file whose name starts with "." and then renamed over the
 * final name. rename() is atomic on the same filesystem, so a reader never sees a half-written file.
 *
 * Queue file format is documented in README.md ("Secretary queue format").
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const QUEUE_FORMAT = 'secretary-queue/v2';
const DONE_DIR_NAME = 'done';           // sub-folder of the queue folder for finished items
const REJECTED_DIR_NAME = 'rejected';   // sub-folder of the queue folder for rejected items
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/; // command ids: no dots or slashes (no path tricks)

// Item states. Only pending_approval and approved are "open" (listed in the queue).
const STATUS = Object.freeze({
  PENDING_APPROVAL: 'pending_approval',
  APPROVED: 'approved',
  DONE: 'done',
  REJECTED: 'rejected',
});
const KNOWN_STATUSES = Object.values(STATUS);

/** Build an Error with a short code the callers check (e.g. ENOENT_QUEUE). */
function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

/** Throw EINVAL_ID unless id is a safe command id. */
function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw codedError('EINVAL_ID', 'invalid command id');
  }
}

/**
 * Write a JSON object to finalPath atomically (temp file in the same folder, fsync, then rename).
 * Throws on failure and removes the temp file.
 */
function writeJsonAtomic(finalPath, obj) {
  const dir = path.dirname(finalPath);
  // Temp name starts with "." so readers that list "*.json" skip it. Random suffix avoids clashes.
  const tmpPath = path.join(dir, `.${path.basename(finalPath)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmpPath, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(obj, null, 2)}\n`);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Read one queue file as a raw object. Throws the fs error (for example ENOENT) when the file cannot be read.
 * A file that is not a JSON object is returned as { corrupt: true } (it is still listed, so the owner can reject it).
 * @returns {{ raw: object|null, corrupt: boolean }}
 */
function readRawItem(file) {
  const text = fs.readFileSync(file, 'utf8');
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (_err) {
    return { raw: null, corrupt: true };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { raw: null, corrupt: true };
  return { raw, corrupt: false };
}

/**
 * Turn a raw queue object into the record the code uses. Only attachment names, sizes and paths are kept
 * from the attachment list. A missing or unknown status is treated as pending_approval (fail closed: the
 * owner must approve it first). This is the v1 migration rule.
 */
function toRecord(id, raw) {
  const status = KNOWN_STATUSES.includes(raw.status) ? raw.status : STATUS.PENDING_APPROVAL;
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments
      .filter((a) => a && typeof a === 'object')
      .map((a) => ({
        name: String(a.name ?? ''),
        type: String(a.type ?? ''),
        size: Number(a.size) || 0,
        path: String(a.path ?? ''),
      }))
    : [];
  return {
    id,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : null,
    text: typeof raw.text === 'string' ? raw.text : '',
    status,
    approvedAt: typeof raw.approvedAt === 'string' ? raw.approvedAt : null,
    corrupt: false,
    attachments,
  };
}

/** Record for a queue file that is not valid JSON. It is shown as pending_approval so the owner can reject it. */
function corruptRecord(id) {
  return {
    id,
    timestamp: null,
    text: '',
    status: STATUS.PENDING_APPROVAL,
    approvedAt: null,
    corrupt: true,
    attachments: [],
  };
}

/**
 * Write one queue file for a command (status pending_approval), atomically.
 * @param {{ id: string, timestamp: string, text: string, dir: string,
 *           files: Array<{name: string, storedAs: string, type: string, size: number}> }} command
 *        dir = absolute folder that holds the uploaded files (data/uploads/<id>)
 * @param {{ queueDir?: string }} [opts]  queueDir overrides the default (tests use a temp folder)
 * @returns {{ accepted: true, mode: 'queue', queued: string }}  queued = file name inside the queue
 * @throws  when the queue folder or file cannot be written (the hub turns this into an ERROR event)
 */
function forwardToSecretary(command, opts = {}) {
  const queueDir = opts.queueDir || config.SECRETARY_QUEUE_DIR;

  // Queue record. Attachments carry the absolute path of the stored file, not its bytes.
  const record = {
    format: QUEUE_FORMAT,
    id: command.id,
    timestamp: command.timestamp,
    text: command.text,
    status: STATUS.PENDING_APPROVAL,
    attachments: command.files.map((f) => ({
      name: f.name,
      type: f.type,
      size: f.size,
      path: path.join(command.dir, f.storedAs),
    })),
  };

  fs.mkdirSync(queueDir, { recursive: true });
  writeJsonAtomic(path.join(queueDir, `${command.id}.json`), record);
  return { accepted: true, mode: 'queue', queued: `${command.id}.json` };
}

/**
 * Read one item from the queue folder (read only, any status). Does not create or move anything.
 * @param {string} id
 * @param {{ queueDir?: string }} [opts]
 * @returns {object} record: { id, timestamp, text, status, approvedAt, corrupt, attachments: [{name, type, size, path}] }
 * @throws  EINVAL_ID for an unsafe id, ENOENT_QUEUE when the item is not in the queue folder
 */
function readQueueItem(id, opts = {}) {
  const queueDir = opts.queueDir || config.SECRETARY_QUEUE_DIR;
  assertId(id);
  let read;
  try {
    read = readRawItem(path.join(queueDir, `${id}.json`));
  } catch (err) {
    if (err.code === 'ENOENT') throw codedError('ENOENT_QUEUE', `queue item not found: ${id}`);
    throw err;
  }
  return read.corrupt ? corruptRecord(id) : toRecord(id, read.raw);
}

/**
 * List the open items (pending_approval and approved) in the queue folder, oldest first.
 * Ignores temp files (names starting with "."), non-JSON files, and any id that also exists in done/ or
 * rejected/. A missing queue folder gives [].
 * @param {string} [queueDir]
 * @returns {object[]} records (see readQueueItem)
 */
function listOpenItems(queueDir = config.SECRETARY_QUEUE_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(queueDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const doneDir = path.join(queueDir, DONE_DIR_NAME);
  const rejectedDir = path.join(queueDir, REJECTED_DIR_NAME);
  const ids = entries
    .filter((d) => d.isFile() && d.name.endsWith('.json') && !d.name.startsWith('.'))
    .map((d) => d.name.slice(0, -'.json'.length))
    .filter((id) => ID_RE.test(id))
    .sort();

  const items = [];
  for (const id of ids) {
    if (fs.existsSync(path.join(doneDir, `${id}.json`)) || fs.existsSync(path.join(rejectedDir, `${id}.json`))) {
      continue;
    }
    let read;
    try {
      read = readRawItem(path.join(queueDir, `${id}.json`));
    } catch (err) {
      if (err.code === 'ENOENT') continue; // removed between readdir and read
      throw err;
    }
    const rec = read.corrupt ? corruptRecord(id) : toRecord(id, read.raw);
    if (rec.status === STATUS.PENDING_APPROVAL || rec.status === STATUS.APPROVED) items.push(rec);
  }
  return items;
}

/**
 * List the ids of items waiting for the owner's approval (oldest first).
 * Corrupt files are included, so the owner can see and reject them.
 * @param {string} [queueDir]
 * @returns {string[]}
 */
function listPending(queueDir = config.SECRETARY_QUEUE_DIR) {
  return listOpenItems(queueDir)
    .filter((rec) => rec.status === STATUS.PENDING_APPROVAL)
    .map((rec) => rec.id);
}

/**
 * List the approved items (oldest first), with full records (attachment paths included).
 * This is what the main Claude session reads. Read only: nothing is changed.
 * @param {string} [queueDir]
 * @returns {object[]} records with status "approved" only
 */
function listApproved(queueDir = config.SECRETARY_QUEUE_DIR) {
  return listOpenItems(queueDir).filter((rec) => rec.status === STATUS.APPROVED);
}

/**
 * Approve one pending item (owner action). The file stays in the queue folder; status becomes "approved"
 * and approvedAt is set. The file is rewritten atomically. A v1 file is rewritten to format v2 here.
 * @returns {{ id: string, status: 'approved', approvedAt: string }}
 * @throws  EINVAL_ID, ENOENT_QUEUE (not in the queue folder), EUNREADABLE (not valid JSON),
 *          ENOT_PENDING (status is not pending_approval; err.status holds the current status)
 */
function approveItem(id, opts = {}) {
  const queueDir = opts.queueDir || config.SECRETARY_QUEUE_DIR;
  assertId(id);
  const file = path.join(queueDir, `${id}.json`);
  let read;
  try {
    read = readRawItem(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw codedError('ENOENT_QUEUE', `queue item not found: ${id}`);
    throw err;
  }
  if (read.corrupt) throw codedError('EUNREADABLE', 'queue item file is not valid JSON', { status: 'unreadable' });
  const current = toRecord(id, read.raw).status;
  if (current !== STATUS.PENDING_APPROVAL) {
    throw codedError('ENOT_PENDING', `queue item is ${current}, not pending_approval`, { status: current });
  }
  const approvedAt = new Date().toISOString();
  writeJsonAtomic(file, { ...read.raw, format: QUEUE_FORMAT, status: STATUS.APPROVED, approvedAt });
  return { id, status: STATUS.APPROVED, approvedAt };
}

/**
 * Reject one open item (owner action). The file is MOVED to rejected/ (never deleted), then its status
 * is set to "rejected" with rejectedAt. Works for pending_approval and approved items (cancel before Claude runs it),
 * and for unreadable files.
 * @returns {{ id: string, status: 'rejected', path: string, recordUpdated: boolean, recordError: string|null }}
 *          recordUpdated=false means the move worked but the status field could not be written (the folder is the source of truth)
 * @throws  EINVAL_ID, ENOENT_QUEUE
 */
function rejectItem(id, opts = {}) {
  const queueDir = opts.queueDir || config.SECRETARY_QUEUE_DIR;
  assertId(id);
  const from = path.join(queueDir, `${id}.json`);
  const rejectedDir = path.join(queueDir, REJECTED_DIR_NAME);
  const to = path.join(rejectedDir, `${id}.json`);

  let read;
  try {
    read = readRawItem(from);
  } catch (err) {
    if (err.code === 'ENOENT') throw codedError('ENOENT_QUEUE', `queue item not found: ${id}`);
    throw err;
  }
  fs.mkdirSync(rejectedDir, { recursive: true });
  try {
    fs.renameSync(from, to); // atomic: the item is either open or rejected, never both
  } catch (err) {
    if (err.code === 'ENOENT') throw codedError('ENOENT_QUEUE', `queue item not found: ${id}`);
    throw err;
  }

  // Record the new status inside the moved file (best effort: the move already happened)
  let recordUpdated = false;
  let recordError = null;
  if (!read.corrupt) {
    try {
      writeJsonAtomic(to, { ...read.raw, format: QUEUE_FORMAT, status: STATUS.REJECTED, rejectedAt: new Date().toISOString() });
      recordUpdated = true;
    } catch (err) {
      recordError = err.message;
    }
  }
  return { id, status: STATUS.REJECTED, path: to, recordUpdated, recordError };
}

/**
 * Mark one APPROVED item as done by moving "<queueDir>/<id>.json" to "<queueDir>/done/<id>.json".
 * Items that are still pending_approval (or unreadable) are refused with ENOT_APPROVED.
 * Safe to call again: a second call for an item already in done/ returns alreadyDone: true.
 * @param {string} id  command id (letters, digits, "-" and "_" only)
 * @param {{ queueDir?: string }} [opts]
 * @returns {{ id: string, alreadyDone: boolean, path: string, recordUpdated: boolean, recordError: string|null }}
 *          path = the done/ file
 * @throws  code 'EINVAL_ID' for an unsafe id, 'ENOENT_QUEUE' when neither folder has the item,
 *          'ENOT_APPROVED' when the item is not approved (err.status holds its status),
 *          any other fs error (for example EACCES) is passed through
 */
function markDone(id, opts = {}) {
  const queueDir = opts.queueDir || config.SECRETARY_QUEUE_DIR;
  assertId(id);
  const from = path.join(queueDir, `${id}.json`);
  const doneDir = path.join(queueDir, DONE_DIR_NAME);
  const to = path.join(doneDir, `${id}.json`);

  let read;
  try {
    read = readRawItem(from);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (fs.existsSync(to)) return { id, alreadyDone: true, path: to, recordUpdated: false, recordError: null };
    throw codedError('ENOENT_QUEUE', `queue item not found: ${id}`);
  }
  const status = read.corrupt ? 'unreadable' : toRecord(id, read.raw).status;
  if (read.corrupt || status !== STATUS.APPROVED) {
    throw codedError('ENOT_APPROVED', `queue item is ${status}, not approved`, { status });
  }

  fs.mkdirSync(doneDir, { recursive: true });
  try {
    fs.renameSync(from, to); // atomic: the item is either open or done, never both
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    if (fs.existsSync(to)) return { id, alreadyDone: true, path: to, recordUpdated: false, recordError: null };
    throw codedError('ENOENT_QUEUE', `queue item not found: ${id}`);
  }

  // Record the new status inside the moved file (best effort: the move already happened)
  let recordUpdated = true;
  let recordError = null;
  try {
    writeJsonAtomic(to, { ...read.raw, format: QUEUE_FORMAT, status: STATUS.DONE, doneAt: new Date().toISOString() });
  } catch (err) {
    recordUpdated = false;
    recordError = err.message;
  }
  return { id, alreadyDone: false, path: to, recordUpdated, recordError };
}

module.exports = {
  forwardToSecretary,
  markDone,
  approveItem,
  rejectItem,
  listPending,
  listApproved,
  listOpenItems,
  readQueueItem,
  QUEUE_FORMAT,
  STATUS,
  DONE_DIR_NAME,
  REJECTED_DIR_NAME,
};
