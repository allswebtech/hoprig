// The desktop's window maths (web/desktop/layout.js) and its catalog of apps (web/desktop/apps.js): no DOM in
// either, so they are driven here directly. The windows themselves are driven in a real browser by
// tools/desktop-check.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { APPS, APP_IDS, appById, appHash, cardHash, filesHash, frameSrc, onComputer, queryOf, searchApps, sessionHash } from '../../web/desktop/apps.js';
import { GRAB, MAX_WINDOWS, MIN_H, MIN_W, clampRect, cleanLayout, keepLayout, keySnap, layoutKey, placeNew, resizeRect, snapRect, snapZone } from '../../web/desktop/layout.js';

const AREA = { w: 1440, h: 852 };

test('a window stays reachable: at least its minimum size, at most the area, its title bar on the screen', () => {
  assert.deepEqual(clampRect({ x: 10, y: 10, w: 100, h: 50 }, AREA), { x: 10, y: 10, w: MIN_W, h: MIN_H });
  assert.deepEqual(clampRect({ x: 0, y: 0, w: 5000, h: 5000 }, AREA), { x: 0, y: 0, w: 1440, h: 852 });
  // Pushed off to the left or right: GRAB pixels of it stay in the area; never above the top.
  assert.equal(clampRect({ x: -2000, y: 10, w: 600, h: 400 }, AREA).x, GRAB - 600);
  assert.equal(clampRect({ x: 5000, y: 10, w: 600, h: 400 }, AREA).x, 1440 - GRAB);
  assert.equal(clampRect({ x: 10, y: -50, w: 600, h: 400 }, AREA).y, 0);
  assert.ok(clampRect({ x: 10, y: 5000, w: 600, h: 400 }, AREA).y < 852);
  // Numbers only, whatever came in.
  assert.deepEqual(clampRect({ x: 'a', y: null, w: undefined, h: NaN }, AREA), { x: 0, y: 0, w: MIN_W, h: MIN_H });
});

test('snap places: the whole area, halves and quarters cover the area exactly, also with an odd size', () => {
  for (const area of [AREA, { w: 1025, h: 553 }]) {
    assert.deepEqual(snapRect('max', area), { x: 0, y: 0, ...area });
    const l = snapRect('l', area);
    const r = snapRect('r', area);
    assert.equal(l.w + r.w, area.w);
    assert.equal(r.x, l.w);
    const q = ['tl', 'tr', 'bl', 'br'].map((s) => snapRect(s, area));
    assert.equal(q.reduce((n, x) => n + x.w * x.h, 0), area.w * area.h, 'the quarters fill it with no gap or overlap');
    assert.equal(q[2].y, q[0].h);
  }
  assert.equal(snapRect('nowhere', AREA), null);
});

test('dragging to an edge or a corner picks the snap place; anywhere else none', () => {
  assert.equal(snapZone(0, 400, AREA), 'l');
  assert.equal(snapZone(1440, 400, AREA), 'r');
  assert.equal(snapZone(700, 0, AREA), 'max');
  assert.equal(snapZone(2, 10, AREA), 'tl');
  assert.equal(snapZone(1439, 30, AREA), 'tr');
  assert.equal(snapZone(0, 850, AREA), 'bl');
  assert.equal(snapZone(1440, 800, AREA), 'br');
  assert.equal(snapZone(700, 400, AREA), null);
  assert.equal(snapZone(15, 400, AREA), null, 'a mouse must reach the edge');
  assert.equal(snapZone(15, 400, AREA, { edge: 20 }), 'l', 'a finger has a wider edge');
});

