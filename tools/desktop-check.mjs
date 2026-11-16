#!/usr/bin/env node
// Dev-only (not in the published package): the desktop (web/desktop/) proven in a real browser, on `hoprig demo`
// (sample data in a temp folder, nothing real) and the local Chrome headless (tools/chrome.mjs).
//
//   TMPDIR=/tmp node tools/desktop-check.mjs [--port 7680] [--out <folder for screenshots>] [--only taskbar,dock,…]
//
// Parts, in this order (the first is the one that matters most): taskbar (1440 × 900, light: in from "Desktop
// mode" in a page head and back from the top right; Sessions, the Task manager and a Terminal as windows, move,
// resize, snap to a half and a quarter, minimise and restore, maximise, close, the keys, the menu, a reload that
// brings the layout back, one session poll for the whole desktop, a terminal that is typed into), dock (dark),
// small (1024 × 600 windows; 390 × 844 the grid of pages with the bottom bar), touch (a long press opens the
// menu), computer (the same desktop for the demo's second computer), framing (a page of another origin cannot
// frame the dashboard). Chrome is started before the demo narrows PATH; Chrome needs a short TMPDIR.
import http from 'node:http';
import { startCheck } from './desktop-check-lib.mjs';

const {
  PORT, want, sleep, check, chrome, url, ev, J, shot, waitFor, click, dblclick, drag, key, rectOf, center, winSel, area, windows,
  frameOk, toFront, frameTarget, open, finish, done, setOther,
} = await startCheck('hoprig-desktop-check');

