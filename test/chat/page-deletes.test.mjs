// Delete on the page (web/chat/deletes.js, sidebar.js, header.js, sheets.js), without a browser: what the
// confirmation says before the press (the names, how many, the 30 days), where Delete is in each menu.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
const D = await import('../../web/chat/deletes.js');

const { FakeElement, texts, byClass } = await import('./fakedom.mjs');

test('before the press: how many, that they go to the trash, and that the transcript goes after 30 days', () => {
  const one = D.deleteWords(['Fix the cart']);
  assert.equal(one.title, 'Delete this session?');
  assert.equal(one.ok, 'Delete');
  assert.match(one.text, /^It goes to the trash and leaves the list\. Put it back from the trash within 30 days; after that the transcript is removed for good\.$/, 'one session: its menu offers Delete only when it is not working');
  const three = D.deleteWords(['a', 'b', 'c']);
  assert.equal(three.title, 'Delete 3 sessions?');
  assert.equal(three.ok, 'Delete 3');
  assert.match(three.text, /^They go to the trash and leave the list\. Put them back.* A session that is working is not deleted\.$/);
  const src = fs.readFileSync(new URL('../../web/chat/deletes.js', import.meta.url), 'utf8');
  assert.match(src, /names\.slice\(0, 8\)\.map\(\(x\) => h\('li', x \|\| 'New session'\)\)/, 'the names are listed before the press');
  assert.match(src, /undoToast\(`\$\{n === 1 .*\(\) => putBack\(r\.deleted\.map\(\(x\) => x\.trash\)/, 'the toast has Undo');
});

test('Delete is in the session menu (Claude Code\'s sessions), a row\'s menu, the list\'s menu (Select to delete, Trash) and Earlier conversations', async () => {
  const { sessionItems } = await import('../../web/chat/header.js');
  const v = { cwd: '/w/shop', short: '~/w/shop', engine: { id: 'claude', capabilities: { fork: true } }, profile: { label: 'Main' } };
  const items = sessionItems(v);
  const del = items.find((x) => x.value === 'delete');
  assert.ok(del && del.danger, 'red, as a delete');
  assert.equal(items.at(-1).value, 'delete', 'last, after Rename');
  assert.ok(!sessionItems({ ...v, engine: { id: 'opencode', capabilities: {} } }).some((x) => x.value === 'delete'), 'another coding tool\'s session is archived, not deleted');
  const side = fs.readFileSync(new URL('../../web/chat/sidebar.js', import.meta.url), 'utf8');
  assert.match(side, /\{ label: 'Archived', icon: 'archive', run: \(\) => archivedSheet\(\) \},\n\s*\{ label: 'Select to delete'.*\n\s*\{ label: 'Trash'/);
  assert.match(side, /items\.push\(\{ label: 'Delete', icon: 'trash', danger: true/);
  const { deletable } = await import('../../web/chat/sidebar.js');
  assert.equal(deletable({ kind: 'chat', machine: null, tool: 'claude' }), true);
  assert.equal(deletable({ kind: 'chat', machine: null, tool: 'opencode' }), false, 'another coding tool\'s session is not offered to delete');
  assert.equal(deletable({ kind: 'chat', machine: 'box2', tool: 'claude' }), false, 'nor one of another computer');
  assert.equal(deletable({ kind: 'claude', machine: null }), false, 'nor a terminal');
  const sheets = fs.readFileSync(new URL('../../web/chat/sheets.js', import.meta.url), 'utf8');
  assert.match(sheets, /const canDelete = \(c\) => canDeleteConversation\(c, tool\);/, 'the App\'s list: the one rule');
  assert.equal(D.canDeleteConversation({ id: 'x' }), true, 'an ended conversation of Claude Code\'s');
  assert.equal(D.canDeleteConversation({ id: 'x', current: true }), false, 'not the one this page shows');
  assert.equal(D.canDeleteConversation({ id: 'x', chat: 'c1' }), false, 'not one open in an App session');
  assert.equal(D.canDeleteConversation({ id: 'x', terminal: true }), false, 'not one a terminal session runs now');
  assert.equal(D.canDeleteConversation({ id: 'x' }, 'opencode'), false, 'not another coding tool\'s');
  for (const f of ['web/session.js', 'web/projects.js']) {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.match(src, /canDeleteConversation\(c(, c\.tool)?\)/, `${f}: Delete offered by the same rule as the App's`);
  }
});

test('the trash says the day it goes for good as a date, not a weekday; a working session cannot be picked', () => {
  const now = new Date(2030, 10, 18, 12).getTime();
  assert.equal(D.goneOn(now + 30 * 86_400_000, now), 'on 18 Dec');
  assert.equal(D.goneOn(new Date(2031, 0, 5).getTime(), now), 'on 5 Jan 2031', 'another year names it');
  assert.equal(D.notPickable({ status: 'waiting' }), '');
  assert.match(D.notPickable({ status: 'working' }), /^Working/);
  assert.match(D.notPickable({ status: 'attention' }), /OK/);
  const src = fs.readFileSync(new URL('../../web/chat/deletes.js', import.meta.url), 'utf8');
  assert.match(src, /type: 'checkbox', disabled: !!why/);
  assert.doesNotMatch(src, /until\(x\.until\)/);
});

// ---------- what the page does, on the stand-in DOM: a sheet is a dialog, a request is answered by `answers` ----------
FakeElement.prototype.showModal = function showModal() {
  this.open = true;
};
FakeElement.prototype.close = function close() {
  this.open = false;
  this.listeners.close?.();
};
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
globalThis.location = globalThis.location || { hash: '', search: '', pathname: '/', href: '' };
let answers = {}; // "METHOD path" → [status, body] or a function of the body
const asked = [];
globalThis.fetch = async (url, o = {}) => {
  const key = `${o.method || 'GET'} ${url}`;
  asked.push(key);
  let a = answers[key] || [404, { error: 'not here' }];
  if (typeof a === 'function') a = a(o.body ? JSON.parse(o.body) : null);
  return { ok: a[0] < 400, status: a[0], json: async () => a[1] };
};
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const dialog = () => document.body.children.find((n) => n.tag === 'dialog');
const openTitle = () => (dialog() && dialog().open ? texts(byClass(dialog(), 'sheet-title')[0]).join('') : null);
const buttonOf = (root, text) => byClass(root, 'btn').concat(byClass(root, 'choice'), byClass(root, 'desk-menu-item')).find((b) => texts(b).join('').trim() === text);
const press = (b) => b.listeners.click({ currentTarget: b, preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 });
const toasts = () => byClass(document.body, 'toast').filter((t) => t.parentNode).map((t) => texts(t).join(' ').trim());

test('a Put back the server refuses stays in the trash with its reason, and no toast says "Put back"; focus stays in the trash', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  answers = {
    'GET /api/chats/trash': [200, { list: [{ id: 'e1', title: 'hello there', short: '~/shop', at: Date.now(), until: Date.now() + 30 * 86_400_000 }, { id: 'e2', title: 'add a coupon', short: '~/shop', at: Date.now(), until: Date.now() + 30 * 86_400_000 }] }],
    'POST /api/chats/trash/e1/restore': [409, { error: 'A conversation with the same id is in that folder again, so this one was not put back over it.' }],
    'POST /api/chats/trash/e2/restore': [200, { chat: 'c2' }],
  };
  let changed = 0;
  D.trashSheet({ after: () => changed++ });
  await settle();
  assert.equal(openTitle(), 'Trash');
  const rowOf = (title) => byClass(dialog(), 'del-row').find((r) => texts(r).includes(title));
  press(buttonOf(rowOf('hello there'), 'Put back'));
  await settle();
  assert.ok(rowOf('hello there'), 'the refused one is still listed');
  assert.match(texts(rowOf('hello there')).join(' '), /Not put back: A conversation with the same id/);
  assert.ok(!toasts().some((x) => /^Put back/.test(x)), 'no toast says it was put back');
  assert.equal(changed, 0, 'nothing changed');
  press(buttonOf(rowOf('add a coupon'), 'Put back'));
  await settle();
  assert.equal(rowOf('add a coupon'), undefined, 'the one put back leaves the trash');
  assert.ok(toasts().some((x) => /^Put back/.test(x)));
  assert.equal(document.activeElement, buttonOf(rowOf('hello there'), 'Put back'), 'the keyboard goes on to the next Put back');
  assert.equal(openTitle(), 'Trash', 'the sheet stays open');
  dialog().close();
});

