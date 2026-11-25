// The composer's row as the Claude Code desktop app has it, without a browser: the menus that open at their control
// (web/chat/menu.js: where they go, 1-9, Up, Down, Escape and the focus after it), the desktop app's keys and the
// nearest free key where the browser keeps one (keys.js), Escape twice for rewind, the usage ring's two meanings and
// the model control's words (words.js). The page itself is proven in a real browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeElement, byClass, texts } from './fakedom.mjs';

// The document's and the window's listeners, kept so a test can press a key as the browser would: capture first.
const docKeys = [];
document.addEventListener = (type, fn, capture) => docKeys.push({ type, fn, capture: !!capture });
document.removeEventListener = (type, fn) => {
  const i = docKeys.findIndex((x) => x.type === type && x.fn === fn);
  if (i >= 0) docKeys.splice(i, 1);
};
document.querySelector = () => null; // no sheet is open
// The window's listeners too (a resize).
const winOn = new Map();
globalThis.window = { addEventListener: (t, fn) => winOn.set(t, fn), removeEventListener: (t, fn) => winOn.get(t) === fn && winOn.delete(t) };
globalThis.innerWidth = 1440;
globalThis.innerHeight = 900;
let platform = 'Linux x86_64';
Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ platform, userAgent: '' }) });

/** Press `key` on the document: the capture listeners, then (unless one stopped it) the others. → the event */
function press(key, mods = {}) {
  let stopped = false;
  const e = { key, code: mods.code || (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === '/' ? 'Slash' : key), ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods, defaultPrevented: false, isComposing: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; } };
  for (const l of docKeys.filter((x) => x.type === 'keydown' && x.capture)) l.fn(e);
  if (!stopped) for (const l of docKeys.filter((x) => x.type === 'keydown' && !x.capture)) l.fn(e);
  return e;
}

const M = await import('../../web/chat/menu.js');
const K = await import('../../web/chat/keys.js');
const W = await import('../../web/chat/words.js');

test('a menu opens at its control: above it, inside the window, below it only where the top leaves no room', () => {
  const view = { width: 1440, height: 900 };
  const ctl = { left: 300, top: 800, bottom: 828 };
  assert.deepEqual(M.placeMenu(ctl, { width: 260, height: 200 }, view), { left: 300, top: 594, maxHeight: 200 }, 'right above the control');
  assert.equal(M.placeMenu({ left: 1300, top: 800, bottom: 828 }, { width: 260, height: 200 }, view).left, 1172, 'moved left to stay inside the window');
  assert.deepEqual(M.placeMenu({ left: 10, top: 40, bottom: 68 }, { width: 260, height: 300 }, view), { left: 10, top: 74, maxHeight: 300 }, 'below a control at the top');
  const short = M.placeMenu({ left: 10, top: 300, bottom: 328 }, { width: 260, height: 500 }, { width: 390, height: 500 });
  assert.ok(short.maxHeight <= 300 - 14 && short.top >= 8, 'cut to the room there is, with its own scroll');
});

function control() {
  const from = new FakeElement('button');
  from.isConnectedHere = true;
  document.body.append(from);
  return from;
}
const modeSections = [
  { items: ['Manual', 'Accept edits', 'Plan', 'Auto', 'Bypass permissions'].map((l, i) => ({ value: `m${i}`, label: l, current: i === 0 })) },
  { label: 'More modes', items: [{ value: 'dontAsk', label: 'Don\'t ask', current: false }] },
];

