/**
 * stellar/model.js - Pure rules of the Stellar Universe view (Phase 1). No DOM, no THREE.
 * Shared by scene.js, hud.js and the node tests (test/stellar-*.test.js).
 *
 * Mapping (documented in README, section "3D scene"):
 *   main agent (secretary, เลขาคนสวย)                  = the sun (pipeline step 'router')
 *   sub-agents (pm, app-dev, qa-reviewer, ...)       = planets (steps pm, appdev, qa, study, portfolio)
 *   any other agent (not registered)                 = a dynamic planet, key 'dyn:<agent>' (see dynamicKeyOf, stellar/dynamic.js)
 *   task dispatched to a sub-agent (PROCESSING)      = comet sun -> planet (drawn by handoff() in scene.js)
 *   task finished by a sub-agent (COMPLETED)         = result comet planet -> sun
 *   task failed (ERROR)                              = debris pulled into the black hole (visual only, no retry)
 *
 * Data honesty: the event stream has NO cpu, memory, token / context-limit or timeout data, and no parent-child link between
 * sub-agents. Those metrics are reported as NO_DATA in the HUD and are never used to scale size or colour. The 'moons' row is the
 * one exception: a moon is a concurrent INSTANCE of the same agent (stellar/moons.js), which the events do report, so the row
 * shows that count from 2 instances on (and stays NO_DATA below that).
 */

// The sun is the main agent. Its pipeline step is 'router' (see lib/workspace-adapter.js).
export const SUN_STEP = 'router';
// Planets: the five registered sub-agents, one planet per agent in the team list.
export const PLANET_STEPS = Object.freeze(['pm', 'appdev', 'qa', 'study', 'portfolio']);
// Pseudo step for the black hole (target of failed tasks). It is not an agent.
export const BLACK_HOLE_STEP = 'blackhole';

// Pipeline step -> canonical agent id (ids as produced by lib/workspace-adapter.js).
export const STEP_AGENT = Object.freeze({
  user: 'user',
  router: 'secretary',
  pm: 'pm',
  appdev: 'app-dev',
  qa: 'qa-reviewer',
  study: 'study-writer',
  portfolio: 'portfolio-writer',
});

// Canonical agent id -> pipeline step (inverse of STEP_AGENT).
export const AGENT_STEP = Object.freeze(
  Object.fromEntries(Object.entries(STEP_AGENT).map(([step, agent]) => [agent, step])),
);

// Display names (team list in index.html): the agent's own name, then a fixed detail text.
// The model suffix, when known, goes between them: "Dev-ไอ้เก่ง (Sonnet-High) · apps/". The owner ('user') never gets one.
// Unknown agent ids are shown as they are.
const AGENT_LABEL = Object.freeze({
  user: Object.freeze({ name: 'User Prompt · คุณกฎ', detail: '' }),
  secretary: Object.freeze({ name: 'เลขาคนสวย', detail: ' · main agent' }),
  pm: Object.freeze({ name: 'PM-Professor-X', detail: ' · planner' }),
  'app-dev': Object.freeze({ name: 'Dev-ไอ้เก่ง', detail: ' · apps/' }),
  'qa-reviewer': Object.freeze({ name: 'QA-คุณละเอียด', detail: ' · read-only' }),
  'study-writer': Object.freeze({ name: 'Writer-ยัยแว่นหนา', detail: ' · study/' }),
  'portfolio-writer': Object.freeze({ name: 'Content Director', detail: ' · portfolio/' }),
});

