#!/usr/bin/env node
// Dev-only (not in the published package): desktop mode against the habits of a desktop, one check per row of
// research/desktop-parity.md (the row's Id is in brackets), on `hoprig demo` (sample data and stand-in coding tools in
// a temp folder, nothing real) and the local Chrome headless (tools/chrome.mjs). Chrome needs a short TMPDIR.
//
//   TMPDIR=/tmp node tools/desktop-parity-check.mjs [--port 7680] [--out <folder for screenshots>] [--only rows,touch,…]
//
// Parts: rows (1440 × 900, light: eight windows, of two App sessions, two Terminal sessions, a shell, the Task
// manager and the Editor: move, double click, the eight edges, snap and its preview, out of a snap, the keys, the
// cycle key, Escape in a drag, the bar, a terminal and a chat that keep their size and place, close, a reload in a
// drag, a smaller browser, Dock and back, a shell that ends while minimised), tabs (two tabs on one desktop), touch
// (1366 × 1024 with a finger), ended (a coding session that ends while minimised), keyboard (the keyboard only: minimise, the
// window menu, a way out of a terminal), looks
// (1000 px, 390 px touch, dark), settings (the keys in Settings → Appearance).
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { startCheck } from './desktop-check-lib.mjs';

const {
  PORT, OUT, hooks, want, sleep, check, chrome, ev, J, shot, waitFor, mouse, click, dblclick, drag, key, rectOf, center, area, open, finish, done,
} = await startCheck('hoprig-desktop-parity');

const ALT = 1;
const CTRL = 2;
const SHIFT = 8;
const AS = ALT | SHIFT;
const W = (id) => `.dwin[data-id="${id}"]`;
const KEY = 'pref:desktop.~';
let n = 0;
const photo = (name) => shot(`p${String(++n).padStart(2, '0')}-${name}`);

/** A drag that is not let go: the pointer stays pressed at (x1, y1). */
async function hold(x0, y0, x1, y1, steps = 10) {
  await mouse('mouseMoved', x0, y0, { buttons: 0 });
  await mouse('mousePressed', x0, y0);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps));
    await sleep(16);
  }
  await sleep(120);
}
const rect = (id) => rectOf(W(id));
const titleOf = (id) => rectOf(`${W(id)} .dwin-title`);
const state = (id) => ev(`(() => { const w = document.querySelector(${J(W(id))}); return w && { snap: w.dataset.snap, min: w.classList.contains('hidden') || getComputedStyle(w).visibility === 'hidden', front: w.getAttribute('aria-current') === 'true' }; })()`);
const frontId = () => ev(`(document.querySelector('.dwin[aria-current="true"]') || {}).dataset?.id || null`);
const toFront = async (id) => {
  await ev(`(() => { const w = document.querySelector(${J(W(id))}); if (w.getAttribute('aria-current') !== 'true' || w.classList.contains('hidden') || w.dataset.min === '1') document.querySelector('.desk-task[data-id=${J(id)}]').click(); return true; })()`);
  await sleep(250);
};
const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const doc = (id) => `document.querySelector(${J(`${W(id)} iframe`)}).contentDocument`;
/** The terminal's size as its shell sees it, read by typing into it. */
async function sttySize(id, tag) {
  const [x, y] = center(await rectOf(`${W(id)} .dwin-body`));
  await click(x, y);
  await sleep(300);
  await chrome.send('Input.insertText', { text: `echo ${tag}$(stty size | tr ' ' x)Z` });
  await key('Enter', 'Enter', 0, 13);
  const re = `/${tag}(\\d+)x(\\d+)Z/`;
  await waitFor(`${re}.test((${doc(id)}.querySelector('.xterm-rows') || {}).textContent || '')`, 6000);
  return ev(`(() => { const m = ${re}.exec(${doc(id)}.querySelector('.xterm-rows').textContent); return m ? m[1] + ' rows x ' + m[2] + ' cols' : null; })()`);
}
const firstRow = (id) => ev(`(() => { const r = ${doc(id)}.querySelector('.xterm-rows'); return r && r.firstElementChild ? r.firstElementChild.textContent.trim() : null; })()`);
const cssOf = (sel, prop) => ev(`(() => { const e = document.querySelector(${J(sel)}); return e ? getComputedStyle(e)[${J(prop)}] : null; })()`);

