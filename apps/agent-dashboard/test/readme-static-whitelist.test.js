'use strict';
/**
 * readme-static-whitelist.test.js - the README list of served static files matches STATIC_FILES in server.js exactly.
 *   - every key of STATIC_FILES is listed in the README (no missing file)
 *   - every path listed in the README is a key of STATIC_FILES (no stale or invented file)
 * The README block is the indented sub-list under "ให้บริการเฉพาะไฟล์ใน whitelist". Only backticked paths that start
 * with "/" are compared, so the other backticked words in the block do not count.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_FILE = path.join(__dirname, '..', 'server.js');
const README_FILE = path.join(__dirname, '..', 'README.md');
const WHITELIST_MARKER = 'ให้บริการเฉพาะไฟล์ใน whitelist';

/** Keys of the STATIC_FILES object in server.js (one "'/path': { file: ..." line per entry). */
function serverKeys() {
  const code = fs.readFileSync(SERVER_FILE, 'utf8');
  const block = code.match(/const STATIC_FILES = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'server.js declares STATIC_FILES');
  return [...block[1].matchAll(/^\s*'(\/[^']*)': \{ file:/gm)].map((m) => m[1]);
}

/** Backticked paths in the README whitelist block (the indented lines after the marker line). */
function readmeKeys() {
  const lines = fs.readFileSync(README_FILE, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes(WHITELIST_MARKER));
  assert.ok(start !== -1, 'README has the whitelist paragraph');
  const paths = [];
  for (let i = start + 1; i < lines.length && lines[i].startsWith('  '); i++) {
    for (const m of lines[i].matchAll(/`(\/[^`]*)`/g)) paths.push(m[1]);
  }
  return paths;
}

test('server.js: STATIC_FILES has no duplicate key', () => {
  const keys = serverKeys();
  assert.equal(new Set(keys).size, keys.length, 'each served path appears once');
  // Sanity: the parser really read the whitelist. Check that known required entries exist
  // (stable core paths + the Stellar hover/quality/sky-pass modules) instead of a loose count.
  const required = [
    '/',
    '/workspace/scene.js',
    '/workspace/stellar/hover.js',
    '/workspace/stellar/quality.js',
    '/workspace/stellar/sky-pass.js',
  ];
  const missingRequired = required.filter((k) => !keys.includes(k));
  assert.deepEqual(missingRequired, [], 'required served paths missing from STATIC_FILES');
});

test('README whitelist: every STATIC_FILES key is listed', () => {
  const listed = new Set(readmeKeys());
  const missing = serverKeys().filter((k) => !listed.has(k));
  assert.deepEqual(missing, [], 'served paths missing from the README');
});

test('README whitelist: every listed path is a STATIC_FILES key (nothing stale or invented)', () => {
  const served = new Set(serverKeys());
  const extra = readmeKeys().filter((k) => !served.has(k));
  assert.deepEqual(extra, [], 'README paths that server.js does not serve');
  assert.equal(new Set(readmeKeys()).size, readmeKeys().length, 'no path is listed twice');
});
