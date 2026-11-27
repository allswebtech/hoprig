// The menu (27 Nov 2026): one list with no More, a phone bar of at most 5, the Settings gear in the page head in place
// of the light/dark button, the one badge on Home fed through registerHomeCount, and #/more landing on Settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import '../chat/fakedom.mjs';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');

globalThis.location = { hash: '#/', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });

test('registerHomeCount: Home shows the sum of what is registered, nothing registered shows no badge', async () => {
  const { registerHomeCount, homeCount } = await import('../../web/registry.js');
  assert.equal(homeCount(), 0, 'nothing registered: no badge');
  let n = 2;
  registerHomeCount(() => n);
  registerHomeCount(() => { throw new Error('x'); });
  registerHomeCount(() => 'junk');
  assert.equal(homeCount(), 2, 'a hook that throws or answers junk counts as 0');
  n = 5;
  assert.equal(homeCount(), 5);
  assert.throws(() => registerHomeCount('no'), /function/);
});

test('menu: Home, the main pages and Settings as one list; the phone bar has no More and at most 5', async () => {
  const { registerPage, registerHomeCount } = await import('../../web/registry.js');
  const { menuItems } = await import('../../web/shell.js');
  for (const [id, order] of [['wk', 5], ['ws', 10], ['pr', 20], ['co', 30]]) registerPage({ id, title: id, icon: 'info', group: 'main', order, render: () => {} });
  registerPage({ id: 'settings', title: 'Settings', icon: 'settings', group: 'more', order: 100, render: () => {} });
  registerPage({ id: 'extra-more', title: 'Extra', icon: 'info', group: 'more', order: 1, render: () => {} });
  const { homeCount } = await import('../../web/registry.js');
  const before = homeCount();
  registerHomeCount(() => 3);
  const { list, bar } = menuItems();
  assert.deepEqual(list.map((p) => p.id), ['home', 'wk', 'ws', 'pr', 'co', 'settings'], 'one list, Settings last, a page left in the old second group is not listed');
  assert.deepEqual(bar.map((p) => p.id), ['home', 'wk', 'ws', 'pr', 'co'], 'five tabs, no More');
  assert.ok(bar.length <= 5 && list.length <= 6);
  assert.equal(list[0].count, before + 3, 'the badge is on Home');
  assert.deepEqual([...list, ...bar].filter((p) => p.id !== 'home' && p.count).map((p) => p.id), [], 'no other number in the menu');
});

test('shell: no More heading, no More tab, the gear instead of the theme button, both through the code', () => {
  const s = read('shell.js');
  assert.doesNotMatch(s, /side-group-title/, 'no group heading');
  assert.doesNotMatch(s, /href: '#\/more'|icon\('grid'/, 'no More tab');
  assert.doesNotMatch(s, /themeButton|Dark colours|Light colours/, 'no theme button in the head');
  assert.match(s, /gearButton/);
  assert.match(s, /gear-btn/);
  assert.match(s, /aria-label['"]?: ?'Settings'|title: 'Settings'/);
  assert.match(s, /registeredHeadTools\(\)/, 'head tools stay');
  assert.match(fs.readFileSync(path.join(WEB, 'style.css'), 'utf8'), /\.gear-btn \{ display: none; \}/, 'the gear is for the phone: gone on wide');
});

test('#/more lands on Settings, with the computer prefix kept; the page itself is gone', () => {
  const app = read('app.js');
  assert.match(app, /'\/more': '\/settings'/);
  assert.doesNotMatch(app, /function viewMore|path === '\/more'/);
});
