// The desktop's window rules that need no DOM: where a window is shown on a smaller area and back, a snapped window
// taken away, the order of the windows (front, minimise, the cycle key), the desktop's keys, and what a window's bar
// button says. The page itself is driven in a real browser by tools/desktop-parity-check.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as keymap from '../../web/desktop/keymap.js';
import { DESK_KEYS, deskKeyOf, inTextField, keyLabel, keySet, modifierUp } from '../../web/desktop/keymap.js';
import { GRAB, MIN_H, MIN_W, TITLE_H, cycleOrder, frontOf, keptState, mergeWindow, restack, shownRect, unsnapRect } from '../../web/desktop/layout.js';
import { adoptLayout } from '../../web/desktop/wmsync.js';
import * as winstate from '../../web/desktop/winstate.js';
import { barName, sessionOf } from '../../web/desktop/winstate.js';

const BIG = { w: 1440, h: 822 };
const SMALL = { w: 1100, h: 622 };
const inside = (r, a) => r.x >= 0 && r.y >= 0 && r.x + r.w <= a.w && r.y + r.h <= a.h;

test('a window on a smaller area is shown wholly inside it, and as it was once the area is large again', () => {
  const r = { x: 680, y: 300, w: 640, h: 400 };
  const small = shownRect(r, SMALL);
  assert.ok(inside(small, SMALL), JSON.stringify(small));
  assert.deepEqual(shownRect(r, BIG), r, 'its own rect is not changed by being shown smaller');
  // Wider and taller than the area: shrunk to it, title bar at the top left.
  assert.deepEqual(shownRect({ x: 50, y: 50, w: 3000, h: 2000 }, SMALL), { x: 0, y: 0, w: SMALL.w, h: SMALL.h });
  // An area smaller than the smallest window, or none at all: the smallest window at the top left, never negative.
  assert.deepEqual(shownRect(r, { w: 200, h: 100 }), { x: 0, y: 0, w: MIN_W, h: MIN_H });
  assert.deepEqual(shownRect(r, { w: 0, h: 0 }), { x: 0, y: 0, w: MIN_W, h: MIN_H });
  // Hostile numbers from storage are numbers again, inside the area (an endless height is the area's).
  assert.deepEqual(shownRect({ x: NaN, y: -1e9, w: 'x', h: Infinity }, BIG), { x: 0, y: 0, w: MIN_W, h: BIG.h });
});

test('a window the owner put partly out stays as put while the area is that large, its title bar reachable', () => {
  const out = { x: BIG.w - 100, y: 200, w: 640, h: 400 };
  assert.deepEqual(shownRect(out, BIG, BIG), out, 'as put');
  const s = shownRect({ x: 5000, y: 5000, w: 640, h: 400 }, BIG, BIG);
  assert.equal(s.x, BIG.w - GRAB);
  assert.ok(s.y <= BIG.h - TITLE_H);
  // On a smaller area than it was put in, wholly inside again.
  assert.ok(inside(shownRect(out, SMALL, BIG), SMALL));
  // Without the area it was put in (a layout read back): wholly inside.
  assert.ok(inside(shownRect(out, BIG), BIG));
});

test('a snapped or maximised window taken by its title bar: its own size, held at the same share of the bar', () => {
  const half = { x: 0, y: 0, w: 720, h: 822 };
  const own = { x: 300, y: 120, w: 640, h: 420 };
  const r = unsnapRect(half, own, 540); // held at 75 % of the half's title bar
  assert.equal(r.w, own.w);
  assert.equal(r.h, own.h);
  assert.equal(r.y, half.y);
  assert.equal(r.x, 540 - 0.75 * 640);
  // Maximised, held at its middle: the middle of its own size under the pointer.
  assert.equal(unsnapRect({ x: 0, y: 0, w: 1440, h: 822 }, own, 720).x, 720 - 320);
  // A pointer outside the snapped rect (it moved since) keeps the window under it, never beside it.
  const far = unsnapRect(half, own, 900);
  assert.ok(far.x <= 900 && far.x + far.w >= 900);
  assert.equal(unsnapRect({ x: 0, y: 0, w: 0, h: 0 }, own, 100).x, 100 - 320, 'a rect of no width: held at the middle');
});

