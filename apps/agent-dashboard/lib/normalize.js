'use strict';
/**
 * normalize.js
 * Converts a raw Claude Code hook payload (JSON received on stdin) into a flat,
 * minimal record that is appended to the local JSONL events file.
 *
 * Privacy/size: prompts, full tool inputs and transcripts are intentionally NOT stored. An ordinary tool call (Read, Bash, Edit, ...)
 * is stored as ids + tool_name only (plus `error` for a failure, max 160 chars); the task description is kept for the Agent tool only.
 * Only short fields needed by the dashboard are kept. Free-text fields are
 * redacted (best effort, regex based) and clipped before they are stored.
 * Short identifier fields are length-capped. cwd is redacted like free text and stored with the
 * home folder replaced by "~".
 * Error text and messages are still stored in PLAINTEXT in data/events.jsonl (apart from the
 * redaction below). See HOOKS-SETUP.md section "Privacy".
 *
 * Field names of the raw payload follow the Claude Code hooks reference:
 *   common: session_id, cwd, hook_event_name, agent_id, agent_type, tool_use_id
 *   Agent tool input: tool_input.subagent_type, tool_input.description
 *   Agent tool response: tool_response.agentId, tool_response.status
 *   SubagentStop/Stop: last_assistant_message
 *   PostToolUseFailure: error
 *   StopFailure: error (error type)
 *   SessionEnd: reason, SessionStart: source
 */

const { isDelegationTool } = require('./delegation');

const MAX_TEXT = 200;        // max chars kept for last_assistant_message
const MAX_ERROR = 160;       // max chars kept for error text (QA M3)
const MAX_DESCRIPTION = 120; // max chars kept for the Agent task description
const MAX_REASON = 80;       // max chars kept for SessionEnd reason / SessionStart source
const MAX_ID = 128;          // max chars for short identifier fields (session_id, agent_id, tool_use_id, ...)
const MAX_CWD = 256;         // max chars kept for cwd (after the home folder is replaced by "~")
const MAX_INPUT = 4000;      // regex window: longer free text is cut at a space BEFORE redaction (bounds regex cost)

// Multi-line PEM private key block (BEGIN ... END). Applied while line breaks still exist, because
// flattening newlines to spaces would split the base64 body and leak its fragments.
// An unclosed block (cut by the input window) is redacted up to the end of the window.
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;

// Secret-like key=value and "key": value pairs (pattern 5 below).
// Group 1 = the key part (kept), the value is replaced by [REDACTED].
// - keyword has no word boundary before it, so DB_PASSWORD, client_secret, GITHUB_TOKEN match.
// - "pass" is special: only as a whole word or with a _ . - suffix (DB_PASS=, pass:), so
//   "passed:", "bypass=" and "compass" are NOT redacted.
// - value forms:
//     "..." or '...'   quoted; an unclosed quote runs to the end of the text.
//                     After the CLOSING quote, if the next char is glued to it (no space, and not one
//                     of ; & , } ]), the value continues to ";" or "&" or the end of the text, so
//                     password="a b"c d hides "c d". A space right after the closing quote ends the
//                     value: password="a b" next keeps "next" readable. "," "}" "]" stop it, so
//                     normal JSON {"password":"x","user":"bob"} keeps "user" readable.
//                     Known limit: escaped quotes (\") inside a JSON string end the value early.
//     bare value      runs to ";" or "&", or to the end of the text. Quotes, spaces and digits do
//                     NOT stop it, so "password=abc def123" hides the whole tail and
//                     "password=a"b c d" hides "a"b c d" (a quote inside a bare value is part of it).
//                     A bare value never starts with a quote: a leading quote takes the quoted rule above.
//                     Over-redaction is accepted on purpose (e.g. "password=x is wrong" hides
//                     "is wrong"). Leaks are not accepted. Same rule for every key.
const SECRET_KV = new RegExp(
  '((?:(?<![A-Za-z])pass(?:[_.-][A-Za-z0-9_.-]*)?'
  + '|(?:password|passwd|passphrase|pwd|secret|token|credential|api[_-]?key|access[_-]?key|private[_-]?key|signature)[A-Za-z0-9_.-]*)'
  + '["\']?\\s*[:=]\\s*)'
  // Alternatives in order: double-quoted, single-quoted, bare (stops only at ";" or "&" or end).
  // A quoted value may be followed by glued chars: the optional group
  //   (?=[^\s;&,}\]])[^;&]*   starts only if the next char is not whitespace, ";", "&", ",", "}" or "]",
  // and then runs to ";" or "&" or the end (same as the bare rule).
  + '(?:"[^"]*"?(?:(?=[^\\s;&,}\\]])[^;&]*)?'
  + '|\'[^\']*\'?(?:(?=[^\\s;&,}\\]])[^;&]*)?'
  + '|[^;&]+)',
  'gi',
);

