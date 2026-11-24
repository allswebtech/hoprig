// The folder list of New-session defaults can be opened at itself (?show=folders): its panel has the id, the fold
// that holds it opens for that address, and the two sentences that name it (Files reach, the editor's refusal) lead there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');

test('the Folders panel has the id folders, and its Advanced fold opens for ?show=folders', async () => {
  const s = src('sessiondefaults.js');
  assert.match(s, /panel\(\{ id: 'folders', icon: 'folder', title: 'Folders'/);
  assert.match(s, /if \(partOf\(queryOf\([^)]*location\.hash\)\) === 'folders'\) adv\.open = true;/);
  const { partOf } = await import('../../web/showpart.js');
  const queryOf = (hash) => new URLSearchParams(String(hash || '').split('?')[1] || '');
  assert.equal(partOf(queryOf('#/settings/new-sessions?show=folders')), 'folders');
});

test('Files reach and the editor link to the folder list itself', () => {
  assert.match(src('desktop/index.js'), /h\('a', \{ href: link\('#\/settings\/new-sessions\?show=folders'\) \}, 'New-session defaults'\)/);
  assert.match(src('editor/places.js'), /href: link\('#\/settings\/new-sessions\?show=folders', null\) \}, 'Open the folder list'/);
});
