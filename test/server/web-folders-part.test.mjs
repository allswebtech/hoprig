// The folder list can be opened at itself (?show=folders): it is under Settings → Security and sign-in now, its panel
// has the id, the old address of New sessions leads there, and the sentences that name it (the editor's refusal) lead
// there too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const src = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');

test('the Folders panel has the id folders, on the Security page', async () => {
  assert.match(src('settings.js'), /panel\(\{ id: 'folders', icon: 'folder', title: 'Folders Hoprig may open'/);
  assert.match(src('settings.js'), /foldersPanel\(ctx\.settings\),/);
  const { partOf } = await import('../../web/showpart.js');
  const queryOf = (hash) => new URLSearchParams(String(hash || '').split('?')[1] || '');
  assert.equal(partOf(queryOf('#/settings/security?show=folders')), 'folders');
});

test('the old address of the folder list (New sessions, ?show=folders) opens Security', async () => {
  globalThis.location = { hash: '#/', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  await import('../chat/fakedom.mjs');
  const { chooseSettingsPage } = await import('../../web/settings.js');
  const pages = [{ id: 'new-sessions' }, { id: 'security' }];
  assert.equal(chooseSettingsPage(pages, 'new-sessions', 'folders').chosen.id, 'security');
});

test('the editor links to the folder list itself', () => {
  assert.match(src('editor/places.js'), /href: link\('#\/settings\/security\?show=folders', null\) \}, 'Open the folder list'/);
});
