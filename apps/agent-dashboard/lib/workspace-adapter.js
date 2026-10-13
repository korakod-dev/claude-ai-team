'use strict';
/**
 * lib/workspace-adapter.js
 * Pure helpers for the Multi-Agent Workspace view (/workspace). No I/O, so everything is testable.
 *
 * Every event the browser sees has this shape:
 *   { ts, agent, status, message, pipelineStep? }
 *   ts            ISO-8601 string
 *   agent         canonical agent id (see AGENT_MAP), or the raw name if unknown
 *   status        one of STATUSES
 *   message       short text (Thai UI text is fine)
 *   pipelineStep  optional pipeline node id: 'user' | 'router' | 'pm' | 'appdev' | 'qa' | 'study' | 'portfolio'
 *
 * Two sources produce this shape:
 *   1. Hook records from data/events.jsonl (written by hook-logger.js) -> convertHookRecord()
 *   2. Events from POST /api/events or the command flow                -> validateEvent()
 */

const { isDelegationTool } = require('./delegation');

const STATUSES = ['IDLE', 'PROCESSING', 'WORKING', 'COMPLETED', 'ERROR'];
// One pipeline node per team position. 'user' = the owner's command source, 'router' = เลขาคนสวย (entry),
// the rest = the specialists (PM-Professor-X, the planner, was added next to the four writers / reviewers).
const PIPELINE_STEPS = ['user', 'router', 'pm', 'appdev', 'qa', 'study', 'portfolio'];
const MAX_MESSAGE_LENGTH = 500;
const MAX_AGENT_LENGTH = 64;
const SUMMARY_LENGTH = 160;
// tool_use_id: the Claude Code id of one Agent tool call (PreToolUse / PostToolUse / PostToolUseFailure share it).
// Same limit as lib/normalize.js (MAX_ID). An id longer than this is dropped, not truncated (it would not match).
const MAX_TOOL_USE_ID = 128;
// Upper bound of the agent_ref -> tool_use_id link map kept by convertHookRecord (oldest entries are dropped first).
const MAX_LINKS = 500;

// Agent registry. Keys are every name seen in hook data (English id, current display name or an OLD display name),
// lower-cased (resolveAgent lower-cases the incoming name; Thai has no case, so only the Latin parts matter).
// `step` = pipeline node the agent drives. null = agent only appears in the agent list / log.
// The team was renamed once (see .claude/agents/*.md frontmatter `name`). The old names stay as ALIASES so events already
// stored in data/events.jsonl (written under the old names) still land on the right planet.
const AGENT_MAP = new Map([
  // เลขาคนสวย = the owner's secretary (.claude/agents/secretary.md). She is the router / entry step:
  // every handoff arrow starts from her node. Aliases: ป้าแจ๋ว (previous name), เลขา (older name).
  ['secretary', { id: 'secretary', step: 'router' }],
  ['เลขาคนสวย', { id: 'secretary', step: 'router' }],
  ['ป้าแจ๋ว', { id: 'secretary', step: 'router' }],
  ['เลขา', { id: 'secretary', step: 'router' }],
  // PM-Professor-X = the planner (.claude/agents/pm.md, frontmatter `name: PM-Professor-X`). Claude Code reports the sub-agent
  // type as that name. Alias: 'pm' (previous name; also the agent id, so "PM", "Pm" and "pm" all resolve here).
  ['pm', { id: 'pm', step: 'pm' }],
  ['pm-professor-x', { id: 'pm', step: 'pm' }],
  // Dev-ไอ้เก่ง = app developer. Alias: เก่ง (previous name).
  ['app-dev', { id: 'app-dev', step: 'appdev' }],
  ['dev-ไอ้เก่ง', { id: 'app-dev', step: 'appdev' }],
  ['เก่ง', { id: 'app-dev', step: 'appdev' }],
  // QA-คุณละเอียด = QA reviewer. Alias: ละเอียด (previous name).
  ['qa-reviewer', { id: 'qa-reviewer', step: 'qa' }],
  ['qa-คุณละเอียด', { id: 'qa-reviewer', step: 'qa' }],
  ['ละเอียด', { id: 'qa-reviewer', step: 'qa' }],
  // Writer-ยัยแว่นหนา = study writer. Alias: หนอนหนังสือ (previous name).
  ['study-writer', { id: 'study-writer', step: 'study' }],
  ['writer-ยัยแว่นหนา', { id: 'study-writer', step: 'study' }],
  ['หนอนหนังสือ', { id: 'study-writer', step: 'study' }],
  // Content Director = portfolio writer (the frontmatter name contains a space; verified to load in Claude Code).
  // 'content-director' is accepted as well in case a hyphenated form ever shows up. Alias: กวีโปรเจกต์ (previous name).
  ['portfolio-writer', { id: 'portfolio-writer', step: 'portfolio' }],
  ['content director', { id: 'portfolio-writer', step: 'portfolio' }],
  ['content-director', { id: 'portfolio-writer', step: 'portfolio' }],
  ['กวีโปรเจกต์', { id: 'portfolio-writer', step: 'portfolio' }],
  // The owner's command source (dashboard command POST writes agent 'user')
  ['user', { id: 'user', step: 'user' }],
]);