test('the order of the windows: one comes forward, a minimised one goes to the back, the cycle key follows the use', () => {
  const wins = [{ id: 'a', z: 1, min: false }, { id: 'b', z: 2, min: false }, { id: 'c', z: 3, min: false }];
  assert.equal(frontOf(wins).id, 'c');
  restack(wins, 'a', true);
  assert.deepEqual(wins.map((w) => w.z), [3, 1, 2], 'layers stay 1…n, the raised one on top');
  assert.equal(frontOf(wins).id, 'a');
  assert.deepEqual(cycleOrder(wins), ['a', 'c', 'b'], 'the front window, then in the order last used');
  // Minimised: to the back of the order, and the one used before it comes forward.
  wins[0].min = true;
  restack(wins, 'a', false);
  assert.deepEqual(wins.map((w) => w.z), [1, 2, 3]);
  assert.equal(frontOf(wins).id, 'c');
  assert.deepEqual(cycleOrder(wins), ['c', 'b', 'a']);
  // Every window minimised, none open, an unknown id: no front window, the layers still 1…n.
  for (const w of wins) w.min = true;
  assert.equal(frontOf(wins), null);
  assert.equal(frontOf([]), null);
  restack(wins, 'nope', true);
  assert.deepEqual(wins.map((w) => w.z).sort(), [1, 2, 3]);
});

test('the desktop\'s keys: one modifier set, the arrows, M, W and `, chosen in Settings', () => {
  const k = (code, mods = {}) => ({ code, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...mods });
  const AS = { altKey: true, shiftKey: true };
  const CA = { ctrlKey: true, altKey: true };
  assert.deepEqual(DESK_KEYS.map((x) => x.act), ['left', 'right', 'up', 'down', 'cycle', 'min', 'close']);
  assert.equal(deskKeyOf(k('ArrowLeft', AS)), 'left');
  assert.equal(deskKeyOf(k('Backquote', AS)), 'cycle', 'Alt+Tab belongs to the computer: the key above Tab');
  assert.equal(deskKeyOf(k('KeyM', AS)), 'min');
  assert.equal(deskKeyOf(k('KeyW', AS)), 'close');
  // Only the chosen set: not with another modifier more or less, not Cmd, not AltGr.
  assert.equal(deskKeyOf(k('ArrowLeft', { altKey: true })), null);
  assert.equal(deskKeyOf(k('ArrowLeft', { ...AS, ctrlKey: true })), null);
  assert.equal(deskKeyOf(k('ArrowLeft', { ...AS, metaKey: true })), null);
  assert.equal(deskKeyOf(k('KeyQ', AS)), null);
  assert.equal(deskKeyOf(k('ArrowLeft', CA), 'ctrl-alt'), 'left');
  assert.equal(deskKeyOf(k('ArrowLeft', AS), 'ctrl-alt'), null, 'the old keys stop when the set changes');
  assert.equal(deskKeyOf(k('KeyM', { ...CA, altGraph: true }), 'ctrl-alt'), null, 'AltGr typing a character stays a character');
  assert.equal(deskKeyOf(k('KeyM', { ...CA, getModifierState: (m) => m === 'AltGraph' }), 'ctrl-alt'), null);
  assert.equal(deskKeyOf(k('ArrowLeft', AS), 'off'), null, 'Off: no key is the desktop\'s');
  // In the code editor (and a Mac's text box) the arrows stay there; M, W and ` are still the desktop's.
  assert.equal(deskKeyOf(k('ArrowDown', AS), 'alt-shift', { inText: true }), null);
  assert.equal(deskKeyOf(k('KeyM', AS), 'alt-shift', { inText: true }), 'min');
  // The kept choice, read back; how a key is written in a menu.
  assert.deepEqual(keymap.keySetChoices(false), [['alt-shift', 'Alt+Shift'], ['ctrl-alt', 'Ctrl+Alt'], ['off', 'Off']]);
  assert.equal(keySet('nonsense'), 'alt-shift');
  assert.equal(keySet('__proto__'), 'alt-shift');
  assert.equal(keySet('off'), 'off');
  assert.equal(keyLabel('alt-shift', 'left', false), 'Alt+Shift+←');
  assert.equal(keyLabel('ctrl-alt', 'cycle', false), 'Ctrl+Alt+`');
  assert.equal(keyLabel('off', 'min', false), null);
  assert.equal(modifierUp({ key: 'Alt' }), true, 'letting go of the keys ends a cycle');
  assert.equal(modifierUp({ key: 'Shift' }), true);
  assert.equal(modifierUp({ key: 'Control' }), false);
  assert.equal(modifierUp({ key: 'Control' }, 'ctrl-alt'), true);
  assert.equal(modifierUp({ key: 'Alt' }, 'off'), false);
});

