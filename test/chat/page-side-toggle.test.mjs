// Hide and show the session list, and the Home icon in the title bar (web/chat/header.js, keys.js, sidebar.css),
// without a browser: the button's words, its place first in the bar, the key, the menu entry, the way the choice is kept.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { byClass } from './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
globalThis.location ||= { hash: '', search: '', pathname: '/' };
const { createHeader, moreItems } = await import('../../web/chat/header.js');
const K = await import('../../web/chat/keys.js');
const src = (p) => fs.readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8');
const V = { title: 'Fix the cart', cwd: '/w/shop', short: '~/w/shop', engine: { id: 'claude' }, profile: { name: 'sub', label: 'Max' } };

test('the title bar starts with the session list button, then Home; the button names what it does and flips', () => {
  let off = false;
  let toggled = 0;
  const hd = createHeader({ A: '/api/chats/x', way: { hash: '#/', label: 'Home' }, act: {}, view: null, side: { hidden: () => off, toggle: () => { toggled++; off = !off; } } });
  hd.paint(V);
  const bar = hd.el.children.filter((n) => n.tag);
  const first = bar.filter((n) => /\bchat-sidebtn\b|\bchat-homebtn\b|\bchatback\b/.test(n.className)).map((n) => n.className.split(' ').find((c) => /^chat-(sidebtn|homebtn)$|^chatback$/.test(c)));
  assert.deepEqual(first, ['chatback', 'chat-sidebtn', 'chat-homebtn'], 'the list button, then Home, before the title');
  const side = byClass(hd.el, 'chat-sidebtn')[0];
  assert.equal(side.title, 'Hide session list');
  assert.equal(side.attrs['aria-label'], 'Hide session list');
  side.listeners.click();
  assert.equal(toggled, 1);
  hd.paint(V);
  assert.equal(side.title, 'Show session list');
  assert.equal(side.attrs['aria-label'], 'Show session list');
  const home = byClass(hd.el, 'chat-homebtn')[0];
  assert.equal(home.attrs.href, '#/');
  assert.equal(home.attrs.title, 'Home');
  assert.equal(home.attrs['aria-label'], 'Home');
});

test('the Desktop mode button is not in the chat bar; without a list there is no list button', () => {
  const hd = createHeader({ A: '/api/chats/x', way: { hash: '#/', label: 'Home' }, act: {}, view: null });
  hd.paint(V);
  assert.equal(byClass(hd.el, 'chat-deskbtn').length, 0);
  assert.equal(byClass(hd.el, 'chat-sidebtn').length, 0);
  assert.equal(byClass(hd.el, 'chat-homebtn').length, 1, 'Home is there with or without the list');
  assert.equal(byClass(hd.el, 'chatback')[0].attrs['aria-label'], 'Back to Home');
});

test('the more menu has Hide or Show session list only where the list fits', () => {
  const labels = (o) => moreItems(V, o).map((i) => i.label);
  assert.ok(labels({ side: { hidden: () => false }, sideWide: true }).includes('Hide session list'));
  assert.ok(labels({ side: { hidden: () => true }, sideWide: true }).includes('Show session list'));
  assert.ok(!labels({ side: { hidden: () => false }, sideWide: false }).some((x) => /session list/.test(x)));
  assert.ok(!labels({}).some((x) => /session list/.test(x)));
  assert.equal(moreItems(V, { side: { hidden: () => false }, sideWide: true }).find((i) => /session list/.test(i.label)).value, 'side');
});

test('Cmd+\\ or Ctrl+\\ hides and shows the list; the sheet has a row for it; it is no key the browser keeps', () => {
  const k = K.desktopKeys(false).find((x) => x.id === 'side');
  assert.equal(k.keys, 'Ctrl+\\');
  assert.equal(K.desktopKeys(true).find((x) => x.id === 'side').keys, 'Cmd+\\');
  assert.equal(k.why, undefined, 'no reason needed: the browser leaves it');
  assert.ok(K.shortcuts(false).some(([keys, what]) => keys === 'Ctrl+\\' && /session list/.test(what)));
  assert.ok(!K.shortcuts(false, 'alt-shift').some(([keys]) => keys === 'Ctrl+\\'), 'a window of the desktop has no list');
  assert.ok(K.isKey({ key: '\\', code: 'Backslash', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, k));
  assert.ok(!K.isKey({ key: '|', code: 'Backslash', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, k), 'with Shift it is another key');
  const page = src('chat/keys.js');
  assert.match(page, /k\.id === 'side'\) o\.side && o\.side\(\)/);
});

test('the choice is kept in this browser as chat.side = off, and the button shows only where the list fits', () => {
  const page = src('chat/page.js');
  assert.match(page, /prefs\.get\('chat\.side', 'on'\) === 'off'/);
  assert.match(page, /prefs\.set\('chat\.side'/);
  assert.match(page, /side: \(\) => sideCtl && sideFits\(\) && sideCtl\.toggle\(\)/);
  const css = src('chat/sidebar.css');
  const wide = css.split('@media (min-width: 900px)')[1];
  assert.match(wide, /\.chat-wrap\.chat-side-off \.chat-side \{ display: none; \}/, 'hidden: the chat takes the whole width');
  assert.match(css.split('@media (min-width: 900px)')[0], /\.chat-sidebtn, \.chat-homebtn \{ display: none; \}/, 'narrower: neither (Back is there)');
  assert.match(wide, /\.chat-sidebtn, \.chat-homebtn \{ display: inline-flex; \}/);
});
