'use strict';
/**
 * workspace-sidebar-fit.test.js - static checks on style.css / index.html so the 7 agent cards keep fitting in the sidebar:
 *   - the activity text ("คิดอยู่" / "กำลังใช้ tool: ...") sits on the NAME row (row 1), never on its own row, so a card does
 *     not grow when agents start working
 *   - the activity text is cut with an ellipsis instead of wrapping
 *   - the log row shrinks with the viewport height, and there are compact card rules for short screens
 *   - index.html still has all 7 cards
 * This is a static check (no browser): the real pixel fit was measured with headless Chrome at 1600x900 and 1440x810.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'public', 'workspace');
const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

/** Body of the first rule whose selector is exactly `selector` (top level, not inside @media). */
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `rule not found: ${selector}`);
  return m[1];
}

test('index.html: 7 agent cards (router + 6 specialists)', () => {
  assert.equal((html.match(/<li class="agent-card"/g) || []).length, 7);
});

test('style.css: the activity text shares row 1 with the name; the scope line is row 2', () => {
  assert.match(rule('.agent-info'), /display:\s*grid/);
  assert.match(rule('.agent-name'), /grid-row:\s*1/);
  assert.match(rule('.agent-act'), /grid-row:\s*1/, 'activity text must not add a row');
  assert.match(rule('.agent-act'), /grid-column:\s*2/);
  assert.match(rule('.agent-scope'), /grid-row:\s*2/);
});

test('style.css: long activity text is truncated, not wrapped; empty text takes no space', () => {
  const act = rule('.agent-act');
  assert.match(act, /white-space:\s*nowrap/);
  assert.match(act, /text-overflow:\s*ellipsis/);
  assert.match(act, /min-width:\s*0/);
  assert.match(rule('.agent-act:empty'), /display:\s*none/);
});

test('style.css: the log row flexes with the viewport height (agent list keeps room on laptops)', () => {
  assert.match(rule('.col-right'), /grid-template-rows:[^;]*min\(\s*250px\s*,\s*28vh\s*\)/);
});

test('style.css: compact card rules exist for short screens in the two-column layout only', () => {
  assert.match(css, /@media \(max-height: 860px\) and \(min-width: 1101px\)\s*\{[^@]*\.agent-card\s*\{[^}]*padding/);
  assert.match(css, /@media \(max-height: 780px\) and \(min-width: 1101px\)\s*\{[^@]*\.agent-card\s*\{[^}]*padding/);
});