test('what stays with the place to type: the editor\'s arrows, every key in a Mac\'s text box, nothing in a terminal', () => {
  const el = (tagName, { cls = [], inEditor = false } = {}) => ({ tagName, classList: { contains: (c) => cls.includes(c) }, closest: (sel) => (inEditor && sel === '.monaco-editor' ? {} : null) });
  assert.equal(inTextField(el('TEXTAREA', { inEditor: true }), false), 'arrows');
  assert.equal(inTextField(el('TEXTAREA', { inEditor: true }), true), 'all');
  assert.equal(inTextField(el('INPUT'), true), 'all');
  assert.equal(inTextField(el('TEXTAREA', { cls: ['xterm-helper-textarea'] }), true), false, 'a terminal never keeps them');
  assert.equal(inTextField(el('INPUT'), false), false);
  assert.equal(inTextField(null), false);
  // On a Mac, Option+Shift with a letter or ` types a character (W is „, M is Â) and macOS reports no AltGraph: in a
  // text box and in the editor no key of the desktop's is taken, or typing „ would close the window.
  const typed = { code: 'KeyW', key: '„', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false };
  assert.equal(deskKeyOf(typed, 'alt-shift', { inText: inTextField(el('TEXTAREA'), true) }), null);
  assert.equal(deskKeyOf({ ...typed, code: 'KeyM', key: 'Â' }, 'alt-shift', { inText: inTextField(el('INPUT'), true) }), null);
  assert.equal(deskKeyOf({ ...typed, code: 'Backquote', key: '`' }, 'alt-shift', { inText: inTextField(el('TEXTAREA', { inEditor: true }), true) }), null);
  assert.equal(deskKeyOf({ ...typed, code: 'ArrowLeft', key: 'ArrowLeft' }, 'alt-shift', { inText: inTextField(el('INPUT'), true) }), null);
  // Elsewhere the editor keeps only the arrows, and a Mac's terminal (Option is Meta there) keeps none.
  assert.equal(deskKeyOf(typed, 'alt-shift', { inText: inTextField(el('TEXTAREA', { inEditor: true }), false) }), 'close');
  assert.equal(deskKeyOf(typed, 'alt-shift', { inText: inTextField(el('TEXTAREA', { cls: ['xterm-helper-textarea'] }), true) }), 'close');
});

test('a window\'s bar button: its session, whether it needs you or ended, and its name says so', () => {
  const sessions = [{ name: 'api server', kind: 'claude' }, { name: 'chat:abc', kind: 'chat', chatId: 'abc' }];
  assert.equal(sessionOf('#/s/api%20server', sessions).name, 'api server');
  assert.equal(sessionOf('#/m/laptop/s/api%20server', sessions).name, 'api server', 'also on another computer');
  assert.equal(sessionOf('#/chat/abc', sessions).chatId, 'abc');
  assert.equal(sessionOf('#/s/gone', sessions), null, 'a session that is not in the list (ended)');
  assert.equal(sessionOf('#/', sessions), undefined, 'the Sessions list is no session');
  assert.equal(sessionOf('#/code?dir=%2Fx', sessions), undefined);
  assert.equal(sessionOf('#/s/%E0%A4', sessions), undefined, 'a broken address is no session');
  assert.equal(sessionOf('#/s/x', null), null);
  assert.equal(barName('Terminal · shell'), 'Terminal · shell');
  assert.equal(barName('Sessions · api', { front: true }), 'Sessions · api, in front');
  assert.equal(barName('Sessions · api', { needs: true, min: true }), 'Sessions · api, needs you, minimised');
  assert.equal(barName('Terminal · shell', { ended: true, min: true, front: true }), 'Terminal · shell, session ended, minimised');
});