test('in an open menu 1-9 pick an item, one number per item through the whole menu; Up and Down move, and no key reaches the page', async () => {
  const from = control();
  let pageSaw = 0;
  const pageKey = () => pageSaw++;
  document.addEventListener('keydown', pageKey); // the page's own keys (keys.js installKeys)
  const picked = M.openMenu({ from, label: 'Permission mode', sections: modeSections });
  assert.ok(M.menuOpen());
  const menu = byClass(document.body, 'chat-menu')[0];
  assert.equal(menu.getAttribute('role'), 'menu');
  assert.equal(menu.getAttribute('aria-label'), 'Permission mode');
  assert.equal(from.getAttribute('aria-expanded'), 'true');
  const items = byClass(menu, 'chat-menu-item');
  assert.deepEqual(items.map((b) => b.getAttribute('role')), Array(6).fill('menuitemradio'));
  assert.deepEqual(items.map((b) => b.getAttribute('aria-checked')), ['true', 'false', 'false', 'false', 'false', 'false']);
  assert.deepEqual(items.map((b) => b.getAttribute('aria-keyshortcuts')), ['1', '2', '3', '4', '5', '6'], 'one number per item: no two items share one');
  assert.deepEqual(items.map((b) => texts(b.querySelector('.chat-menu-num')).join('')), ['1', '2', '3', '4', '5', '6'], 'and each shows its own');
  assert.equal(document.activeElement, items[0], 'the keyboard starts on the one chosen now');
  press('ArrowDown');
  assert.equal(document.activeElement, items[1]);
  press('ArrowUp');
  press('ArrowUp');
  assert.equal(document.activeElement, items[5], 'Up from the first goes round to the last');
  press('?');
  assert.equal(pageSaw, 0, 'a key in the menu never reaches the page (no shortcut sheet, no card answered)');
  assert.ok(M.menuOpen(), 'a key the menu has no use for leaves it open');
  press('6');
  assert.equal(await picked, 'dontAsk', 'the sixth item, Don\'t ask, whichever section the keyboard is in');
  assert.ok(!M.menuOpen());
  assert.equal(document.activeElement, from, 'the keyboard is back on the control');
  assert.equal(from.getAttribute('aria-expanded'), 'false');
  const again = M.openMenu({ from, label: 'Permission mode', sections: modeSections });
  press('3');
  assert.equal(await again, 'm2', 'its third, Plan');
  assert.equal(pageSaw, 0);
  document.removeEventListener('keydown', pageKey);
});

test('a menu of more than nine items (the model menu): only the section the keyboard is in shows numbers, and they follow the keyboard', async () => {
  const from = control();
  const sec = (name, n) => ({ label: name, items: Array.from({ length: n }, (_, i) => ({ value: `${name}:${i}`, label: `${name} ${i}`, current: i === 0 })) });
  const picked = M.openMenu({ from, label: 'Model and effort', sections: [sec('model', 4), sec('effort', 6)], at: 1 });
  const items = byClass(byClass(document.body, 'chat-menu').at(-1), 'chat-menu-item');
  const keys = () => items.map((b) => b.getAttribute('aria-keyshortcuts'));
  assert.deepEqual(keys(), [null, null, null, null, '1', '2', '3', '4', '5', '6'], 'opened at Effort: its numbers only, none shared with Model');
  assert.deepEqual(items.slice(0, 4).map((b) => texts(b.querySelector('.chat-menu-num')).join('')), ['', '', '', ''], 'Model shows none');
  press('Home');
  assert.deepEqual(keys(), ['1', '2', '3', '4', null, null, null, null, null, null], 'the keyboard in Model: the numbers move there');
  press('2');
  assert.equal(await picked, 'model:1');
});

test('Escape closes the menu and does nothing else: no pick, the keyboard back where it was, Claude not stopped', async () => {
  const from = control();
  const box = new FakeElement('textarea');
  document.body.append(box);
  box.focus(); // a key opened it from the message box
  let stopped = 0;
  const unkeys = K.installKeys({ working: () => true, stop: () => stopped++, openAsk: () => null, box, nextMode() {} });
  const picked = M.openMenu({ from, label: 'Model and effort', sections: [{ label: 'Model', items: [{ value: 'a', label: 'Auto', current: true }] }, { label: 'Effort', items: [{ value: 'e1', label: 'Low', current: false }, { value: 'e2', label: 'High', current: true }] }], at: 1 });
  assert.equal(texts(byClass(document.body, 'chat-menu')[0]).filter((t) => t === 'Effort').length, 1, 'Effort is a section of the model menu');
  assert.equal(document.activeElement.getAttribute('aria-checked'), 'true', 'at: 1 starts in Effort, on the one chosen');
  press('Escape');
  assert.equal(await picked, null);
  assert.equal(stopped, 0, 'Escape in a menu does not stop Claude');
  assert.equal(document.activeElement, box, 'back in the box it was opened from');
  press('Escape');
  assert.equal(stopped, 1, 'with no menu open Escape stops Claude, as before');
  unkeys();
});