/**
 * Decide whether a 32+ char run of [A-Za-z0-9+/_-] (plus optional "=" padding) is a base64 blob rather than a file path.
 * Only runs that contain "/" or "+" or end with "=" are judged here (a run without them is handled by the plain
 * long-opaque rule). A blob is redacted when
 *   - "/" is rare in it (at most one per 16 chars: a path has one every 6-10 chars), and
 *   - it ends with "=" padding, or contains "+", or mixes digits, upper case and lower case (random-looking).
 * Best effort: a path with a long mixed-case run and few slashes can still be redacted (over-redaction, on purpose).
 * @param {string} m  matched run
 * @returns {boolean}
 */
function isBase64Blob(m) {
  const special = m.includes('/') || m.includes('+') || m.endsWith('=');
  if (!special) return false;
  const slashes = (m.match(/\//g) || []).length;
  if (slashes * 16 > m.length) return false;
  return m.endsWith('=') || m.includes('+') || (/[0-9]/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m));
}

// Patterns replaced before any free text is stored. Best effort only: a secret that matches
// none of these is still stored. Order matters (more specific patterns first).
const REDACTIONS = [
  // 1. Authorization header with ANY scheme (Basic, Bearer, Digest, ...): keep the header name,
  //    drop the scheme and the credential. Matches inside longer names too (Proxy-Authorization).
  [/(authorization["']?\s*[:=]\s*["']?)(?:[A-Za-z]+\s+)?[^\s"',;&]+/gi, '$1[REDACTED]'],

  // 1b. Cookie and Set-Cookie headers: keep the header name, drop the name=value pairs
  //     (a value is one or more "name=value" pairs separated by ";", or a bare run).
  [/((?:set-)?cookie["']?\s*[:=]\s*["']?)(?:[^\s=;"']+=[^;"'\s]*(?:\s*;\s*[^\s=;"']+=[^;"'\s]*)*|[^\s"',;&]+)/gi, '$1[REDACTED]'],

  // 2. Bearer tokens anywhere in the text.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],

  // 3. Vendor key prefixes: sk-, pk-, GitHub tokens (ghp_ gho_ ghu_ ghs_ ghr_ and fine-grained github_pat_), GitLab glpat-,
  //    Slack xoxa/xoxb/xoxp/xoxr/xoxs- and xapp-.
  [/\b(?:sk|pk|gh[pousr]|github_pat|glpat|xox[abprs]|xapp)[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]'],

  // 3b. Other vendor key formats: npm tokens (npm_ + 20+ alphanumerics), Google API keys (AIza + 35 chars).
  [/\bnpm_[A-Za-z0-9]{20,}/g, '[REDACTED_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_KEY]'],

  // 3c. JSON Web Tokens (header.payload.signature, header and payload start with "eyJ"): the payload carries claims, so the
  //     whole token goes, not only the signature. The signature part may be empty (unsigned token).
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]'],

  // 4. AWS access key IDs: AKIA (long-term) or ASIA (temporary), 20 chars in total.
  //    No word boundary: the ID may follow "=" or sit inside a longer name.
  [/(?:AKIA|ASIA)[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]'],

  // 4b. URL userinfo: scheme://user:password@host -> scheme://[REDACTED]@host
  //     The password may itself contain "@" (greedy up to the LAST "@" before the first "/" or space).
  [/(:\/\/)[^\s:/@]+:[^\s/]+@/g, '$1[REDACTED]@'],

  // 4c. Secret flags with the value after a space: --password hunter2, --token abc, --api-key abc, --secret-key abc.
  //     (The "=" form, --password=hunter2, is handled by the key=value pattern below.)
  [/(--[A-Za-z-]*(?:password|passwd|token|secret|api-?key|access-?key)[A-Za-z-]*\s+)(?!-)\S+/gi, '$1[REDACTED]'],

  // 4d. A bare "key" query parameter (?key=... / &key=...), e.g. Google APIs. A bare word "key=" in normal text is left alone.
  [/([?&]key=)[^&\s#]+/gi, '$1[REDACTED]'],

  // 5. Secret-like key=value and "key": value pairs (env vars, JSON, URLs, log lines).
  //    Side effect: a longer word such as "tokens:" is redacted too (over-redaction, on purpose).
  [SECRET_KV, '$1[REDACTED]'],

  // 6. Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],

  // 7a. Base64 / base64url blobs that contain "/" or "+" or end with "=" padding (32+ chars). The plain rule below cannot see
  //     them whole, because "/", "+" and "=" split the run. See isBase64Blob() for what counts as a blob (paths stay readable).
  [/[A-Za-z0-9+/_-]{32,}={0,2}/g, (m) => (isBase64Blob(m) ? '[REDACTED_TOKEN]' : m)],

  // 7. Long opaque strings (32+ chars of letters, digits, _ and -): keys, hashes (hex and base64url included).
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[REDACTED_TOKEN]'],

  // 8. Home folder: keep the path tail, drop the user name (macOS, Linux, Windows).
  [/\/(?:Users|home)\/[^/\s]+/g, '~'],
  [/[A-Za-z]:\\Users\\[^\\\s]+/g, '~'],
];

// Home folder at the START of a path: /Users/<name>, /home/<name>, C:\Users\<name>.
// The lookahead makes sure the whole user name is matched (not a prefix of it).
const HOME_PREFIX = /^(?:\/Users\/[^/\\]+|\/home\/[^/\\]+|[A-Za-z]:\\Users\\[^\\/]+)(?=$|[/\\])/;

/**
 * Cut a string to at most `n` UTF-16 code units without leaving a lone high surrogate at the end
 * (a surrogate pair is never split: the cut moves one unit back in that case).
 */
function cutAt(s, n) {
  let end = n;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // high surrogate at the cut: drop it too
  return s.slice(0, end);
}

/** Clip a string to a safe length. Non-strings return undefined (field is dropped). */
function clip(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? `${cutAt(value, max)}...` : value;
}

/**
 * Redact and flatten free text, WITHOUT clipping to a display length.
 * Steps: bound the input -> PEM private key blocks -> control chars to spaces -> cut at a space
 *        -> regex redaction -> collapse spaces.
 * @param {*} value  raw field value (non-strings give undefined)
 * @returns {string|undefined}  redacted text (may be empty), or undefined for non-strings
 */
function redactText(value) {
  if (typeof value !== 'string') return undefined;

  // 1) Bound the input. Take one char more than the window to know whether it was cut.
  let text = value.slice(0, MAX_INPUT + 1);

  // 2) Redact PEM private key blocks while line breaks are still present.
  text = text.replace(PEM_BLOCK, '[REDACTED_PRIVATE_KEY]');

  // 3) Control chars (including newlines and tabs) become spaces.
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ');

  // 4) If the text is longer than the window, cut at the last space inside it. A secret written
  //    without spaces is then either fully inside the window or fully dropped; it is never
  //    split by this cut. Only when there is no space at all do we cut at the hard limit.
  //    Test: test/normalize.test.js "secret straddling the INPUT window ...".
  if (text.length > MAX_INPUT) {
    const space = text.lastIndexOf(' ', MAX_INPUT);
    text = space > 0 ? text.slice(0, space) : cutAt(text, MAX_INPUT);
  }

  // 5) Redact the bounded text (all patterns, before any clipping).
  for (const [pattern, replacement] of REDACTIONS) text = text.replace(pattern, replacement);

  // 6) Collapse spaces.
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Redact, flatten and clip free text before it is stored.
 * Clipping is the LAST step (after redactText), so a secret is already replaced when the output is
 * cut and can never be stored half-readable.
 * @param {*} value  raw field value (non-strings give undefined)
 * @param {number} max  max output length
 * @returns {string|undefined}
 */
function safeText(value, max) {
  const text = redactText(value);
  if (text === undefined) return undefined;
  return clip(text, max) || undefined;
}

/**
 * Return a short identifier field, or undefined, so JSON.stringify drops it when missing.
 * Values longer than `max` are cut (display and grouping only, so a cut id is still stable).
 */
function str(value, max = MAX_ID) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > max ? cutAt(value, max) : value;
}

/** Replace the home folder at the start of a path with "~" (so the user name is not stored). */
function homeToTilde(p) {
  return p.replace(HOME_PREFIX, '~');
}

/**
 * cwd field: home folder replaced by "~", then redacted like free text (a path can carry a secret,
 * e.g. "?token=..."), then length-capped to MAX_CWD (no "..." suffix, same as other ids).
 */
function cwdField(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const text = redactText(homeToTilde(value));
  if (!text) return undefined;
  return str(text, MAX_CWD);
}

/**
 * @param {object} raw   parsed hook payload
 * @param {Date}   [now] injectable clock (used by tests and replay)
 * @returns {object|null} normalized record, or null if the payload is not a hook payload
 */
function normalize(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object' || typeof raw.hook_event_name !== 'string') {
    return null;
  }
  const input = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
  const resp = raw.tool_response && typeof raw.tool_response === 'object' ? raw.tool_response : {};
  // SessionEnd sends "reason"; SessionStart sends "source". Use whichever is a non-empty string.
  const reasonRaw = typeof raw.reason === 'string' && raw.reason.length > 0 ? raw.reason : raw.source;

  // With the hook matcher on every tool, ordinary tool records (Read, Bash, Edit, ...) are the bulk of the log. They keep only
  // tool_name / ids; the free text of their input (a Bash "description", ...) is NOT stored: nothing reads it (only the Agent
  // PreToolUse uses it as the task text), and it would add up to 123 chars of text per record. A payload without tool_name
  // (SubagentStart, Stop, tests) and the Agent tool (also its older name "Task") keep the field as before.
  const isDelegation = typeof raw.tool_name !== 'string' || isDelegationTool(raw.tool_name);

  return {
    ts: now.toISOString(),                 // receive time (hook-side clock)
    event: raw.hook_event_name,
    session_id: str(raw.session_id) || 'unknown',
    cwd: cwdField(raw.cwd),                // home folder replaced by "~", then redacted
    agent_id: str(raw.agent_id),           // present only for events fired inside a subagent
    agent_type: str(raw.agent_type),       // agent name (subagent or --agent session)
    tool_name: str(raw.tool_name),
    tool_use_id: str(raw.tool_use_id),
    subagent_type: str(input.subagent_type), // Agent tool: which agent was requested
    description: isDelegation ? safeText(input.description, MAX_DESCRIPTION) : undefined, // only a delegation's task text; see below
    agent_ref: str(resp.agentId),          // PostToolUse(Agent): id of the spawned subagent
    response_status: str(resp.status),     // "completed" | "async_launched"
    error: safeText(raw.error, MAX_ERROR), // PostToolUseFailure message or StopFailure type
    last_message: safeText(raw.last_assistant_message, MAX_TEXT),
    reason: safeText(reasonRaw, MAX_REASON), // SessionEnd reason / SessionStart source (redacted)
  };
}

module.exports = {
  normalize,
  clip,
  safeText,
  homeToTilde,
  MAX_TEXT,
  MAX_ERROR,
  MAX_DESCRIPTION,
  MAX_REASON,
  MAX_ID,
  MAX_CWD,
  MAX_INPUT,
};