test('on a Mac the keys are written as its keyboard names them, and Cmd+Tab is the computer\'s', () => {
  assert.equal(keyLabel('alt-shift', 'left', true), 'Option+Shift+←');
  assert.equal(keyLabel('ctrl-alt', 'close', true), 'Ctrl+Option+W');
  assert.deepEqual(keymap.keySetChoices(true), [['alt-shift', 'Option+Shift'], ['ctrl-alt', 'Ctrl+Option'], ['off', 'Off']], 'the choice in Settings too');
  const { keysText } = keymap;
  assert.equal(typeof keysText, 'function');
  assert.match(keysText('alt-shift', { mac: true })[0], /^Cmd\+Tab belongs to your computer; here it is Option\+Shift\+`\.$/);
  assert.match(keysText('alt-shift', { mac: false })[0], /^Alt\+Tab belongs to your computer; here it is Alt\+Shift\+`\.$/);
  // F6 is the way out of a terminal or the editor (they keep Tab), whatever the keys are set to: Settings says so.
  // A Mac's top row sends its own keys (brightness, sound) unless Fn is held: there it is Fn+F6.
  assert.equal(keysText('off', { mac: false })[0], 'Off: every key goes to the app in the window, except F6, which takes the keyboard to its title bar.');
  assert.equal(keysText('off', { mac: true })[0], 'Off: every key goes to the app in the window, except Fn+F6, which takes the keyboard to its title bar.');
  assert.match(keysText('alt-shift', { mac: false }).join(' '), /(^| )F6 takes the keyboard from the app in a window to its title bar\./);
  assert.match(keysText('alt-shift', { mac: true }).join(' '), /Fn\+F6 takes the keyboard from the app in a window to its title bar\./);
});

test('on a Linux desktop, Settings names the keys GNOME keeps for itself', () => {
  const { keysText } = keymap;
  const gnome = (set) => keysText(set, { mac: false, linux: true }).join(' ');
  // GNOME's defaults: Shift+Alt+Above_Tab (switch-group-backward), Ctrl+Alt+arrows (switch-to-workspace-*).
  assert.match(gnome('alt-shift'), /On GNOME, Alt\+Shift\+` is the computer's too: there "Next window" in the title bar's menu goes on\./);
  assert.match(gnome('ctrl-alt'), /On GNOME, Ctrl\+Alt with an arrow switches workspaces: there only Ctrl\+Alt\+M, W and ` reach the desktop\./);
  assert.doesNotMatch(keysText('alt-shift', { mac: false, linux: false }).join(' '), /GNOME/);
  assert.doesNotMatch(keysText('alt-shift', { mac: true, linux: false }).join(' '), /GNOME/);
});

test('the title bar\'s menu shows a key for every act that has one, the quarters by their two presses', async () => {
  const { windowMenu } = await import('../../web/desktop/winmenu.js');
  const items = windowMenu({ id: 'w1', snap: null, hash: '#/' }, {}, 'alt-shift').filter(Boolean);
  const hint = (label) => items.find((x) => x.label === label).hint;
  assert.equal(hint('Top left quarter'), keymap.quarterLabel('alt-shift', 'tl'));
  assert.equal(keymap.quarterLabel('alt-shift', 'tl', false), 'Alt+Shift+← ↑');
  assert.equal(keymap.quarterLabel('alt-shift', 'br', false), 'Alt+Shift+→ ↓');
  assert.equal(keymap.quarterLabel('ctrl-alt', 'tr', true), 'Ctrl+Option+→ ↑');
  assert.equal(keymap.quarterLabel('off', 'tl'), null);
  for (const l of ['Top right quarter', 'Bottom left quarter', 'Bottom right quarter']) assert.ok(hint(l), l);
});