/** True when the plain object has its own key (avoids prototype keys such as 'constructor'). */
function own(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/* ---------- model suffix (model + effort from the agent definition files) ---------- */
// The server reads model and effort from the frontmatter of .claude/agents/*.md (GET /api/agents, lib/agent-models.js).
// app.js passes the result to setAgentModels(); nothing is hardcoded here. Until then every label is the plain name.
const SUFFIX_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;   // a suffix is "Model-Effort": letters, digits, dot, dash
let agentSuffix = Object.create(null);                    // agent id -> "Sonnet-High"

/**
 * Store the suffix of every agent. `agents` is the `agents` object of GET /api/agents:
 * { <agent id>: { suffix: "Sonnet-High" | null, ... } }. Anything that is not a safe string is ignored, and the owner
 * ('user') is always skipped. Replaces the previous map. Returns the number of suffixes stored.
 */
export function setAgentModels(agents) {
  const next = Object.create(null);
  if (agents && typeof agents === 'object') {
    Object.keys(agents).forEach((id) => {
      const info = agents[id];
      const suffix = info && typeof info === 'object' ? info.suffix : null;
      if (id !== 'user' && typeof suffix === 'string' && SUFFIX_OK.test(suffix)) next[id] = suffix;
    });
  }
  agentSuffix = next;
  return Object.keys(next).length;
}

/** "Sonnet-High" for an agent id, or null when its model or effort is unknown (or it is the owner). */
export function modelSuffixOf(agent) {
  return typeof agent === 'string' && own(agentSuffix, agent) ? agentSuffix[agent] : null;
}

/**
 * Text of the compact 3D label chip (.node-model): the "Model-Effort" suffix when known, otherwise the member's display
 * name (dynamic planets without an agent file, or /api/agents failed), so a planet never shows an empty label.
 * Only an empty name AND no suffix gives ''. Hover / focus still shows the full name chip (style.css).
 */
export function chipTextOf(agent, name) {
  return modelSuffixOf(agent) || (typeof name === 'string' ? name : '');
}

/** A name followed by the model suffix of the agent: "Dev-ไอ้เก่ง (Sonnet-High)". Just the name when there is no suffix. */
export function withModel(name, agent) {
  const suffix = modelSuffixOf(agent);
  return suffix ? `${name} (${suffix})` : name;
}

/** Display name of an agent id, with its model suffix when known. Unknown or empty ids are returned as text. */
export function labelOf(agent) {
  if (typeof agent !== 'string' || !agent) return 'unknown';
  if (!own(AGENT_LABEL, agent)) return withModel(agent, agent);
  const entry = AGENT_LABEL[agent];
  return `${withModel(entry.name, agent)}${entry.detail}`;
}

/** Pipeline step of an event: its pipelineStep when set, otherwise the step of its agent. null when unknown. */
export function stepOfEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (typeof ev.pipelineStep === 'string' && ev.pipelineStep) return ev.pipelineStep;
  return own(AGENT_STEP, ev.agent) ? AGENT_STEP[ev.agent] : null;
}

/* ---------- dynamic planets (agents that are not registered) ---------- */
// An agent that is not one of the registered team agents gets its own planet when it first appears in the events.
// Its body key is DYNAMIC_PREFIX + the agent id, so it never collides with a pipeline step (the step names have no ':').
// The planet itself (look, orbit, cap) is built in stellar/dynamic.js and scene.js.
const DYNAMIC_PREFIX = 'dyn:';

/** True when the body key belongs to a dynamic planet. */
export function isDynamicKey(key) {
  return typeof key === 'string' && key.length > DYNAMIC_PREFIX.length && key.startsWith(DYNAMIC_PREFIX);
}

/**
 * Body key of the dynamic planet of this agent id. null when the agent has a registered planet or no planet at all:
 * the registered team agents, the main agent (secretary) and the user are in AGENT_STEP.
 */
export function dynamicKeyOf(agent) {
  if (typeof agent !== 'string' || !agent) return null;
  if (own(AGENT_STEP, agent)) return null;
  return DYNAMIC_PREFIX + agent;
}

/**
 * Body key of an event: its pipeline step (registered agents and explicit pipelineStep), otherwise the dynamic
 * planet key of its agent. null when the event has no body (for example an unknown event without an agent).
 */
export function bodyKeyOf(ev) {
  return stepOfEvent(ev) || dynamicKeyOf(ev && ev.agent);
}

/** Agent id behind a body key: the registered agent of a step, or the name behind a dynamic key. null for others. */
export function agentOfBodyKey(key) {
  if (isDynamicKey(key)) return key.slice(DYNAMIC_PREFIX.length);
  return own(STEP_AGENT, key) ? STEP_AGENT[key] : null;
}