test('a second press of its control closes the menu; Tab closes it too', async () => {
  const from = control();
  const p = M.openMenu({ from, label: 'Add', sections: [{ items: [{ value: 'files', label: 'Add files or photos' }] }] });
  assert.equal(byClass(document.body, 'chat-menu')[0].querySelector('.chat-menu-item').getAttribute('role'), 'menuitem', 'not a choice: plain items');
  assert.equal(await M.openMenu({ from, label: 'Add', sections: [] }), null);
  assert.equal(await p, null);
  const q = M.openMenu({ from, label: 'Add', sections: [{ items: [{ value: 'files', label: 'Add files or photos' }] }] });
  press('Tab');
  assert.equal(await q, null);
  assert.ok(!M.menuOpen());
});

// Chrome's own shortcuts (support.google.com/chrome/answer/157179, read 19 Nov 2026) that the desktop app's keys meet.
// A page never gets these: the browser acts first. Judged from the published list, not by sending keys to a page.
const CHROME_KEEPS = {
  linux: ['Ctrl+O', 'Ctrl+Shift+M', 'Ctrl+Shift+D', 'Ctrl+Shift+J', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+W', 'Ctrl+Shift+B', 'Ctrl+Shift+O', 'Ctrl+Shift+G', 'Ctrl+Shift+R', 'Ctrl+Shift+I', 'Alt+Shift+I'],
  mac: ['Cmd+O', 'Cmd+Shift+M', 'Cmd+Shift+I', 'Cmd+Shift+D', 'Cmd+Shift+J', 'Cmd+Shift+N', 'Cmd+Shift+T', 'Cmd+Shift+W', 'Cmd+Shift+B', 'Cmd+Shift+G', 'Cmd+Shift+R', 'Cmd+Shift+H', 'Cmd+Option+I', 'Cmd+Shift+]', 'Cmd+Shift+['],
};
// The desktop app's keys (code.claude.com/docs/en/desktop, Keyboard shortcuts; Cmd is Ctrl on Windows and Linux).
const DESKTOP = { shortcuts: 'Cmd+/', mode: 'Cmd+Shift+M', model: 'Cmd+Shift+I', effort: 'Cmd+Shift+E', view: 'Ctrl+O', diff: 'Cmd+Shift+D', next: 'Cmd+Shift+]', prev: 'Cmd+Shift+[' };

// The App's other keys with a modifier, outside keys.js: they must stay theirs.
const OTHER_PAGE_KEYS = [
  { what: 'undo a delete (deletes.js)', code: 'KeyZ', ctrlKey: true, shiftKey: false, altKey: false },
  { what: 'send every diff comment (diffpane.js)', code: 'Enter', ctrlKey: true, shiftKey: false, altKey: false },
];

for (const os of ['linux', 'mac']) {
  test(`on ${os} a key does one thing: no two of the App's keys are the same press, and none is another key of the page`, () => {
    const mac = os === 'mac';
    const sig = (p) => [p.code, !!p.ctrlKey, !!p.metaKey, !!p.shiftKey, !!p.altKey].join(' ');
    const seen = new Map();
    for (const k of K.desktopKeys(mac)) {
      const s = sig(K.pressOf(k, mac));
      assert.ok(!seen.has(s), `${k.id} and ${seen.get(s)} are the same press (${k.keys})`);
      seen.set(s, k.id);
    }
    const asCmd = (p) => (mac ? { ...p, metaKey: p.ctrlKey, ctrlKey: false } : p);
    for (const p of OTHER_PAGE_KEYS) assert.ok(!seen.has(sig(asCmd(p))), `${p.what} stays the page's own`);
    // And each key's own press is that key and no other.
    platform = mac ? 'MacIntel' : 'Linux x86_64';
    for (const k of K.desktopKeys(mac)) {
      const hits = K.desktopKeys(mac).filter((x) => K.isKey({ ...K.pressOf(k, mac), key: K.pressOf(k, mac).key || 'x' }, x)).map((x) => x.id);
      assert.deepEqual(hits, [k.id], `${k.keys}`);
    }
    platform = 'Linux x86_64';
    const rows = K.shortcuts(mac).map(([keys]) => keys);
    assert.equal(new Set(rows).size, rows.length, 'the sheet lists each key once');
    const kept = K.browserKeeps(mac).map(([keys]) => keys);
    for (const k of kept) assert.ok(!rows.includes(k), `${k} is kept by the browser, not one of the App's keys`);
    assert.deepEqual(kept, mac ? ['Cmd+N', 'Cmd+W', 'Ctrl+Tab'] : ['Ctrl+N', 'Ctrl+W', 'Ctrl+Tab']);
  });
}

test('inside a window of the desktop, a key the desktop takes for its windows says so on its row, and only there', () => {
  // The default keys (Alt+Shift) take none of the App's.
  for (const k of K.desktopKeys(false)) assert.equal(K.deskTakes(k, 'alt-shift', false), null, k.keys);
  assert.ok(K.shortcuts(false, 'alt-shift').every(([, , why]) => !/the desktop's \(/.test(why || '')));
  // With Ctrl+Alt chosen, Ctrl+Alt+M is the desktop's Minimise: the mode menu's row says so.
  const mode = K.desktopKeys(false).find((k) => k.id === 'mode');
  assert.equal(K.deskTakes(mode, 'ctrl-alt', false).act, 'min');
  const row = K.shortcuts(false, 'ctrl-alt').find(([keys]) => keys === 'Ctrl+Alt+M');
  assert.match(row[2], /switching browser users\. In a window of the desktop this key is the desktop's \(Minimise\); Settings → Appearance can give the desktop other keys\.$/);
  assert.equal(K.shortcuts(false, 'ctrl-alt').filter(([, , why]) => /the desktop's \(/.test(why || '')).length, 1, 'only that one');
  assert.ok(K.shortcuts(false, 'off').every(([, , why]) => !/the desktop's \(/.test(why || '')), 'the desktop\'s keys off: none');
  // A window of the desktop has no session list: no keys for it there.
  assert.ok(!K.shortcuts(false, 'alt-shift').some(([keys]) => keys === 'Ctrl+Shift+]'));
  assert.ok(K.shortcuts(false).some(([keys]) => keys === 'Ctrl+Shift+]'));
});

test('Ctrl+Shift+] and [ go to the next and the previous session of the list; a session list that is not drawn does nothing', () => {
  const did = [];
  const unkeys = K.installKeys({ working: () => false, stop() {}, openAsk: () => null, box: null, nextMode() {}, go: (d) => did.push(d) });
  assert.ok(press(']', { ctrlKey: true, shiftKey: true, code: 'BracketRight' }).defaultPrevented);
  press('}', { ctrlKey: true, shiftKey: true, code: 'BracketRight' }); // a US keyboard reports } with Shift
  press('[', { ctrlKey: true, shiftKey: true, code: 'BracketLeft' });
  assert.ok(!press(']', { ctrlKey: true, code: 'BracketRight' }).defaultPrevented, 'Ctrl+] without Shift is left alone');
  assert.deepEqual(did, [1, 1, -1]);
  unkeys();
});

for (const os of ['linux', 'mac']) {
  test(`the desktop app's keys on ${os}: its own where the browser leaves it, else the nearest free one with its reason`, () => {
    const keys = K.desktopKeys(os === 'mac');
    for (const k of keys) {
      const desk = os === 'mac' ? DESKTOP[k.id] : DESKTOP[k.id].replace('Cmd', 'Ctrl');
      assert.ok(!CHROME_KEEPS[os].includes(k.keys), `${k.id}: ${k.keys} is not one the browser keeps`);
      if (CHROME_KEEPS[os].includes(desk)) {
        assert.notEqual(k.keys, desk);
        assert.ok(k.why && k.why.startsWith(`The desktop app's ${desk}`), `${k.id}: the sheet names the desktop app's key first (${desk}): ${k.why}`);
        assert.match(k.why, /; the browser keeps it for \w/, `${k.id}: and says what the browser keeps it for`);
      } else {
        assert.equal(k.keys, desk, `${k.id}: the desktop app's own key`);
        assert.equal(k.why, undefined, `${k.id}: no reason needed`);
      }
      assert.doesNotMatch(k.keys, os === 'mac' ? /Alt|Win/ : /Cmd|Option/, 'the keys a person on this computer has');
    }
    const rows = K.shortcuts(os === 'mac');
    assert.ok(rows.some(([k]) => k === (os === 'mac' ? 'Cmd+/' : 'Ctrl+/')), 'the sheet lists its own key');
    assert.ok(rows.some(([k, what]) => k === '1 … 9' && /open menu/.test(what)), '1-9 in an open menu');
    assert.ok(rows.some(([k, what]) => k === 'Esc Esc' && /rewind/.test(what)));
  });
}

test('a key event is the desktop key it should be, and no other: Ctrl+/ and Cmd+/, Ctrl+Shift+E, Ctrl+Alt+I, not Ctrl+Shift+I', () => {
  const by = (id) => K.desktopKeys().find((k) => k.id === id);
  const ev = (key, m) => ({ key, code: key === '/' ? 'Slash' : `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...m });
  platform = 'Linux x86_64';
  assert.ok(K.isKey(ev('/', { ctrlKey: true }), by('shortcuts')));
  assert.ok(!K.isKey(ev('/', { metaKey: true }), by('shortcuts')), 'the Windows key is not Ctrl');
  assert.ok(K.isKey(ev('E', { ctrlKey: true, shiftKey: true }), by('effort')));
  assert.ok(K.isKey(ev('i', { ctrlKey: true, altKey: true }), by('model')));
  assert.ok(!K.isKey(ev('I', { ctrlKey: true, shiftKey: true }), by('model')), 'the browser\'s developer tools stay the browser\'s');
  assert.ok(!K.isKey(ev('€', { ctrlKey: true, altKey: true, code: 'KeyE' }), by('mode')), 'AltGr typing a letter is typing');
  platform = 'MacIntel';
  assert.ok(K.isKey(ev('/', { metaKey: true }), K.desktopKeys().find((k) => k.id === 'shortcuts')));
  assert.ok(K.isKey(ev('E', { metaKey: true, shiftKey: true }), K.desktopKeys().find((k) => k.id === 'effort')));
  assert.ok(K.isKey(ev('o', { ctrlKey: true }), K.desktopKeys().find((k) => k.id === 'view')), 'Ctrl+O on a Mac is free: the desktop app\'s own key');
  assert.ok(K.isKey(ev('I', { ctrlKey: true, shiftKey: true }), K.desktopKeys().find((k) => k.id === 'model')));
  platform = 'Linux x86_64';
});

test('the page\'s keys open what the desktop app\'s keys open; Escape twice in an empty box opens rewind', () => {
  const box = new FakeElement('textarea');
  box.value = '';
  document.body.append(box);
  box.focus();
  const did = [];
  let working = false;
  const unkeys = K.installKeys({ working: () => working, stop: () => did.push('stop'), openAsk: () => null, box, nextMode() {}, menu: (w) => did.push(`menu ${w}`), view: () => did.push('view'), diff: () => did.push('diff'), rewind: () => did.push('rewind'), clearDraft: () => did.push('clear') });
  assert.ok(press('m', { ctrlKey: true, altKey: true }).defaultPrevented);
  press('i', { ctrlKey: true, altKey: true });
  press('E', { ctrlKey: true, shiftKey: true });
  press('o', { ctrlKey: true, altKey: true });
  press('d', { ctrlKey: true, altKey: true });
  assert.ok(!press('o', { ctrlKey: true }).defaultPrevented, 'Ctrl+O is the browser\'s: left alone');
  assert.deepEqual(did, ['menu mode', 'menu model', 'menu effort', 'view', 'diff']);
  did.length = 0;
  press('Escape');
  assert.deepEqual(did, [], 'one Escape: nothing');
  press('Escape');
  assert.deepEqual(did, ['rewind'], 'two in a row: rewind');
  did.length = 0;
  box.value = 'half a message';
  press('Escape');
  assert.deepEqual(did, [], 'one Escape with words: nothing');
  press('Escape');
  assert.deepEqual(did, ['clear'], 'with words in the box Escape twice is no rewind: the words are cleared, as the terminal does');
  did.length = 0;
  box.value = '';
  working = true;
  press('Escape');
  press('Escape');
  assert.deepEqual(did, ['stop', 'stop'], 'while Claude works Escape stops it');
  unkeys();
});

test('the usage ring: plan usage where the provider reports it, context where it does not, and its words say which', () => {
  const sub = { engine: { id: 'claude' }, profile: { kind: 'subscription' }, usage: { contextPercent: 12 }, limits: { five_hour: { percent: 41, resetsAt: Date.now() + 3_600_000 }, seven_day: { percent: 9 } } };
  assert.deepEqual(W.ringOf(sub), { kind: 'plan', percent: 41, text: 'Plan 41%', said: 'Plan usage 41% (5-hour limit)' }, 'its fullest window');
  const gateway = { ...sub, profile: { kind: 'api' } };
  assert.deepEqual(W.ringOf(gateway), { kind: 'context', percent: 12, text: 'Context 12%', said: 'Context: how full the chat\'s memory is (12%)' }, 'a key billed by use (a gateway): no plan, the context');
  assert.equal(W.ringOf({ ...sub, limits: {} }).kind, 'context', 'a subscription that has not reported its plan yet');
  assert.equal(W.ringOf({ engine: { id: 'opencode' }, profile: { kind: 'subscription' }, limits: sub.limits, usage: {} }), null, 'another coding tool has no plan, and no context known yet');
  assert.deepEqual(W.planWindows(sub.limits).map((w) => w.name), ['5-hour limit', 'Weekly limit']);
});

test('the model control shows the model and its effort, as the desktop app\'s model picker', () => {
  assert.equal(W.modelWords({ engine: { id: 'claude' }, model: 'sonnet', effort: 'high' }).text, 'Sonnet · High');
  assert.equal(W.modelWords({ engine: { id: 'claude' } }).text, 'Auto', 'a new session (Auto, Auto): short, for a phone\'s row');
  assert.equal(W.modelWords({ engine: { id: 'claude' } }).said, 'Model: Auto, effort: auto', 'its name still says both');
  assert.equal(W.modelWords({ engine: { id: 'claude' }, model: 'sonnet' }).text, 'Sonnet');
  assert.equal(W.modelWords({ engine: { id: 'claude' }, model: 'haiku' }).said, 'Model: Haiku, effort: auto');
  assert.equal(W.modelWords({ engine: { id: 'opencode', label: 'OpenCode' }, model: 'm1', effort: 'low', ultracode: true }).text, 'm1 · Highest', 'another tool\'s ultracode decides the effort');
});

test('a plan window whose reset time has passed is not shown: the ring falls back to a window still counting, else the context', () => {
  const now = Date.now();
  const sub = { engine: { id: 'claude' }, profile: { kind: 'subscription' }, usage: { contextPercent: 12 } };
  const gone = { five_hour: { percent: 93, resetsAt: now - 3_600_000 } };
  assert.deepEqual(W.ringOf({ ...sub, limits: gone }), { kind: 'context', percent: 12, text: 'Context 12%', said: 'Context: how full the chat\'s memory is (12%)' }, 'not "Plan 93%" for a window that started again');
  assert.deepEqual(W.planWindows(gone), [], 'the sheet lists no window that started again in the past');
  assert.equal(W.limitsLine(gone), '', 'nor the status line');
  const both = { ...gone, seven_day: { percent: 20, resetsAt: now + 86_400_000 } };
  assert.equal(W.ringOf({ ...sub, limits: both }).text, 'Plan 20%', 'the window still counting');
});

test('the effort key with the model menu open moves the keyboard to Effort; the same key again, or the control, closes it', async () => {
  const from = control();
  const sec = (name, n) => ({ label: name, items: Array.from({ length: n }, (_, i) => ({ value: `${name}:${i}`, label: `${name} ${i}`, current: i === 0 })) });
  const sections = [sec('model', 4), sec('effort', 6)];
  const picked = M.openMenu({ from, label: 'Model and effort', sections, at: 0, key: true }); // Ctrl+Alt+I
  assert.equal(await M.openMenu({ from, label: 'Model and effort', sections, at: 1, key: true }), null); // Ctrl+Shift+E
  assert.ok(M.menuOpen(), 'still open');
  assert.equal(texts(document.activeElement.querySelector('.chat-menu-label')).join(''), 'effort 0', 'the keyboard is at Effort, on the one chosen');
  press('3');
  assert.equal(await picked, 'effort:2', 'a number picks there');
  const again = M.openMenu({ from, label: 'Model and effort', sections, at: 1, key: true });
  await M.openMenu({ from, label: 'Model and effort', sections, at: 1, key: true });
  assert.ok(!M.menuOpen(), 'the same key a second time closes it');
  assert.equal(await again, null);
  const click = M.openMenu({ from, label: 'Model and effort', sections, at: 1, key: true });
  await M.openMenu({ from, label: 'Model and effort', sections, at: 0 }); // a press of the control
  assert.ok(!M.menuOpen(), 'a press of its control closes it');
  assert.equal(await click, null);
});

test('a resize of the height alone (a touch screen\'s keyboard going away) leaves the menu open; a new width closes it', async () => {
  const from = control();
  const p = M.openMenu({ from, label: 'Permission mode', sections: modeSections });
  globalThis.innerHeight = 500; // the keyboard went away: only the height changed
  winOn.get('resize')();
  assert.ok(M.menuOpen(), 'still open');
  globalThis.innerWidth = 1000;
  winOn.get('resize')();
  assert.ok(!M.menuOpen(), 'a new width closes it (the control moved)');
  assert.equal(await p, null);
  globalThis.innerWidth = 1440;
  globalThis.innerHeight = 900;
});

test('a change of the height alone places the open menu at its control again: above it after the window got shorter, and after it got taller', async () => {
  const from = control();
  let ctl = { left: 300, top: 841, bottom: 869, right: 420, width: 120, height: 28 };
  from.getBoundingClientRect = () => ctl;
  const vvOn = new Map();
  globalThis.window.visualViewport = { height: 900, addEventListener: (t, fn) => vvOn.set(t, fn), removeEventListener: (t, fn) => vvOn.get(t) === fn && vvOn.delete(t) };
  try {
    const p = M.openMenu({ from, label: 'Permission mode', sections: modeSections });
    const menu = byClass(document.body, 'chat-menu').at(-1);
    const top = () => Number.parseFloat(menu.style.top);
    const first = top();
    assert.ok(first < ctl.top, 'above its control');
    // The window is 600 px high now: the control moved up by 300.
    globalThis.innerHeight = 600;
    globalThis.window.visualViewport.height = 600;
    ctl = { ...ctl, top: 541, bottom: 569 };
    winOn.get('resize')();
    assert.ok(M.menuOpen(), 'still open');
    assert.equal(top(), first - 300, 'it moved up with the control');
    // A phone's keyboard went away: only the visible part grew, and the control moved down by 500.
    globalThis.window.visualViewport.height = 1100;
    ctl = { ...ctl, top: 1041, bottom: 1069 };
    vvOn.get('resize')();
    assert.equal(top(), first + 200, 'it followed the control down');
    M.closeMenu();
    assert.equal(await p, null);
    assert.equal(vvOn.size, 0, 'closed: it no longer listens');
  } finally {
    delete globalThis.window.visualViewport;
    globalThis.innerHeight = 900;
  }
});

test('the words say send and take back, not queue: the note after Stop and the refusal of a 21st message', async () => {
  assert.equal(W.backWords(1, 1), 'The message you sent is back in the box; attach its file again');
  assert.equal(W.backWords(2, 3), 'The messages you sent are back in the box; attach their files again');
  const { MessageQueue } = await import('../../src/chat/queue.mjs');
  const q = new MessageQueue(() => {});
  for (let n = 0; n < 20; n++) q.add({ id: `m${n}`, text: 'more' });
  assert.throws(() => q.add({ id: 'm20', text: 'one more' }), (e) => e.status === 409 && e.message === '20 messages wait already: wait for them, or take one back');
  await assert.rejects(q.remove('nope'), /^Error: that message is not waiting any more: it was read, or taken back already$/);
  const page = (await import('node:fs')).readFileSync(new URL('../../web/chat/page.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /queued message/i, 'no "queued message" on the page');
  // The process went with messages sent while it worked, not read yet: the timeline's notice says so in the same words.
  const { lostWork } = await import('../../src/chat/hear.mjs');
  for (const [n, want] of [[1, 'The message you sent was lost with the process: send it again.'], [2, 'The 2 messages you sent were lost with the process: send them again.']]) {
    const pushed = [];
    const lq = new MessageQueue(() => {});
    for (let i = 0; i < n; i++) lq.items.push({ id: `s${i}`, text: 'more', state: 'sent' });
    const back = [];
    lostWork({ tasks: { lost() {} }, queue: lq, push: (e) => pushed.push(e), live: new Map(), emit() {}, gaveBack: (id) => back.push(id) });
    assert.deepEqual(back, Array.from({ length: n }, (_, i) => `s${i}`), 'each lost message is given back: it never ran');
    assert.deepEqual(pushed.map((e) => e.text), [want]);
    assert.doesNotMatch(want, /queue/i);
  }
});
