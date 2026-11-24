// The new project's Check step, for a person who does not know the files: one line first (what is made, how many
// files, nothing else changes) with the list folded under "What exactly".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Just enough of a browser for the page's modules to load (nothing is drawn here).
globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, append() {} }), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
globalThis.Node ??= class {};
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const src = fs.readFileSync(new URL('../../web/projects.js', import.meta.url), 'utf8');

test('the Check step: one line he can judge first, the list folded under What exactly', async () => {
  const { checkLine } = await import('../../web/projects.js');
  const files = Array.from({ length: 35 }, (_, i) => `f${i}`);
  const pv = { dir: '/home/alex/Workspace/projects/bakery-website', template: 'built-in', files };
  assert.equal(checkLine(pv, { name: 'bakery-website', brief: 'A site for my bakery.' }), 'A folder bakery-website with your brief and the starting files the AI needs (35 files). Nothing else on the computer changes.');
  assert.equal(checkLine(pv, { name: 'bakery-website', brief: '' }), 'A folder bakery-website with the starting files the AI needs (35 files). Nothing else on the computer changes.');
  assert.match(checkLine({ ...pv, template: 'mine', files: ['a'] }, { name: 'x', brief: '', github: true }), /^A folder bakery-website with the files of your own project template \(1 file\)\. It is uploaded to a private GitHub repository too\. Nothing else/);
  for (const t of [checkLine(pv, { name: 'b', brief: 'x' })]) assert.doesNotMatch(t, /AGENTS\.md|ai_brain|\.claude|decisions\.md|skill/, 'no file he cannot judge in the first line');
  assert.match(src, /h\('p\.sheet-text', checkLine\(pv, st\)\),\n\s+fold\('new-what', 'What exactly', h\('ul\.pj-will',/, 'the line comes first, the list is folded');
});