/** True when the body key can be focused as a planet (registered planet step or dynamic planet). */
export function isPlanetKey(key) {
  return PLANET_STEPS.includes(key) || isDynamicKey(key);
}

/* ---------- body mood and planet look ---------- */

export const MOOD = Object.freeze({ IDLE: 'idle', ACTIVE: 'active', DONE: 'done', ERROR: 'error' });

/**
 * Mood of a body from its last status.
 *   PROCESSING / WORKING -> active
 *   ERROR                -> error (stays until the next status of that body)
 *   COMPLETED            -> done while `flashing` is true (short flash), otherwise idle
 *   anything else        -> idle
 */
export function statusMood(status, flashing = false) {
  if (status === 'PROCESSING' || status === 'WORKING') return MOOD.ACTIVE;
  if (status === 'ERROR') return MOOD.ERROR;
  if (status === 'COMPLETED' && flashing) return MOOD.DONE;
  return MOOD.IDLE;
}

/**
 * Target look of a planet per mood. The scene eases from the current values to these targets.
 *   spin    radians per simulated second around the planet's own axis
 *   energy  0..1 opacity of the energy ring around the planet
 *   jitter  0..1 strength of the shake (error only)
 *   tint    halo colour (pale blue = idle, pale yellow = completed flash, red = error aura)
 */
const PLANET_LOOK = Object.freeze({
  idle: Object.freeze({ spin: 0.12, energy: 0, jitter: 0, tint: 0xbae6fd }),
  active: Object.freeze({ spin: 0.9, energy: 1, jitter: 0, tint: 0xbae6fd }),
  done: Object.freeze({ spin: 0.12, energy: 0, jitter: 0, tint: 0xfef08a }),
  error: Object.freeze({ spin: 0.12, energy: 0, jitter: 1, tint: 0xff3b3b }),
});

/** Planet look for a mood (idle when the mood is unknown). */
export function planetLook(mood) {
  return own(PLANET_LOOK, mood) ? PLANET_LOOK[mood] : PLANET_LOOK.idle;
}

/**
 * Visual intents of one workspace event: what the scene draws on top of the body status.
 * The dispatch comet (PROCESSING, sun -> planet) is drawn by handoff() from app.js, so it is not listed here
 * (for dynamic planets scene.js draws it).
 *   ERROR from any body                 -> { kind: 'failure', step }   debris pulled into the black hole
 *   COMPLETED from a planet (not sun)   -> { kind: 'result', step }    result comet planet -> sun
 * `step` is the body key (a pipeline step, or a dynamic key for an agent without a registered planet).
 * The user beacon draws nothing. Returns an array (possibly empty).
 */
export function visualIntentsForEvent(ev) {
  const step = bodyKeyOf(ev);
  if (!step || step === 'user') return [];
  if (ev.status === 'ERROR') return [{ kind: 'failure', step }];
  if (ev.status === 'COMPLETED' && step !== SUN_STEP) return [{ kind: 'result', step }];
  return [];
}

/* ---------- metrics (data honesty) ---------- */

export const NO_DATA = 'no data';

// Metrics the HUD shows. None of them exists in data/events.jsonl or the workspace event stream today.
export const METRICS = Object.freeze([
  { key: 'cpu', label: 'CPU' },
  { key: 'memory', label: 'Memory' },
  { key: 'tokens', label: 'Token usage / context limit' },
  { key: 'moons', label: 'Micro-agents (moons)' },
  { key: 'timeouts', label: 'Timeouts' },
]);

/** Text for one metric value: NO_DATA for null, undefined, empty or non-finite numbers. */
export function formatMetric(value) {
  if (value === null || value === undefined || value === '') return NO_DATA;
  if (typeof value === 'number' && !Number.isFinite(value)) return NO_DATA;
  return String(value);
}

/** One row per metric for the HUD. Values are looked up by key; a missing key is NO_DATA. */
export function metricRows(values = {}) {
  return METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    text: formatMetric(own(values, m.key) ? values[m.key] : null),
  }));
}