// Main session = เลขาคนสวย (router). Used when a hook record has no usable agent_type.
const MAIN_ACTOR = { id: 'secretary', step: 'router' };

/** Map a raw agent name to { id, step }. Unknown names are kept as-is (step null). */
function resolveAgent(raw) {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  if (!key) return null;
  const hit = AGENT_MAP.get(key.toLowerCase());
  if (hit) return hit;
  return { id: key.slice(0, MAX_AGENT_LENGTH), step: null };
}

/** Remove common Markdown markers (bold, code ticks, heading hashes) so the log reads as plain text. */
function plainText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '');
}

/** Collapse whitespace and cut long text to `max` characters (with an ellipsis). */
function shorten(text, max = SUMMARY_LENGTH) {
  if (typeof text !== 'string') return '';
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Validate and normalize one event (from POST /api/events, a stored line, or a converted hook record).
 * Returns { event } on success or { error } with a message for the client.
 * @param {unknown} input
 * @param {Date} [now]  used when `ts` is missing
 */
function validateEvent(input, now = new Date()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'event must be a JSON object' };
  }

  let ts = now.toISOString();
  if (input.ts !== undefined) {
    if (typeof input.ts !== 'string' || Number.isNaN(Date.parse(input.ts))) {
      return { error: 'ts must be an ISO-8601 date string' };
    }
    ts = new Date(input.ts).toISOString();
  }

  if (typeof input.agent !== 'string' || !input.agent.trim()) {
    return { error: 'agent is required' };
  }
  if (input.agent.trim().length > MAX_AGENT_LENGTH) {
    return { error: `agent must be at most ${MAX_AGENT_LENGTH} characters` };
  }
  const resolved = resolveAgent(input.agent);

  const status = typeof input.status === 'string' ? input.status.trim().toUpperCase() : '';
  if (!STATUSES.includes(status)) {
    return { error: `status must be one of ${STATUSES.join(', ')}` };
  }

  if (typeof input.message !== 'string') {
    return { error: 'message must be a string' };
  }
  const message = shorten(input.message, MAX_MESSAGE_LENGTH);

  // pipelineStep: explicit value wins; otherwise use the step of the registered agent
  let step = resolved.step;
  if (input.pipelineStep !== undefined && input.pipelineStep !== null) {
    if (!PIPELINE_STEPS.includes(input.pipelineStep)) {
      return { error: `pipelineStep must be one of ${PIPELINE_STEPS.join(', ')}` };
    }
    step = input.pipelineStep;
  }

  const event = { ts, agent: resolved.id, status, message };
  if (step) event.pipelineStep = step;

  // toolUseId (optional): exact key that pairs a start event with its end event in the browser store.
  // Only kept when it is a non-empty string within the limit; events without it are matched by FIFO there.
  if (typeof input.toolUseId === 'string') {
    const id = input.toolUseId.trim();
    if (id && id.length <= MAX_TOOL_USE_ID) event.toolUseId = id;
  }
  return { event };
}

