'use strict';
/**
 * partial-json.js
 * Best-effort field extraction from a hook payload that was CUT (stdin read cap in hook-logger.js).
 * A cut JSON text cannot be parsed, but its head still holds the small identifying fields
 * (hook_event_name, session_id, tool_name, ...) because Claude Code writes the large parts
 * (tool_input contents, tool_response) late. This scanner walks the text once, tracks nesting, and
 * collects only the string fields the normalizer reads, from these places and nowhere else:
 *   - top level                      hook_event_name, session_id, cwd, agent_id, agent_type, tool_name, tool_use_id,
 *                                    error, last_assistant_message, reason, source
 *   - tool_input   (top-level key)   subagent_type, description
 *   - tool_response (top-level key)  agentId, status
 * A value is taken only when its string is complete (closing quote seen). Nothing is ever evaluated or
 * regex-matched on the whole text, so text inside a big nested value cannot be mistaken for a top-level field.
 * Never throws.
 */

const TOP_KEYS = new Set([
  'hook_event_name', 'session_id', 'cwd', 'agent_id', 'agent_type', 'tool_name', 'tool_use_id',
  'error', 'last_assistant_message', 'reason', 'source',
]);
const NESTED_KEYS = {
  tool_input: new Set(['subagent_type', 'description']),
  tool_response: new Set(['agentId', 'status']),
};

/**
 * Read one JSON string starting at text[i] === '"'.
 * @returns {{ value: string, end: number }|null}  end = index after the closing quote; null when the string is not closed
 */
function readString(text, i) {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '"') {
      try {
        return { value: JSON.parse(text.slice(i, j + 1)), end: j + 1 };
      } catch (_err) {
        return null; // invalid escape: give up on this string
      }
    }
    j += 1;
  }
  return null; // cut inside the string
}

/**
 * @param {string} text  start of a JSON object (may be cut anywhere)
 * @returns {object}  payload-shaped object with only the complete string fields found, e.g.
 *                    { hook_event_name, tool_name, tool_input: { subagent_type }, tool_response: { status } }
 */
function scanPartialPayload(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  // Stack of container kinds ('{' or '[') and, for objects, the key whose value we are inside
  const stack = [];
  let pendingKey = null;       // last key string read in the current object, waiting for its value
  const keyPath = [];          // keys of the enclosing objects (depth 1 = top-level key we are inside)
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      const s = readString(text, i);
      if (!s) break;           // cut inside a string: stop, everything before is already collected
      i = s.end;
      // Is this string a KEY (next non-space char is ":") or a value?
      let k = i;
      while (k < n && /\s/.test(text[k])) k += 1;
      const top = stack[stack.length - 1];
      if (top === '{' && text[k] === ':') {
        pendingKey = s.value;
        i = k + 1;
        continue;
      }
      // A string VALUE: store it when it sits at a collected position
      if (top === '{' && pendingKey !== null) {
        if (stack.length === 1 && TOP_KEYS.has(pendingKey)) out[pendingKey] = s.value;
        else if (stack.length === 2 && keyPath[0] && NESTED_KEYS[keyPath[0]] && NESTED_KEYS[keyPath[0]].has(pendingKey)) {
          if (!out[keyPath[0]]) out[keyPath[0]] = {};
          out[keyPath[0]][pendingKey] = s.value;
        }
      }
      pendingKey = null;
      continue;
    }
    if (c === '{' || c === '[') {
      // Entering a container: remember which key it belongs to (only objects under a top-level key matter)
      if (stack.length === 1 && pendingKey !== null) keyPath[0] = pendingKey;
      stack.push(c);
      pendingKey = null;
    } else if (c === '}' || c === ']') {
      stack.pop();
      if (stack.length <= 1) keyPath.length = 0;
      pendingKey = null;
      if (stack.length === 0) break; // the top-level object is complete
    } else if (c === ',') {
      pendingKey = null;
    }
    i += 1;
  }
  return out;
}

module.exports = { scanPartialPayload };
