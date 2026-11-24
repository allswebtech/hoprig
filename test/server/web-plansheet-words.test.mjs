// Plan with AI and Do it name the provider "provider", the same word as the field above them (never a second name,
// "the AI account"), and the reason Plan is grey stands in the sheet's footer beside Plan, which stays in view.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.Node ??= class {};
globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, append() {} }), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
const { planMissing } = await import('../../web/workpropose.js');
const { optionsLine } = await import('../../web/workdo.js');

test('one name: provider, never the AI account, in the plan sheet\'s and the Do it sheet\'s lines', () => {
  for (const t of [planMissing(null, null), planMissing('shop', null)]) {
    assert.doesNotMatch(t, /AI account/, t);
    assert.match(t, /a provider/, t);
  }
  const p = { tools: [{ id: 'claude', name: 'Claude Code' }], tool: 'claude', providers: [], provider: null, folders: [] };
  assert.equal(optionsLine(p), 'Claude Code: choose a provider');
});

test('the reason Plan is grey is in the footer beside Plan (sticky), not a line below the fields', () => {
  const src = fs.readFileSync(new URL('../../web/workpropose.js', import.meta.url), 'utf8');
  assert.match(src, /h\('div\.sheet-actions', project && \(v\.provider \|\| c\.provider\) \? null : h\('span\.wk-left\.wk-plan-missing', planMissing\(/);
  assert.doesNotMatch(src, /: planMissing\(project, v\.provider \|\| c\.provider\)\)\),/, 'no longer the info line under the fields');
});
