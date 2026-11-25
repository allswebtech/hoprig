// The map panel's two new lines (web/workspacemap.js): the old form's line and its button, the letter-case line and
// its button, each shown only when the map says so, each said the same in docs/WORKSPACE.md and the changelog, and
// the page's yes sends the look's id back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s*\n\s*/g, ' ');

// Just enough of a browser for the page's modules to load: each element keeps its text, so the test reads it.
globalThis.Node ??= class {};
const el = (tag) => Object.assign(new globalThis.Node(), { tag, style: {}, dataset: {}, kids: [], classList: { add() {}, remove() {}, replace() {}, toggle() {} }, setAttribute() {}, addEventListener() {}, append(...k) { this.kids.push(...k); }, appendChild(k) { this.kids.push(k); return k; }, replaceChildren(...k) { this.kids = k; } });

globalThis.document ??= { createElement: el, createElementNS: el, createTextNode: (t) => ({ text: String(t) }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
const textOf = (n) => (!n ? '' : typeof n === 'string' ? n : n.text !== undefined ? n.text : [n.textContent || '', ...(n.kids || []).map(textOf)].join(' '));

const W = await import('../../web/workspacemap.js');

test('the old form: a line and its button only while the map is version 1; Undo only while it can be undone', () => {
  const v1 = W.mapExtras({ exists: true, map: { version: 1 } }, () => {});
  assert.match(textOf(v1), /Your workspace map is in the old form\./);
  assert.match(textOf(v1), /See what the upgrade changes/);
  assert.doesNotMatch(textOf(v1), /Undo/);
  assert.equal(W.mapExtras({ exists: true, map: { version: 2 } }, () => {}), null, 'nothing to say for version 2');
  assert.equal(W.mapExtras({ exists: false, map: { version: 1 } }, () => {}), null, 'no map yet');
  assert.equal(W.mapExtras({ exists: true, map: null, errors: ['x'] }, () => {}), null, 'a refused map has its own line');
  const up = textOf(W.mapExtras({ exists: true, map: { version: 2 }, upgradeUndo: true }, () => {}));
  assert.match(up, /Undo the upgrade/);
  assert.ok(up.includes(W.UPGRADED_HINT), 'the undo says what it undoes');
});

test('a folder that differs only in letter case: the status sentence and the rename button; Undo after a rename', () => {
  const m = { exists: true, map: { version: 2 }, caseOnly: [{ words: 'The folder Shop is shop in the map' }] };
  const t = textOf(W.mapExtras(m, () => {}));
  assert.match(t, /The folder Shop is shop in the map\./);
  assert.match(t, /Give it the map's name/);
  const back = textOf(W.mapExtras({ exists: true, map: { version: 2 }, caseUndo: true }, () => {}));
  assert.match(back, /Undo the rename/);
  assert.ok(back.includes(W.RENAMED_HINT), 'the undo says what it undoes');
});

test('the yes sends back the id of the look it showed, and the panel shows the lines next to the map', () => {
  const src = read('web/workspacemap.js');
  assert.match(src, /api\(UPGRADE, \{ dryRun: true \}\)/, 'the upgrade is looked at first');
  assert.match(src, /yes: \(seen\) => api\(UPGRADE, \{ seen \}\)/);
  assert.match(src, /api\(CASE, \{ dryRun: true, \.\.\.\(undo \? \{ undo: true \} : \{\}\) \}\)/);
  assert.match(src, /yes: \(seen\) => api\(CASE, \{ seen, \.\.\.\(undo \? \{ undo: true \} : \{\}\) \}\)/);
  assert.match(read('web/workspace.js'), /\n {4}mapExtras\(m, refresh\),\n/, 'in the map panel');
});

test('the docs and the changelog say the page\'s words', () => {
  const doc = flat(read('docs/WORKSPACE.md'));
  for (const s of ['"Your workspace map is in the old form"', '**See what the upgrade changes**', '**Upgrade the map**', '**Undo the upgrade**', '"This changed since you looked: look again."', '"The folder Shop is shop in the map"', '**Give it the map\'s name**', '**Undo the rename**', '`hoprig workspace map --undo`', '`hoprig workspace map --fix-case [--dry-run] [--yes] [--json]`', 'no Mac ran it']) assert.ok(doc.includes(s), `docs/WORKSPACE.md: ${s}`);
  assert.match(doc, /that nothing on disk changes/, 'the promise of the hint is in the docs');
  for (const s of [W.UPGRADED_HINT, W.RENAMED_HINT]) assert.ok(doc.includes(s), `docs/WORKSPACE.md: ${s}`);
  const log = read('site/content/changelog.md');
  const line = log.split('\n').find((l) => l.startsWith('- **The map\'s old form and a folder\'s letter case, on the Workspace page.**'));
  assert.ok(line, 'the changelog line');
  for (const s of [W.OLD_FORM, 'See what the upgrade changes', 'Undo the upgrade', 'The folder Shop is shop in the map', '`hoprig workspace map --fix-case`']) assert.ok(line.includes(s), `changelog: ${s}`);
  const CHANGED = 'This changed since you looked: look again.';
  assert.match(read('src/workspace/mapundo.mjs'), new RegExp(CHANGED.replace(/[.:]/g, '\\$&')));
  assert.match(read('src/workspace/mapcase.mjs'), new RegExp(CHANGED.replace(/[.:]/g, '\\$&')));
});