/**
 * Remember that the sub-agent with this agent_ref (= SubagentStart / SubagentStop agent_id) was started by the
 * Agent tool call with this tool_use_id. Bounded: when the map is full, the oldest link is dropped.
 * @param {Map<string, string>} links
 */
function linkAgentToToolUse(links, agentRef, toolUseId) {
  if (!links || typeof agentRef !== 'string' || !agentRef || typeof toolUseId !== 'string' || !toolUseId) return;
  links.delete(agentRef);            // re-insert so the newest link is the last one in the Map
  links.set(agentRef, toolUseId);
  while (links.size > MAX_LINKS) links.delete(links.keys().next().value);
}

/** Build one converted event, or null when the actor is unknown. */
function makeEvent(ts, actor, status, message, extra = {}) {
  if (!actor) return null;
  const result = validateEvent(
    { ts, agent: actor.id, status, message, pipelineStep: actor.step, ...extra },
    ts ? new Date(Date.parse(ts) || Date.now()) : new Date(),
  );
  return result.event || null;
}

/**
 * True when the hook record comes from the main session (เลขาคนสวย, the router).
 * A record without agent_type is also treated as the main session (see MAIN_ACTOR).
 */
function isMainPersona(rec) {
  const actor = resolveAgent(rec.agent_type) || MAIN_ACTOR;
  return actor.id === MAIN_ACTOR.id;
}

/**
 * Convert one raw hook record (data/events.jsonl) into a workspace event.
 * Returns null for hook events that are not shown in the log (SessionStart, PostToolUse, PostToolUseFailure of an ordinary tool, ...).
 * Mapping rules (approximation, NOT confirmed by the owner, see README):
 *   UserPromptSubmit                  -> router (เลขาคนสวย) PROCESSING: the entry step receives the prompt
 *   PreToolUse tool_name=Agent        -> handoff: target agent PROCESSING (drives the edge into it)
 *                                        the handoff arrows start from the router node
 *   PreToolUse (other tools)          -> actor WORKING "using tool X"
 *                                        main session: logged only, the router node is NOT changed
 *   SubagentStart                     -> actor WORKING
 *   SubagentStop                      -> actor COMPLETED with last_message
 *                                        main session: ignored (the main turn is still running)
 *   Stop                              -> actor COMPLETED with last_message (main session -> router COMPLETED)
 *   PostToolUseFailure tool_name=Agent -> ERROR of the dispatched sub-agent (subagent_type), or of the record's actor
 *                                        (agent_type) when no sub-agent is named: a failed delegation
 *   PostToolUseFailure (other tools)  -> null. A failed Bash / Edit / Read is normal work, NOT a failed agent: no status
 *                                        change, no black hole, no stop-hold side effect (decision 2026-10-13, owner). It only
 *                                        shows as a red beam through convertToolActivity (phase 'error').
 *
 * Task ids (toolUseId, exact pairing in stellar/store.js):
 *   PreToolUse(Agent)        PROCESSING carries toolUseId = tool_use_id
 *   PostToolUseFailure       ERROR carries toolUseId = tool_use_id (it closes the Agent call's task). The hub
 *                            (lib/workspace.js) also drops or marks the sub-agent's held stop, see lib/stop-hold.js failed()
 *   PostToolUse(Agent)       sets no event; with `links` it records agent_ref -> tool_use_id
 *   SubagentStop             COMPLETED carries toolUseId only when `links` already knows the agent_id. That is the
 *                            case for async runs (their PostToolUse arrives before the stop). For sync runs (PostToolUse
 *                            arrives after the stop) the event has no id here: lib/workspace.js holds it for up to
 *                            TOOL_USE_WAIT_MS and adds the id from the PostToolUse. Only a stop that times out keeps
 *                            no id, and the store then matches it by FIFO and marks it approx.
 * @param {object} rec  raw hook record (already parsed JSON)
 * @param {Map<string,string>} [links]  agent_ref -> tool_use_id map, owned by the caller and kept across records.
 *                                      Without it, SubagentStop never gets a toolUseId.
 * @returns {object|null} workspace event
 */
