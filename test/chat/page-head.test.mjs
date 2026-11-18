// The chat page's head (web/chat/header.js), without a browser: the title bar, the session menu, Open in, the more menu.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

test('the head as the desktop app\'s title bar: a session menu on the caret, the title-bar buttons, Archive', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  const { createHeader, sessionItems } = await import('../../web/chat/header.js');
  const v = { title: 'Fix the cart', cwd: '/w/shop', short: '~/w/shop', branch: 'fix/cart-total', profile: { name: 'sub', label: 'Max' }, engine: { id: 'claude' } };
  // The desktop app's items first, in its order, then Hoprig's own.
  assert.deepEqual(sessionItems(v, { view: 'verbose' }).map((x) => x.label), ['Transcript view', 'Open in', 'Archive', 'Copy branch name', 'Earlier conversations', 'Rename']);
  assert.match(sessionItems(v, { view: 'verbose' })[0].sub, /^Verbose/);
  assert.ok(!sessionItems({ ...v, branch: null }).some((x) => x.label === 'Copy branch name'), 'no branch, nothing to copy');
  assert.ok(sessionItems(v, { phone: true }).some((x) => x.label === 'Provider'), 'a phone has no provider chip: the menu has it');
  assert.ok(!sessionItems(v).some((x) => /close/i.test(x.label)), 'Archive is the word, not Close');
  const hd = createHeader({ A: '/api/chats/x', way: { hash: '#/', label: 'Home' }, act: {}, view: { now: () => 'normal', set() {}, thought: () => false } });
  hd.paint(v);
  const titled = (n) => (n.attrs && n.attrs.title ? [n.attrs.title] : []).concat(n.children ? n.children.flatMap(titled) : []);
  const names = titled(hd.el);
  assert.ok(names.includes('Session menu'), 'the caret beside the title');
  for (const b of ['Open in Terminal', 'Changes', 'Files', 'Desktop mode']) assert.ok(names.includes(b), b);
  assert.equal(byClass(hd.el, 'chat-histbtn').length, 0, 'the unlabelled clock is gone (Earlier conversations is in the menu)');
  assert.equal(byClass(hd.el, 'chat-caret').length, 1);
  assert.match(texts(byClass(hd.el, 'chat-folder')[0]).join(''), /^shop$/, 'the folder is said, not a menu of its own');
});

test('Open in names its targets as the desktop app does; the more menu has Background tasks once there is background work', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  const { openInItems, moreItems } = await import('../../web/chat/header.js');
  const v = { title: 'Fix the cart', cwd: '/w/shop', short: '~/w/shop', branch: 'main', engine: { id: 'claude' }, caps: {}, tasks: [] };
  // Inside "Open in" the terminal is "Terminal", not "Open in Terminal" a second time.
  assert.deepEqual(openInItems(v).map((x) => x.label), ['Terminal', 'Files', 'Changes']);
  assert.equal(openInItems({ ...v, terminal: { name: 'w1' } })[0].label, 'Open the terminal', 'while a terminal runs it, the entry goes there');
  const labels = (x, o) => moreItems(x, o).map((i) => i.label);
  assert.ok(!labels(v).includes('Background tasks'), 'no background work: no entry that opens an empty pane');
  const busy = { ...v, tasks: [{ taskId: 't', type: 'shell', status: 'running', title: 'npm test' }] };
  assert.ok(labels(busy).includes('Background tasks'));
  assert.ok(labels({ ...v, tasks: [{ taskId: 't', type: 'agent', status: 'completed' }] }).includes('Background tasks'), 'an ended task can still be read');
  assert.ok(!labels({ ...v, tasks: undefined }).includes('Background tasks'), 'an older computer that sends no tasks');
  assert.deepEqual(labels(busy, { rail: { hidden: () => true }, wide: true }).slice(-2), ['Keyboard shortcuts', 'Show session rail']);
  assert.ok(!labels(busy, { rail: { hidden: () => false }, wide: false }).some((x) => /session rail/.test(x)), 'no rail where it does not fit');
  assert.ok(!labels(busy, { touch: true }).includes('Keyboard shortcuts'));
  // The strip and the more menu open the same sheet.
  const Ag = await import('../../web/chat/agents.js');
  assert.equal(typeof Ag.agentsStrip({ stop() {}, jump() {} }).open, 'function');
});