test('a window\'s session ended: gone from the list, or a coding session whose program ended and left its shell', () => {
  const { endedOf } = winstate;
  assert.equal(typeof endedOf, 'function');
  const seen = new Map();
  assert.equal(endedOf('w1', { name: 'api', kind: 'claude' }, seen), false, 'running');
  // The pty backend keeps the terminal as a shell when the coding tool exits (src/server/watcher.mjs counts it ended).
  assert.equal(endedOf('w1', { name: 'api', kind: 'shell' }, seen), true);
  assert.equal(endedOf('w1', { name: 'api', kind: 'shell' }, seen), true, 'and stays so while its window is not in front');
  // A notice, as the watcher's: once its window is in front, the shell left in it is a shell that runs.
  assert.equal(endedOf('w1', { name: 'api', kind: 'shell' }, seen, true), false, 'its window came to the front');
  assert.equal(endedOf('w1', { name: 'api', kind: 'shell' }, seen), false, 'and the mark does not come back when it goes behind');
  assert.equal(endedOf('w1', { name: 'api', kind: 'claude' }, seen), false, 'the coding tool started again in it');
  assert.equal(endedOf('w1', { name: 'api', kind: 'shell' }, seen), true, 'and ended again');
  assert.equal(endedOf('w5', { name: 'web', kind: 'claude' }, seen, true), false);
  assert.equal(endedOf('w5', { name: 'web', kind: 'shell' }, seen, true), false, 'ended in front: the window itself shows it');
  assert.equal(endedOf('w2', { name: 'sh', kind: 'shell' }, seen), false, 'a shell seen as a shell is running');
  assert.equal(endedOf('w2', null, seen), true, 'gone from the list');
  assert.equal(endedOf('w3', null, seen), false, 'never seen: a new one is in the list a poll later');
  assert.equal(endedOf('w4', undefined, seen), false, 'no session in the window');
});

test('a key\'s name is drawn with each arrow on its own, so ← and → are told apart', () => {
  const { keyParts } = keymap;
  assert.equal(typeof keyParts, 'function');
  assert.deepEqual(keyParts('Alt+Shift+← ↑'), [{ text: 'Alt+Shift+', arrow: false }, { text: '←', arrow: true }, { text: ' ', arrow: false }, { text: '↑', arrow: true }]);
  assert.deepEqual(keyParts('Alt+Shift+M'), [{ text: 'Alt+Shift+M', arrow: false }]);
});

test('a screen reader hears a menu item\'s key once, as its shortcut', async () => {
  const { keyShortcut } = keymap;
  assert.equal(typeof keyShortcut, 'function');
  assert.equal(keyShortcut('alt-shift', 'left'), 'Alt+Shift+ArrowLeft');
  assert.equal(keyShortcut('ctrl-alt', 'cycle'), 'Control+Alt+`');
  assert.equal(keyShortcut('off', 'min'), null);
  const { windowMenu } = await import('../../web/desktop/winmenu.js');
  const items = windowMenu({ id: 'w1', snap: 'max', hash: '#/' }, {}, 'alt-shift').filter(Boolean);
  assert.equal(items.find((x) => x.label === 'Restore').keys, 'Alt+Shift+ArrowDown');
  assert.equal(items.find((x) => x.label === 'Close').keys, 'Alt+Shift+W');
});

test('two tabs: what this tab changed of a window since it last kept it stays, the rest follows the other tab', () => {
  const at = (x, extra = {}) => ({ rect: { x, y: 40, w: 640, h: 420 }, snap: null, min: false, hash: '#/', ...extra });
  const here = at(100);
  const kept = keptState(here);
  // Nothing changed here: the other tab's place, minimise and page are taken.
  let m = mergeWindow(here, kept, at(500, { min: true, hash: '#/s/alpha', snap: 'l' }));
  assert.deepEqual([m.rect.x, m.snap, m.min, m.hash], [500, 'l', true, '#/s/alpha']);
  assert.deepEqual(m.own, { place: false, min: false, hash: false });
  // Its page moved on here (both tabs moved it, this one last): this tab's page stays, the place follows.
  m = mergeWindow({ ...here, hash: '#/s/shop' }, kept, at(500, { hash: '#/s/alpha' }));
  assert.deepEqual([m.hash, m.rect.x, m.own.hash, m.own.place], ['#/s/shop', 500, true, false]);
  // Moved here (a drag that ended after the other tab's change): its place stays, a snap is a place too.
  m = mergeWindow({ ...here, rect: { ...here.rect, x: 400 } }, kept, at(500));
  assert.deepEqual([m.rect.x, m.snap, m.own.place], [400, null, true]);
  m = mergeWindow({ ...here, snap: 'r' }, kept, at(500, { snap: 'l' }));
  assert.equal(m.snap, 'r');
  // A trailing slash is the same page; a window never kept here is all this tab's.
  assert.equal(mergeWindow({ ...here, hash: '#/s/alpha/' }, keptState(here, '#/s/alpha'), at(1, { hash: '#/s/beta' })).hash, '#/s/beta');
  assert.deepEqual(mergeWindow(here, null, at(500)).own, { place: true, min: true, hash: true });
});

