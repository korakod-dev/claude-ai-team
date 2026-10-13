#!/usr/bin/env node
'use strict';
/**
 * scripts/queue.js - read-only CLI for the main Claude session.
 *
 *   node scripts/queue.js            print ALL approved items as a JSON array
 *   node scripts/queue.js <id>       print ONE approved item (text and attachment paths) as JSON
 *   node scripts/queue.js --help     usage
 *
 * Rules:
 *   - Only APPROVED items are printed. A pending_approval item is refused (exit 2), so the session never
 *     sees a command the owner has not approved.
 *   - This script changes NOTHING. It does not move, rename or rewrite any file.
 *     To mark an item done, use POST /api/queue/done (with the dashboard running) or markDone() from
 *     lib/secretary-adapter.js. Both refuse items that are not approved.
 *   - The queue folder is taken from DASHBOARD_SECRETARY_QUEUE_DIR (default: data/secretary-queue/).
 *
 * Exit codes: 0 = ok, 1 = usage error or item not found or queue unreadable, 2 = item exists but is not approved.
 */
const config = require('../lib/config');
const { listApproved, readQueueItem, STATUS } = require('../lib/secretary-adapter');

const USAGE = 'usage: node scripts/queue.js [<id>]   (no id: list approved items; with id: one approved item)';

/** Shape printed for each item: no internal fields, attachment paths included (the session needs them). */
function printable(rec) {
  return {
    id: rec.id,
    timestamp: rec.timestamp,
    status: rec.status,
    approvedAt: rec.approvedAt,
    text: rec.text,
    attachments: rec.attachments.map((a) => ({ name: a.name, type: a.type, size: a.size, path: a.path })),
  };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const queueDir = config.SECRETARY_QUEUE_DIR;

  try {
    if (args.length === 0) {
      const items = listApproved(queueDir).map(printable);
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      return 0;
    }

    const id = args[0];
    const rec = readQueueItem(id, { queueDir });
    if (rec.status !== STATUS.APPROVED) {
      process.stderr.write(`item ${id} is not approved (status: ${rec.status}). Only approved items are printed.\n`);
      return 2;
    }
    process.stdout.write(`${JSON.stringify(printable(rec), null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err.code === 'ENOENT_QUEUE' || err.code === 'EINVAL_ID') {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    process.stderr.write(`could not read the queue: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { main, printable };
