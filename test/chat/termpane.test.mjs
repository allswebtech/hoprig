// The terminal pane under the chat (web/chat/termpane.js), without a browser: a shell in the session's folder by the
// route the editor's terminal uses (POST /api/shells), kept while the pane is hidden, + adds a tab, Ctrl+` and the
// title bar's Terminal button.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { byClass } from './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
globalThis.location ||= { hash: '', search: '', pathname: '/' };
const src = (p) => fs.readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8');
const { machine } = await import('../../web/lib.js');
const { createTermPane } = await import('../../web/chat/termpane.js');
const K = await import('../../web/chat/keys.js');
const { createHeader } = await import('../../web/chat/header.js');

function fetcher() {
  const calls = [];
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const json = String(url).endsWith('/api/shells') ? { name: `w${++n}` } : {};
    return { ok: true, status: 200, json: async () => json };
  };
  return calls;
}
const frames = (el) => {
  const out = [];
  const walk = (x) => (x.children || []).forEach((c) => { if (c.tag === 'iframe') out.push(c); walk(c); });
  walk(el);
  return out;
};

test('the pane starts a shell in the session folder, keeps it when hidden, and + adds a tab', async () => {
  const calls = fetcher();
  const shown = [];
  const p = createTermPane({ id: 'c1', cwd: () => '/w/shop', onToggle: (on) => shown.push(on) });
  assert.equal(p.shown, false);
  await p.show();
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [['POST', '/api/shells', { dir: '/w/shop', chat: 'c1' }]]);
  assert.equal(frames(p.el).length, 1);
  assert.match(frames(p.el)[0].attrs.src, /#\/s\/w1$/, 'the shell\'s own session page');
  p.hide();
  assert.equal(p.shown, false);
  assert.equal(frames(p.el).length, 1, 'hidden, not ended: its history stays');
  await p.show();
  assert.equal(calls.length, 1, 'shown again: the same shell, no new one');
  const add = byClass(p.el, 'chat-term-add')[0];
  assert.ok(add && add.attrs['aria-label'], 'the + button has a name');
  await add.listeners.click();
  assert.equal(calls.filter((c) => c.url === '/api/shells').length, 2);
  assert.equal(frames(p.el).length, 2);
  assert.equal(byClass(p.el, 'chat-term-tab').length, 2);
  assert.deepEqual(shown, [true, false, true]);
});

test('End this terminal ends the tab\'s shell on the computer, tab by tab, and closing the last tab hides the pane', async () => {
  const calls = fetcher();
  const shown = [];
  const p = createTermPane({ id: 'c4', cwd: () => '/w/shop', onToggle: (on) => shown.push(on) });
  await p.show();
  await byClass(p.el, 'chat-term-add')[0].listeners.click();
  const bin = byClass(p.el, 'chat-term-kill')[0];
  await bin.listeners.click();
  assert.deepEqual(calls.filter((c) => /kill$/.test(c.url)).map((c) => [c.method, c.url]), [['POST', '/api/sessions/w2/kill']], 'the shown tab\'s own shell');
  assert.equal(frames(p.el).length, 1);
  assert.equal(p.shown, true, 'a tab is left: the pane stays');
  await bin.listeners.click();
  assert.deepEqual(calls.filter((c) => /kill$/.test(c.url)).map((c) => c.url), ['/api/sessions/w2/kill', '/api/sessions/w1/kill']);
  assert.equal(frames(p.el).length, 0);
  assert.equal(p.shown, false, 'the last tab closed: the pane hides');
  assert.deepEqual(shown, [true, false]);
});