test('the last Put back keeps the sheet open with its empty text, and the keyboard on Close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  answers = {
    'GET /api/chats/trash': [200, { list: [{ id: 'e3', title: 'pay by card', short: '~/shop', at: Date.now(), until: Date.now() + 30 * 86_400_000 }] }],
    'POST /api/chats/trash/e3/restore': [200, { chat: 'c3' }],
  };
  location.hash = '#/chat/here';
  D.trashSheet();
  await settle();
  press(buttonOf(dialog(), 'Put back'));
  await settle();
  assert.equal(openTitle(), 'Trash');
  assert.match(texts(dialog()).join(' '), /The trash is empty/);
  assert.equal(document.activeElement.getAttribute('title'), 'Close');
  assert.equal(location.hash, '#/chat/here', 'the page stays: the toast\'s Open goes to the session');
  dialog().close();
});

test('a toast with Undo stays while the pointer or the keyboard is on it, and Ctrl+Z presses Undo', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const keys = [];
  const add = document.addEventListener;
  const remove = document.removeEventListener;
  document.addEventListener = (k, fn) => k === 'keydown' && keys.push(fn);
  document.removeEventListener = (k, fn) => keys.splice(keys.indexOf(fn), 1);
  t.after(() => {
    document.addEventListener = add;
    document.removeEventListener = remove;
  });
  let undone = 0;
  const toast = D.undoToast('Deleted "hello there".', () => undone++);
  toast.listeners.focusin();
  t.mock.timers.tick(60_000);
  assert.ok(toast.isConnected, 'held while the keyboard is on it');
  toast.listeners.focusout();
  t.mock.timers.tick(3000);
  assert.ok(!toast.isConnected, 'gone a moment after it left');
  const two = D.undoToast('Deleted "add a coupon".', () => undone++);
  assert.equal(two.listeners.mouseenter, undefined);
  t.mock.timers.tick(7000);
  assert.ok(two.isConnected, 'longer than an ordinary toast');
  assert.match(byClass(two, 'toast-action')[0].getAttribute('aria-label'), /Ctrl\+Z/, 'the key is named');
  keys.at(-1)({ ctrlKey: true, key: 'z', target: document.body, preventDefault() {} });
  assert.equal(undone, 1, 'Ctrl+Z pressed Undo');
  assert.ok(!two.isConnected);
  const three = D.undoToast('Deleted "ship it".', () => undone++);
  keys.at(-1)({ ctrlKey: true, key: 'z', target: { tagName: 'TEXTAREA' }, preventDefault() {} });
  assert.equal(undone, 1, 'not inside a text field (its own undo)');
  three.remove();
});

