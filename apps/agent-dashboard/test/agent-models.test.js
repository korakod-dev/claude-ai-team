'use strict';
/**
 * agent-models.test.js - Model + effort labels of the team ("Dev-ไอ้เก่ง (Sonnet-High)").
 *   - lib/agent-models.js: frontmatter parser, capitalisation, name -> agent id mapping, missing values, size limits
 *   - the REAL .claude/agents/*.md files: the label matches an independent read of each file (nothing hardcoded)
 *   - GET /api/agents: JSON shape, reads the folder on every request, Host / Origin guards, no path in the answer
 *   - stellar/model.js: labelOf / withModel add the suffix (HUD), never for the owner, safe against bad input
 * Every server test passes temp paths only (never data/). Listens on 127.0.0.1 only. Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { isolateEnv, tempWorkspaceOpts } = require('./helpers/temp-paths');
isolateEnv();
const { createServer } = require('../server');
const config = require('../lib/config');
const { parseFrontmatter, capitalizeValue, modelInfo, readAgentModels, MAX_FILE_BYTES } = require('../lib/agent-models');

const REAL_AGENTS_DIR = path.resolve(__dirname, '..', '..', '..', '.claude', 'agents');

/** A temp folder with the given { fileName: text } files. */
function tempAgentsDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-agents-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

/** Frontmatter text for a test agent. */
const agentFile = (name, model, effort) => `---\nname: ${name}\ndescription: x\n${model ? `model: ${model}\n` : ''}${effort ? `effort: ${effort}\n` : ''}---\n\nBody text\nmodel: not-this-one\n`;

test('parseFrontmatter: reads top-level key: value pairs of the first block, strips quotes, ignores the body', () => {
  const fm = parseFrontmatter('---\nname: "Dev-ไอ้เก่ง"\nmodel: sonnet\neffort:   high  \ntools: Read, Write\n---\nmodel: opus\n');
  assert.equal(fm.name, 'Dev-ไอ้เก่ง');
  assert.equal(fm.model, 'sonnet');
  assert.equal(fm.effort, 'high');
  assert.equal(fm.tools, 'Read, Write');
  assert.equal(parseFrontmatter('---\r\nname: a\r\nmodel: opus\r\n---\r\n').model, 'opus', 'CRLF files');
  assert.equal(parseFrontmatter('﻿---\nmodel: opus\n---\n').model, 'opus', 'BOM');
});

test('parseFrontmatter: no block, an unclosed block, or a non-string gives nothing', () => {
  assert.deepEqual({ ...parseFrontmatter('# title\nmodel: opus\n') }, {});
  assert.deepEqual({ ...parseFrontmatter('---\nmodel: opus\n(no end)') }, {});
  assert.deepEqual({ ...parseFrontmatter(undefined) }, {});
  assert.deepEqual({ ...parseFrontmatter('') }, {});
});

test('capitalizeValue / modelInfo: sonnet -> Sonnet, high -> High; unsafe or missing values are null; suffix needs both', () => {
  assert.equal(capitalizeValue('sonnet'), 'Sonnet');
  assert.equal(capitalizeValue(' high '), 'High');
  assert.equal(capitalizeValue('xhigh'), 'Xhigh');
  assert.equal(capitalizeValue(''), null);
  assert.equal(capitalizeValue(undefined), null);
  assert.equal(capitalizeValue('<script>'), null, 'unsafe characters are refused');
  assert.equal(capitalizeValue('a'.repeat(33)), null, 'too long');
  assert.deepEqual(modelInfo({ model: 'sonnet', effort: 'high' }), { model: 'Sonnet', effort: 'High', suffix: 'Sonnet-High' });
  assert.equal(modelInfo({ model: 'sonnet' }).suffix, null, 'effort missing: no suffix');
  assert.equal(modelInfo({ effort: 'high' }).suffix, null, 'model missing: no suffix');
  assert.equal(modelInfo(undefined).suffix, null);
});