try {
  // ---------- the sessions: two App (chats), two Terminal (the demo's sessions), a shell ----------
  await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': null, 'desktop.style': null, 'desktop.keys': null, 'page.theme': 'light' } });
  await waitFor(`window.__hoprigStore && window.__hoprigStore.all.length > 0 && (window.__hoprigStore.all[0].sessions || []).some((s) => s.name === 'shop-frontend')`, 15000);
  const dir = await ev(`window.__hoprigStore.all[0].sessions.find((s) => s.name === 'shop-frontend').cwd`);
  const post = (path, body) => ev(`fetch(${J(path)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${J(J(body))} }).then((r) => r.json())`);
  const shell = (await post('/api/shells', {})).name;
  await post('/api/chats', { dir, text: 'Say hello in one line.' });
  await waitFor(`window.__hoprigStore.all[0].sessions.filter((s) => s.kind === 'chat').length >= 2`, 15000);
  const chats = await ev(`window.__hoprigStore.all[0].sessions.filter((s) => s.kind === 'chat').map((s) => s.chatId)`);
  const lay = (id, app, hash, x, y, w, h, z, extra = {}) => ({ id, app, hash, title: '', rect: { x, y, w, h }, snap: null, min: false, z, ...extra });
  const layout = {
    focus: 'wtasks',
    windows: [
      lay('wedit', 'editor', `#/code?dir=${encodeURIComponent(dir)}&file=src%2Fcart.js`, 60, 20, 760, 470, 1),
      lay('wchat2', 'sessions', `#/chat/${chats[1]}`, 640, 30, 620, 420, 2),
      lay('wchat', 'sessions', `#/chat/${chats[0]}`, 200, 290, 600, 420, 3),
      lay('wsess2', 'sessions', '#/s/api-server', 680, 300, 640, 400, 4),
      lay('wneed', 'sessions', '#/s/mobile-app', 720, 200, 640, 420, 5),
      lay('wterm', 'terminal', `#/s/${encodeURIComponent(shell)}`, 420, 110, 720, 440, 6, { home: `#/s/${encodeURIComponent(shell)}`, own: true }),
      lay('wtasks', 'tasks', '#/desktop/tasks', 140, 60, 640, 420, 7),
    ],
  };
  await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': layout } });
  await waitFor(`document.querySelectorAll('.dwin').length === 7`, 8000);
  await waitFor(`[...document.querySelectorAll('.dwin iframe')].every((f) => f.contentDocument && f.contentDocument.querySelector('main'))`, 15000);
  await sleep(1500);
  await photo('seven-windows');
  const a = await area();

  if (want('rows')) {
    const P = 'rows';
    // [move] by the title bar
    let r0 = await rect('wtasks');
    let t = await titleOf('wtasks');
    await drag(t.x + 40, t.y + 12, t.x + 40 + 150, t.y + 12 + 60);
    let r1 = await rect('wtasks');
    check(P, '[move] a window moves by its title bar, as far as the pointer', r1.x - r0.x === 150 && r1.y - r0.y === 60, `${r1.x - r0.x}, ${r1.y - r0.y}`);
    // [dblclick-max] [dblclick-restore]
    t = await titleOf('wtasks');
    await dblclick(t.x + 60, t.y + 12);
    await sleep(250);
    const rm = await rect('wtasks');
    check(P, '[dblclick-max] a double click on the title bar maximises', rm.x === a.x && rm.y === a.y && rm.w === a.w && rm.h === a.h, J(rm));
    t = await titleOf('wtasks');
    await dblclick(t.x + 60, t.y + 12);
    await sleep(250);
    check(P, '[dblclick-restore] a second double click brings back its place and size', same(await rect('wtasks'), r1), J(await rect('wtasks')));
    // [resize-*] each edge and corner, with its cursor
    const want8 = { n: [0, -30], s: [0, 30], e: [30, 0], w: [-30, 0], ne: [30, -30], nw: [-30, -30], se: [30, 30], sw: [-30, 30] };
    const cursors = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
    for (const [dir8, [dx, dy]] of Object.entries(want8)) {
      const before = await rect('wtasks');
      const g = await rectOf(`${W('wtasks')} .dwin-grip[data-dir="${dir8}"]`);
      const [gx, gy] = center(g);
      await drag(gx, gy, gx + dx, gy + dy, 6);
      const after = await rect('wtasks');
      const ok = (dir8.includes('e') ? after.w - before.w === dx && after.x === before.x : true)
        && (dir8.includes('w') ? after.x - before.x === dx && after.x + after.w === before.x + before.w : true)
        && (dir8.includes('s') ? after.h - before.h === dy && after.y === before.y : true)
        && (dir8.includes('n') ? after.y - before.y === dy && after.y + after.h === before.y + before.h : true)
        && (!/[ew]/.test(dir8) ? after.w === before.w : true) && (!/[ns]/.test(dir8) ? after.h === before.h : true);
      const cur = await cssOf(`${W('wtasks')} .dwin-grip[data-dir="${dir8}"]`, 'cursor');
      check(P, `[resize-${dir8}] resizes from the ${dir8} grip, the far side stays; cursor ${cursors[dir8]}`, ok && cur === cursors[dir8], `${J(before)} → ${J(after)}, ${cur}`);
    }
    // [resize-min]
    let g = await rectOf(`${W('wtasks')} .dwin-grip[data-dir="se"]`);
    await drag(...center(g), g.x - 1500, g.y - 1500, 8);
    let rr = await rect('wtasks');
    check(P, '[resize-min] a resize stops at the smallest size (320 × 200)', rr.w === 320 && rr.h === 200, J(rr));
    g = await rectOf(`${W('wtasks')} .dwin-grip[data-dir="se"]`);
    await drag(...center(g), g.x + 340, g.y + 240, 8);
    r1 = await rect('wtasks');
    // [snap-preview] [snap-l]
    t = await titleOf('wtasks');
    await hold(t.x + 40, t.y + 12, a.x + 1, a.y + 360);
    const pv = await ev(`(() => { const p = document.querySelector('.desk-preview'); if (!p || p.classList.contains('hidden')) return null; const r = p.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    await photo('snap-preview');
    await mouse('mouseReleased', a.x + 1, a.y + 360);
    await sleep(250);
    check(P, '[snap-preview] before the release, the place it will take is shown', pv && pv.x === a.x && Math.abs(pv.w - a.w / 2) <= 1 && pv.h === a.h, J(pv));
    const rl = await rect('wtasks');
    check(P, '[snap-half] dragged to the left edge it takes the left half', rl.x === a.x && Math.abs(rl.w - a.w / 2) <= 1 && rl.h === a.h, J(rl));
    // [snap-away] taken out of the half: its own size, under the pointer at the same share of the bar
    t = await titleOf('wtasks');
    const grabX = t.x + Math.round(t.w * 0.75);
    const shareBefore = (grabX - rl.x) / rl.w;
    await drag(grabX, t.y + 12, grabX + 300, t.y + 160);
    const ra = await rect('wtasks');
    const shareAfter = (grabX + 300 - ra.x) / ra.w;
    check(P, '[snap-away] dragged out of a snap place it takes back its own size, held at the same share of the bar', ra.w === r1.w && ra.h === r1.h && Math.abs(shareAfter - shareBefore) < 0.03, `${ra.w}×${ra.h}, share ${shareBefore.toFixed(2)} → ${shareAfter.toFixed(2)}`);
    // [snap-max] [snap-quarter]
    t = await titleOf('wtasks');
    await drag(t.x + 40, t.y + 12, a.x + 700, a.y + 1);
    check(P, '[snap-max] dragged to the top edge it maximises', (await state('wtasks')).snap === 'max');
    // [max-drag] a maximised window dragged down: back to its size under the pointer
    t = await titleOf('wtasks');
    await drag(t.x + 700, t.y + 12, t.x + 700, t.y + 200);
    const rd = await rect('wtasks');
    check(P, '[max-drag] a maximised window dragged down takes back its own size under the pointer', rd.w === r1.w && rd.h === r1.h && rd.x < a.x + 700 && rd.x + rd.w > a.x + 700, J(rd));
    t = await titleOf('wtasks');
    await drag(t.x + 40, t.y + 12, a.x + a.w - 1, a.y + 20);
    check(P, '[snap-quarter] dragged to a corner it takes that quarter', (await state('wtasks')).snap === 'tr');
    // [keys-snap] a corner, then a half by the keys; up and down
    await click(...center(await rectOf(`${W('wtasks')} .dwin-body`)));
    await key('ArrowLeft', 'ArrowLeft', AS, 37);
    await sleep(250);
    const k1 = (await state('wtasks')).snap;
    await key('ArrowUp', 'ArrowUp', AS, 38);
    await sleep(250);
    const k2 = (await state('wtasks')).snap;
    await key('ArrowDown', 'ArrowDown', AS, 40);
    await sleep(250);
    const k3 = (await state('wtasks')).snap;
    check(P, '[keys-snap] Alt+Shift+Left a half, Up its top quarter, Down back where it was', k1 === 'l' && k2 === 'tl' && k3 === '', `${k1}, ${k2}, ${k3}`);
    r1 = await rect('wtasks');
    await key('ArrowUp', 'ArrowUp', AS, 38);
    await sleep(250);
    const k4 = (await state('wtasks')).snap;
    await key('ArrowDown', 'ArrowDown', AS, 40);
    await sleep(250);
    check(P, '[keys-max] Alt+Shift+Up maximises, Down restores its place and size', k4 === 'max' && same(await rect('wtasks'), r1), `${k4}, ${J(await rect('wtasks'))}`);
    // [min-bar] [focus-after-min] minimise by the key; the keyboard lands on its bar button
    await key('KeyM', 'M', AS, 77);
    await sleep(300);
    const sm = await state('wtasks');
    const onBtn = await ev(`!!document.activeElement && document.activeElement.matches('.desk-task[data-id="wtasks"], .desk-dock-item[data-app="tasks"]')`);
    check(P, '[min-key] Alt+Shift+M minimises the window in front', sm.min);
    check(P, '[focus-after-min] after a minimise by the keyboard, the keyboard is on its bar button', onBtn, await ev(`document.activeElement && (document.activeElement.className || document.activeElement.tagName)`));
    const ariaMin = await ev(`document.querySelector('.desk-task[data-id="wtasks"]').getAttribute('aria-label') || ''`);
    check(P, '[aria-bar-min] its bar button says it is minimised', /minimi[sz]ed/i.test(ariaMin), ariaMin);
    await ev(`document.querySelector('.desk-task[data-id="wtasks"]').click()`);
    await sleep(300);
    const back = await state('wtasks');
    check(P, '[min-bar] its bar button brings it back, in front, at its place', !back.min && back.front && same(await rect('wtasks'), r1));
    // [bar-front] [bar-behind]
    await click(...center(await rectOf('.desk-task[data-id="wtasks"]')));
    await sleep(300);
    check(P, '[bar-front] the bar button of the window in front minimises it', (await state('wtasks')).min);
    await click(...center(await rectOf('.desk-task[data-id="wtasks"]')));
    await sleep(300);
    await click(...center(await rectOf('.desk-task[data-id="wchat"]')));
    await sleep(300);
    check(P, '[bar-behind] the bar button of a window behind brings it to the front', (await frontId()) === 'wchat');
    // [first-click] a press on a window behind brings it forward; what the press lands on
    const tb = await rect('wterm');
    const pt = [tb.x + tb.w - 60, tb.y + tb.h - 40];
    await click(...pt);
    await sleep(300);
    check(P, '[first-click] the first press on a window behind brings it to the front', (await frontId()) === 'wterm');
    // [aria-window]
    const names = await ev(`[...document.querySelectorAll('.dwin')].map((w) => w.getAttribute('aria-label')).join(' | ')`);
    check(P, '[aria-window] each window is named by its title', !names.split(' | ').some((x) => !x), names);
    // [cycle] Alt+Shift+` goes to the window used before, a minimised one comes back
    await toFront('wtasks');
    await toFront('wterm');
    await key('Backquote', '`', AS, 192);
    await sleep(350);
    const c1 = await frontId();
    await sleep(1600); // the key let go: the next press starts from the window in front again
    check(P, '[cycle] Alt+Shift+` brings the window used before to the front (Alt+Tab belongs to the computer)', c1 === 'wtasks', String(c1));
    await toFront('wtasks');
    await click(...center(await rectOf(`${W('wtasks')} .dwin-btn[data-act="minus"]`)));
    await sleep(250);
    await toFront('wterm');
    await sleep(1600);
    // Held down, the key goes on through the windows in the order last used; the minimised one comes last.
    const count = await ev(`document.querySelectorAll('.dwin').length`);
    const seen = [];
    for (let i = 1; i < count; i++) {
      await key('Backquote', '`', AS, 192);
      await sleep(300);
      seen.push(await frontId());
    }
    const c2 = seen[seen.length - 1];
    check(P, '[cycle-min] held down, the cycle key goes through every window and brings back a minimised one last', c2 === 'wtasks' && !(await state('wtasks')).min && new Set(seen).size === count - 1, seen.join(' '));
    await sleep(1600);
    // [escape-drag]
    await toFront('wtasks');
    const re0 = await rect('wtasks');
    t = await titleOf('wtasks');
    await hold(t.x + 40, t.y + 12, t.x + 240, t.y + 112);
    await key('Escape', 'Escape', 0, 27);
    await sleep(150);
    await mouse('mouseReleased', t.x + 240, t.y + 112);
    await sleep(250);
    check(P, '[escape-drag] Escape during a drag puts the window back', same(await rect('wtasks'), re0), J(await rect('wtasks')));
    // [needs-you] the bar button of a session that needs you
    const need = await ev(`(() => { const b = document.querySelector('.desk-task[data-id="wneed"]'); return { label: b.getAttribute('aria-label') || '', mark: !!b.querySelector('.desk-task-mark') }; })()`);
    check(P, '[needs-you] the bar button of a window whose session needs you has the mark, and its name says so', need.mark && /needs you/i.test(need.label), J(need));
    // [term-keeps] a terminal minimised and covered keeps its size and its scroll
    await toFront('wterm');
    const s0 = (await sttySize('wterm', 'A')) || (await sttySize('wterm', 'A'));
    const rowsNow = () => ev(`${doc('wterm')}.querySelector('.xterm-rows').childElementCount`);
    const n0 = await rowsNow();
    await chrome.send('Input.insertText', { text: 'seq 1 400' });
    await key('Enter', 'Enter', 0, 13);
    await sleep(800);
    const tc = center(await rectOf(`${W('wterm')} .dwin-body`));
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: tc[0], y: tc[1], deltaX: 0, deltaY: -600 });
    await sleep(600);
    const row0 = await firstRow('wterm');
    await toFront('wtasks');
    await sleep(800);
    const rowCovered = await firstRow('wterm');
    await toFront('wterm');
    await click(...center(await rectOf(`${W('wterm')} .dwin-btn[data-act="minus"]`)));
    await sleep(1500);
    const nMin = await rowsNow();
    await toFront('wterm');
    await sleep(1200);
    const row1 = await firstRow('wterm');
    await photo('terminal-after-minimise');
    const s1 = await sttySize('wterm', 'B');
    check(P, '[term-size] a terminal keeps its size while minimised and when brought back', s0 && s0 === s1 && n0 === nMin, `${s0} → ${s1}; rows drawn ${n0}, while minimised ${nMin}`);
    check(P, '[term-scroll] a terminal keeps its scroll place when covered, minimised and brought back', row0 && row0 === rowCovered && row0 === row1, `${row0} / ${rowCovered} / ${row1}`);
    // [keys-terminal] the desktop's keys work with the keyboard in a terminal window, and its shell still types
    await toFront('wterm');
    await click(...center(await rectOf(`${W('wterm')} .dwin-body`)));
    await sleep(300);
    await key('ArrowRight', 'ArrowRight', AS, 39);
    await sleep(400);
    const kt = (await state('wterm')).snap;
    await key('ArrowDown', 'ArrowDown', AS, 40);
    await sleep(400);
    const kt2 = (await state('wterm')).snap;
    await key('ArrowDown', 'ArrowDown', AS, 40);
    await sleep(400);
    check(P, '[keys-terminal] with the keyboard in a terminal window Alt+Shift+Right snaps it, Down its bottom quarter, Down again puts it back', kt === 'r' && kt2 === 'br' && (await state('wterm')).snap === '', `${kt}, ${kt2}, ${(await state('wterm')).snap}`);
    // [chat-place] a chat keeps its place
    await toFront('wchat');
    await waitFor(`!!${doc('wchat')}.querySelector('.chat-scroll')`, 8000);
    const top0 = await ev(`(() => { const s = ${doc('wchat')}.querySelector('.chat-scroll'); s.scrollTop = Math.max(0, Math.round((s.scrollHeight - s.clientHeight) / 2)); return s.scrollTop + '/' + (s.scrollHeight - s.clientHeight); })()`);
    await click(...center(await rectOf(`${W('wchat')} .dwin-btn[data-act="minus"]`)));
    await sleep(1200);
    await toFront('wchat');
    await sleep(800);
    const top1 = await ev(`(() => { const s = ${doc('wchat')}.querySelector('.chat-scroll'); return s.scrollTop + '/' + (s.scrollHeight - s.clientHeight); })()`);
    check(P, '[chat-place] a chat keeps its place when minimised and brought back', top0 === top1, `${top0} → ${top1}`);
    // [close-plain] [close-shell] [close-unsaved]
    await toFront('wterm');
    await click(...center(await rectOf(`${W('wterm')} .dwin-btn[data-act="x"]`)));
    const askShell = await waitFor(`!!document.querySelector('dialog[open]')`, 3000);
    await photo('close-shell-asks');
    await ev(`(() => { const b = [...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Cancel'); if (b) b.click(); return true; })()`);
    await sleep(400);
    check(P, '[close-shell] closing a shell the desktop started asks whether it ends too', askShell && !!(await rect('wterm')));
    await toFront('wedit');
    const monaco = await waitFor(`!!${doc('wedit')}.querySelector('.monaco-editor textarea')`, 20000);
    if (monaco) {
      const eb = await rectOf(`${W('wedit')} .dwin-body`);
      await click(eb.x + Math.round(eb.w * 0.7), eb.y + 120);
      await sleep(400);
      await chrome.send('Input.insertText', { text: '// x' });
      await sleep(400);
      const ed = `document.querySelector(${J(`${W('wedit')} iframe`)}).contentWindow.monaco.editor.getEditors()[0]`;
      const what = () => ev(`(() => { const e = ${ed}; return e.getModel().getLineCount() + ' lines, ' + e.getSelections().length + ' cursors'; })()`);
      const w0 = await what();
      await key('ArrowDown', 'ArrowDown', AS, 40);
      await sleep(500);
      const w1 = await what();
      const es = await state('wedit');
      // Alt+Shift+Down is the editor's own: a copied line (Windows, macOS) or a second cursor (Linux).
      check(P, '[keys-editor] in an Editor window Alt+Shift+Down stays the editor\'s, the window stays', w1 !== w0 && !es.min && es.snap === '', `${w0} → ${w1}, window ${J(es)}`);
      if (es.min || es.snap) await toFront('wedit');
      await ev(`(() => { const w = document.querySelector(${J(W('wedit'))}); w.querySelector('.dwin-btn[data-act="x"]').click(); return true; })()`);
      const askEd = await waitFor(`!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').textContent.includes('unsaved')`, 3000);
      await photo('close-unsaved-asks');
      await ev(`(() => { const b = [...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Cancel'); if (b) b.click(); return true; })()`);
      check(P, '[close-unsaved] closing an Editor with unsaved changes asks first', askEd);
      // Closed without saving: nothing of the demo's file changes, and a reload asks nothing.
      await sleep(300);
      await ev(`(() => { const w = document.querySelector(${J(W('wedit'))}); w.querySelector('.dwin-btn[data-act="x"]').click(); return true; })()`);
      await waitFor(`!!document.querySelector('dialog[open]')`, 3000);
      await ev(`(() => { const b = [...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Close without saving'); if (b) b.click(); return true; })()`);
      check(P, '[close-unsaved-drop] "Close without saving" closes it', await waitFor(`!document.querySelector(${J(W('wedit'))})`, 3000));
    } else check(P, '[close-unsaved] the editor loaded', false, 'no Monaco in 20 s');
    await toFront('wtasks');
    await click(...center(await rectOf(`${W('wtasks')} .dwin-btn[data-act="x"]`)));
    await sleep(400);
    check(P, '[close-plain] a window with nothing to lose closes at once, without a question', !(await ev(`!!document.querySelector('dialog[open]')`)) && !(await ev(`!!document.querySelector('.dwin[data-id="wtasks"]')`)));
    // [menu-keys] the title bar's menu shows each act with its key
    await toFront('wsess2');
    t = await titleOf('wsess2');
    await click(t.x + 80, t.y + 12, { button: 'right', buttons: 2 });
    await waitFor(`!!document.querySelector('.desk-menu')`);
    const menu = await ev(`(document.querySelector('.desk-menu') || {}).innerText || ''`);
    await photo('window-menu');
    await key('Escape', 'Escape', 0, 27);
    check(P, '[menu-keys] the title bar\'s menu shows each act with its key', /Alt\+Shift\+←/.test(menu) && /Alt\+Shift\+M/.test(menu) && /Alt\+Shift\+W/.test(menu), menu.replace(/\n/g, ' | '));
    // [reload-drag] a reload in the middle of a drag keeps the last place shown
    const rq0 = await rect('wsess2');
    t = await titleOf('wsess2');
    await hold(t.x + 40, t.y + 12, t.x + 40 - 200, t.y + 12 - 150);
    const rq1 = await rect('wsess2');
    await open('#/desktop', { w: 1440, h: 900, wait: 2500 });
    await mouse('mouseReleased', 10, 10);
    const rq2 = await rect('wsess2');
    check(P, '[reload-drag] after a reload in the middle of a drag the window is where it was last shown', same(rq2, rq1) && !same(rq1, rq0), `${J(rq0)} → shown ${J(rq1)} → after ${J(rq2)}`);
    // [reload] the layout comes back after a reload
    const before = await ev(`[...document.querySelectorAll('.dwin')].map((w) => [w.dataset.id, w.dataset.snap, w.style.left, w.style.top, w.style.width, w.style.height].join(' ')).sort().join(';')`);
    await open('#/desktop', { w: 1440, h: 900, wait: 2500 });
    const after = await ev(`[...document.querySelectorAll('.dwin')].map((w) => [w.dataset.id, w.dataset.snap, w.style.left, w.style.top, w.style.width, w.style.height].join(' ')).sort().join(';')`);
    check(P, '[reload] the layout is there again after a reload', before === after, after);
    // [smaller] a smaller browser: every title bar reachable, the 1440 layout the same afterwards
    const all = () => ev(`[...document.querySelectorAll('.dwin')].map((w) => [w.dataset.id, w.style.left, w.style.top, w.style.width, w.style.height].join(' ')).sort().join(';')`);
    const l0 = await all();
    await chrome.viewport(1100, 700, { theme: 'light' });
    await sleep(700);
    const reach = await ev(`(() => { const a = document.querySelector('.desk-area').getBoundingClientRect(); return [...document.querySelectorAll('.dwin:not(.hidden)')].every((w) => { const t = w.querySelector('.dwin-bar').getBoundingClientRect(); return t.top >= a.top && t.bottom <= a.bottom && t.left >= a.left - 1 && t.right <= a.right + 1; }); })()`);
    await photo('smaller-1100');
    check(P, '[reach] at 1100 × 700 every title bar is inside the work area', reach);
    await chrome.viewport(1000, 700, { theme: 'light' });
    await sleep(1500);
    await chrome.viewport(1440, 900, { theme: 'light' });
    await sleep(2000);
    const l1 = await all();
    check(P, '[back-1440] after 1100 and 1000 px, back at 1440 every window has its place and size again', l0 === l1, `${l0} → ${l1}`);
    // [dock-and-back]
    const l2 = await all();
    const styleBy = async (word) => {
      // The free corner of the area as it is now (the Dock's bars take other room than the Taskbar's).
      const fa = await area();
      for (const w of ['wchat', 'wchat2', 'wneed', 'wsess2', 'wterm']) if (await rect(w) && !(await state(w)).min) await click(...center(await rectOf(`${W(w)} .dwin-btn[data-act="minus"]`)));
      await sleep(300);
      await click(fa.x + fa.w - 8, fa.y + fa.h - 8, { button: 'right', buttons: 2 });
      await waitFor(`!!document.querySelector('.desk-menu')`);
      await ev(`[...document.querySelectorAll('.desk-menu-item')].find((b) => b.textContent.includes(${J(word)})).click()`);
      for (const w of ['wchat', 'wchat2', 'wneed', 'wsess2', 'wterm']) if (await rect(w) === null || (await state(w)).min) await ev(`(() => { const b = document.querySelector('.desk-task[data-id=${J(w)}], .desk-dock-item'); return true; })()`);
      await sleep(900);
    };
    await styleBy('Dock style');
    await photo('dock-style');
    await styleBy('Taskbar style');
    for (const w of ['wchat', 'wchat2', 'wneed', 'wsess2', 'wterm']) await toFront(w);
    check(P, '[dock-and-back] Taskbar to Dock and back: every window in its place', l2 === (await all()), await all());
    // [ended-min] a shell that ends while its window is minimised
    await toFront('wterm');
    await click(...center(await rectOf(`${W('wterm')} .dwin-btn[data-act="minus"]`)));
    await sleep(300);
    await post(`/api/sessions/${encodeURIComponent(shell)}/kill`, {});
    await ev(`window.__hoprigStore.refresh()`);
    await sleep(3500);
    const ended = await ev(`(() => { const b = document.querySelector('.desk-task[data-id="wterm"]'); return b ? { label: b.getAttribute('aria-label') || '', ended: b.dataset.ended === '1' } : null; })()`);
    check(P, '[ended-bar] a session that ended while minimised says so on its bar button', ended && ended.ended && /ended/i.test(ended.label), J(ended));
    await photo('ended-on-bar');
    await toFront('wterm');
    await sleep(600);
    const endedIn = await ev(`/This session has ended/.test(${doc('wterm')}.body.textContent)`);
    await photo('ended-in-window');
    check(P, '[ended-window] and its window says it ended', endedIn);
  }

  // ---------- two tabs on one desktop ----------
  if (want('tabs')) {
    const P = 'tabs';
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': { focus: null, windows: [] } }, wait: 1500 });
    // A second tab of the same browser, on the same desktop.
    const made = await chrome.send('Target.createTarget', { url: await ev('location.href'), background: true });
    await sleep(2500);
    const list = await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json();
    const t2 = list.find((x) => x.id === made.targetId);
    const ws = new WebSocket(t2.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    let id = 0;
    const ev2 = (expression) => new Promise((resolve) => {
      const my = ++id;
      const on = (m) => {
        const j = JSON.parse(m);
        if (j.id !== my) return;
        ws.off('message', on);
        resolve(j.result && j.result.result ? j.result.result.value : null);
      };
      ws.on('message', on);
      ws.send(J({ id: my, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    // A new tab opens at the browser's own size: the same 1440 × 900 as tab one, drawn again at that size.
    await new Promise((r) => {
      ws.send(J({ id: 900, method: 'Emulation.setDeviceMetricsOverride', params: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false } }));
      ws.send(J({ id: 901, method: 'Page.reload', params: {} }));
      setTimeout(r, 3000);
    });
    check(P, '[two-tabs-open] the second tab shows the same desktop with windows', await ev2(`!!document.querySelector('.desk-area')`));
    // Tab two is behind (the browser shows tab one): its page is told so, as the browser tells a tab behind.
    await ev2(`(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); return true; })()`);
    // Tab one opens the Task manager and Logs.
    await click(...center(await rectOf('.desk-icon[data-app="tasks"]')));
    await waitFor(`!!document.querySelector('.dwin[data-app="tasks"]')`);
    await click(...center(await rectOf('.desk-icon[data-app="logs"]')));
    await waitFor(`!!document.querySelector('.dwin[data-app="logs"]')`);
    await sleep(900);
    const inTwo = await ev2(`[...document.querySelectorAll('.dwin')].map((w) => w.dataset.app).sort().join(',')`);
    const oneHidden = await ev('document.hidden');
    check(P, '[two-tabs] a tab behind takes the layout another tab changed', inTwo === 'logs,tasks', `${inTwo}; tab one hidden: ${oneHidden}`);
    // Tab two comes to the front and moves a window: tab one's windows are still in what is kept.
    await ev2(`(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); const m = document.querySelector('.dwin'); if (m) m.querySelector('.dwin-btn[data-act="minus"]').click(); return true; })()`);
    await sleep(900);
    const kept = await ev(`(JSON.parse(localStorage.getItem(${J(KEY)})) || { windows: [] }).windows.map((w) => w.app).sort().join(',')`);
    check(P, '[two-tabs-kept] after the other tab changed something, no window of either tab is lost', kept === 'logs,tasks', kept);
    await chrome.send('Target.closeTarget', { targetId: made.targetId }).catch(() => {});
    ws.close();

    // Another tab of this browser with its own connection: `newWindow` (its own browser window, so both are in view)
    // or a tab in front of this one (this one goes behind).
    const newTab = async (newWindow) => {
      const t = await chrome.send('Target.createTarget', { url: await ev('location.href'), newWindow, background: false });
      await sleep(2500);
      const found = (await (await fetch(`http://127.0.0.1:${chrome.port}/json/list`)).json()).find((x) => x.id === t.targetId);
      const sock = new WebSocket(found.webSocketDebuggerUrl);
      await new Promise((r, j) => { sock.once('open', r); sock.once('error', j); });
      let nid = 0;
      const send = (method, params) => new Promise((resolve) => {
        const my = ++nid;
        const on = (m) => { const j = JSON.parse(m); if (j.id !== my) return; sock.off('message', on); resolve(j.result); };
        sock.on('message', on);
        sock.send(J({ id: my, method, params }));
      });
      const evx = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r && r.result ? r.result.value : null; };
      await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await send('Page.reload', {});
      await sleep(3500);
      return { send, ev: evx, close: async () => { await chrome.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {}); sock.close(); } };
    };
    const keptOf = () => ev(`(JSON.parse(localStorage.getItem(${J(KEY)})) || { windows: [] }).windows.map((w) => w.id + ':' + w.snap).sort().join(',')`);
    const tabShot = async (t, name) => fs.writeFileSync(path.join(OUT, `p${String(++n).padStart(2, '0')}-${name}.png`), Buffer.from((await t.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const frameHash = (t, id) => t.ev(`document.querySelector('.dwin[data-id="${id}"] iframe').contentWindow.location.hash`);
    const goTo = (t, id, hash) => t.ev(`(document.querySelector('.dwin[data-id="${id}"] iframe').contentWindow.location.hash = ${J(hash)}, true)`);
    const keysTo = (t, id) => t.ev(`(document.querySelector('.dwin[data-id="${id}"] iframe').contentWindow.focus(), true)`);
    const shownOf = (t) => t.ev(`[...document.querySelectorAll('.dwin')].filter((w) => !w.classList.contains('hidden')).map((w) => w.dataset.id + '@' + w.style.left + ',' + w.style.top + (w.getAttribute('aria-current') === 'true' ? '*' : '')).sort().join(' ')`);
    const lay1 = (id, app, hash, x, y) => ({ id, app, hash, title: '', rect: { x, y, w: 640, h: 420 }, snap: null, min: false, z: 1 });

    // [two-tabs-both] both tabs in view: tab one opens a window, then tab two snaps its window by a key pressed inside
    // that window's page. Tab two takes tab one's change first, so its snap is kept and no window jumps afterwards.
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': { focus: 'wt', windows: [lay1('wt', 'sessions', '#/s/api-server', 300, 120)] } } });
    await waitFor(`!!(document.querySelector('.dwin[data-id="wt"] iframe') || {}).contentDocument?.querySelector('main')`, 10000);
    const two = await newTab(true);
    const bothShown = !(await ev('document.hidden')) && !(await two.ev('document.hidden'));
    await click(...center(await rectOf('.desk-icon[data-app="logs"]')));
    await waitFor(`!!document.querySelector('.dwin[data-app="logs"]')`);
    await sleep(600);
    // The keyboard inside the window's page (a session's terminal): the key goes through lib.js there, not this document.
    const inPage = await two.ev(`(() => { const f = document.querySelector('.dwin[data-id="wt"] iframe'); if (!f) return false; f.contentWindow.focus(); return true; })()`);
    await sleep(300);
    for (const type of ['rawKeyDown', 'keyUp']) await two.send('Input.dispatchKeyEvent', { type, code: 'ArrowLeft', key: 'ArrowLeft', modifiers: AS, windowsVirtualKeyCode: 37 });
    await sleep(700);
    const keptKey = await keptOf();
    const tb = await two.ev(`(() => { const r = document.querySelector('.dwin[data-id="wt"] .dwin-title').getBoundingClientRect(); return [Math.round(r.x + 30), Math.round(r.y + 10)]; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await two.send('Input.dispatchMouseEvent', { type, x: tb[0], y: tb[1], button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    await sleep(700);
    const snapLater = await two.ev(`document.querySelector('.dwin[data-id="wt"]').dataset.snap`);
    const appsTwo = await two.ev(`[...document.querySelectorAll('.dwin')].map((w) => w.dataset.app).sort().join(',')`);
    check(P, '[two-tabs-both] two tabs in view: a key from inside a window\'s page is kept, with the other tab\'s window, and nothing jumps', bothShown && inPage && /wt:l/.test(keptKey) && keptKey.split(',').length === 2 && snapLater === 'l' && appsTwo === 'logs,sessions',
      `both in view ${bothShown}; key in the page ${inPage}; kept ${keptKey}; after a press on its title bar: snap "${snapLater}", windows ${appsTwo}`);
    await two.close();

    // [two-tabs-moved-on] both tabs in view, tab two's keyboard already in its window's page: tab one opens a window,
    // then tab two's page moves on inside that window (a session opened from its list), with no press on the desktop.
    // Both changes are kept, while tab two is open and after it is closed.
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': { focus: 'wt', windows: [lay1('wt', 'sessions', '#/', 300, 120)] } } });
    await waitFor(`!!(document.querySelector('.dwin[data-id="wt"] iframe') || {}).contentDocument?.querySelector('main')`, 10000);
    const keptHash = () => ev(`(JSON.parse(localStorage.getItem(${J(KEY)})) || { windows: [] }).windows.map((w) => w.app + ':' + w.hash).sort().join(',')`);
    const mover = await newTab(true);
    await mover.ev(`(document.querySelector('.dwin[data-id="wt"] iframe').contentWindow.focus(), true)`);
    await sleep(400);
    await click(...center(await rectOf('.desk-icon[data-app="logs"]')));
    await waitFor(`!!document.querySelector('.dwin[data-app="logs"]')`);
    await sleep(600);
    await mover.ev(`(document.querySelector('.dwin[data-id="wt"] iframe').contentWindow.location.hash = '#/s/api-server', true)`);
    await sleep(2500);
    const keptOpen = await keptHash();
    const moverView = await mover.ev(`(() => { const f = document.querySelector('.dwin[aria-current="true"]'); const r = document.querySelector('.dwin[data-id="wt"] .dwin-body').getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); const on = e && e.closest('.dwin'); return (f && f.dataset.id) + '/' + (on && on.dataset.id); })()`);
    await tabShot(mover, 'two-tabs-moved-on');
    await mover.close();
    await sleep(800);
    const keptClosed = await keptHash();
    await open('#/desktop', { w: 1440, h: 900, wait: 2500 });
    const movedTitle = await ev(`(document.querySelector('.dwin[data-id="wt"] .dwin-title') || {}).textContent`);
    const movedApps = await ev(`[...document.querySelectorAll('.dwin')].map((w) => w.dataset.app).sort().join(',')`);
    const keptBoth = (k) => /(^|,)sessions:#\/s\/api-server(,|$)/.test(k) && /(^|,)logs:/.test(k);
    check(P, '[two-tabs-moved-on] two tabs in view: a page that moves on in a window of one tab is kept with the other tab\'s window, also after that tab is closed; that tab\'s window stays in front, uncovered', keptBoth(keptOpen) && keptBoth(keptClosed) && /api-server/.test(movedTitle) && movedApps === 'logs,sessions' && moverView === 'wt/wt',
      `kept while open ${keptOpen}; front/at the centre of its window in that tab ${moverView}; after it closed ${keptClosed}; next visit "${movedTitle}", windows ${movedApps}`);

    // [two-tabs-switch] a window closed, and at once another tab comes to the front (this one goes behind): the close
    // is kept, so the window does not come back on the next visit.
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': { focus: 'wb', windows: [lay1('wa', 'tasks', '#/desktop/tasks', 100, 100), { ...lay1('wb', 'logs', '#/desktop/logs', 300, 200), z: 2 }] } } });
    await waitFor(`document.querySelectorAll('.dwin').length === 2`);
    await sleep(800);
    await ev(`(document.querySelector('.dwin[data-id="wb"] .dwin-btn[data-act="x"]').click(), true)`);
    const front = await newTab(false);
    const wentBehind = await ev('document.hidden');
    await sleep(800);
    const keptSwitch = await keptOf();
    await front.close();
    await sleep(500);
    await open('#/desktop', { w: 1440, h: 900, wait: 2000 });
    const afterSwitch = await ev(`[...document.querySelectorAll('.dwin')].map((w) => w.dataset.id).sort().join(',')`);
    check(P, '[two-tabs-switch] a close right before another tab comes to the front is kept', wentBehind && afterSwitch === 'wa', `this tab behind ${wentBehind}; kept ${keptSwitch}; after a reload ${afterSwitch}`);

    // [two-tabs-both-move] both tabs in view move one window's page, tab two last: three seconds later tab two still
    // shows its own page, and that page is the one kept.
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': { focus: 'wt', windows: [lay1('wt', 'sessions', '#/', 300, 120)] } } });
    await waitFor(`!!(document.querySelector('.dwin[data-id="wt"] iframe') || {}).contentDocument?.querySelector('main')`, 10000);
    const bm = await newTab(true);
    await keysTo(bm, 'wt');
    await sleep(500);
    await goTo({ ev }, 'wt', '#/s/api-server');
    await sleep(2500);
    await goTo(bm, 'wt', '#/s/shop-frontend');
    await sleep(3000);
    const bmHash = await frameHash(bm, 'wt');
    const bmKept = await keptHash();
    await tabShot(bm, 'two-tabs-both-move');
    await bm.close();
    check(P, '[two-tabs-both-move] both tabs move one window\'s page, tab two last: tab two still shows its own page three seconds later, and it is kept', bmHash === '#/s/shop-frontend' && /sessions:#\/s\/shop-frontend/.test(bmKept), `tab two shows ${bmHash}; kept ${bmKept}`);

    // [two-tabs-drag] a drag in tab two that tab one's change (a window opened) falls into: the window stays where it
    // was let go, and that place is kept with tab one's window.
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': { focus: 'wa', windows: [lay1('wa', 'tasks', '#/desktop/tasks', 100, 100)] } } });
    await waitFor(`!!document.querySelector('.dwin[data-id="wa"]')`);
    const dg = await newTab(true);
    const tr = await dg.ev(`(() => { const r = document.querySelector('.dwin[data-id="wa"] .dwin-title').getBoundingClientRect(); return [Math.round(r.x + 40), Math.round(r.y + r.height / 2)]; })()`);
    const dm = (type, x, y, buttons = 1) => dg.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1 });
    await dm('mouseMoved', tr[0], tr[1], 0);
    await dm('mousePressed', tr[0], tr[1]);
    for (let i = 1; i <= 6; i++) (await dm('mouseMoved', tr[0] + i * 25, tr[1] + i * 15), await sleep(20));
    await click(...center(await rectOf('.desk-icon[data-app="logs"]')));
    await waitFor(`!!document.querySelector('.dwin[data-app="logs"]')`);
    await sleep(900);
    for (let i = 7; i <= 12; i++) (await dm('mouseMoved', tr[0] + i * 25, tr[1] + i * 15), await sleep(20));
    await dm('mouseReleased', tr[0] + 300, tr[1] + 180, 0);
    await sleep(900);
    const dgShown = await shownOf(dg);
    const dgKept = await ev(`(JSON.parse(localStorage.getItem(${J(KEY)})) || { windows: [] }).windows.map((w) => w.app + '@' + w.rect.x + ',' + w.rect.y).sort().join(' ')`);
    await tabShot(dg, 'two-tabs-drag');
    await dg.close();
    check(P, '[two-tabs-drag] a drag in tab two while tab one opens a window: it stays where it was let go, and is kept there with that window', /wa@400px,280px/.test(dgShown) && /tasks@400,280/.test(dgKept) && /logs@/.test(dgKept), `tab two shows ${dgShown}; kept ${dgKept}`);

    // [two-tabs-closed-in-use] tab one closes the window tab two's person types in; a key from inside it in tab two:
    // the window stays under them, does what the key says, and is kept again.
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': { focus: 'wt', windows: [{ ...lay1('wt', 'sessions', '#/s/api-server', 300, 120), z: 2 }, lay1('wa', 'tasks', '#/desktop/tasks', 60, 60)] } } });
    await waitFor(`!!(document.querySelector('.dwin[data-id="wt"] iframe') || {}).contentDocument?.querySelector('main')`, 10000);
    const cu = await newTab(true);
    await keysTo(cu, 'wt');
    await sleep(500);
    await ev(`(document.querySelector('.dwin[data-id="wt"] .dwin-btn[data-act="x"]').click(), true)`);
    await sleep(900);
    for (const type of ['rawKeyDown', 'keyUp']) await cu.send('Input.dispatchKeyEvent', { type, code: 'ArrowLeft', key: 'ArrowLeft', modifiers: AS, windowsVirtualKeyCode: 37 });
    await sleep(900);
    const cuShown = await shownOf(cu);
    const cuSnap = await cu.ev(`(document.querySelector('.dwin[data-id="wt"]') || {}).dataset?.snap || null`);
    const cuKept = await keptOf();
    await tabShot(cu, 'two-tabs-closed-in-use');
    await cu.close();
    check(P, '[two-tabs-closed-in-use] a window closed in tab one while tab two\'s person types in it: a key there keeps it, in front, snapped, and kept', /wt@[^ ]*\*/.test(cuShown) && cuSnap === 'l' && /wt:l/.test(cuKept), `tab two shows ${cuShown}; its snap ${cuSnap}; kept ${cuKept}`);

    // [two-tabs-unused] tab two in view, nobody uses it (its keyboard in no window): tab one opens a window, and a page
    // in tab two moves on by itself. Tab two does not change under the person looking at it; its next press takes tab
    // one's window, and both changes are kept.
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': { focus: 'wt', windows: [lay1('wt', 'sessions', '#/', 300, 120)] } } });
    await waitFor(`!!(document.querySelector('.dwin[data-id="wt"] iframe') || {}).contentDocument?.querySelector('main')`, 10000);
    const un = await newTab(true);
    await un.ev(`(document.activeElement && document.activeElement.blur && document.activeElement.blur(), true)`);
    await click(...center(await rectOf('.desk-icon[data-app="logs"]')));
    await waitFor(`!!document.querySelector('.dwin[data-app="logs"]')`);
    await sleep(700);
    await goTo(un, 'wt', '#/s/api-server');
    await sleep(2500);
    const unLooked = await shownOf(un);
    for (const type of ['mousePressed', 'mouseReleased']) await un.send('Input.dispatchMouseEvent', { type, x: 1300, y: 500, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    await sleep(1500);
    const unUsed = await un.ev(`[...document.querySelectorAll('.dwin')].map((w) => w.dataset.app).sort().join(',')`);
    const unPage = await frameHash(un, 'wt');
    await un.close();
    await sleep(800);
    const unKept = await keptHash();
    check(P, '[two-tabs-unused] a tab in view that nobody uses does not change when one of its pages moves on by itself; its next press takes the other tab\'s window, and both are kept', /^wt@[^ ]*\*$/.test(unLooked) && unUsed === 'logs,sessions' && unPage === '#/s/api-server' && /(^|,)logs:/.test(unKept) && /sessions:#\/s\/api-server/.test(unKept),
      `while only looked at ${unLooked}; after a press ${unUsed} at ${unPage}; kept ${unKept}`);
  }

  // ---------- touch: 1366 × 1024 with a finger ----------
  if (want('touch')) {
    const P = 'touch';
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const one = { focus: 'wtasks', windows: [lay('wtasks', 'tasks', '#/desktop/tasks', 300, 120, 640, 440, 1)] };
    for (const style of ['taskbar', 'dock']) {
      await open('#/desktop', { w: 1366, h: 1024, prefs: { 'desktop.~': one, 'desktop.style': style } });
      await waitFor(`!!document.querySelector('.dwin')`);
      await sleep(600);
      const small = await ev(`[...document.querySelectorAll('.dwin .dwin-grip, .dwin .dwin-btn')].map((e) => { const r = e.getBoundingClientRect(); return [e.dataset.dir || e.dataset.act, Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => w < 24 || h < 24)`);
      check(P, `[touch-size] ${style}: every grip and title-bar button is at least 24 × 24 px on a touch screen`, small.length === 0, J(small));
      // A 7 × 7 grid over each title-bar button: no point is a resize grip (a rounded button's corners fall through to
      // the strip of buttons around it, as its shape says; that is no grip).
      const covered = await ev(`[...document.querySelectorAll('.dwin .dwin-btn')].map((b) => { const r = b.getBoundingClientRect(); const miss = []; for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) { const e = document.elementFromPoint(r.left + 1 + ((r.width - 2) * i) / 6, r.top + 1 + ((r.height - 2) * j) / 6); if (e && e.closest('.dwin-grip')) miss.push('grip ' + e.closest('.dwin-grip').dataset.dir); } return [b.dataset.act, miss.length, [...new Set(miss)].join(' ')]; }).filter(([, m]) => m > 0)`);
      check(P, `[touch-buttons] ${style}: no point of a title-bar button is a resize grip`, covered.length === 0, J(covered));
      await photo(`touch-${style}`);
      const xb = await rectOf(`${W('wtasks')} .dwin-btn[data-act="x"]`);
      // Taskbar: its square button's top right corner; Dock: the top of its round button.
      const tap = style === 'dock' ? { x: xb.x + Math.round(xb.w / 2), y: xb.y + 3 } : { x: xb.x + xb.w - 3, y: xb.y + 3 };
      for (const [type, pts] of [['touchStart', [tap]], ['touchEnd', []]]) await chrome.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
      await sleep(500);
      check(P, `[touch-close-corner] ${style}: a tap 3 px inside the top of Close closes the window`, !(await ev(`!!document.querySelector(${J(W('wtasks'))})`)));
    }
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await open('#/desktop', { w: 1366, h: 1024, prefs: { 'desktop.~': one, 'desktop.style': 'taskbar' } });
    await waitFor(`!!document.querySelector('.dwin')`);
    await sleep(600);
    const touchDrag = async (x0, y0, x1, y1) => {
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
      for (let i = 1; i <= 10; i++) {
        await chrome.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(x0 + ((x1 - x0) * i) / 10), y: Math.round(y0 + ((y1 - y0) * i) / 10) }] });
        await sleep(20);
      }
      await chrome.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(300);
    };
    const t0 = await rect('wtasks');
    const tt = await titleOf('wtasks');
    await touchDrag(tt.x + 40, tt.y + 12, tt.x + 140, tt.y + 92);
    const t1 = await rect('wtasks');
    check(P, '[touch-move] a finger moves a window by its title bar', t1.x - t0.x === 100 && t1.y - t0.y === 80, `${t1.x - t0.x}, ${t1.y - t0.y}`);
    const sg = await rectOf(`${W('wtasks')} .dwin-grip[data-dir="se"]`);
    await touchDrag(...center(sg), center(sg)[0] + 60, center(sg)[1] + 40);
    const t2 = await rect('wtasks');
    check(P, '[touch-resize] a finger resizes a window from a corner', t2.w - t1.w === 60 && t2.h - t1.h === 40, `${t2.w - t1.w}, ${t2.h - t1.h}`);
    const eg = await rectOf(`${W('wtasks')} .dwin-grip[data-dir="e"]`);
    await touchDrag(...center(eg), center(eg)[0] - 50, center(eg)[1]);
    const t3 = await rect('wtasks');
    check(P, '[touch-resize-edge] and from an edge', t3.w - t2.w === -50 && t3.h === t2.h, `${t3.w - t2.w}`);
    await photo('touch-after');
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }

  // ---------- a coding session whose program ends while its window is minimised ----------
  if (want('ended')) {
    const P = 'ended';
    const one = { focus: 'wcode', windows: [lay('wcode', 'sessions', '#/s/api-server', 300, 120, 720, 460, 1)] };
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': one, 'desktop.style': 'taskbar' } });
    await waitFor(`!!document.querySelector('.desk-task[data-id="wcode"]')`);
    await sleep(2500); // the bar sees it running at least once
    await click(...center(await rectOf(`${W('wcode')} .dwin-btn[data-act="minus"]`)));
    await sleep(400);
    // The stand-in coding tool of that session, by its run record in the demo's own state folder (nothing real).
    const cwd = await ev(`window.__hoprigStore.all[0].sessions.find((s) => s.name === 'api-server').cwd`);
    const runs = path.join(hooks.info.root, 'state', 'runs');
    const pids = fs.readdirSync(runs).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(runs, f), 'utf8')); } catch { return null; } })
      .filter((r) => r && r.cwd === cwd && Number.isInteger(r.pid)).map((r) => r.pid);
    for (const pid of pids) process.kill(pid, 'SIGTERM');
    await waitFor(`(window.__hoprigStore.refresh(), (window.__hoprigStore.all[0].sessions.find((s) => s.name === 'api-server') || {}).kind === 'shell')`, 12000);
    await ev(`window.__hoprigStore.refresh()`);
    await sleep(2500);
    const card = await ev(`(() => { const s = window.__hoprigStore.all[0].sessions.find((x) => x.name === 'api-server'); return s ? s.kind : 'gone'; })()`);
    const b = await ev(`(() => { const b = document.querySelector('.desk-task[data-id="wcode"]'); return b && { label: b.getAttribute('aria-label'), ended: b.dataset.ended === '1', tag: !!b.querySelector('.desk-task-ended') }; })()`);
    await photo('ended-coding-on-bar');
    check(P, '[ended-coding] a coding session whose program ended while minimised says so on its bar button', pids.length > 0 && b && b.ended && b.tag && /session ended/.test(b.label), `stand-ins ${pids.length}; card ${card}; ${J(b)}`);
    // Brought back, the window shows its terminal, which is a shell now (the program's last lines above the prompt).
    await ev(`(document.querySelector('.desk-task[data-id="wcode"]').click(), true)`);
    await sleep(1200);
    const inWin = await ev(`(() => { const d = document.querySelector('${W('wcode')} iframe').contentDocument; return { rows: !!d.querySelector('.xterm-rows'), ended: /This session has ended/.test(d.body.textContent) }; })()`);
    await photo('ended-coding-in-window');
    check(P, '[ended-coding-window] brought back, its window shows the terminal that is left, a shell', inWin.rows, J(inWin));
    // [ended-coding-seen] in front, and the shell left in it is used: the bar's notice is gone (a running shell).
    const [ex, ey] = center(await rectOf(`${W('wcode')} .dwin-body`));
    await click(ex, ey);
    await sleep(300);
    await chrome.send('Input.insertText', { text: 'echo alive$((40+2))' });
    await key('Enter', 'Enter', 0, 13);
    const ran = await waitFor(`/alive42/.test((${doc('wcode')}.querySelector('.xterm-rows') || {}).textContent || '')`, 6000);
    await ev('window.__hoprigStore.refresh()');
    await sleep(2500);
    const seenB = await ev(`(() => { const b = document.querySelector('.desk-task[data-id="wcode"]'); return b && { label: b.getAttribute('aria-label'), ended: b.dataset.ended === '1', tag: !!b.querySelector('.desk-task-ended') }; })()`);
    await photo('ended-coding-seen');
    check(P, '[ended-coding-seen] once its window is in front and its shell is used, its bar button no longer says the session ended', ran && seenB && !seenB.ended && !seenB.tag && !/ended/.test(seenB.label), `ran ${ran}; ${J(seenB)}`);
  }

  // ---------- the keyboard only: minimise by Enter and Space, the window menu by its key, a way out of a terminal ----------
  if (want('keyboard')) {
    const P = 'keyboard';
    const press = async (code, keyName, vk, text = '', mods = 0) => {
      await chrome.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', code, key: keyName, text, unmodifiedText: text, modifiers: mods, windowsVirtualKeyCode: vk });
      await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName, modifiers: mods, windowsVirtualKeyCode: vk });
      await sleep(400);
    };
    const active = () => ev(`(() => { const a = document.activeElement; return a ? (a.matches('.desk-task') ? 'bar:' + a.dataset.id : a.matches('.dwin-btn') ? 'btn:' + a.closest('.dwin').dataset.id + ':' + a.dataset.act : a.tagName) : null; })()`);
    const lay3 = { focus: 'wc', windows: [lay('wa', 'logs', '#/desktop/logs', 80, 40, 620, 420, 1), lay('wb', 'services', '#/desktop/services', 300, 120, 620, 420, 2), lay('wc', 'tasks', '#/desktop/tasks', 520, 200, 620, 420, 3)] };
    for (const style of ['taskbar', 'dock']) {
      await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': lay3, 'desktop.style': style, 'desktop.keys': null } });
      await waitFor(`document.querySelectorAll('.dwin').length === 3`);
      await sleep(800);
      // [focus-after-min-enter] Enter on the front window's Minimise button: the keyboard is on its bar button.
      await ev(`(document.querySelector('${W('wc')} .dwin-btn[data-act="minus"]').focus(), true)`);
      await press('Enter', 'Enter', 13, '\r');
      const afterEnter = await active();
      const barOf = (id) => (style === 'dock' ? null : `bar:${id}`);
      const onDock = (app) => ev(`!!document.activeElement && document.activeElement.matches('.desk-dock-item[data-app="${app}"]')`);
      check(P, `[focus-after-min-enter] ${style}: Enter on Minimise: the window goes to the bar and the keyboard is on its button`, (await state('wc')).min && (style === 'dock' ? await onDock('tasks') : afterEnter === barOf('wc')), afterEnter);
      if (style === 'taskbar') {
        // [focus-after-min-space] Space on the front window's bar button minimises it; the keyboard stays on that button.
        await ev(`(document.querySelector('.desk-task[data-id="wb"]').focus(), true)`);
        const frontBefore = await frontId();
        await press('Space', ' ', 32, ' ');
        const afterSpace = await active();
        check(P, '[focus-after-min-space] Space on the front window\'s bar button minimises it; the keyboard stays on that button', frontBefore === 'wb' && (await state('wb')).min && afterSpace === 'bar:wb', `${frontBefore}, ${afterSpace}`);
        // [aria-bar-front] the front window's button says "in front" once (pressed), not in its name as well
        await ev(`(document.querySelector('.desk-task[data-id="wc"]').click(), true)`);
        await sleep(300);
        const fb = await ev(`(() => { const b = document.querySelector('.desk-task[data-id="wc"]'); return { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed') }; })()`);
        check(P, '[aria-bar-front] the front window\'s bar button is pressed, and its name does not say "in front" again', fb.pressed === 'true' && !/in front/.test(fb.label), J(fb));
      }
    }
    // [focus-after-theme] Enter on the tray's colours button: the bars are drawn again, the keyboard stays on that button
    for (const style of ['taskbar', 'dock']) {
      await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': lay3, 'desktop.style': style, 'desktop.keys': null, 'page.theme': 'light' } });
      await waitFor(`document.querySelectorAll('.dwin').length === 3`);
      await sleep(600);
      const named = () => ev(`(() => { const a = document.activeElement; return a ? a.getAttribute('aria-label') || a.tagName : null; })()`);
      await ev(`(document.querySelector('.desk-tray-btn[aria-label="Dark colours"]').focus(), true)`);
      await press('Enter', 'Enter', 13, '\r');
      const once = await named();
      const darkNow = await ev(`document.documentElement.dataset.theme`);
      await press('Enter', 'Enter', 13, '\r');
      const twice = await named();
      check(P, `[focus-after-theme] ${style}: Enter on the colours button changes them and the keyboard stays on that button`, once === 'Light colours' && darkNow === 'dark' && twice === 'Dark colours', `after one Enter ${once} (${darkNow}), after two ${twice}`);
    }
    // [focus-after-appmenu] Dock: the keyboard on the top bar's window-menu button stays there when the front window's
    // title changes and the bars are drawn again.
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': { focus: 'ws', windows: [lay('ws', 'sessions', '#/', 300, 120, 720, 460, 1)] }, 'desktop.style': 'dock', 'desktop.keys': null } });
    await waitFor(`!!(document.querySelector('.dwin[data-id="ws"] iframe') || {}).contentDocument?.querySelector('main')`, 10000);
    await sleep(800);
    await ev(`(document.querySelector('.desk-appmenu').focus(), true)`);
    const amBefore = await ev(`(document.querySelector('.desk-appmenu') || {}).title || null`);
    await ev(`(document.querySelector('.dwin[data-id="ws"] iframe').contentWindow.location.hash = '#/s/api-server', true)`);
    await sleep(2200);
    const amAfter = await ev(`(() => { const a = document.activeElement; return a && a.matches('.desk-appmenu') ? a.title : a ? a.tagName : null; })()`);
    check(P, '[focus-after-appmenu] Dock: the keyboard on the window-menu button stays there when the front window\'s title changes', amAfter && amAfter !== amBefore && /api-server/.test(amAfter), `before "${amBefore}", after "${amAfter}"`);
    // [menu-key] the context-menu key (Shift+F10) on a title bar's button opens the window menu with every act
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': lay3, 'desktop.style': 'taskbar', 'desktop.keys': 'off' } });
    await waitFor(`document.querySelectorAll('.dwin').length === 3`);
    await sleep(800);
    await ev(`(document.querySelector('${W('wc')} .dwin-btn[data-act="minus"]').focus(), true)`);
    await press('F10', 'F10', 121, '', SHIFT);
    let how = 'Shift+F10';
    if (!(await ev(`!!document.querySelector('.desk-menu')`))) {
      await press('ContextMenu', 'ContextMenu', 93);
      how = 'the context-menu key';
    }
    if (!(await ev(`!!document.querySelector('.desk-menu')`))) {
      // What the browser sends for either key, where this headless one sends nothing: a contextmenu at 0, 0.
      await ev(`(document.activeElement.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 })), true)`);
      await sleep(300);
      how = 'its contextmenu event';
    }
    const km = await ev(`(document.querySelector('.desk-menu') || {}).innerText || ''`);
    const kmFocus = await ev(`!!document.activeElement && document.activeElement.matches('.desk-menu-item')`);
    await photo('menu-by-key');
    await key('Escape', 'Escape', 0, 27);
    check(P, '[menu-key] with the keys off, the context-menu key on a title bar\'s button opens the window menu with every act, the keyboard in it', /Top left quarter/.test(km) && /Next window/.test(km) && /Reload/.test(km) && kmFocus, `${how}: ${km.replace(/\n/g, ' | ')}`);
    // [menu-aria] a menu item's key is given to a screen reader as a shortcut, said once
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': lay3, 'desktop.style': 'taskbar', 'desktop.keys': null } });
    await waitFor(`document.querySelectorAll('.dwin').length === 3`);
    await sleep(600);
    const tt = await titleOf('wc');
    await click(tt.x + 80, tt.y + 12, { button: 'right', buttons: 2 });
    await waitFor(`!!document.querySelector('.desk-menu')`);
    const it = await ev(`(() => { const b = [...document.querySelectorAll('.desk-menu-item')].find((x) => x.textContent.includes('left half')); const k = b && b.querySelector('kbd'); return b && { keys: b.getAttribute('aria-keyshortcuts'), hidden: k && k.getAttribute('aria-hidden'), arrow: !!(k && k.querySelector('.desk-key-arrow')) }; })()`);
    await photo('menu-keys-arrows');
    await key('Escape', 'Escape', 0, 27);
    check(P, '[menu-aria] "Snap to the left half" has aria-keyshortcuts Alt+Shift+ArrowLeft; the drawn key is hidden from a screen reader', it && it.keys === 'Alt+Shift+ArrowLeft' && it.hidden === 'true', J(it));
    check(P, '[menu-arrows] the arrow in a menu\'s key is drawn on its own (larger, in the body font)', it && it.arrow, J(it));
    // [terminal-way-out] with the keys off, F6 in a terminal takes the keyboard to its window's title bar
    const sh = (await post('/api/shells', {})).name;
    const tlay = { focus: 'wsh', windows: [lay('wsh', 'terminal', `#/s/${encodeURIComponent(sh)}`, 200, 80, 720, 440, 1, { home: `#/s/${encodeURIComponent(sh)}`, own: true })] };
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': tlay, 'desktop.keys': 'off' } });
    await waitFor(`!!${doc('wsh')}.querySelector('.xterm-helper-textarea')`, 12000);
    await sleep(800);
    await click(...center(await rectOf(`${W('wsh')} .dwin-body`)));
    await sleep(400);
    const inTerm = await ev(`(() => { const f = document.activeElement; return f && f.tagName === 'IFRAME' && f.contentDocument.activeElement && f.contentDocument.activeElement.className; })()`);
    for (let i = 0; i < 3; i++) await press('Tab', 'Tab', 9, '\t');
    const stillIn = await ev(`document.activeElement && document.activeElement.tagName`);
    await press('F6', 'F6', 117);
    const out = await active();
    await post(`/api/sessions/${encodeURIComponent(sh)}/kill`, {});
    check(P, '[terminal-way-out] with the keys off, F6 in a terminal takes the keyboard to its title bar (Tab stays in the terminal)', /xterm-helper-textarea/.test(String(inTerm)) && stillIn === 'IFRAME' && /^btn:wsh:/.test(String(out)), `${inTerm}; after Tab ×3 ${stillIn}; after F6 ${out}`);
  }

  // ---------- Settings → Appearance: the keys ----------
  if (want('settings')) {
    const P = 'settings';
    await open('#/settings/appearance?show=desktop', { w: 1440, h: 900, prefs: { 'desktop.keys': null } });
    await waitFor(`document.body.textContent.includes('Desktop style')`);
    await sleep(500);
    const txt = await ev(`document.querySelector('#desktop, [data-panel="desktop"]') ? (document.querySelector('#desktop, [data-panel="desktop"]').innerText) : document.body.innerText`);
    check(P, '[settings-keys] Settings → Appearance lists the desktop\'s keys with one choice: Alt+Shift, Ctrl+Alt, Off', /Alt\+Shift/.test(txt) && /Ctrl\+Alt/.test(txt) && /Off/.test(txt) && /Alt\+Tab belongs to your computer/.test(txt), txt.replace(/\n/g, ' | ').slice(0, 400));
    await photo('settings-appearance');
    // [settings-keys-mac] on a Mac (its user agent and platform) the choice is written as its keyboard names the keys
    const ua = await ev('navigator.userAgent');
    await chrome.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', platform: 'MacIntel' });
    await open('#/settings/appearance?show=desktop', { w: 1440, h: 900, prefs: { 'desktop.keys': null } });
    await waitFor(`!!document.querySelector('[aria-label="Desktop keys"] .seg')`, 10000);
    const macSeg = await ev(`[...document.querySelectorAll('[aria-label="Desktop keys"] .seg')].map((b) => b.textContent)`);
    const macLines = await ev(`(document.querySelector('.desk-keys-text') || {}).innerText || ''`);
    await ev(`(document.querySelector('[aria-label="Desktop keys"]').scrollIntoView({ block: 'center' }), true)`);
    await sleep(300);
    await photo('settings-mac');
    await chrome.send('Emulation.setUserAgentOverride', { userAgent: ua, platform: '' });
    check(P, '[settings-keys-mac] on a Mac the choice reads Option+Shift, Ctrl+Option, Off, as the list under it does', J(macSeg) === J(['Option+Shift', 'Ctrl+Option', 'Off']), J(macSeg));
    check(P, '[settings-way-out-mac] on a Mac the way out of a window is written Fn+F6', /Fn\+F6 takes the keyboard/.test(macLines), macLines.replace(/\n/g, ' | '));
  }

  // ---------- the looks: 1000 px, 390 px touch, dark ----------
  if (want('looks')) {
    const P = 'looks';
    await open('#/desktop', { w: 1000, h: 800 });
    check(P, '[grid-1000] at 1000 px the apps are a grid of pages', await ev(`document.querySelectorAll('.desk-tile').length === 7 && !document.querySelector('.desk')`));
    await photo('1000-grid');
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await open('#/desktop', { w: 390, h: 844, mobile: true });
    check(P, '[grid-390] at 390 px touch the grid, no sideways scroll', await ev(`document.querySelectorAll('.desk-tile').length === 7 && document.documentElement.scrollWidth <= 390`));
    await photo('390-touch-light');
    await open('#/desktop', { w: 390, h: 844, mobile: true, theme: 'dark', prefs: { 'page.theme': 'dark' } });
    await photo('390-touch-dark');
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    for (const style of ['taskbar', 'dock']) {
      await open('#/desktop', { w: 1440, h: 900, theme: 'dark', prefs: { 'page.theme': 'dark', 'desktop.style': style, 'desktop.~': layout } });
      await waitFor(`document.querySelectorAll('.dwin').length >= 5`, 8000);
      await sleep(2500);
      check(P, `[dark-${style}] dark colours, ${style}`, await ev(`document.documentElement.dataset.theme === 'dark'`));
      await photo(`dark-${style}`);
    }
    const t = await titleOf('wtasks');
    await hold(t.x + 40, t.y + 12, a.x + 1, a.y + 30);
    await photo('dark-snap-preview');
    await mouse('mouseReleased', a.x + 1, a.y + 30);
    await sleep(300);
    await click(t.x + 80, t.y + 12, { button: 'right', buttons: 2 });
    await sleep(400);
    await photo('dark-window-menu');
    await key('Escape', 'Escape', 0, 27);
  }

  await finish();
} catch (e) {
  check('run', 'the run finished', false, e.stack || e.message);
} finally {
  await done();
}