test('one Ctrl+Z presses one Undo, the newest that shows: two deletes in a row come back one at a time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const keys = [];
  const add = document.addEventListener;
  const remove = document.removeEventListener;
  document.addEventListener = (k, fn) => k === 'keydown' && keys.push(fn);
  document.removeEventListener = (k, fn) => keys.includes(fn) && keys.splice(keys.indexOf(fn), 1);
  t.after(() => {
    document.addEventListener = add;
    document.removeEventListener = remove;
  });
  const undone = [];
  const key = () => {
    let stopped = false;
    for (const fn of [...keys]) fn({ ctrlKey: true, key: 'z', target: document.body, preventDefault: () => (stopped = true) });
    return stopped;
  };
  const one = D.undoToast('Deleted "one".', () => undone.push('one'));
  const two = D.undoToast('Deleted "two".', () => undone.push('two'));
  assert.ok(key(), 'the key was taken');
  assert.deepEqual(undone, ['two'], 'only the newest');
  assert.ok(one.isConnected && !two.isConnected, 'the older Undo still shows');
  assert.ok(key());
  assert.deepEqual(undone, ['two', 'one']);
  assert.equal(key(), false, 'none shows: the key is the page\'s again');
  assert.deepEqual(undone, ['two', 'one']);
  assert.equal(keys.length, 0, 'the listener went with the last toast');
});