test('readAgentModels: maps the frontmatter name to the agent id, applies the rules, skips what it cannot use', () => {
  const dir = tempAgentsDir({
    'a-secretary.md': agentFile('เลขาคนสวย', 'sonnet', 'medium'),
    'b-appdev.md': agentFile('Dev-ไอ้เก่ง', 'sonnet', 'high'),
    'b-pm.md': agentFile('PM-Professor-X', 'opus', 'high'),               // the planner: frontmatter name "PM-Professor-X" maps to the id "pm"
    'c-qa.md': agentFile('QA-คุณละเอียด', 'opus', 'medium'),
    'd-study.md': agentFile('Writer-ยัยแว่นหนา', 'sonnet', null),   // effort missing
    'e-portfolio.md': agentFile('Content Director', null, null),    // both missing
    'f-owner.md': agentFile('user', 'opus', 'high'),          // the owner is never labelled
    'g-noname.md': '---\nmodel: opus\n---\n',                 // no name
    'h-extra.md': agentFile('data-analyst', 'haiku', 'low'),  // not a known team member: never served
    'notes.txt': agentFile('Dev-ไอ้เก่ง', 'opus', 'max'),            // not a .md file
    'z-dup.md': agentFile('Dev-ไอ้เก่ง', 'opus', 'max'),             // second file of the same agent: the first one (sorted) wins
  });
  try {
    const r = readAgentModels(dir);
    assert.deepEqual(Object.keys(r).sort(), ['app-dev', 'pm', 'portfolio-writer', 'qa-reviewer', 'secretary', 'study-writer']);
    assert.equal(r.secretary.suffix, 'Sonnet-Medium');
    assert.equal(r['app-dev'].suffix, 'Sonnet-High');
    assert.equal(r.pm.suffix, 'Opus-High', 'PM-Professor-X is a known team member');
    assert.equal(r['qa-reviewer'].suffix, 'Opus-Medium');
    assert.equal(r['study-writer'].suffix, null);
    assert.equal(r['study-writer'].model, 'Sonnet');
    assert.equal(r['portfolio-writer'].suffix, null);
    assert.equal(r['data-analyst'], undefined, 'an unknown name is not served');
    assert.equal(r.user, undefined, 'the owner gets no entry');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readAgentModels: a missing folder gives {}, an oversized file is skipped, a folder named *.md does not crash it', () => {
  assert.deepEqual({ ...readAgentModels(path.join(os.tmpdir(), 'dash-agents-does-not-exist')) }, {});
  const dir = tempAgentsDir({ 'ok.md': agentFile('Dev-ไอ้เก่ง', 'sonnet', 'high'), 'big.md': `${agentFile('QA-คุณละเอียด', 'opus', 'high')}${'x'.repeat(MAX_FILE_BYTES)}` });
  fs.mkdirSync(path.join(dir, 'folder.md'));
  try {
    const r = readAgentModels(dir);
    assert.deepEqual(Object.keys(r), ['app-dev']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readAgentModels: a symlink is never followed (file or folder), even when its target is a valid definition', () => {
  const outside = tempAgentsDir({ 'secret.md': agentFile('QA-คุณละเอียด', 'opus', 'max') }); // a folder outside the agents folder
  const dir = tempAgentsDir({ 'ok.md': agentFile('Dev-ไอ้เก่ง', 'sonnet', 'high') });
  try {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'link-file.md'));   // link to a file elsewhere
    fs.symlinkSync(outside, path.join(dir, 'link-dir.md'));                            // link to a folder
    fs.symlinkSync(path.join(dir, 'ok.md'), path.join(dir, 'zz-self-link.md'));        // link to a valid file inside
    const r = readAgentModels(dir);
    assert.deepEqual(Object.keys(r), ['app-dev'], 'only the real file is read');
    assert.equal(r['qa-reviewer'], undefined, 'the linked definition is not served');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('readAgentModels: only known team members are served; a long or hostile name never reaches the result', () => {
  const longName = 'x'.repeat(5000);
  const dir = tempAgentsDir({
    'a.md': agentFile(longName, 'opus', 'high'),
    'b.md': agentFile('<img src=x onerror=alert(1)>', 'opus', 'high'),
    'c.md': agentFile('__proto__', 'opus', 'high'),
    'd.md': agentFile('constructor', 'opus', 'high'),
    'e.md': agentFile('Secretary', 'sonnet', 'medium'),  // known id, any case
  });
  try {
    const r = readAgentModels(dir);
    assert.deepEqual(Object.keys(r), ['secretary'], 'unknown names are dropped');
    assert.equal(JSON.stringify(r).includes('xxxx'), false);
    assert.equal(JSON.stringify(r).includes('onerror'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real config: every .claude/agents/*.md gets the label that its own frontmatter says (nothing is hardcoded)', () => {
  assert.equal(config.AGENTS_DIR, REAL_AGENTS_DIR, 'the default folder is <repo>/.claude/agents');
  const files = fs.readdirSync(REAL_AGENTS_DIR).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 5, 'the five team members are defined');
  const result = readAgentModels(REAL_AGENTS_DIR);
  // Independent read with plain regexes (does not use parseFrontmatter)
  const expected = {};
  for (const f of files) {
    const text = fs.readFileSync(path.join(REAL_AGENTS_DIR, f), 'utf8');
    const head = text.split(/\r?\n---\r?\n/)[0];
    const name = /^name:\s*(.+)$/m.exec(head)[1].trim();
    const model = /^model:\s*(\S+)/m.exec(head);
    const effort = /^effort:\s*(\S+)/m.exec(head);
    const cap = (v) => v[0].toUpperCase() + v.slice(1);
    expected[name] = model && effort ? `${cap(model[1])}-${cap(effort[1])}` : null;
  }
  const idOf = { 'เลขาคนสวย': 'secretary', 'PM-Professor-X': 'pm', 'Dev-ไอ้เก่ง': 'app-dev', 'QA-คุณละเอียด': 'qa-reviewer', 'Writer-ยัยแว่นหนา': 'study-writer', 'Content Director': 'portfolio-writer' };
  for (const [name, id] of Object.entries(idOf)) {
    assert.ok(name in expected, `${name} has a definition file`);
    assert.equal(result[id].suffix, expected[name], `${name} -> ${expected[name]}`);
  }
});

// ---------- GET /api/agents ----------

/** Start the server with a temp agents folder. */
async function startServer(agentsDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-test-'));
  const server = createServer({ ...tempWorkspaceOpts(dir), agentsDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    cleanup: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Plain request helper (method, headers) returning { status, headers, body }. */
function request(port, urlPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/agents: JSON with the label data, re-read on every request, no path in the answer', async () => {
  const dir = tempAgentsDir({ 'app-dev.md': agentFile('Dev-ไอ้เก่ง', 'sonnet', 'high') });
  const ctx = await startServer(dir);
  try {
    const res = await request(ctx.port, '/api/agents');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(res.headers['content-security-policy'], 'security headers are sent');
    assert.deepEqual(JSON.parse(res.body), { agents: { 'app-dev': { name: 'Dev-ไอ้เก่ง', model: 'Sonnet', effort: 'High', suffix: 'Sonnet-High' } } });
    assert.equal(res.body.includes(dir), false, 'the folder path is not leaked');

    // The config changes: the next request shows it (no restart)
    fs.writeFileSync(path.join(dir, 'app-dev.md'), agentFile('Dev-ไอ้เก่ง', 'opus', 'xhigh'));
    const changed = JSON.parse((await request(ctx.port, '/api/agents')).body);
    assert.equal(changed.agents['app-dev'].suffix, 'Opus-Xhigh');
  } finally {
    await ctx.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/agents: an empty or missing folder answers 200 with no agents; Host / Origin guards and GET-only apply', async () => {
  const ctx = await startServer(path.join(os.tmpdir(), 'dash-agents-does-not-exist'));
  try {
    const res = await request(ctx.port, '/api/agents');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { agents: {} });
    assert.equal((await request(ctx.port, '/api/agents', { headers: { Host: 'evil.example.com' } })).status, 403, 'DNS-rebinding guard');
    assert.equal((await request(ctx.port, '/api/agents', { headers: { Origin: 'http://evil.example.com' } })).status, 403, 'cross-site guard');
    assert.equal((await request(ctx.port, '/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status, 405, 'no POST');
    assert.equal((await request(ctx.port, '/api/agents/', {})).status, 404, 'only the exact path');
  } finally {
    await ctx.cleanup();
  }
});

// ---------- stellar/model.js (HUD labels) ----------

const loadModel = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'workspace', 'stellar', 'model.js')).href);

test('model.js: labelOf adds the suffix after the name (HUD), the owner never gets one, and it is reset by setAgentModels', async () => {
  const m = await loadModel();
  m.setAgentModels({});
  assert.equal(m.labelOf('app-dev'), 'Dev-ไอ้เก่ง · apps/', 'no data: the plain label');
  assert.equal(m.labelOf('secretary'), 'เลขาคนสวย · main agent');
  const n = m.setAgentModels({
    secretary: { suffix: 'Sonnet-Medium' },
    pm: { suffix: 'Opus-High' },
    'app-dev': { suffix: 'Sonnet-High' },
    'qa-reviewer': { suffix: 'Opus-Medium' },
    'study-writer': { suffix: null },
    'portfolio-writer': { suffix: 'Sonnet-Medium' },
    user: { suffix: 'Opus-High' },
  });
  assert.equal(n, 5, 'null and the owner are not stored');
  assert.equal(m.labelOf('app-dev'), 'Dev-ไอ้เก่ง (Sonnet-High) · apps/');
  assert.equal(m.labelOf('pm'), 'PM-Professor-X (Opus-High) · planner', 'the PM-Professor-X label renders as "PM-Professor-X (Opus-High)"');
  assert.equal(m.labelOf('secretary'), 'เลขาคนสวย (Sonnet-Medium) · main agent');
  assert.equal(m.labelOf('qa-reviewer'), 'QA-คุณละเอียด (Opus-Medium) · read-only');
  assert.equal(m.labelOf('study-writer'), 'Writer-ยัยแว่นหนา · study/', 'a missing value shows just the name');
  assert.equal(m.labelOf('portfolio-writer'), 'Content Director (Sonnet-Medium) · portfolio/');
  assert.equal(m.labelOf('user'), 'User Prompt · คุณกฎ', 'the owner has no suffix');
  assert.equal(m.withModel('Dev-ไอ้เก่ง', 'app-dev'), 'Dev-ไอ้เก่ง (Sonnet-High)');
  assert.equal(m.withModel('Dev-ไอ้เก่ง', 'nobody'), 'Dev-ไอ้เก่ง');
  m.setAgentModels(null);
  assert.equal(m.labelOf('app-dev'), 'Dev-ไอ้เก่ง · apps/', 'bad input clears the suffixes');
});

test('model.js: unsafe suffixes and prototype keys are ignored', async () => {
  const m = await loadModel();
  const n = m.setAgentModels({
    'app-dev': { suffix: '<b>x</b>' },
    'qa-reviewer': { suffix: 7 },
    constructor: { suffix: 'Sonnet-High' },
    secretary: 'Sonnet-High',
  });
  assert.equal(n, 1, 'only "constructor" with a safe suffix is stored (as a plain key)');
  assert.equal(m.labelOf('app-dev'), 'Dev-ไอ้เก่ง · apps/');
  assert.equal(m.labelOf('secretary'), 'เลขาคนสวย · main agent');
  assert.equal(m.modelSuffixOf('toString'), null, 'inherited keys are not suffixes');
  assert.equal(m.modelSuffixOf(undefined), null);
  m.setAgentModels(null);
});
