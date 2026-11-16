// The desktop's window maths (web/desktop/layout.js) and its catalog of apps (web/desktop/apps.js): no DOM in
// either, so they are driven here directly. The windows themselves are driven in a real browser by
// tools/desktop-check.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { APPS, APP_IDS, appById, appHash, frameSrc, onComputer, searchApps, sessionHash } from '../../web/desktop/apps.js';
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
  const good = { id: 'wabc123', app: 'workspace', hash: '#/workspace', title: 'Workspace', rect: { x: 10, y: 20, w: 600, h: 400 }, snap: 'l', min: false, z: 7 };
  const raw = {
    focus: 'wabc123',
    windows: [
      good,
      { ...good, id: 'wdef', app: 'terminal', hash: '#/m/laptop/s/shell-1', snap: 'sideways', z: 3, min: 'yes' },
      { ...good, id: 'wbad1', app: 'browser' }, // not an app
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
  assert.deepEqual(Object.keys(kept.windows[0]).sort(), ['app', 'hash', 'id', 'min', 'rect', 'snap', 'title', 'z']);
  assert.deepEqual(cleanLayout(JSON.parse(JSON.stringify(kept)), APP_IDS).windows[0].rect, good.rect, 'what is kept reads back the same');
  assert.equal(layoutKey(null), 'desktop.~');
  assert.equal(layoutKey('laptop'), 'desktop.laptop');
});

test('the catalog: the apps of this step, each with a known icon and an address of this page', async () => {
  const { ICON_NAMES } = await import('../../web/icons.js');
  assert.deepEqual(APPS.map((a) => a.id), ['sessions', 'terminal', 'workspace', 'providers', 'computers', 'automations', 'skills', 'brain', 'settings']);
  for (const a of APPS) {
    assert.ok(ICON_NAMES.includes(a.icon), `${a.id}: icon ${a.icon}`);
    assert.ok(['page', 'terminal'].includes(a.kind), a.id);
    if (a.kind === 'page') assert.match(a.hash, /^#\/[a-z-]*$/, a.id);
  }
  for (const name of ['monitor', 'square', 'restore']) assert.ok(ICON_NAMES.includes(name), name);
  assert.equal(appById('nope'), null);
  // For another computer every page app opens there, except the list of every computer.
  assert.equal(appHash(appById('workspace'), null), '#/workspace');
  assert.equal(appHash(appById('workspace'), 'laptop'), '#/m/laptop/workspace');
  assert.equal(appHash(appById('sessions'), 'laptop'), '#/m/laptop/');
  assert.equal(appHash(appById('computers'), 'laptop'), '#/computers');
  assert.equal(onComputer('#/settings/appearance', 'laptop'), '#/m/laptop/settings/appearance');
  assert.equal(sessionHash('a b/c', null), '#/s/a%20b%2Fc');
  assert.equal(sessionHash('x', 'laptop'), '#/m/laptop/s/x');
  assert.equal(frameSrc('#/workspace'), '/?bare=1#/workspace');
  assert.deepEqual(searchApps('term').map((a) => a.id), ['terminal']);
  assert.equal(searchApps('set')[0].id, 'settings');
  assert.equal(searchApps('memory')[0].id, 'brain', 'words besides the title');
  assert.equal(searchApps('  ').length, APPS.length);
  assert.deepEqual(searchApps('zzz'), []);
});