test('Delete of an ended conversation says "conversation"; after its confirmation Earlier conversations opens again where it was', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = D.deleteWords(['an old ended talk'], 'conversation');
  assert.equal(w.title, 'Delete this conversation?');
  assert.equal(w.text, 'It goes to the trash and leaves Earlier conversations. Put it back from the trash within 30 days; after that the transcript is removed for good.');
  answers = { 'GET /api/chats/x/history': [200, { tool: 'claude', conversations: [{ id: 'k1', title: 'an old ended talk', at: Date.now() }, { id: 'k2', title: 'older still', at: Date.now() }] }] };
  const { historySheet } = await import('../../web/chat/sheets.js');
  historySheet({ A: '/api/chats/x', v: { cwd: '/w/shop', short: '~/w/shop', profile: { name: 'sub' } } });
  await settle();
  assert.equal(openTitle(), 'Earlier conversations');
  press(byClass(dialog(), 'chat-history-del')[0]);
  await settle();
  assert.equal(openTitle(), 'Delete this conversation?');
  press(buttonOf(dialog(), 'Cancel'));
  await settle();
  assert.equal(openTitle(), 'Earlier conversations', 'the list is there again after Cancel');
  t.mock.timers.tick(1);
  assert.equal(document.activeElement, byClass(byClass(dialog(), 'chat-history-row')[0], 'choice')[0], 'the keyboard on the row it was at');
  dialog().close();
});

test('a working session: Delete is off in the session menu and the row\'s menu, with the reason', async () => {
  const { sessionItems } = await import('../../web/chat/header.js');
  const v = { cwd: '/w/shop', short: '~/w/shop', engine: { id: 'claude', capabilities: {} }, profile: { label: 'Main' } };
  const del = (x) => sessionItems(x).find((i) => i.value === 'delete');
  assert.deepEqual([del({ ...v, status: 'working' }).disabled, del({ ...v, status: 'working' }).sub], [true, 'Working: stop it first']);
  assert.equal(del({ ...v, status: 'attention' }).disabled, true);
  assert.equal(del({ ...v, status: 'waiting' }).disabled, undefined);
});

