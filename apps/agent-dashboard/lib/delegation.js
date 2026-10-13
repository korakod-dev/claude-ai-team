'use strict';
/**
 * delegation.js
 * One shared definition of "this tool call is a delegation to a sub-agent".
 *
 * Claude Code names the sub-agent tool "Agent" in current versions and "Task" in older ones.
 * Every place that treats delegation specially (normalize.js, workspace-adapter.js, workspace.js)
 * must use this helper, so the two names can never drift apart again.
 */

// Tool names that start a sub-agent (current name first, older name second)
const DELEGATION_TOOLS = Object.freeze(['Agent', 'Task']);

/**
 * @param {*} toolName  hook payload tool_name (any type)
 * @returns {boolean} true when toolName is the sub-agent delegation tool ("Agent" or the older "Task")
 */
function isDelegationTool(toolName) {
  return typeof toolName === 'string' && DELEGATION_TOOLS.includes(toolName);
}

module.exports = { isDelegationTool, DELEGATION_TOOLS };
