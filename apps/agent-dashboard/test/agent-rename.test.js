'use strict';
/**
 * agent-rename.test.js - The team rename (old -> new display names):
 *   ป้าแจ๋ว -> เลขาคนสวย, เก่ง -> Dev-ไอ้เก่ง, ละเอียด -> QA-คุณละเอียด, PM -> PM-Professor-X,
 *   หนอนหนังสือ -> Writer-ยัยแว่นหนา, กวีโปรเจกต์ -> Content Director.
 *   - resolveAgent maps BOTH the new names and the old names (old events in data/events.jsonl must still land on the
 *     right planet) to the same agent id and pipeline step
 *   - the labels shown by the page are the new names
 *   - the real .claude/agents/*.md files carry the new names, and the secretary's Agent(...) list names exactly them
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { resolveAgent, validateEvent, convertHookRecord } = require('../lib/workspace-adapter');
const { readAgentModels } = require('../lib/agent-models');

const AGENTS_DIR = path.join(__dirname, '..', '..', '..', '.claude', 'agents');
const TS = '2026-10-13T10:00:00.000Z';

// [new name, old name, expected agent id, expected pipeline step]
const RENAMES = [
  ['เลขาคนสวย', 'ป้าแจ๋ว', 'secretary', 'router'],
  ['PM-Professor-X', 'PM', 'pm', 'pm'],
  ['Dev-ไอ้เก่ง', 'เก่ง', 'app-dev', 'appdev'],
  ['QA-คุณละเอียด', 'ละเอียด', 'qa-reviewer', 'qa'],
  ['Writer-ยัยแว่นหนา', 'หนอนหนังสือ', 'study-writer', 'study'],
  ['Content Director', 'กวีโปรเจกต์', 'portfolio-writer', 'portfolio'],
];

test('resolveAgent: every NEW name maps to its agent id and pipeline step', () => {
  for (const [name, , id, step] of RENAMES) {
    assert.deepEqual(resolveAgent(name), { id, step }, `${name} -> ${id}`);
  }
});

test('resolveAgent: every OLD name stays an alias of the same agent id and step', () => {
  for (const [, oldName, id, step] of RENAMES) {
    assert.deepEqual(resolveAgent(oldName), { id, step }, `${oldName} -> ${id}`);
  }
  // The still older secretary alias keeps working too
  assert.deepEqual(resolveAgent('เลขา'), { id: 'secretary', step: 'router' });
});

test('resolveAgent: new and old name of one agent give the same result as the English id', () => {
  for (const [name, oldName, id] of RENAMES) {
    assert.equal(resolveAgent(name).id, resolveAgent(id).id, `${name} == ${id}`);
    assert.equal(resolveAgent(oldName).id, resolveAgent(id).id, `${oldName} == ${id}`);
  }
});

test('resolveAgent: case-insensitive and trimmed (Claude Code may report any case); hyphenated Content-Director also resolves', () => {
  assert.equal(resolveAgent('  dev-ไอ้เก่ง ').id, 'app-dev');
  assert.equal(resolveAgent('QA-คุณละเอียด').id, 'qa-reviewer');
  assert.equal(resolveAgent('pm-professor-x').id, 'pm');
  assert.equal(resolveAgent('PM-PROFESSOR-X').id, 'pm');
  assert.equal(resolveAgent('content director').id, 'portfolio-writer');
  assert.equal(resolveAgent('CONTENT DIRECTOR').id, 'portfolio-writer');
  assert.equal(resolveAgent('Content-Director').id, 'portfolio-writer');
  assert.equal(resolveAgent('pm').id, 'pm');
  assert.equal(resolveAgent('Pm').id, 'pm');
});

test('resolveAgent: a name that is only similar to a team name is NOT mapped (step null)', () => {
  for (const name of ['Dev', 'Content', 'Director', 'PM-Professor', 'QA', 'Writer']) {
    assert.equal(resolveAgent(name).step, null, `${name} is unknown`);
  }
});

test('validateEvent: old and new names give the same step when pipelineStep is omitted', () => {
  for (const [name, oldName, , step] of RENAMES) {
    const a = validateEvent({ agent: name, status: 'WORKING', message: 'x' });
    const b = validateEvent({ agent: oldName, status: 'WORKING', message: 'x' });
    assert.equal(a.event.pipelineStep, step, `${name} -> ${step}`);
    assert.equal(b.event.pipelineStep, step, `${oldName} -> ${step}`);
  }
});

test('convertHookRecord: an OLD stored hook record (agent_type / subagent_type with old names) still lands on the right planet', () => {
  const old = convertHookRecord({
    ts: TS, event: 'PreToolUse', agent_type: 'ป้าแจ๋ว', tool_name: 'Agent',
    subagent_type: 'เก่ง', description: 'Build UI',
  });
  const next = convertHookRecord({
    ts: TS, event: 'PreToolUse', agent_type: 'เลขาคนสวย', tool_name: 'Agent',
    subagent_type: 'Dev-ไอ้เก่ง', description: 'Build UI',
  });
  assert.ok(old, 'old record converts');
  assert.ok(next, 'new record converts');
  assert.equal(old.agent, next.agent, 'same agent id for the old and the new record');
  assert.equal(old.pipelineStep, next.pipelineStep, 'same pipeline step for the old and the new record');
});

test('page labels: the stellar model shows the NEW display names (with the model suffix when known)', async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'workspace', 'stellar', 'model.js')).href);
  model.setAgentModels({}); // plain names first
  assert.match(model.labelOf('secretary'), /^เลขาคนสวย/);
  assert.match(model.labelOf('pm'), /^PM-Professor-X/);
  assert.match(model.labelOf('app-dev'), /^Dev-ไอ้เก่ง/);
  assert.match(model.labelOf('qa-reviewer'), /^QA-คุณละเอียด/);
  assert.match(model.labelOf('study-writer'), /^Writer-ยัยแว่นหนา/);
  assert.match(model.labelOf('portfolio-writer'), /^Content Director/);
  assert.match(model.labelOf('user'), /คุณกฎ/, 'the owner star stays คุณกฎ');
  model.setAgentModels({ 'app-dev': { suffix: 'Sonnet-High' } });
  assert.equal(model.labelOf('app-dev'), 'Dev-ไอ้เก่ง (Sonnet-High) · apps/');
  model.setAgentModels({}); // do not leak state into other tests in this process
});

test('index.html: the cards and nodes use the new names and the old English aliases are gone', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'workspace', 'index.html'), 'utf8');
  for (const [name, oldName] of RENAMES) {
    assert.ok(html.includes(`>${name}<`), `index.html shows ${name}`);
    // old Thai names must not be displayed (PM is checked as a whole word; it is a prefix of the new PM name)
    if (oldName !== 'PM') assert.equal(html.includes(`>${oldName}<`), false, `index.html no longer shows ${oldName}`);
  }
  assert.equal(/Keng|La-iad|agent-alias/.test(html), false, 'redundant English aliases removed from the cards');
});

test('.claude/agents/*.md: frontmatter names are the new names and the secretary may call exactly the six specialists', () => {
  const nameOf = (file) => /^name:\s*(.+)$/m.exec(fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8'))[1].trim();
  assert.equal(nameOf('secretary.md'), 'เลขาคนสวย');
  assert.equal(nameOf('pm.md'), 'PM-Professor-X');
  assert.equal(nameOf('app-dev.md'), 'Dev-ไอ้เก่ง');
  assert.equal(nameOf('qa-reviewer.md'), 'QA-คุณละเอียด');
  assert.equal(nameOf('study-writer.md'), 'Writer-ยัยแว่นหนา');
  assert.equal(nameOf('portfolio-writer.md'), 'Content Director');
  assert.equal(nameOf('advisor.md'), 'Advisor');

  const tools = /^tools:\s*Agent\(([^)]*)\)/m.exec(fs.readFileSync(path.join(AGENTS_DIR, 'secretary.md'), 'utf8'));
  assert.ok(tools, 'secretary.md has an Agent(...) tool list');
  const listed = tools[1].split(',').map((s) => s.trim()).sort();
  const expected = ['PM-Professor-X', 'Dev-ไอ้เก่ง', 'QA-คุณละเอียด', 'Writer-ยัยแว่นหนา', 'Content Director', 'Advisor'].sort();
  assert.deepEqual(listed, expected, 'exactly the same six agents (five renamed + the new Advisor)');
});

test('readAgentModels: the real agent files resolve to the seven agent ids (secretary + six specialists) through the new names', () => {
  const info = readAgentModels(AGENTS_DIR);
  for (const id of ['secretary', 'pm', 'app-dev', 'qa-reviewer', 'study-writer', 'portfolio-writer', 'advisor']) {
    assert.ok(info[id], `${id} found in .claude/agents`);
  }
});

// ---------- Advisor (sixth specialist, added after the rename; no old name, so it is not in RENAMES) ----------

test('Advisor: every spelling maps to agent id "advisor" and pipeline step "advisor"', () => {
  for (const name of ['Advisor', 'advisor', 'ADVISOR', '  Advisor  ']) {
    assert.deepEqual(resolveAgent(name), { id: 'advisor', step: 'advisor' }, `${name} -> advisor`);
  }
  // A name that is only similar must stay unknown (step null)
  for (const name of ['Advise', 'Advisors', 'Advisor-X']) assert.equal(resolveAgent(name).step, null, `${name} is unknown`);
});

test('Advisor: validateEvent and convertHookRecord attribute events to the advisor node', () => {
  const posted = validateEvent({ agent: 'Advisor', status: 'WORKING', message: 'answering' });
  assert.equal(posted.event.agent, 'advisor');
  assert.equal(posted.event.pipelineStep, 'advisor');
  // An explicit pipelineStep "advisor" is accepted (it is in PIPELINE_STEPS)
  assert.ok(validateEvent({ agent: 'advisor', status: 'IDLE', message: 'x', pipelineStep: 'advisor' }).event);
  // Delegation from the secretary: the handoff drives the advisor node
  const handoff = convertHookRecord({
    ts: TS, event: 'PreToolUse', agent_type: 'เลขาคนสวย', tool_name: 'Agent',
    subagent_type: 'Advisor', description: 'Explain a concept',
  });
  assert.ok(handoff, 'delegation record converts');
  assert.equal(handoff.agent, 'advisor');
  assert.equal(handoff.pipelineStep, 'advisor');
  // The sub-agent's own lifecycle record is attributed to it too
  const start = convertHookRecord({ ts: TS, event: 'SubagentStart', agent_type: 'Advisor', agent_id: 'agent-adv-1' });
  assert.equal(start.agent, 'advisor');
  assert.equal(start.pipelineStep, 'advisor');
});

test('Advisor: the real .claude/agents/advisor.md is served with its model and effort', () => {
  const info = readAgentModels(AGENTS_DIR);
  assert.ok(info.advisor, 'advisor found in .claude/agents');
  assert.equal(info.advisor.name, 'Advisor');
  assert.ok(info.advisor.model, 'model is read from the frontmatter');
});

test('Advisor: the page has a label, a team card, a planet config and a model-label entry', async () => {
  const root = path.join(__dirname, '..', 'public', 'workspace');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /class="node" data-step="advisor"/, 'label node in the label layer');
  assert.match(html, /class="agent-card" data-agent="advisor"/, 'card in the team list');
  const model = await import(pathToFileURL(path.join(root, 'stellar', 'model.js')).href);
  model.setAgentModels({});
  assert.match(model.labelOf('advisor'), /^Advisor/);
  assert.equal(model.STEP_AGENT.advisor, 'advisor');
  assert.ok(model.PLANET_STEPS.includes('advisor'), 'advisor is a registered planet');
  assert.equal(model.dynamicKeyOf('advisor'), null, 'advisor never becomes a dynamic planet');
  const scene = fs.readFileSync(path.join(root, 'scene.js'), 'utf8');
  assert.match(scene, /const PLANET_THEME = [\s\S]*?\n  advisor: \{/, 'planet theme');
  assert.match(scene, /const SATELLITE_CONFIG = \{[\s\S]*?\n  advisor: /, 'orbit config');
});