function convertHookRecord(rec, links) {
  if (!rec || typeof rec !== 'object') return null;
  const ts = typeof rec.ts === 'string' ? rec.ts : undefined;
  const actor = resolveAgent(rec.agent_type) || MAIN_ACTOR;
  // The id of an Agent tool call (only for Agent calls; other tools have no task to pair)
  const agentToolUseId = isDelegationTool(rec.tool_name) && typeof rec.tool_use_id === 'string' ? rec.tool_use_id : undefined;

  switch (rec.event) {
    case 'UserPromptSubmit':
      // The owner's prompt enters through เลขาคนสวย (router), so the router node is the one that goes PROCESSING
      return makeEvent(ts, MAIN_ACTOR, 'PROCESSING', 'รับคำสั่งงานจากผู้ใช้แล้ว');

    case 'PostToolUse':
      // Not a log line. Only the link agent_ref -> tool_use_id is kept (for the SubagentStop that follows)
      if (isDelegationTool(rec.tool_name) && agentToolUseId && typeof rec.agent_ref === 'string') {
        linkAgentToToolUse(links, rec.agent_ref, agentToolUseId);
      }
      return null;

    case 'PreToolUse': {
      if (isDelegationTool(rec.tool_name) && typeof rec.subagent_type === 'string') {
        // Handoff: the target agent becomes active. The caller's name is shown in the message.
        const target = resolveAgent(rec.subagent_type);
        const task = shorten(rec.description, 120) || 'ไม่มีรายละเอียด';
        return makeEvent(ts, target, 'PROCESSING', `รับงานจาก ${rec.agent_type || 'ผู้ใช้'}: ${task}`, { toolUseId: agentToolUseId });
      }
      const tool = shorten(rec.tool_name, 60);
      const message = tool ? `ใช้เครื่องมือ ${tool}` : 'กำลังทำงาน';
      if (isMainPersona(rec)) {
        // Every main-session tool call would flip the router to WORKING (node flapping).
        // Keep the log line but drop pipelineStep so the router node is not touched.
        const ev = makeEvent(ts, actor, 'WORKING', message);
        if (ev) delete ev.pipelineStep;
        return ev;
      }
      return makeEvent(ts, actor, 'WORKING', message);
    }

    case 'SubagentStart':
      return makeEvent(ts, actor, 'WORKING', 'เริ่มทำงาน');

    case 'SubagentStop':
      // A SubagentStop for the main session would mark the router COMPLETED while the main turn still runs.
      // Ignore it; Stop still completes the turn.
      if (isMainPersona(rec)) return null;
      // The Agent tool call of this sub-agent, when a PostToolUse with the same agent_ref was seen before (async run)
      return makeEvent(ts, actor, 'COMPLETED', shorten(plainText(rec.last_message)) || 'ทำงานเสร็จแล้ว',
        { toolUseId: links && typeof rec.agent_id === 'string' ? links.get(rec.agent_id) : undefined });

    case 'Stop':
      return makeEvent(ts, actor, 'COMPLETED', shorten(plainText(rec.last_message)) || 'ตอบกลับเสร็จแล้ว');

    case 'PostToolUseFailure': {
      // An ordinary tool failed (Bash exit != 0, Edit mismatch, Read of a missing file ...): not an agent failure. No event here;
      // the red beam comes from convertToolActivity(). Only a failed Agent call (dispatch) is an ERROR.
      if (!isDelegationTool(rec.tool_name)) return null;
      // Failure of an Agent call: the ERROR belongs to the sub-agent that was dispatched (subagent_type), so that agent's
      // status shows the failure, and the tool_use_id closes its task. Without subagent_type the caller keeps the event.
      const failedAgent = isDelegationTool(rec.tool_name) && typeof rec.subagent_type === 'string'
        ? resolveAgent(rec.subagent_type) : null;
      return makeEvent(ts, failedAgent || actor, 'ERROR',
        `เครื่องมือ ${shorten(rec.tool_name, 60) || ''} ล้มเหลว`.replace(/\s+/g, ' ').trim(),
        { toolUseId: agentToolUseId });
    }

    default:
      return null;
  }
}