test('a row has a ⋯ button that opens its menu (no right-click needed); Select to delete of the open session goes Home', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, x) => kept.set(k, String(x)) };
  t.after(() => delete globalThis.localStorage);
  const S = await import('../../web/chat/sidebar.js');
  const sessions = [
    { name: 'chat:a', kind: 'chat', chatId: 'a', display: 'Fix the cart', cwd: '/w/shop', short: '~/w/shop', status: 'waiting', statusAt: 100, tool: 'claude' },
    { name: 'chat:b', kind: 'chat', chatId: 'b', display: 'Busy one', cwd: '/w/shop', short: '~/w/shop', status: 'working', statusAt: 90, tool: 'claude' },
  ];
  const store = { all: [{ machine: null, machineLabel: 'Workstation', status: 'online', sessions }], multi: false, subscribe: (f) => (f(), () => {}), refresh() {} };
  const side = S.createSidebar({ store, current: { chat: 'a', machine: null }, newSession() {} });
  document.body.append(side.el);
  t.after(() => side.stop());
  const more = byClass(side.el, 'chat-side-more');
  assert.equal(more.length, 2, 'one on each row');
  assert.equal(more[0].getAttribute('aria-haspopup'), 'menu');
  assert.match(more[0].getAttribute('aria-label'), /^More for Fix the cart$/);
  press(more[1]);
  const menu = byClass(document.body, 'desk-menu').find((m) => m.parentNode);
  assert.deepEqual(byClass(menu, 'desk-menu-item').map((b) => texts(b).join('')), ['Open in new window', 'Archive', 'Delete (working: stop it first)']);
  const off = byClass(menu, 'desk-menu-item')[2];
  assert.ok(off.disabled === true || off.getAttribute('disabled') !== null, 'a working one cannot be deleted');
  press(more[1]); // the second press closes it
  // ---- Select to delete, with the open session picked ----
  answers = { 'POST /api/chats/delete': [200, { deleted: [{ trash: '0123456789abcdef', title: 'Fix the cart', chat: 'a' }], refused: [] }] };
  location.hash = '#/chat/a';
  press(byClass(side.el, 'chat-side-sort')[0]);
  press(buttonOf(document.body, 'Select to delete'));
  await settle();
  assert.equal(openTitle(), 'Select sessions to delete');
  const boxes = byClass(dialog(), 'del-row').map((r) => r.children.find((c) => c.tag === 'input'));
  boxes[0].listeners.change({ target: { checked: true } });
  press(buttonOf(dialog(), 'Delete 1'));
  await settle();
  press(buttonOf(dialog(), 'Delete'));
  await settle();
  assert.equal(location.hash, '#/', 'the open session was deleted: the page goes Home');
});

test('under a touch pointer Put back and a toast\'s Undo are 44 px high, as the other delete buttons', () => {
  const css = fs.readFileSync(new URL('../../web/chat/sidebar.css', import.meta.url), 'utf8');
  const coarse = [...css.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  assert.match(coarse, /\.del-trash \.btn, \.toast \.btn\.toast-action \{ min-height: 44px; \}/);
});

test('a toast can be pressed over an open sheet: its box is in the sheet (a modal dialog) while one is open, on the page after', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const L = await import('../../web/lib.js');
  let undone = 0;
  const one = D.undoToast('Deleted "an old ended talk".', () => undone++);
  const box = () => byClass(document.body, 'toasts')[0];
  assert.equal(box().parentNode, document.body, 'no sheet: on the page');
  L.openSheet({ title: 'Earlier conversations' }, () => []);
  assert.equal(box().parentNode, dialog(), 'inside the open modal dialog, the only part of the page a press reaches');
  L.openSheet({ title: 'Delete this conversation?' }, () => []); // one sheet in another's place
  assert.equal(box().parentNode, dialog(), 'not taken away with the old sheet\'s content');
  assert.ok(byClass(dialog(), 'toast').some((x) => texts(x).join(' ').includes('Undo')));
  dialog().close();
  assert.equal(box().parentNode, document.body, 'back on the page when the sheet closed');
  one.remove();
  assert.equal(undone, 0);
});