test('one word for one act: an archived session\'s page says archived, as the menu\'s Archive does', async () => {
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  const W = await import('../../web/chat/words.js');
  assert.equal(W.goneWords(null), 'This session is not open in the App any more: it was archived, or moved to the Terminal.');
  assert.equal(W.goneWords({ terminal: 'w1' }), 'This session moved to the Terminal: the conversation goes on there.');
  const { createHeader } = await import('../../web/chat/header.js');
  const hd = createHeader({ A: '/api/chats/x', way: null, act: {}, view: null });
  hd.closed(null);
  assert.equal(texts(byClass(hd.el, 'chat-title-text')[0]).join(''), 'Archived session');
  assert.doesNotMatch(W.goneWords(null), /closed/);
});

const V = { title: 'Fix the cart', cwd: '/w/shop', short: '~/w/shop', branch: 'main', profile: { name: 'sub', label: 'Max' }, engine: { id: 'claude' } };
const paths = (n) => (n.attrs && n.attrs.d ? [n.attrs.d] : []).concat(n.children ? n.children.flatMap(paths) : []);

test('on a phone the session menu lists Terminal, Files and Changes at its first level: two taps, as before', async () => {
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  const { sessionItems } = await import('../../web/chat/header.js');
  const phone = sessionItems(V, { view: 'normal', phone: true }).map((x) => x.label);
  assert.deepEqual(phone, ['Transcript view', 'Open in Terminal', 'Files', 'Changes', 'Archive', 'Copy branch name', 'Earlier conversations', 'Rename', 'Provider']);
  assert.ok(!sessionItems(V, { view: 'normal' }).some((x) => x.label === 'Open in Terminal'), 'a wide screen: under Open in');
});

test('the session menu at the caret: Transcript view and Open in are submenus of it, the view now marked', async () => {
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  const { sessionTree } = await import('../../web/chat/header.js');
  const tree = sessionTree(V, { view: 'thinking', thought: true, who: 'Claude' });
  assert.deepEqual(tree.map((x) => x.label), ['Transcript view', 'Open in', 'Archive', 'Copy branch name', 'Earlier conversations', 'Rename']);
  assert.deepEqual(tree[0].items.map((x) => [x.label, x.checked]), [['Normal', false], ['Thinking', true], ['Verbose', false]]);
  assert.deepEqual(tree[1].items.map((x) => x.label), ['Terminal', 'Files', 'Changes']);
  assert.deepEqual(sessionTree(V, { view: null }).map((x) => x.label)[0], 'Open in', 'no view to choose: no entry');
});

test('the title bar\'s hand-off button says what it does: Open in Terminal, not a plain shell\'s "Terminal"', async () => {
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  const { createHeader } = await import('../../web/chat/header.js');
  const hd = createHeader({ A: '/api/chats/x', way: null, act: {}, view: null });
  hd.paint(V);
  const term = byClass(hd.el, 'chat-tbtn')[0];
  assert.equal(term.attrs.title, 'Open in Terminal');
  assert.notEqual(paths(term)[0], 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'not the plain terminal icon');
});

test('the more button is the desktop app\'s ⋮: three dots one above the other', async () => {
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  const { createHeader } = await import('../../web/chat/header.js');
  const hd = createHeader({ A: '/api/chats/x', way: null, act: {}, view: null });
  assert.deepEqual(paths(byClass(hd.el, 'chat-morebtn')[0]), ['M12 5h.01', 'M12 12h.01', 'M12 19h.01']);
});

test('the menus of a session without a title are titled as its head: New session', async () => {
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  const { menuTitle } = await import('../../web/chat/header.js');
  assert.equal(menuTitle({ title: '' }), 'New session');
  assert.equal(menuTitle(null), 'New session');
  assert.equal(menuTitle(V), 'Fix the cart');
});

test('Archive has an archive icon, not the X of Close and Remove', async () => {
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  const { sessionItems } = await import('../../web/chat/header.js');
  assert.equal(sessionItems(V).find((x) => x.value === 'archive').icon, 'archive');
});