try {

  // ---------- 1. Taskbar, light, 1440 × 900: the case that matters most ----------
  if (want('taskbar')) {
    const P = 'taskbar';
    await open('#/', { w: 1440, h: 900, prefs: { 'desktop.~': null, 'desktop.style': null, 'page.theme': 'light' } });
    check(P, '"Desktop mode" is at the top right of the page head', await waitFor(`(() => { const b = document.querySelector('.pagehead .desk-headbtn'); if (!b || !b.offsetWidth) return false; const r = b.getBoundingClientRect(); return r.right > innerWidth - 140 && r.top < 90; })()`));
    await click(...center(await rectOf('.pagehead .desk-headbtn')));
    check(P, 'it opens the desktop', await waitFor(`location.hash === '#/desktop' && !!document.querySelector('.desk')`));
    await click(...center(await rectOf('.desk-back')));
    check(P, '"Dashboard" at the top right leads back', await waitFor(`location.hash === '#/' && !document.querySelector('.desk') && !!document.querySelector('.sidebar')`));
    await open('#/desktop', { w: 1440, h: 900 });
    check(P, 'the desktop fills the window, Taskbar style, no sidebar', await ev(`!!document.querySelector('.desk[data-desk-style="taskbar"] .desk-taskbar') && !document.querySelector('.sidebar')`));
    // Sessions from its desktop icon (one click), the Task manager from the start menu, Terminal by search + Enter.
    const icon = await rectOf('.desk-icon[data-app="sessions"]');
    await click(...center(icon));
    check(P, 'a click on a desktop icon opens Sessions', await waitFor(`!!document.querySelector('.dwin[data-app="sessions"]')`));
    await click(...center(await rectOf('.desk-start')));
    check(P, 'the start menu opens with the search field focused', await waitFor(`document.activeElement && document.activeElement.classList.contains('desk-search')`));
    check(P, 'the start menu has the computer\'s apps only', await ev(`[...document.querySelectorAll('.desk-app')].map((b) => b.textContent).join('|') === 'Sessions|Terminal|Task manager|Services|Logs'`), await ev(`[...document.querySelectorAll('.desk-app')].map((b) => b.textContent).join('|')`));
    const ws = await ev(`(() => { const b = [...document.querySelectorAll('.desk-app')].find((x) => x.textContent.includes('Task manager')); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await click(...ws);
    check(P, 'the Task manager opens from the start menu, which closes', await waitFor(`!!document.querySelector('.dwin[data-app="tasks"]') && !document.querySelector('.desk-pop')`));
    await click(...center(await rectOf('.desk-start')));
    await waitFor(`document.activeElement && document.activeElement.classList.contains('desk-search')`);
    await chrome.send('Input.insertText', { text: 'term' });
    await key('Enter', 'Enter', 0, 13);
    check(P, 'Terminal opens by searching "term" and Enter: a new shell in a window', await waitFor(`!!document.querySelector('.dwin[data-app="terminal"]')`, 10000));
    await waitFor(`[...document.querySelectorAll('.dwin iframe')].every((f) => f.contentDocument && f.contentDocument.querySelector('main, .term-wrap, .xterm'))`, 10000);
    await sleep(1200);
    check(P, 'the Task manager is a native app in its window (no frame), with the processes', await waitFor(`!document.querySelector('.dwin[data-app="tasks"] iframe') && document.querySelectorAll('.dwin[data-app="tasks"] .dapp-tbody .dapp-tr').length >= 5`));
    for (const a of ['sessions', 'terminal']) {
      const why = await frameOk(a);
      check(P, `the ${a} window shows its page in bare mode (no navigation, no floating buttons)`, why === '', why);
    }
    check(P, 'three windows, the newest in front, three buttons in the taskbar', await ev(`document.querySelectorAll('.dwin').length === 3 && document.querySelector('.dwin[aria-current="true"]').dataset.app === 'terminal' && document.querySelectorAll('.desk-task').length === 3`));
    await shot('1-taskbar-three-windows');

    // Move: the Workspace window by its title bar.
    await click(...center(await rectOf(`${winSel('tasks')} .dwin-title`)));
    let r0 = await rectOf(winSel('tasks'));
    let bar = await rectOf(`${winSel('tasks')} .dwin-title`);
    await drag(bar.x + 30, bar.y + 10, bar.x + 30 + 140, bar.y + 10 + 70);
    let r1 = await rectOf(winSel('tasks'));
    check(P, 'a window moves with its title bar', r1.x - r0.x === 140 && r1.y - r0.y === 70, `${r1.x - r0.x}, ${r1.y - r0.y}`);
    // Resize from the bottom right corner.
    const se = await rectOf(`${winSel('tasks')} .dwin-grip[data-dir="se"]`);
    await drag(se.x + 6, se.y + 6, se.x + 6 + 90, se.y + 6 + 50);
    const r2 = await rectOf(winSel('tasks'));
    check(P, 'a window resizes from its corner', r2.w - r1.w === 90 && r2.h - r1.h === 50, `${r2.w - r1.w}, ${r2.h - r1.h}`);
    // Resize from the left edge: the right edge stays.
    const wgrip = await rectOf(`${winSel('tasks')} .dwin-grip[data-dir="w"]`);
    await drag(wgrip.x + 3, wgrip.y + 40, wgrip.x + 3 - 60, wgrip.y + 40);
    const r3 = await rectOf(winSel('tasks'));
    check(P, 'a window resizes from its left edge, its right edge stays', r3.x === r2.x - 60 && r3.x + r3.w === r2.x + r2.w, `${r3.x}, ${r3.w}`);
    // Snap to the left half by dragging to the left edge.
    const a = await area();
    bar = await rectOf(`${winSel('tasks')} .dwin-title`);
    await drag(bar.x + 20, bar.y + 10, a.x + 1, a.y + 300);
    let ww = await rectOf(winSel('tasks'));
    check(P, 'dragged to the left edge it takes the left half', ww.x === a.x && ww.y === a.y && Math.abs(ww.w - a.w / 2) <= 1 && ww.h === a.h, J(ww));
    // A quarter: Sessions to the top right corner.
    await toFront('sessions');
    bar = await rectOf(`${winSel('sessions')} .dwin-title`);
    await drag(bar.x + 20, bar.y + 10, a.x + a.w - 1, a.y + 10);
    const sq = await rectOf(winSel('sessions'));
    check(P, 'dragged to the top right corner it takes that quarter', Math.abs(sq.x - (a.x + a.w / 2)) <= 1 && sq.y === a.y && Math.abs(sq.h - a.h / 2) <= 1, J(sq));
    // Taken out of a snap place it gets its own size back.
    bar = await rectOf(`${winSel('tasks')} .dwin-title`);
    await drag(bar.x + 100, bar.y + 10, bar.x + 400, bar.y + 120);
    ww = await rectOf(winSel('tasks'));
    check(P, 'dragged out of the half it has its own size again', ww.w === r3.w && ww.h === r3.h, `${ww.w}×${ww.h}`);
    // The keys: Alt+Shift+→ snaps the window in front to the right half (the keyboard is in its page).
    await click(...center(await rectOf(`${winSel('tasks')} .dwin-body`)));
    await key('ArrowRight', 'ArrowRight', 1 | 8, 39);
    await sleep(300);
    check(P, 'Alt+Shift+Right snaps the window in front to the right half', (await windows()).find((w) => w.app === 'tasks').snap === 'r');
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
    check(P, 'the Task manager is back and reads its processes again', await waitFor(`document.querySelectorAll('.dwin[data-app="tasks"] .dapp-tbody .dapp-tr').length >= 5`));
    await shot('1-taskbar-after-reload');
  }

  // ---------- 2. Dock, dark ----------
  if (want('dock')) {
    const P = 'dock';
    await open('#/desktop', { w: 1440, h: 900, theme: 'dark', prefs: { 'desktop.style': 'dock', 'page.theme': 'dark' } });
    check(P, 'Dock style: a bar at the top and a dock at the bottom', await ev(`!!document.querySelector('.desk[data-desk-style="dock"] .desk-topbar') && !!document.querySelector('.desk-dock') && !document.querySelector('.desk-taskbar')`));
    check(P, 'dark colours', await ev(`document.documentElement.dataset.theme === 'dark'`));
    await click(...center(await rectOf('.desk-dock-item[data-app="services"]')));
    check(P, 'a dock item opens its app; a dot shows it is open', await waitFor(`!!document.querySelector('.dwin[data-app="services"]') && document.querySelector('.desk-dock-item[data-app="services"]').dataset.open === '1'`));
    check(P, 'the top bar names the app in front', await waitFor(`document.querySelector('.desk-appmenu') && document.querySelector('.desk-appmenu').textContent.includes('Services')`));
    check(P, '"Dashboard" is at the top right in Dock style', await ev(`(() => { const r = document.querySelector('.desk-back').getBoundingClientRect(); return r.right > innerWidth - 140 && r.top < 30; })()`));
    await sleep(1500);
    check(P, 'the window in Dock style has its buttons on the left', await ev(`(() => { const w = document.querySelector('.dwin[data-app="services"]'); return w.querySelector('.dwin-btn[data-act="x"]').getBoundingClientRect().x < w.querySelector('.dwin-title').getBoundingClientRect().x; })()`));
    check(P, 'the app in the window lists the services, in dark colours', await waitFor(`document.querySelectorAll('.dwin[data-app="services"] .dapp-tbody .dapp-tr').length >= 3 && getComputedStyle(document.querySelector('.dwin[data-app="services"] .dapp-table')).backgroundColor !== 'rgb(255, 255, 255)'`));
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
    check(P, '390 × 844: no windows; a grid of the apps as pages, the bottom bar kept', await ev(`!document.querySelector('.desk') && document.querySelectorAll('.desk-tile').length === 5 && getComputedStyle(document.querySelector('.bottombar')).display !== 'none'`));
    check(P, '390 × 844: a native app\'s tile is a link to it as a page', await ev(`document.querySelector('a.desk-tile[href="#/desktop/tasks"]') !== null`));
    check(P, '390 × 844: no "Desktop mode" in the page head', await ev(`!document.querySelector('.desk-headbtn') || !document.querySelector('.desk-headbtn').offsetWidth`));
    check(P, 'no sideways scroll at 390', await ev(`document.documentElement.scrollWidth <= 390`));
    await shot('3-390x844');
    await open('#/desktop/tasks', { w: 390, h: 844, mobile: true });
    check(P, '390 × 844: the Task manager as a page lists the processes', await waitFor(`document.querySelectorAll('.dapp-page .dapp-tbody .dapp-tr').length >= 5`));
    check(P, '390 × 844: no sideways scroll of the page there', await ev(`document.documentElement.scrollWidth <= 390`), await ev(`String(document.documentElement.scrollWidth)`));
    await shot('3-390x844-tasks');
    await open('#/', { w: 1440, h: 900 });
    check(P, 'no "Desktop" in the sidebar: the desktop is beside the dashboard', await ev(`!![...document.querySelectorAll('.side-item')].length && ![...document.querySelectorAll('.side-item')].some((a) => a.textContent.includes('Desktop'))`));
    await open('#/', { w: 390, h: 844, mobile: true });
    check(P, 'the phone\'s bottom bar has no "Desktop"', await ev(`![...document.querySelectorAll('.bottombar .tab')].some((a) => a.textContent.includes('Desktop'))`));
    await open('#/settings/appearance', { w: 1440, h: 900 });
    check(P, 'Settings → Appearance has Desktop style and no Start view', await waitFor(`document.body.textContent.includes('Desktop style') && !document.body.textContent.includes('Start view')`));
    await open('#/computer', { w: 1440, h: 900 });
    check(P, 'a computer\'s page has "Open desktop"', await waitFor(`[...document.querySelectorAll('a.btn')].some((a) => a.textContent.includes('Open desktop') && a.getAttribute('href') === '#/desktop')`));
    await open('', { w: 1440, h: 900, prefs: { 'desktop.start': 'desktop' } });
    check(P, 'a fresh open lands on Home, whatever an older version kept', await waitFor(`!document.querySelector('.desk') && !!document.querySelector('.sidebar')`));
  }

  // ---------- 4. Touch: a long press opens the menu ----------
  if (want('touch')) {
    const P = 'touch';
    await open('#/desktop', { w: 1280, h: 800 });
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const r = await rectOf('.desk-icon[data-app="tasks"]');
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
      await dblclick(...center(await rectOf('.desk-icon[data-app="tasks"]')));
      check(P, 'its apps open for that computer: the Task manager asks the Laptop, through the hub', await waitFor(`performance.getEntriesByType('resource').some((e) => e.name.includes('/m/laptop/api/system/processes')) && document.querySelector('.dwin[data-app="tasks"]').textContent.includes('backup.mjs')`, 12000));
      await dblclick(...center(await rectOf('.desk-icon[data-app="sessions"]')));
      check(P, 'a page app opens for that computer', await waitFor(`(() => { const f = document.querySelector('.dwin[data-app="sessions"] iframe'); return f && f.contentWindow.location.hash === '#/m/laptop/'; })()`));
      await sleep(1500);
      await shot('5-laptop-desktop');
      await open('#/desktop', { w: 1440, h: 900 });
      check(P, 'each computer keeps its own layout', await ev(`!document.querySelector('.dwin[data-app="sessions"] iframe') || !document.querySelector('.dwin[data-app="sessions"] iframe').getAttribute('src').includes('/m/laptop')`));
    }
  }

  // ---------- 6. A page of another origin cannot frame the dashboard ----------
  if (want('framing')) {
    const P = 'framing';
    const other = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><title>other</title><iframe id="f" src="${url}/?bare=1#/" width="800" height="500"></iframe>`);
    });
    setOther(other);
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

  await finish();
} catch (e) {
  check('run', 'the run finished', false, e.stack || e.message);
} finally {
  await done();
}
