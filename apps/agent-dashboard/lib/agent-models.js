'use strict';
/**
 * lib/agent-models.js
 * Reads the model and effort of every team member from the YAML frontmatter of the agent definition files
 * (<repo>/.claude/agents/*.md), so the dashboard labels follow the real config and nothing is hardcoded.
 *
 *   ---
 *   name: Dev-ไอ้เก่ง
 *   model: sonnet
 *   effort: high
 *   ---
 *
 * The agent is identified by the frontmatter `name` (resolved to the canonical agent id with resolveAgent, the same
 * mapping the event stream uses). The result is served by GET /api/agents and used by the page for labels such as
 * "Dev-ไอ้เก่ง (Sonnet-High)".
 *
 * Rules:
 *   - model and effort are capitalised (sonnet -> Sonnet, high -> High)
 *   - a missing or unsafe value gives suffix null: the page then shows the plain name
 *   - the folder is read on every request (a handful of small files), so a config change shows after a page reload
 *   - read-only; only regular *.md files directly inside the folder (symlinks are skipped); file size is capped;
 *     no path is ever returned; only names that map to a known team member are served
 * Only built-in modules are used. The parser handles the simple "key: value" frontmatter these files use
 * (it is not a full YAML parser).
 */
const fs = require('fs');
const path = require('path');
const { resolveAgent } = require('./workspace-adapter');

const MAX_FILES = 50;                 // upper bound of definition files read per call
const MAX_FILE_BYTES = 64 * 1024;     // a definition file larger than this is skipped
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/; // what a model / effort value may look like

/**
 * Parse the frontmatter block at the top of a markdown text into a plain { key: value } object (strings only).
 * Returns {} when the text does not start with a "---" block. Quotes around a value are removed.
 * @param {string} text
 * @returns {Record<string,string>}
 */
function parseFrontmatter(text) {
  const out = Object.create(null);
  if (typeof text !== 'string') return out;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') return out;                       // end of the block
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line); // top-level "key: value" only
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1).trim();
    if (!Object.prototype.hasOwnProperty.call(out, m[1])) out[m[1]] = value;
  }
  return Object.create(null);                                     // no closing "---": not a valid block
}

/** "sonnet" -> "Sonnet". Returns null for a missing, empty or unsafe value. */
function capitalizeValue(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!SAFE_VALUE.test(v)) return null;
  return v.charAt(0).toUpperCase() + v.slice(1);
}

/**
 * Model and effort of one frontmatter object, capitalised.
 * suffix is "Model-Effort" only when BOTH values exist; otherwise null (the page shows just the name).
 */
function modelInfo(front) {
  const model = capitalizeValue(front && front.model);
  const effort = capitalizeValue(front && front.effort);
  return { model, effort, suffix: model && effort ? `${model}-${effort}` : null };
}

/**
 * Read every agent definition in `dir`.
 * @param {string} dir  folder with the *.md definition files (normally <repo>/.claude/agents)
 * @returns {Record<string,{name:string,model:string|null,effort:string|null,suffix:string|null}>}
 *          keyed by canonical agent id (e.g. "app-dev"). An unreadable or missing folder gives {}.
 */
function readAgentModels(dir) {
  const result = Object.create(null); // no prototype: an agent id such as "__proto__" is just a key
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().slice(0, MAX_FILES);
  } catch (_err) {
    return result;
  }
  for (const file of files) {
    try {
      const full = path.join(dir, file);
      // lstat (not stat): a symlink is never followed, so a link cannot point the reader at a file outside the folder
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const front = parseFrontmatter(fs.readFileSync(full, 'utf8'));
      const agent = resolveAgent(front.name);
      // Known team members only: resolveAgent keeps unknown names as-is (step null), and those are not served, so an
      // arbitrary frontmatter name never reaches the response. The owner ('user') gets no suffix either.
      if (!agent || agent.step === null || agent.id === 'user') continue;
      if (Object.prototype.hasOwnProperty.call(result, agent.id)) continue; // first file (sorted) wins
      result[agent.id] = { name: front.name, ...modelInfo(front) };
    } catch (_err) {
      // One unreadable file must not hide the others
    }
  }
  return result;
}

module.exports = { parseFrontmatter, capitalizeValue, modelInfo, readAgentModels, MAX_FILE_BYTES };
