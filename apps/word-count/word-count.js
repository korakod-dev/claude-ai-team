#!/usr/bin/env node
// word-count.js
// Counts words in a plain-text file and prints the count to stdout.
//
// Usage: node word-count.js <path-to-text-file>
//
// Word definition: a run of non-whitespace characters, split on /\s+/.
// NOTE: Thai has no spaces between words, so this method will UNDERCOUNT
// Thai text (a whole Thai sentence without spaces counts as one "word").
// Use a dictionary-based word segmenter (e.g. Intl.Segmenter with
// granularity "word", or a Thai tokenizer library) if accurate Thai counts
// are needed.

'use strict';

const fs = require('fs');

/**
 * Print an error message to stderr and exit with a non-zero code.
 * @param {string} message - Human-readable error text.
 * @param {number} [code=1] - Process exit code.
 */
function fail(message, code = 1) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

/**
 * Count words in a string using the whitespace-split definition.
 * Empty tokens (produced by leading/trailing whitespace) are discarded.
 * @param {string} text - Input text.
 * @returns {number} Number of words.
 */
function countWords(text) {
  return text.split(/\s+/).filter((token) => token.length > 0).length;
}

/**
 * Entry point: validate the CLI argument, read the file as UTF-8, print count.
 */
function main() {
  const filePath = process.argv[2];

  // Require exactly one argument (the file path).
  if (!filePath) {
    fail('missing file argument.\nUsage: node word-count.js <path-to-text-file>', 2);
  }

  let text;
  try {
    // Read as UTF-8 so Thai and other multi-byte characters decode correctly.
    text = fs.readFileSync(filePath, { encoding: 'utf8' });
  } catch (err) {
    // Translate common Node.js error codes into readable messages.
    if (err.code === 'ENOENT') {
      fail(`file not found: ${filePath}`, 3);
    } else if (err.code === 'EISDIR') {
      fail(`path is a directory, not a file: ${filePath}`, 4);
    } else if (err.code === 'EACCES') {
      fail(`permission denied: ${filePath}`, 5);
    } else {
      fail(`could not read file: ${filePath} (${err.message})`, 1);
    }
  }

  // Print only the number, followed by a newline.
  process.stdout.write(`${countWords(text)}\n`);
}

main();