test('a long folder name gives way in the head: the provider chip keeps its name (it shrinks only to its own limit)', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../web/chat/chat.css', import.meta.url), 'utf8');
  const rule = (sel) => (new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css) || [])[1] || '';
  assert.match(rule('.chat-hchip'), /flex:\s*none/, 'the provider chip does not shrink with the folder');
  assert.match(rule('.chat-hchip'), /max-width:/, 'a very long provider name still has a limit');
  assert.match(rule('.chat-folder'), /flex:\s*0 1 auto/, 'the folder gives way');
});

// The session menu drops down from the caret onto the page's body (web/desktop/menu.js). Its listeners on the document
// are kept here, so a press can be sent to them.
async function caretMenu() {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.window.removeEventListener ||= () => {};
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  Object.assign(globalThis, { innerWidth: 1440, innerHeight: 900 });
  const on = new Map();
  document.addEventListener = (k, fn) => on.set(k, fn);
  document.removeEventListener = (k, fn) => on.get(k) === fn && on.delete(k);
  const { createHeader } = await import('../../web/chat/header.js');
  const M = await import('../../web/desktop/menu.js');
  M.closeMenu(); // none left from another test
  let view = 'normal';
  const hd = createHeader({ A: '/api/chats/x', way: { hash: '#/', label: 'Home' }, act: {}, view: { now: () => view, set: (x) => (view = x), thought: () => false } });
  hd.paint({ title: 'Fix the cart', cwd: '/w/shop', short: '~/w/shop', branch: 'main', profile: { name: 'sub', label: 'Max' }, engine: { id: 'claude' } });
  document.body.append(hd.el);
  const caret = byClass(hd.el, 'chat-caret')[0];
  const menus = () => byClass(document.body, 'desk-menu');
  const item = (label) => byClass(document.body, 'desk-menu-item').find((b) => texts(b).join('') === label);
  const press = async (target) => {
    await new Promise((r) => setTimeout(r, 1)); // the menu listens for presses from the next tick
    on.get('pointerdown')?.({ target });
  };
  const done = () => {
    M.closeMenu();
    hd.el.remove();
  };
  return { hd, M, caret, menus, item, press, view: () => view, done };
}

test('the session menu goes with its page: left, or the session archived elsewhere, it is not left on screen acting on it', async () => {
  const t = await caretMenu();
  try {
    await t.caret.listeners.click();
    assert.equal(t.menus().length, 1, 'open');
    t.hd.stop(); // the page's teardown (another page was opened)
    assert.equal(t.menus().length, 0, 'gone with the page');
    await t.caret.listeners.click();
    t.hd.closed('Fix the cart'); // archived or handed off in another tab
    assert.equal(t.menus().length, 0, 'gone with the session');
    // A menu that is not the head's (the desktop's right-click menu) is left alone.
    t.M.openMenu(10, 10, [{ label: 'Open', run() {} }]);
    t.hd.stop();
    assert.equal(t.menus().length, 1, 'another menu stays');
  } finally {
    t.done();
  }
});

test('after a choice in the session menu the keyboard is back on the caret', async () => {
  const t = await caretMenu();
  try {
    t.caret.focus();
    await t.caret.listeners.click();
    assert.ok(t.menus()[0].contains(document.activeElement), 'the keyboard in the menu');
    t.item('Transcript view').listeners.click(); // its submenu
    t.item('Verbose').listeners.click();
    assert.equal(t.view(), 'verbose', 'the choice is made');
    assert.equal(t.menus().length, 0);
    assert.equal(document.activeElement, t.caret, 'the keyboard back where it was, not on the page\'s body');
  } finally {
    t.done();
  }
});

test('a second press of the caret closes the session menu, as a drop-down button does; it says whether it is open', async () => {
  const t = await caretMenu();
  try {
    t.caret.focus();
    // The press reaches the document first, then the caret's click; the menu closes, not opens anew.
    await t.caret.listeners.click();
    assert.equal(t.caret.attrs['aria-expanded'], 'true', 'said to be open');
    const first = t.menus()[0];
    await t.press(t.caret);
    assert.deepEqual(t.menus(), [first], 'a press on its own caret does not close it as a press outside');
    await t.caret.listeners.click();
    assert.equal(t.menus().length, 0, 'the second press closes it');
    assert.equal(t.caret.attrs['aria-expanded'], 'false');
    assert.equal(document.activeElement, t.caret);
    await t.caret.listeners.click();
    await t.press(document.body);
    assert.equal(t.menus().length, 0, 'a press outside still closes it');
  } finally {
    t.done();
  }
});