test('resize from each edge and corner: the opposite side stays, never below the minimum or out of the area', () => {
  const s = { x: 200, y: 100, w: 600, h: 400 };
  assert.deepEqual(resizeRect(s, 'se', 90, 50, AREA), { x: 200, y: 100, w: 690, h: 450 });
  assert.deepEqual(resizeRect(s, 'w', -60, 0, AREA), { x: 140, y: 100, w: 660, h: 400 });
  assert.deepEqual(resizeRect(s, 'n', 0, 30, AREA), { x: 200, y: 130, w: 600, h: 370 });
  const tiny = resizeRect(s, 'nw', 2000, 2000, AREA);
  assert.equal(tiny.w, MIN_W);
  assert.equal(tiny.h, MIN_H);
  assert.equal(tiny.x + tiny.w, s.x + s.w, 'the right edge stays');
  assert.equal(tiny.y + tiny.h, s.y + s.h, 'the bottom edge stays');
  const big = resizeRect(s, 'se', 5000, 5000, AREA);
  assert.equal(big.x + big.w, AREA.w);
  assert.equal(big.y + big.h, AREA.h);
  assert.equal(resizeRect(s, 'nw', -5000, -5000, AREA).x, 0);
  // A window partly outside the area (only its title bar's grip on the screen) never goes below the minimum, and a
  // press on its left edge does not pull it in and shrink it.
  assert.equal(resizeRect({ x: AREA.w - 48, y: 0, w: 600, h: 400 }, 'e', 0, 0, AREA).w, MIN_W);
  assert.equal(resizeRect({ x: 0, y: AREA.h - 36, w: 600, h: 400 }, 's', 0, 0, AREA).h, MIN_H);
  assert.deepEqual(resizeRect({ x: -200, y: 0, w: 600, h: 400 }, 'w', 0, 0, AREA), { x: -200, y: 0, w: 600, h: 400 });
  assert.deepEqual(resizeRect({ x: -200, y: 0, w: 600, h: 400 }, 'w', 50, 0, AREA), { x: -150, y: 0, w: 550, h: 400 });
});

test('a new window opens inside the area, never exactly on top of another', () => {
  const wins = [];
  for (let i = 0; i < 8; i++) {
    const rect = placeNew(wins, AREA);
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= AREA.w && rect.y + rect.h <= AREA.h, JSON.stringify(rect));
    assert.ok(!wins.some((w) => w.rect.x === rect.x && w.rect.y === rect.y), `window ${i} sits on another`);
    wins.push({ rect, min: false });
  }
  const small = placeNew([], { w: 400, h: 300 });
  assert.ok(small.w <= 400 && small.h <= 300);
});

test('the window keys: halves, quarters from a half, maximise, back, minimise', () => {
  assert.deepEqual(keySnap(null, 'ArrowLeft'), { snap: 'l' });
  assert.deepEqual(keySnap('tl', 'ArrowRight'), { snap: 'r' });
  assert.deepEqual(keySnap('l', 'ArrowUp'), { snap: 'tl' });
  assert.deepEqual(keySnap('r', 'ArrowDown'), { snap: 'br' });
  assert.deepEqual(keySnap(null, 'ArrowUp'), { snap: 'max' });
  assert.deepEqual(keySnap('tl', 'ArrowUp'), { snap: 'max' });
  assert.deepEqual(keySnap('max', 'ArrowDown'), { snap: null });
  assert.deepEqual(keySnap('br', 'ArrowDown'), { snap: null });
  assert.deepEqual(keySnap(null, 'ArrowDown'), { min: true });
  assert.equal(keySnap(null, 'KeyQ'), null);
});

test('the kept layout is read back only where it is sound', () => {
  const good = { id: 'wabc123', app: 'tasks', hash: '#/desktop/tasks', title: 'Task manager', rect: { x: 10, y: 20, w: 600, h: 400 }, snap: 'l', min: false, z: 7 };
  const raw = {
    focus: 'wabc123',
    windows: [
      good,
      { ...good, id: 'wdef', app: 'terminal', hash: '#/m/laptop/s/shell-1', snap: 'sideways', z: 3, min: 'yes' },
      { ...good, id: 'wbad1', app: 'browser' }, // not an app
      { ...good, id: 'wbad0', app: 'workspace', hash: '#/workspace' }, // a page that is no longer an app
      { ...good, id: 'wbad2', hash: 'javascript:alert(1)' }, // not an address of this page
      { ...good, id: 'wbad3', hash: '#/x" onload="y' },
      { ...good, id: 'wbad4', rect: { x: 'a', y: 0, w: 1, h: 1 } },
      { ...good, id: 'Bad id' },
      { ...good }, // the same id again
      null,
      'text',
    ],
  };
  const out = cleanLayout(raw, APP_IDS);
  assert.deepEqual(out.windows.map((w) => w.id), ['wdef', 'wabc123'], 'sorted by layer');
  assert.deepEqual(out.windows.map((w) => w.z), [1, 2], 'layers renumbered from 1');
  assert.equal(out.windows[0].snap, null, 'an unknown snap place is none');
  assert.equal(out.windows[0].min, false, 'only true minimises');
  assert.equal(out.focus, 'wabc123');
  for (const bad of [null, 'x', {}, { windows: 'no' }]) assert.deepEqual(cleanLayout(bad, APP_IDS), { windows: [], focus: null });
  const many = { windows: Array.from({ length: 30 }, (_, i) => ({ ...good, id: `w${i}` })) };
  assert.equal(cleanLayout(many, APP_IDS).windows.length, MAX_WINDOWS);
  // What is kept is the model only: no element, no frame.
  const kept = keepLayout([{ ...good, el: {}, frame: {}, watch: 1 }], 'wabc123');
  assert.deepEqual(Object.keys(kept.windows[0]).sort(), ['app', 'hash', 'home', 'id', 'min', 'own', 'rect', 'snap', 'title', 'z']);
  // Where a window's app starts and whether the desktop started its shell come back too, checked like the rest.
  const term = cleanLayout({ windows: [{ ...good, app: 'terminal', hash: '#/s/shell-2', home: '#/s/shell-2', own: true }, { ...good, id: 'wx2', home: 'javascript:x', own: 'yes' }] }, APP_IDS).windows;
  assert.deepEqual(term.map((w) => [w.home, w.own]), [['#/s/shell-2', true], [null, false]]);
  assert.deepEqual(cleanLayout(JSON.parse(JSON.stringify(kept)), APP_IDS).windows[0].rect, good.rect, 'what is kept reads back the same');
  assert.equal(layoutKey(null), 'desktop.~');
  assert.equal(layoutKey('laptop'), 'desktop.laptop');
});