test('Put back draws the deleted page again in one place, wherever it was pressed (its own page, the list\'s Trash, the session menu\'s Trash); Open closes the trash', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fired = [];
  const had = { d: window.dispatchEvent, e: globalThis.HashChangeEvent };
  window.dispatchEvent = (e) => fired.push(e.type);
  globalThis.HashChangeEvent = class { constructor(type) { this.type = type; } };
  t.after(() => {
    window.dispatchEvent = had.d;
    globalThis.HashChangeEvent = had.e;
  });
  answers = {
    'GET /api/chats/trash': [200, { list: [{ id: 'e4', title: 'hello there', short: '~/shop', at: Date.now(), until: Date.now() + 30 * 86_400_000 }] }],
    'POST /api/chats/trash/e4/restore': [200, { chat: 'c4' }],
    'POST /api/chats/trash/e5/restore': [200, { chat: 'c9' }],
  };
  location.hash = '#/chat/c4'; // the page that says "This session was deleted"
  // As the list's Trash and the session menu's Trash open it: an after() that only refreshes the list.
  let refreshed = 0;
  D.trashSheet({ after: () => refreshed++ });
  await settle();
  press(buttonOf(dialog(), 'Put back'));
  await settle();
  assert.deepEqual(fired, ['hashchange'], 'the page that showed it deleted is drawn again at once, though its address stays');
  assert.equal(refreshed, 1, 'and the list is refreshed');
  const open = byClass(document.body, 'toast-action').filter((b) => b.isConnected && texts(b).join('') === 'Open').at(-1); // the newest
  press(open);
  assert.equal(openTitle(), null, 'Open closes the trash');
  assert.equal(location.hash, '#/chat/c4');
  assert.deepEqual(fired, ['hashchange'], 'not drawn a second time');
  // Undo from a toast, for a session another page shows: no redraw here; Open goes to its address.
  await D.putBack(['e5']);
  assert.deepEqual(fired, ['hashchange'], 'another session put back: this page is not drawn again');
  D.openChat('c9');
  assert.equal(location.hash, '#/chat/c9', 'another session: its address');
  const page = fs.readFileSync(new URL('../../web/chat/page.js', import.meta.url), 'utf8');
  const side = fs.readFileSync(new URL('../../web/chat/sidebar.js', import.meta.url), 'utf8');
  assert.match(page, /onclick: \(\) => trashSheet\(\{ after: \(\) => store\.refresh\(\) \}\)/, 'the deleted page\'s Open the trash needs no redraw of its own');
  assert.match(side, /run: \(\) => trashSheet\(\{ after: \(\) => o\.store\.refresh\?\.\(\) \}\)/, 'the list\'s Trash is the same sheet');
});

test('after Undo the terminal page\'s and the Projects page\'s Earlier conversations are drawn again, with the conversation back', () => {
  const src = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
  // deleteNow calls after() once the Delete is done and again (putBack) once its Undo is: both lists draw again there.
  assert.match(src('web/session.js'), /deleteConversation\(s\.cwd, picked\.id, name\(picked\), \{ after: \(\) => \{\n\s*store\.refresh\(\);\n\s*if \(deleting \|\| earlierShown\) earlierSheet\(s\);/, 'the terminal page: its sheet again, also after Undo');
  assert.match(src('web/projects.js'), /deleteConversation\(dir, c\.id, name, \{ after: \(\) => \{\n\s*store\.refresh\(\);\n\s*done\(\);/, 'the Projects page: its list read again, also after Undo');
});

test('on a phone the trash button of Earlier conversations is a finger\'s size (44 px), on the terminal page and the Projects page', () => {
  const src = (f) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
  assert.match(src('web/session.js'), /h\('button\.btn\.icon\.ghost\.small\.ses-pastdel'/);
  assert.match(src('web/page-session.css'), /@media \(max-width: 599px\) \{ \.ses-pastdel \{ width: 44px; min-height: 44px; \} \}/);
  assert.match(src('web/page-projects.css'), /@media \(max-width: 599px\) \{ \.pj-pastdel \{ width: 44px; min-height: 44px; \} \}/);
});

test('on a phone the chips give way to ONE pill that is cut with an ellipsis, a long model name is cut at 18 characters, and the page is never pushed sideways', () => {
  const css = fs.readFileSync(new URL('../../web/chat/chat-input.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-modelchip \.chat-chip-label \{ max-width: 18ch; \}/, 'the name is capped');
  const chat = fs.readFileSync(new URL('../../web/chat/chat.css', import.meta.url), 'utf8');
  const phone = chat.slice(chat.indexOf('/* ---------- phones'));
  assert.match(phone, /\.chat-chips \{ display: none; \}/, 'no chip row on a phone');
  assert.match(phone, /\.chat-setpill \{ display: inline-flex; \}/, 'the pill instead');
  assert.match(chat, /\.chat-pill-text \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/, 'one line, cut with an ellipsis');
  assert.match(chat, /\.chat-chip-label \{ min-width: 0; overflow: hidden; text-overflow: ellipsis;/, 'the name is cut with an ellipsis');
});