test('archiving the chat ends the shells its pane holds', async () => {
  const calls = fetcher();
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  try {
    const p = createTermPane({ id: 'c5', cwd: () => '/w/shop' });
    await p.show();
    await byClass(p.el, 'chat-term-add')[0].listeners.click();
    p.hide();
    const { archiveSession } = await import('../../web/chat/sidebar.js');
    assert.equal(await archiveSession({ chatId: 'c5' }), true);
    assert.deepEqual(calls.filter((c) => /kill$/.test(c.url)).map((c) => c.url).sort(), ['/api/sessions/w1/kill', '/api/sessions/w2/kill']);
    assert.equal(store.size, 0, 'nothing is kept for a chat that is archived');
    const other = calls.length;
    assert.equal(await archiveSession({ chatId: 'c6' }), true);
    assert.equal(calls.slice(other).filter((c) => /kill$/.test(c.url)).length, 0, 'a chat with no pane shells ends nothing');
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('a shell on another computer goes through that computer', async () => {
  const calls = fetcher();
  machine.set('lap');
  const p = createTermPane({ id: 'c2', cwd: () => '/w/a' });
  await p.show();
  machine.set(null);
  assert.equal(calls[0].url, '/m/lap/api/shells');
  assert.match(frames(p.el)[0].attrs.src, /#\/m\/lap\/s\/w1$/);
});

test('no terminal on the computer: the pane says why in a line', async () => {
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'no shell here' }) });
  const p = createTermPane({ id: 'c3', cwd: () => '/w/a' });
  await p.show();
  assert.equal(frames(p.el).length, 0);
  assert.match(byClass(p.el, 'chat-term-note')[0].children.map((c) => c.text).join(''), /No terminal here: No shell here/);
});

test('Ctrl+` toggles the pane, the sheet lists it, and the title bar\'s first button is Terminal', () => {
  const k = K.desktopKeys(false).find((x) => x.id === 'terminal');
  assert.equal(k.keys, 'Ctrl+`');
  assert.equal(K.desktopKeys(true).find((x) => x.id === 'terminal').keys, 'Ctrl+`', 'the Control key on a Mac too');
  assert.ok(K.isKey({ key: '`', code: 'Backquote', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, k));
  assert.ok(K.shortcuts(false).some(([keys, what]) => keys === 'Ctrl+`' && /terminal/i.test(what)));
  assert.match(src('chat/keys.js'), /k\.id === 'terminal'\) o\.terminal && o\.terminal\(\)/);
  let n = 0;
  const hd = createHeader({ A: '/api/chats/x', way: null, act: { termPane: () => n++ }, view: null });
  hd.paint({ title: 't', cwd: '/w/shop', short: '~/w/shop', engine: { id: 'claude' }, profile: { name: 's', label: 'M' } });
  const btns = byClass(hd.el, 'chat-tbtns')[0].children.map((x) => x.attrs.title);
  assert.deepEqual(btns.slice(0, 3), ['Terminal (Ctrl+`)', 'Changes', 'Files']);
  byClass(hd.el, 'chat-tbtns')[0].children[0].listeners.click();
  assert.equal(n, 1, 'the button opens the pane (the hand-off is in the session menu)');
  hd.paintTerm(true);
  assert.equal(byClass(hd.el, 'chat-tbtns')[0].children[0].attrs['aria-pressed'], 'true');
});

test('Ctrl+Alt+N opens the new-session screen; the sheet lists it with its reason', () => {
  const k = K.desktopKeys(false).find((x) => x.id === 'new');
  assert.equal(k.keys, 'Ctrl+Alt+N');
  assert.ok(K.isKey({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true, metaKey: false, shiftKey: false }, k));
  assert.ok(!K.isKey({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }, k));
  assert.equal(K.desktopKeys(true).find((x) => x.id === 'new').keys, 'Ctrl+Shift+N', 'a Mac keeps Option for typing: the Shift form, as the other keys');
  const row = K.shortcuts(false).find(([keys]) => keys === 'Ctrl+Alt+N');
  assert.ok(row && /new session/i.test(row[1]));
  assert.match(row[2], /new window/, 'the reason: the browser keeps Ctrl+N');
  assert.match(src('chat/keys.js'), /k\.id === 'new'\) o\.newSession && o\.newSession\(\)/);
  assert.match(src('chat/page.js'), /newSession: \(\) => openNewSession\(\{ m: machine\.current \?\? null \}\)/);
});
