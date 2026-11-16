#!/usr/bin/env node
// Dev-only (not in the published package): the desktop (web/desktop/) proven in a real browser, on `hoprig demo`
// (sample data in a temp folder, nothing real) and the local Chrome headless (tools/chrome.mjs).
//
//   TMPDIR=/tmp node tools/desktop-check.mjs [--port 7680] [--out <folder for screenshots>] [--only taskbar,dock,…]
//
// Parts, in this order (the first is the one that matters most): taskbar (1440 × 900, light: three apps, move,
// resize, snap to a half and a quarter, minimise and restore, maximise, close, the keys, the menu, a reload that
// brings the layout back, one session poll for the whole desktop, a terminal that is typed into), dock (dark),
// small (1024 × 600 windows; 390 × 844 the grid of pages with the bottom bar), touch (a long press opens the
// menu), computer (the same desktop for the demo's second computer), framing (a page of another origin cannot
// frame the dashboard). Chrome is started before the demo narrows PATH; Chrome needs a short TMPDIR.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { launchChrome } from './chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(opt('--port', '7680'));
const OUT = path.resolve(opt('--out', path.join(os.tmpdir(), 'hoprig-desktop-check')));
const ONLY = opt('--only', '') ? new Set(opt('--only', '').split(',')) : null;
const want = (p) => !ONLY || ONLY.has(p);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let failed = 0;
function check(part, what, ok, detail = '') {
  results.push({ part, what, ok: !!ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${part}] ${what}${detail ? ` (${detail})` : ''}`);
}

const chrome = await launchChrome({ port: PORT + 1 });
const { main } = await import(path.join(ROOT, 'src/demo/index.mjs'));
const hooks = { onReady: (i) => (hooks.info = i) };
if ((await main(['--no-open', '--quiet', '--port', String(PORT)], hooks)) !== null) throw new Error('the demo did not start');
await hooks.background;
const { url } = hooks.info;
let other = null;
const stopAll = async () => {
  await chrome.close().catch(() => {});
  if (other) other.close();
  await hooks.stop();
};
setTimeout(async () => {
  console.error('desktop-check: still running after 8 minutes; stopping');
  await stopAll();
  process.exit(1);
}, 8 * 60_000).unref();

const ev = (expr) => chrome.evaluate(expr);
const J = JSON.stringify;
async function shot(name) {
  fs.writeFileSync(path.join(OUT, `${name}.png`), await chrome.shot());
}
async function waitFor(expr, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}
async function mouse(type, x, y, { buttons = type === 'mouseReleased' ? 0 : 1, clickCount = 1, button = 'left' } = {}) {
  await chrome.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : button, buttons, clickCount });
}
async function click(x, y, opts = {}) {
  await mouse('mouseMoved', x, y, { buttons: 0 });
  await mouse('mousePressed', x, y, opts);
  await mouse('mouseReleased', x, y, opts);
}
async function dblclick(x, y) {
  await click(x, y, { clickCount: 1 });
  await click(x, y, { clickCount: 2 });
}
async function drag(x0, y0, x1, y1, steps = 14) {
  await mouse('mouseMoved', x0, y0, { buttons: 0 });
  await mouse('mousePressed', x0, y0);
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps));
    await sleep(16);
  }
  await sleep(40);
  await mouse('mouseReleased', x1, y1);
  await sleep(120);
}
async function key(code, keyName, mods = 0, vk = 0) {
  await chrome.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key: keyName, modifiers: mods, windowsVirtualKeyCode: vk });
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName, modifiers: mods, windowsVirtualKeyCode: vk });
}
const rectOf = (sel) => ev(`(() => { const e = document.querySelector(${J(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
const center = (r) => [r.x + Math.round(r.w / 2), r.y + Math.round(r.h / 2)];
const winSel = (app) => `.dwin[data-app=${J(app)}]`;
const area = () => rectOf('.desk-area');
const windows = () => ev(`[...document.querySelectorAll('.dwin')].map((w) => ({ app: w.dataset.app, snap: w.dataset.snap, hidden: w.classList.contains('hidden'), front: w.getAttribute('aria-current') === 'true', title: w.querySelector('.dwin-title').textContent }))`);
// '' when the window's page is in bare mode with nothing of the full page's frame; else what is wrong.
const frameOk = (app) => ev(`(() => { const f = document.querySelector(${J(`.dwin[data-app="${app}"] iframe`)}); const d = f && f.contentDocument; if (!d || !d.body) return 'no page'; const extra = [...d.querySelectorAll('.sidebar, .bottombar, .fab, .tia-boxroot:not(.hidden)')].map((e) => e.className); if (extra.length) return 'has ' + extra.join(', '); if (!f.contentWindow.location.search.includes('bare=1')) return 'not bare'; return ''; })()`);
/** Bring a window to the front from its taskbar button (a click on a window behind may land on another one). */
const toFront = (app) => ev(`(() => { const w = document.querySelector('.dwin[data-app="${app}"]'); if (w.getAttribute('aria-current') !== 'true' || w.classList.contains('hidden')) document.querySelector('.desk-task[data-id="' + w.dataset.id + '"]').click(); return true; })()`).then(() => sleep(150));
/** What the document in a frame target (Chrome's own list) shows: { url, ok: the dashboard's page is in it }. */
async function frameTarget(re) {
  const list = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json();
  const t = list.find((x) => x.type === 'iframe' && re.test(x.url));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const answer = new Promise((r) => ws.on('message', (m) => { const j = JSON.parse(m); if (j.id === 1) r(j); }));
  ws.send(J({ id: 1, method: 'Runtime.evaluate', params: { expression: `({ url: location.href, ok: !!document.getElementById('app') })`, returnByValue: true } }));
  const j = await Promise.race([answer, sleep(5000).then(() => null)]);
  ws.close();
  return j && j.result && j.result.result ? j.result.result.value : { error: 'no answer' };
}
let loads = 0;
async function open(hash, { w, h, theme = 'light', mobile = false, prefs = null, wait = 1800 } = {}) {
  await chrome.viewport(w, h, { mobile, theme });
  if (prefs) {
    await chrome.goto(`${url}/?load=${++loads}#/more`, 600);
    await ev(`(() => { ${Object.entries(prefs).map(([k, v]) => (v === null ? `localStorage.removeItem(${J(`pref:${k}`)});` : `localStorage.setItem(${J(`pref:${k}`)}, ${J(J(v))});`)).join(' ')} return true; })()`);
  }
  await chrome.goto(`${url}/?load=${++loads}${hash}`, wait);
}

try {
  await chrome.viewport(1440, 900, { theme: 'light' });
  await chrome.goto(hooks.info.link, 2500); // the one-time sign-in link; the cookie stays for the whole run

  // ---------- 1. Taskbar, light, 1440 × 900: the case that matters most ----------
  if (want('taskbar')) {
    const P = 'taskbar';
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': null, 'desktop.style': null, 'page.theme': 'light' } });
    check(P, 'the desktop fills the window, Taskbar style, no sidebar', await ev(`!!document.querySelector('.desk[data-desk-style="taskbar"] .desk-taskbar') && !document.querySelector('.sidebar')`));
    // Sessions from its desktop icon (double click), Workspace from the start menu, Terminal by search + Enter.
    const icon = await rectOf('.desk-icon[data-app="sessions"]');
    await dblclick(...center(icon));
    check(P, 'a double click on a desktop icon opens Sessions', await waitFor(`!!document.querySelector('.dwin[data-app="sessions"]')`));
    await click(...center(await rectOf('.desk-start')));
    check(P, 'the start menu opens with the search field focused', await waitFor(`document.activeElement && document.activeElement.classList.contains('desk-search')`));
    const ws = await ev(`(() => { const b = [...document.querySelectorAll('.desk-app')].find((x) => x.textContent.includes('Workspace')); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await click(...ws);
    check(P, 'Workspace opens from the start menu, which closes', await waitFor(`!!document.querySelector('.dwin[data-app="workspace"]') && !document.querySelector('.desk-pop')`));
    await click(...center(await rectOf('.desk-start')));
    await waitFor(`document.activeElement && document.activeElement.classList.contains('desk-search')`);
    await chrome.send('Input.insertText', { text: 'term' });
    await key('Enter', 'Enter', 0, 13);
    check(P, 'Terminal opens by searching "term" and Enter: a new shell in a window', await waitFor(`!!document.querySelector('.dwin[data-app="terminal"]')`, 10000));
    await waitFor(`[...document.querySelectorAll('.dwin iframe')].every((f) => f.contentDocument && f.contentDocument.querySelector('main, .term-wrap, .xterm'))`, 10000);
    await sleep(1200);
    for (const a of ['sessions', 'workspace', 'terminal']) {
      const why = await frameOk(a);
      check(P, `the ${a} window shows its page in bare mode (no navigation, no floating buttons)`, why === '', why);
    }
    check(P, 'three windows, the newest in front, three buttons in the taskbar', await ev(`document.querySelectorAll('.dwin').length === 3 && document.querySelector('.dwin[aria-current="true"]').dataset.app === 'terminal' && document.querySelectorAll('.desk-task').length === 3`));
    await shot('1-taskbar-three-windows');

    // Move: the Workspace window by its title bar.
    await click(...center(await rectOf(`${winSel('workspace')} .dwin-title`)));
    let r0 = await rectOf(winSel('workspace'));
    let bar = await rectOf(`${winSel('workspace')} .dwin-title`);
    await drag(bar.x + 30, bar.y + 10, bar.x + 30 + 140, bar.y + 10 + 70);
    let r1 = await rectOf(winSel('workspace'));
    check(P, 'a window moves with its title bar', r1.x - r0.x === 140 && r1.y - r0.y === 70, `${r1.x - r0.x}, ${r1.y - r0.y}`);
    // Resize from the bottom right corner.
    const se = await rectOf(`${winSel('workspace')} .dwin-grip[data-dir="se"]`);
    await drag(se.x + 6, se.y + 6, se.x + 6 + 90, se.y + 6 + 50);
    const r2 = await rectOf(winSel('workspace'));
    check(P, 'a window resizes from its corner', r2.w - r1.w === 90 && r2.h - r1.h === 50, `${r2.w - r1.w}, ${r2.h - r1.h}`);
    // Resize from the left edge: the right edge stays.
    const wgrip = await rectOf(`${winSel('workspace')} .dwin-grip[data-dir="w"]`);
    await drag(wgrip.x + 3, wgrip.y + 40, wgrip.x + 3 - 60, wgrip.y + 40);
    const r3 = await rectOf(winSel('workspace'));
    check(P, 'a window resizes from its left edge, its right edge stays', r3.x === r2.x - 60 && r3.x + r3.w === r2.x + r2.w, `${r3.x}, ${r3.w}`);
    // Snap to the left half by dragging to the left edge.
    const a = await area();
    bar = await rectOf(`${winSel('workspace')} .dwin-title`);
    await drag(bar.x + 20, bar.y + 10, a.x + 1, a.y + 300);
    let ww = await rectOf(winSel('workspace'));
    check(P, 'dragged to the left edge it takes the left half', ww.x === a.x && ww.y === a.y && Math.abs(ww.w - a.w / 2) <= 1 && ww.h === a.h, J(ww));
    // A quarter: Sessions to the top right corner.
    await toFront('sessions');
    bar = await rectOf(`${winSel('sessions')} .dwin-title`);
    await drag(bar.x + 20, bar.y + 10, a.x + a.w - 1, a.y + 10);
    const sq = await rectOf(winSel('sessions'));
    check(P, 'dragged to the top right corner it takes that quarter', Math.abs(sq.x - (a.x + a.w / 2)) <= 1 && sq.y === a.y && Math.abs(sq.h - a.h / 2) <= 1, J(sq));
    // Taken out of a snap place it gets its own size back.
    bar = await rectOf(`${winSel('workspace')} .dwin-title`);
    await drag(bar.x + 100, bar.y + 10, bar.x + 400, bar.y + 120);
    ww = await rectOf(winSel('workspace'));
    check(P, 'dragged out of the half it has its own size again', ww.w === r3.w && ww.h === r3.h, `${ww.w}×${ww.h}`);
    // The keys: Alt+Shift+→ snaps the window in front to the right half (the keyboard is in its page).
    await click(...center(await rectOf(`${winSel('workspace')} .dwin-body`)));
    await key('ArrowRight', 'ArrowRight', 1 | 8, 39);
    await sleep(300);
    check(P, 'Alt+Shift+Right snaps the window in front to the right half', (await windows()).find((w) => w.app === 'workspace').snap === 'r');
    // Maximise with a double click on the title bar, restore the same way.
    bar = await rectOf(`${winSel('terminal')} .dwin-title`);
    await dblclick(bar.x + 30, bar.y + 10);
    await sleep(200);
    const tm = await rectOf(winSel('terminal'));
    check(P, 'a double click on the title bar maximises', tm.x === a.x && tm.y === a.y && tm.w === a.w && tm.h === a.h, J(tm));
    bar = await rectOf(`${winSel('terminal')} .dwin-title`);
    await dblclick(bar.x + 30, bar.y + 10);
    await sleep(200);
    check(P, 'and again restores', (await windows()).find((w) => w.app === 'terminal').snap === '');
    // Minimise from its button, restore from the taskbar.
    await toFront('sessions');
    await click(...center(await rectOf(`${winSel('sessions')} .dwin-btn[data-act="minus"]`)));
    await sleep(200);
    check(P, 'minimise hides the window and dims its taskbar button', await ev(`document.querySelector('.dwin[data-app="sessions"]').classList.contains('hidden') && [...document.querySelectorAll('.desk-task')].some((b) => b.dataset.min === '1')`));
    await click(...center(await rectOf('.desk-task[data-min="1"]')));
    await sleep(200);
    check(P, 'its taskbar button brings it back, in front', (await windows()).find((w) => w.app === 'sessions' && !w.hidden && w.front));
    // The right-click menu on the desktop.
    await ev(`(() => { for (const w of document.querySelectorAll('.dwin')) w.classList.add('hidden'); return true; })()`);
    await click(a.x + a.w - 200, a.y + a.h - 100, { button: 'right', buttons: 2 });
    check(P, 'a right click on the desktop opens its menu', await waitFor(`!!document.querySelector('.desk-menu') && document.querySelector('.desk-menu').textContent.includes('New terminal')`));
    await shot('1-taskbar-menu');
    await key('Escape', 'Escape', 0, 27);
    check(P, 'Escape closes the menu', await waitFor(`!document.querySelector('.desk-menu')`));
    await ev(`(() => { for (const w of document.querySelectorAll('.dwin')) if (w.dataset.app !== 'sessions' || !w.classList.contains('hidden')) w.classList.remove('hidden'); return true; })()`);
    // Typing in the terminal: the window comes to the front with the first press, the next one goes to the terminal.
    await toFront('terminal');
    const tb = await rectOf(`${winSel('terminal')} .dwin-body`);
    await click(...center(tb));
    await sleep(300);
    await chrome.send('Input.insertText', { text: 'echo desk-ok-$((6*7))' });
    await key('Enter', 'Enter', 0, 13);
    const typed = await waitFor(`(() => { const d = document.querySelector('.dwin[data-app="terminal"] iframe').contentDocument; return /desk-ok-42/.test((d.querySelector('.xterm-rows') || d.body).textContent); })()`, 8000);
    check(P, 'a terminal window can be typed into (the shell answered)', typed, typed ? '' : await ev(`(() => { const d = document.querySelector('.dwin[data-app="terminal"] iframe').contentDocument; return (d.activeElement && d.activeElement.className) + ' | ' + document.activeElement.tagName + ' | ' + (d.querySelector('.xterm-rows') || d.body).textContent.slice(-300); })()`));
    await shot('1-taskbar-terminal');
    // One session poll for the whole desktop: the windows read the desktop's store.
    const polls = await ev(`(async () => {
      const count = () => [window, ...[...document.querySelectorAll('.dwin iframe')].map((f) => f.contentWindow)].map((w) => w.performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/machines/sessions')).length);
      const before = count();
      await new Promise((r) => setTimeout(r, 9000));
      const after = count();
      return after.map((n, i) => n - before[i]);
    })()`);
    check(P, 'one session poll for the whole desktop (the windows ask nothing themselves)', polls[0] >= 2 && polls[0] <= 4 && polls.slice(1).every((n) => n === 0), J(polls));
    // Close one; reload: the layout comes back.
    await toFront('sessions');
    await click(...center(await rectOf(`${winSel('sessions')} .dwin-btn[data-act="x"]`)));
    await sleep(500);
    const before = await ev(`[...document.querySelectorAll('.dwin')].map((w) => [w.dataset.app, w.dataset.snap, w.style.left, w.style.top, w.style.width, w.style.height].join(' ')).sort()`);
    check(P, 'close removes the window and its taskbar button', before.length === 2 && (await ev(`document.querySelectorAll('.desk-task').length`)) === 2);
    await open('#/desktop', { w: 1440, h: 900, wait: 2500 });
    const after = await ev(`[...document.querySelectorAll('.dwin')].map((w) => [w.dataset.app, w.dataset.snap, w.style.left, w.style.top, w.style.width, w.style.height].join(' ')).sort()`);
    check(P, 'after a reload the same windows are back in the same places', J(before) === J(after), J(after));
    check(P, 'the terminal window is attached to its shell again', await waitFor(`(() => { const d = document.querySelector('.dwin[data-app="terminal"] iframe').contentDocument; return /desk-ok-42/.test((d.querySelector('.xterm-rows') || d.body).textContent); })()`, 8000));
    await shot('1-taskbar-after-reload');
  }

  // ---------- 2. Dock, dark ----------
  if (want('dock')) {
    const P = 'dock';
    await open('#/desktop', { w: 1440, h: 900, theme: 'dark', prefs: { 'desktop.style': 'dock', 'page.theme': 'dark' } });
    check(P, 'Dock style: a bar at the top and a dock at the bottom', await ev(`!!document.querySelector('.desk[data-desk-style="dock"] .desk-topbar') && !!document.querySelector('.desk-dock') && !document.querySelector('.desk-taskbar')`));
    check(P, 'dark colours', await ev(`document.documentElement.dataset.theme === 'dark'`));
    await click(...center(await rectOf('.desk-dock-item[data-app="providers"]')));
    check(P, 'a dock item opens its app; a dot shows it is open', await waitFor(`!!document.querySelector('.dwin[data-app="providers"]') && document.querySelector('.desk-dock-item[data-app="providers"]').dataset.open === '1'`));
    check(P, 'the top bar names the app in front', await waitFor(`document.querySelector('.desk-appmenu') && document.querySelector('.desk-appmenu').textContent.includes('Providers')`));
    await sleep(1500);
    check(P, 'the window in Dock style has its buttons on the left', await ev(`(() => { const w = document.querySelector('.dwin[data-app="providers"]'); return w.querySelector('.dwin-btn[data-act="x"]').getBoundingClientRect().x < w.querySelector('.dwin-title').getBoundingClientRect().x; })()`));
    check(P, 'the page inside the window is dark too', await ev(`document.querySelector('.dwin[data-app="providers"] iframe').contentDocument.documentElement.dataset.theme === 'dark'`));
    await click(...center(await rectOf('.desk-dock-all')));
    check(P, 'the launcher opens from the dock', await waitFor(`!!document.querySelector('.desk-pop-dock')`));
    await shot('2-dock-dark-launcher');
    await key('Escape', 'Escape', 0, 27);
    await shot('2-dock-dark');
  }

  // ---------- 3. Smaller screens ----------
  if (want('small')) {
    const P = 'small';
    await open('#/desktop', { w: 1024, h: 600, prefs: { 'desktop.style': null, 'page.theme': 'light' } });
    check(P, '1024 × 600: still windows', await ev(`!!document.querySelector('.desk .desk-taskbar')`));
    await shot('3-1024x600');
    await open('#/desktop', { w: 390, h: 844, mobile: true });
    check(P, '390 × 844: no windows; a grid of the apps as pages, the bottom bar kept', await ev(`!document.querySelector('.desk') && document.querySelectorAll('.desk-tile').length >= 9 && getComputedStyle(document.querySelector('.bottombar')).display !== 'none'`));
    check(P, '390 × 844: a tile is a link to the normal page', await ev(`document.querySelector('a.desk-tile[href="#/workspace"]') !== null`));
    check(P, 'no sideways scroll at 390', await ev(`document.documentElement.scrollWidth <= 390`));
    await shot('3-390x844');
    await open('#/', { w: 1440, h: 900 });
    check(P, 'the sidebar has "Desktop" on a wide screen', await ev(`[...document.querySelectorAll('.side-item')].some((a) => a.textContent.includes('Desktop'))`));
    await open('#/', { w: 390, h: 844, mobile: true });
    check(P, 'the phone\'s bottom bar has no "Desktop"', await ev(`![...document.querySelectorAll('.bottombar .tab')].some((a) => a.textContent.includes('Desktop'))`));
    await open('#/settings/appearance', { w: 1440, h: 900 });
    check(P, 'Settings → Appearance has Desktop style and Start view', await waitFor(`document.body.textContent.includes('Desktop style') && document.body.textContent.includes('Start view')`));
    await open('#/computer', { w: 1440, h: 900 });
    check(P, 'a computer\'s page has "Open desktop"', await waitFor(`[...document.querySelectorAll('a.btn')].some((a) => a.textContent.includes('Open desktop') && a.getAttribute('href') === '#/desktop')`));
    await open('', { w: 1440, h: 900, prefs: { 'desktop.start': 'desktop' } });
    check(P, 'Start view Desktop: a fresh open lands on the desktop', await waitFor(`location.hash === '#/desktop' && !!document.querySelector('.desk')`));
    await open('', { w: 1440, h: 900, prefs: { 'desktop.start': null } });
    check(P, 'Start view Home (the default): a fresh open lands on Home', await waitFor(`!document.querySelector('.desk') && !!document.querySelector('.sidebar')`));
  }

  // ---------- 4. Touch: a long press opens the menu ----------
  if (want('touch')) {
    const P = 'touch';
    await open('#/desktop', { w: 1280, h: 800 });
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const r = await rectOf('.desk-icon[data-app="workspace"]');
    const [x, y] = center(r);
    await chrome.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await sleep(700);
    const menu = await ev(`!!document.querySelector('.desk-menu')`);
    await chrome.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    check(P, 'a long press on a desktop icon opens its menu', menu);
    await shot('4-touch-menu');
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }

  // ---------- 5. Another computer: the same desktop for it ----------
  if (want('computer')) {
    const P = 'computer';
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.m.laptop': null } });
    const has = await waitFor(`document.querySelectorAll('.desk-pc').length && window.__hoprigStore.all.length > 1`, 12000);
    check(P, 'the demo has a second computer', has);
    if (has) {
      await click(...center(await rectOf('.desk-pc')));
      await waitFor(`!!document.querySelector('.desk-menu')`);
      await ev(`[...document.querySelectorAll('.desk-menu-item')].find((b) => b.textContent.includes('Laptop')).click()`);
      check(P, 'the computer switch opens the Laptop\'s desktop', await waitFor(`location.hash === '#/m/laptop/desktop' && !!document.querySelector('.desk')`));
      await dblclick(...center(await rectOf('.desk-icon[data-app="workspace"]')));
      check(P, 'its apps open for that computer', await waitFor(`(() => { const f = document.querySelector('.dwin[data-app="workspace"] iframe'); return f && f.contentWindow.location.hash === '#/m/laptop/workspace'; })()`));
      await sleep(1500);
      await shot('5-laptop-desktop');
      await open('#/desktop', { w: 1440, h: 900 });
      check(P, 'each computer keeps its own layout', await ev(`!document.querySelector('.dwin[data-app="workspace"] iframe') || !document.querySelector('.dwin[data-app="workspace"] iframe').getAttribute('src').includes('/m/laptop')`));
    }
  }

  // ---------- 6. A page of another origin cannot frame the dashboard ----------
  if (want('framing')) {
    const P = 'framing';
    other = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><title>other</title><iframe id="f" src="${url}/?bare=1#/" width="800" height="500"></iframe>`);
    });
    await new Promise((r) => other.listen(PORT + 2, '127.0.0.1', r));
    // Another port is another origin (and the same site, so the sign-in cookie still goes with the request).
    await chrome.goto(`http://127.0.0.1:${PORT + 2}/`, 2500);
    check(P, 'the other origin\'s page loaded with its frame', await ev(`location.port === ${J(String(PORT + 2))} && !!document.getElementById('f')`));
    // The frame runs apart from the page (another origin), so it is asked on its own DevTools connection: a refused
    // frame holds the browser's error page, not the dashboard.
    const inner = await frameTarget(/\?bare=1/);
    check(P, 'a page of another origin gets no dashboard in its frame (the browser refuses it)', inner && inner.ok === false, J(inner));
    await shot('6-framing-other-origin');
    // The same page of this origin may: the desktop's own case.
    await chrome.goto(`${url}/#/desktop`, 1500);
    const own = await ev(`(() => { const f = document.createElement('iframe'); f.src = '/?bare=1#/'; document.body.appendChild(f); return new Promise((r) => f.onload = () => setTimeout(() => r(!!(f.contentDocument && f.contentDocument.querySelector('#app'))), 600)); })()`);
    check(P, 'a page of this same origin may frame it', own);
  }

  const errs = chrome.errors.filter((e) => !/Failed to load resource|net::ERR_ABORTED|frame-ancestors|X-Frame-Options|Refused to display/.test(e));
  check('page', 'no uncaught errors in the page', errs.length === 0, errs.slice(0, 5).join(' | '));
} catch (e) {
  check('run', 'the run finished', false, e.stack || e.message);
} finally {
  await stopAll();
}
console.log(`\n${results.length - failed} of ${results.length} checks passed; screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