// Hook event -> phase of a tool call. Used by convertToolActivity().
const TOOL_PHASE = Object.freeze({ PreToolUse: 'start', PostToolUse: 'end', PostToolUseFailure: 'error' });
const MAX_TOOL_NAME = 60;

/**
 * Convert one hook record into a TOOL ACTIVITY message, or null when the record is not the start / end of a tool call.
 * This is a separate channel from the workspace events above (log, pipeline, tasks): it only feeds the activity effects of the
 * 3D scene (a thinking pulse, one beam per tool call). It is sent live and is never stored in the replay buffer.
 *
 *   PreToolUse          -> phase 'start'
 *   PostToolUse         -> phase 'end'
 *   PostToolUseFailure  -> phase 'error' (the tool call ended, with an error; the scene draws a red beam for the actor)
 * The Agent tool is NOT activity: a delegation is drawn as a dispatch comet, and a sync Agent call lasts as long as the whole
 * sub-agent run, so it would mark its caller "acting" for minutes.
 *
 * Attribution (who made the call):
 *   agent     the agent TYPE of the record (agent_type), the main session (secretary) when it has none
 *   instance  tool_use_id of the Agent call that started the sub-agent which made the call: the task id the browser store uses
 *             for that instance (a moon). Only set when the hook record carries agent_id (events fired inside a sub-agent have
 *             it, main-session events do not) AND `instanceOf(agent_id)` knows a trusted link. Otherwise undefined, and the
 *             browser attributes the call to the agent (planet) only.
 * @param {object} rec  raw hook record (already parsed JSON)
 * @param {(agentRef: string) => string|undefined} [instanceOf]  agent_id -> task id of its instance (trusted links only)
 * @returns {{ ts: string, agent: string, phase: string, tool: string, callId?: string, instance?: string }|null}
 */
function convertToolActivity(rec, instanceOf) {
  if (!rec || typeof rec !== 'object') return null;
  const phase = Object.prototype.hasOwnProperty.call(TOOL_PHASE, rec.event) ? TOOL_PHASE[rec.event] : null;
  if (!phase) return null;
  const tool = shorten(rec.tool_name, MAX_TOOL_NAME);
  if (!tool || isDelegationTool(rec.tool_name)) return null;
  const actor = resolveAgent(rec.agent_type) || MAIN_ACTOR;
  const ts = typeof rec.ts === 'string' && !Number.isNaN(Date.parse(rec.ts)) ? new Date(rec.ts).toISOString() : new Date().toISOString();
  const out = { ts, agent: actor.id, phase, tool };
  if (typeof rec.tool_use_id === 'string' && rec.tool_use_id && rec.tool_use_id.length <= MAX_TOOL_USE_ID) out.callId = rec.tool_use_id;
  if (typeof rec.agent_id === 'string' && rec.agent_id && typeof instanceOf === 'function') {
    const instance = instanceOf(rec.agent_id);
    if (typeof instance === 'string' && instance) out.instance = instance;
  }
  return out;
}

module.exports = {
  STATUSES,
  PIPELINE_STEPS,
  MAX_MESSAGE_LENGTH,
  resolveAgent,
  shorten,
  validateEvent,
  convertHookRecord,
  convertToolActivity,
};