test('the catalog: the computer\'s own apps, each with a known icon and an address of this page', async () => {
  const fs = await import('node:fs');
  const { ICON_NAMES } = await import('../../web/icons.js');
  // Sessions and the Editor are the dashboard pages that are apps; the other pages of the dashboard are not apps.
  assert.deepEqual(APPS.map((a) => a.id), ['sessions', 'terminal', 'files', 'editor', 'tasks', 'services', 'logs']);
  for (const a of APPS) {
    assert.ok(ICON_NAMES.includes(a.icon), `${a.id}: icon ${a.icon}`);
    assert.ok(['page', 'terminal', 'native'].includes(a.kind), a.id);
    if (a.kind === 'page') assert.match(a.hash, /^#\/[a-z-]*$/, a.id);
    if (a.kind === 'native') assert.ok(fs.existsSync(new URL(`../../web/desktop/${a.module}`, import.meta.url)), `${a.id}: ${a.module}`);
  }
  for (const name of ['monitor', 'square', 'restore']) assert.ok(ICON_NAMES.includes(name), name);
  assert.equal(appById('nope'), null);
  assert.equal(appById('settings'), null, 'Settings stays in the dashboard');
  // For another computer every app opens there; a native app as a page lives under the desktop.
  assert.equal(appHash(appById('sessions'), null), '#/');
  // Home is every computer's at once: the router sends "#/m/<pc>/" to "#/", so a window's start page (the way back
  // in it compares with where its page lands) must be "#/" for any computer; the Sessions app keeps to its computer by
  // `only`. No app may start at an address the router moves on from.
  assert.equal(appHash(appById('sessions'), 'laptop'), '#/');
  assert.equal(onComputer('#/', 'laptop'), '#/');
  for (const a of APPS.filter((x) => x.kind !== 'terminal')) assert.doesNotMatch(appHash(a, 'laptop'), /^#\/m\/[^/]+\/?$/, a.id);
  assert.equal(appHash(appById('tasks'), null), '#/desktop/tasks');
  assert.equal(appHash(appById('logs'), 'laptop'), '#/m/laptop/desktop/logs');
  assert.equal(onComputer('#/settings/appearance', 'server-1'), '#/m/server-1/settings/appearance');
  assert.equal(sessionHash('a b/c', null), '#/s/a%20b%2Fc');
  // Files at a folder (Show in Files from the Editor), and the Editor's own address on another computer.
  assert.equal(filesHash('/home/dev/a b', null, 'x.txt'), '#/desktop/files?path=%2Fhome%2Fdev%2Fa+b&select=x.txt');
  assert.equal(filesHash('/srv', 'laptop'), '#/m/laptop/desktop/files?path=%2Fsrv');
  assert.equal(queryOf(filesHash('/srv/a&b', null)).get('path'), '/srv/a&b');
  assert.equal(queryOf('#/desktop/files').get('path'), null);
  assert.equal(appHash(appById('editor'), 'laptop'), '#/m/laptop/code');
  assert.equal(sessionHash('x', 'laptop'), '#/m/laptop/s/x');
  // A card of the sessions list: a chat ("chat:<id>") opens at its conversation, anything else at its session page.
  const chatId = '0b8c1a52-2f7e-4d0a-9a43-5f1c2b3d4e5f';
  assert.equal(cardHash({ kind: 'chat', name: `chat:${chatId}`, chatId }, null), `#/chat/${chatId}`);
  assert.equal(cardHash({ kind: 'chat', name: `chat:${chatId}`, chatId }, 'laptop'), `#/m/laptop/chat/${chatId}`);
  assert.equal(cardHash({ kind: 'claude', tool: 'opencode', name: 'web' }, null), '#/s/web');
  assert.equal(cardHash({ kind: 'shell', name: 'sh 1' }, 'laptop'), '#/m/laptop/s/sh%201');
  assert.equal(frameSrc('#/'), '/?bare=1#/');
  // What a window's page is told about its app: where it starts, its name, its computer (lib.js WINDOW reads it).
  const src = frameSrc('#/m/laptop/s/x', '/', { home: '#/', label: 'Sessions', only: 'laptop' });
  const q = new URLSearchParams(src.slice(src.indexOf('?'), src.indexOf('#')));
  assert.deepEqual([q.get('bare'), q.get('home'), q.get('label'), q.get('only')], ['1', '#/', 'Sessions', 'laptop']);
  assert.ok(src.endsWith('#/m/laptop/s/x') && !src.slice(0, src.lastIndexOf('#/m/laptop/s/x')).includes('#'), 'the "#" of home is encoded in the query');
  assert.deepEqual(searchApps('term').map((a) => a.id), ['terminal']);
  assert.equal(searchApps('serv')[0].id, 'services');
  assert.equal(searchApps('journal')[0].id, 'logs', 'words besides the title');
  assert.equal(searchApps('kill')[0].id, 'tasks');
  assert.equal(searchApps('  ').length, APPS.length);
  assert.deepEqual(searchApps('zzz'), []);
});

test('the native apps\' shared words and sorting', async () => {
  const { duration, errorText, minWidthOf, pct, sortBy } = await import('../../web/desktop/native.js');
  // A table turns narrow below what its wide columns need: fixed and minmax() tracks, gaps, padding, a scroll bar.
  assert.equal(minWidthOf(['minmax(150px, 1fr)', '104px', '1fr', 'auto']), 150 + 104 + 3 * 10 + 36);
  assert.ok(minWidthOf(['minmax(150px, 1.3fr)', 'minmax(120px, 1.6fr)', '104px', '104px', '178px']) > 635, 'a new Services window at 1024 × 600 is narrow');
  const { ApiError } = await import('../../web/lib.js');
  assert.equal(pct(12.34), '12 %');
  assert.equal(pct(3.14), '3.1 %');
  assert.equal(pct(null), '–');
  assert.equal(duration(40), '40 s');
  assert.equal(duration(8 * 60 + 5), '8 min');
  assert.equal(duration(5 * 3600 + 12 * 60), '5 h 12 min');
  assert.equal(duration(3 * 86400 + 4 * 3600), '3 d 4 h');
  const list = [{ n: 'b', v: 2 }, { n: 'a', v: null }, { n: 'c', v: 10 }];
  assert.deepEqual(sortBy(list, 'v', true).map((x) => x.n), ['c', 'b', 'a'], 'numbers, the unknown last');
  assert.deepEqual(sortBy(list, 'v', false).map((x) => x.n), ['b', 'c', 'a']);
  assert.deepEqual(sortBy(list, 'n', false).map((x) => x.n), ['a', 'b', 'c']);
  assert.equal(errorText(new ApiError('Not found', 404, { error: 'not found' })), 'This computer needs a Hoprig update for this app.', 'an older computer: no such route');
  assert.equal(errorText(new ApiError('There is no such file or folder', 404, { error: 'there is no such file or folder' })), 'There is no such file or folder', 'a missing file says so, not "update"');
  assert.equal(errorText(new ApiError('Offline', 404, { code: 'offline' })), 'Offline');
  assert.equal(errorText(new ApiError('No such process', 409)), 'No such process');
});

test('the desktop and each of its apps have an address, in the page and in what Tia can open, in step', async () => {
  const fs = await import('node:fs');
  const { SCREENS } = await import('../../src/assistant/tools.mjs');
  const app = fs.readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  const pages = [...(/export const PAGE_ADDRESSES = \[([\s\S]*?)\];/.exec(app)[1]).matchAll(/'#\/(desktop[^']*)'/g)].map((m) => m[1]);
  const want = ['desktop', ...APPS.map((a) => `desktop/${a.id}`)];
  assert.deepEqual([...pages].sort(), [...want].sort(), 'web/app.js PAGE_ADDRESSES');
  assert.deepEqual(SCREENS.filter((x) => x.startsWith('desktop')).sort(), [...want].sort(), 'src/assistant/tools.mjs SCREENS');
});