test('two tabs: a tab in view keeps the window in use where it is and in front; a tab behind takes everything', () => {
  const win = (id, x, z, extra = {}) => ({ id, app: 'tasks', hash: '#/desktop/tasks', rect: { x, y: 40, w: 640, h: 420 }, snap: null, min: false, z, ...extra });
  const tab = (...ws) => {
    const wins = ws.map((w) => ({ ...w, kept: keptState(w) }));
    const dropped = [];
    const ops = {
      byId: (id) => wins.find((v) => v.id === id) || null,
      drop: (v) => (wins.splice(wins.indexOf(v), 1), dropped.push(v.id)),
      restore: (k) => wins.push({ ...k, kept: keptState(k) }),
      canAdd: () => wins.length < 12,
    };
    return { wins, dropped, ops };
  };
  // The other tab opened b in front of a; this tab's person types in a: a stays in front, b is there behind it.
  let t = tab(win('a', 100, 1));
  let f = adoptLayout(t.wins, { focus: 'b', windows: [win('a', 100, 1), win('b', 300, 2)] }, { inView: true, typing: t.wins[0], front: t.wins[0], ...t.ops });
  assert.equal(f, 'a');
  assert.deepEqual(t.wins.map((v) => `${v.id}${v.z}`).sort(), ['a2', 'b1']);
  // The same while nobody uses this tab, or with it behind: the other tab's front window is in front.
  t = tab(win('a', 100, 1));
  assert.equal(adoptLayout(t.wins, { focus: 'b', windows: [win('a', 100, 1), win('b', 300, 2)] }, { inView: true, typing: null, front: t.wins[0], ...t.ops }), 'b');
  t = tab(win('a', 100, 1));
  assert.equal(adoptLayout(t.wins, { focus: 'b', windows: [win('a', 100, 1), win('b', 300, 2)] }, { inView: false, typing: t.wins[0], front: t.wins[0], ...t.ops }), 'b');
  // A drag here ended after the other tab's change: the window stays where it was let go, and in front.
  t = tab(win('a', 100, 1));
  t.wins[0].rect = { ...t.wins[0].rect, x: 400 };
  f = adoptLayout(t.wins, { focus: 'b', windows: [win('a', 100, 1), win('b', 300, 2)] }, { inView: true, typing: null, front: t.wins[0], ...t.ops });
  assert.deepEqual([f, t.wins[0].rect.x, t.wins[0].kept.rect.x], ['a', 400, 100], 'its own place stays, kept by the next keep');
  // The other tab closed (or minimised) the window this tab's person types in: here it stays, shown, in front.
  t = tab(win('a', 100, 2), win('c', 60, 1));
  f = adoptLayout(t.wins, { focus: 'c', windows: [win('c', 60, 1)] }, { inView: true, typing: t.wins[0], front: t.wins[0], ...t.ops });
  assert.deepEqual([f, t.dropped, t.wins.map((v) => v.id).sort().join()], ['a', [], 'a,c']);
  t = tab(win('a', 100, 2), win('c', 60, 1));
  f = adoptLayout(t.wins, { focus: 'c', windows: [win('a', 100, 2, { min: true }), win('c', 60, 1)] }, { inView: true, typing: t.wins[0], front: t.wins[0], ...t.ops });
  assert.deepEqual([f, t.wins[0].min], ['a', false]);
  // Behind, or not in use, a window the other tab closed goes here too.
  t = tab(win('a', 100, 2), win('c', 60, 1));
  adoptLayout(t.wins, { focus: 'c', windows: [win('c', 60, 1)] }, { inView: true, typing: null, front: t.wins[1], ...t.ops });
  assert.deepEqual(t.dropped, ['a']);
});
