#!/usr/bin/env node
// Dev-only (not in the published package): the desktop's native apps (Task manager, Services, Logs) proven in a
// real browser, on `hoprig demo` (sample processes, services and logs: nothing on this computer is shown, ended,
// started or stopped) and, read-only, on this computer's own system (Linux).
//
//   TMPDIR=/tmp node tools/desktop-apps-check.mjs [--port 7680] [--out <folder>] [--only tasks,services,logs,dock,phone,real]
//
// Parts, the first is the one that matters most: tasks, services, logs (Taskbar style, light, 1440 × 900), then
// dock (Dock style, dark), phone (390 × 844: the apps as pages), real (a second dashboard in this process with the
// real system parts: the processes, the services and the journal of this computer are read, and the only process
// ended is one this check started itself; its screenshots show this computer, so they stay where they are written).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, startCheck } from './desktop-check-lib.mjs';

const {
  PORT, want, sleep, check, chrome, ev, J, shot, waitFor, click, dblclick, key, rectOf, center, open, finish, done,
} = await startCheck('hoprig-desktop-apps-check');

const W = (app) => `.dwin[data-app="${app}"]`;
const rows = (sel) => ev(`[...document.querySelectorAll(${J(`${sel} .dapp-tbody .dapp-tr`)})].map((r) => [...r.children].map((c) => c.textContent))`);
const press = async (sel) => click(...center(await rectOf(sel)));
/** Press the first element matching `sel` whose text includes `text`. */
const pressText = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${J(sel)})].find((x) => x.textContent.includes(${J(text)})); if (!b) return false; b.click(); return true; })()`);
const toast = (re) => waitFor(`[...document.querySelectorAll('.toast')].some((t) => ${re}.test(t.textContent))`, 8000);
/** Open app `id` on the desktop from its icon, maximised. */
async function openApp(id) {
  await dblclick(...center(await rectOf(`.desk-icon[data-app="${id}"]`)));
  await waitFor(`!!document.querySelector(${J(W(id))})`);
  await ev(`document.querySelector(${J(`${W(id)} .dwin-btn[data-act="square"]`)}).click()`);
  await sleep(300);
}
const mb = (t) => {
  const m = /([\d.]+) (B|KB|MB|GB)/.exec(t);
  return m ? Number(m[1]) * { B: 1, KB: 1e3, MB: 1e6, GB: 1e9 }[m[2]] : 0;
};
/** Enter as a person types it (with its character), so a form is sent. */
const enter = async () => {
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 });
};
const typeIn = async (sel, text) => {
  await press(sel);
  await chrome.send('Input.insertText', { text });
};

try {
  // ---------- 1. the Task manager: Taskbar, light, 1440 × 900 ----------
  if (want('tasks')) {
    const P = 'tasks';
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': null, 'desktop.style': null, 'page.theme': 'light' } });
    await openApp('tasks');
    check(P, 'the processes are listed', await waitFor(`document.querySelectorAll('${W('tasks')} .dapp-tbody .dapp-tr').length >= 9`, 10000));
    await sleep(2800); // a second reading: the CPU each one uses now
    let r = await rows(W('tasks'));
    const cpu = r.map((x) => parseFloat(x[3]) || 0);
    check(P, 'sorted by the CPU they use now, the busiest first', cpu[0] > 1 && cpu.every((v, i) => i === 0 || v <= cpu[i - 1]), J(cpu));
    check(P, 'name, PID, user, CPU, memory and command in each row', r[0].length === 7 && /^\d+$/.test(r[0][1]) && /MB|GB/.test(r[0][4]) && r[0][5].length > 3, J(r[0]));
    await pressText(`${W('tasks')} .dapp-sort`, 'Memory');
    await sleep(200);
    r = await rows(W('tasks'));
    check(P, 'a press on "Memory" sorts by memory', r.map((x) => mb(x[4])).every((v, i, a) => i === 0 || v <= a[i - 1]), J(r.map((x) => x[4])));
    await typeIn(`${W('tasks')} .dapp-filter`, 'claude');
    await sleep(300);
    r = await rows(W('tasks'));
    check(P, 'the filter finds the matching processes', r.length === 2 && r.every((x) => /claude/.test(x.join(' '))), J(r.map((x) => x[0])));
    check(P, 'a process of another user, or this dashboard, has no end button', await ev(`(() => { document.querySelector('${W('tasks')} .dapp-filter').value = ''; document.querySelector('${W('tasks')} .dapp-filter').dispatchEvent(new Event('input')); const sys = [...document.querySelectorAll('${W('tasks')} .dapp-tr')].find((t) => t.textContent.includes('/sbin/init')); return !!sys && !sys.querySelector('.dapp-end') && !!sys.querySelector('.dapp-lock'); })()`));
    await shot('1-tasks-processes');
    await ev(`[...document.querySelectorAll('${W('tasks')} .dapp-tr')].find((t) => t.textContent.includes('pipeline.run')).querySelector('.dapp-end').click()`);
    check(P, 'ending one asks first, with its command', await waitFor(`!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').textContent.includes('pipeline.run') && document.querySelector('dialog[open]').textContent.includes('Force')`));
    await shot('1-tasks-end-sheet');
    await pressText('dialog[open] button', 'End it');
    check(P, 'the answer is shown (the demo ends nothing)', await toast(/in the demo/i));
    await pressText(`${W('tasks')} .seg`, 'Performance');
    check(P, 'Performance: the CPU, each core and the memory', await waitFor(`(() => { const w = document.querySelector('${W('tasks')}'); return /CPU/.test(w.textContent) && w.querySelectorAll('.dapp-core').length === 8 && /of 32 GB in use/.test(w.textContent); })()`, 6000));
    await sleep(4500);
    check(P, 'the CPU strip grows as it is read again', await ev(`document.querySelectorAll('${W('tasks')} .dapp-strip i').length >= 2`));
    await shot('1-tasks-performance');
    await pressText(`${W('tasks')} .seg`, 'Disks');
    check(P, 'Disks: each one with its size, use and free space', await waitFor(`document.querySelectorAll('${W('tasks')} .dapp-tbody .dapp-tr').length === 2 && document.querySelector('${W('tasks')}').textContent.includes('/home/data')`));
    await shot('1-tasks-disks');
    await pressText(`${W('tasks')} .seg`, 'Network');
    check(P, 'Network: the addresses, the traffic and the listening ports', await waitFor(`(() => { const w = document.querySelector('${W('tasks')}'); return w.textContent.includes('192.0.2.24') && /KB\\/s/.test(w.textContent) && w.querySelectorAll('.dapp-tbody .dapp-tr').length === 3; })()`, 8000));
    await shot('1-tasks-network');
    // A minimised window asks nothing; it asks again as soon as it is back.
    await pressText(`${W('tasks')} .seg`, 'Processes');
    await sleep(800);
    await ev(`document.querySelector('${W('tasks')} .dwin-btn[data-act="minus"]').click()`);
    const asked = (since) => ev(`performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/system/') && e.startTime > ${since}).length`);
    const t0 = await ev('performance.now()');
    await sleep(6000);
    check(P, 'a minimised Task manager asks the computer nothing', (await asked(t0)) === 0, String(await asked(t0)));
    await press('.desk-task');
    await sleep(1500);
    check(P, 'brought back, it reads again at once', (await asked(t0)) >= 1);
  }

  // ---------- 2. Services ----------
  if (want('services')) {
    const P = 'services';
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': null, 'desktop.style': null, 'page.theme': 'light' } });
    await openApp('services');
    check(P, 'your own services are listed first, with their state', await waitFor(`document.querySelectorAll('${W('services')} .dapp-tbody .dapp-tr').length === 3`));
    check(P, 'this dashboard\'s own service is marked and has no buttons', await ev(`(() => { const t = [...document.querySelectorAll('${W('services')} .dapp-tr')].find((x) => x.textContent.includes('hoprig.service')); return t.textContent.includes('this dashboard') && !t.querySelector('.dapp-acts'); })()`));
    await ev(`[...document.querySelectorAll('${W('services')} .dapp-tr')].find((x) => x.textContent.includes('backup.service')).querySelector('button[aria-label^="Restart"]').click()`);
    check(P, 'one of yours restarts at once, without a password', await toast(/backup\.service restarted/));
    await pressText(`${W('services')} .seg`, 'The system\'s');
    check(P, 'the system\'s services, with a word on the password', await waitFor(`document.querySelectorAll('${W('services')} .dapp-tbody .dapp-tr').length === 6 && document.querySelector('${W('services')}').textContent.includes('asks for this computer\\'s password')`));
    await ev(`[...document.querySelectorAll('${W('services')} .dapp-tr')].find((x) => x.textContent.includes('nginx.service')).querySelector('button[aria-label^="Start"]').click()`);
    check(P, 'starting one of the system\'s asks for the computer\'s password', await waitFor(`!!document.querySelector('dialog[open] input[type="password"]')`));
    await shot('2-services-password');
    await press('dialog[open] input[type="password"]');
    await chrome.send('Input.insertText', { text: 'demo-password' });
    await enter();
    check(P, 'with it the service starts, and shows as running', await toast(/nginx\.service started/) && await waitFor(`[...document.querySelectorAll('${W('services')} .dapp-tr')].find((x) => x.textContent.includes('nginx.service')).textContent.includes('active (running)')`));
    await ev(`[...document.querySelectorAll('${W('services')} .dapp-tr')].find((x) => x.textContent.includes('ssh.service')).querySelector('button[aria-label^="Stop"]').click()`);
    check(P, 'stopping SSH asks for its name to be typed first', await waitFor(`!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').textContent.includes('cut this computer off')`));
    await shot('2-services-ssh-confirm');
    await press('dialog[open] input');
    await chrome.send('Input.insertText', { text: 'ssh' });
    await enter();
    check(P, 'a name that is not the service\'s is not taken', await waitFor(`document.querySelector('dialog[open] .form-error').textContent.includes('exactly')`));
    await chrome.send('Input.insertText', { text: '.service' });
    await enter();
    check(P, 'the right name goes on to the password', await waitFor(`!!document.querySelector('dialog[open] input[type="password"]')`));
    await press('dialog[open] input[type="password"]');
    await chrome.send('Input.insertText', { text: 'demo-password' });
    await enter();
    check(P, 'and SSH stops', await toast(/ssh\.service stopped/));
    await ev(`[...document.querySelectorAll('${W('services')} .dapp-link')].find((x) => x.textContent.includes('cron.service')).click()`);
    check(P, 'a service\'s name shows the last lines of its log', await waitFor(`!document.querySelector('${W('services')} .dapp-logpane').classList.contains('hidden') && document.querySelector('${W('services')} .dapp-log').textContent.includes('pam_unix')`));
    await typeIn(`${W('services')} .dapp-filter`, 'post');
    await sleep(300);
    check(P, 'the filter finds a service', (await rows(W('services'))).length === 1);
    await shot('2-services');
  }

  // ---------- 3. Logs ----------
  if (want('logs')) {
    const P = 'logs';
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': null, 'desktop.style': null, 'page.theme': 'light' } });
    await openApp('logs');
    check(P, 'the journal\'s last entries', await waitFor(`document.querySelectorAll('${W('logs')} .dapp-entry').length >= 8`));
    check(P, 'an error stands out', await ev(`!!document.querySelector('${W('logs')} .dapp-entry.dapp-p3')`));
    await shot('3-logs-journal');
    await ev(`(() => { const s = document.querySelector('${W('logs')} .dapp-select'); s.value = '3'; s.dispatchEvent(new Event('change')); return true; })()`);
    check(P, '"Errors and worse" leaves the error only', await waitFor(`(() => { const e = document.querySelectorAll('${W('logs')} .dapp-entry'); return e.length === 1 && e[0].classList.contains('dapp-p3'); })()`));
    await ev(`(() => { const s = document.querySelector('${W('logs')} .dapp-select'); s.value = ''; s.dispatchEvent(new Event('change')); const u = document.querySelector('${W('logs')} .dapp-unit'); u.value = 'cron.service'; u.dispatchEvent(new Event('change')); return true; })()`);
    check(P, 'a unit\'s entries only', await waitFor(`(() => { const e = [...document.querySelectorAll('${W('logs')} .dapp-unit-name')]; return e.length >= 1 && e.every((x) => x.textContent === 'cron.service'); })()`));
    await ev(`(() => { const u = document.querySelector('${W('logs')} .dapp-unit'); u.value = ''; u.dispatchEvent(new Event('change')); return true; })()`);
    await waitFor(`document.querySelectorAll('${W('logs')} .dapp-entry').length >= 8`);
    const before = await ev(`document.querySelectorAll('${W('logs')} .dapp-entry').length`);
    await pressText(`${W('logs')} button`, 'Follow');
    check(P, '"Follow" shows a new entry when it comes (one every 20 s in the demo)', await waitFor(`document.querySelectorAll('${W('logs')} .dapp-entry').length > ${before}`, 26_000));
    await pressText(`${W('logs')} button`, 'Follow');
    await pressText(`${W('logs')} .seg`, 'Log files');
    check(P, 'the log files are listed', await waitFor(`document.querySelectorAll('${W('logs')} .dapp-file option').length >= 2`));
    const file = await ev(`(() => { const s = document.querySelector('${W('logs')} .dapp-file'); s.value = s.options[1].value; s.dispatchEvent(new Event('change')); return s.value; })()`);
    check(P, 'a file is read from its end', await waitFor(`document.querySelector('${W('logs')} .dapp-log').textContent.includes('pam_unix')`));
    await pressText(`${W('logs')} button`, 'Follow');
    fs.appendFileSync(file, 'line written while followed: desk-follow-7\n');
    check(P, '"Follow" shows a line added to the file', await waitFor(`document.querySelector('${W('logs')} .dapp-log').textContent.includes('desk-follow-7')`, 6000));
    await shot('3-logs-file');
  }

  // ---------- 4. Dock style, dark ----------
  if (want('dock')) {
    const P = 'dock';
    await open('#/desktop', { w: 1440, h: 900, theme: 'dark', prefs: { 'desktop.~': null, 'desktop.style': 'dock', 'page.theme': 'dark' } });
    for (const id of ['tasks', 'services', 'logs']) {
      await press(`.desk-dock-item[data-app="${id}"]`);
      await waitFor(`!!document.querySelector(${J(W(id))})`);
    }
    check(P, 'the three apps open from the dock, each with a dot', await waitFor(`['tasks', 'services', 'logs'].every((a) => document.querySelector('.desk-dock-item[data-app="' + a + '"]').dataset.open === '1')`));
    check(P, 'each draws its content, in dark colours', await waitFor(`document.querySelectorAll('${W('tasks')} .dapp-tbody .dapp-tr').length >= 5 && document.querySelectorAll('${W('services')} .dapp-tbody .dapp-tr').length >= 3 && document.querySelectorAll('${W('logs')} .dapp-entry').length >= 5 && getComputedStyle(document.querySelector('${W('logs')} .dapp-journal')).backgroundColor !== 'rgb(255, 255, 255)'`, 10000));
    // Side by side with the keys: Task manager left, Services top right, Logs bottom right.
    await press('.desk-dock-item[data-app="tasks"]'); // a window behind comes to the front
    await key('ArrowLeft', 'ArrowLeft', 1 | 8, 37);
    await press('.desk-dock-item[data-app="services"]'); // a window behind comes to the front
    await key('ArrowRight', 'ArrowRight', 1 | 8, 39);
    await key('ArrowUp', 'ArrowUp', 1 | 8, 38);
    await press('.desk-dock-item[data-app="logs"]'); // a window behind comes to the front
    await key('ArrowRight', 'ArrowRight', 1 | 8, 39);
    await key('ArrowDown', 'ArrowDown', 1 | 8, 40);
    await sleep(2500);
    await shot('4-dock-dark-three-apps');
    check(P, 'side by side: left half, top right and bottom right', await ev(`['l', 'tr', 'br'].join() === ['tasks', 'services', 'logs'].map((a) => document.querySelector('.dwin[data-app="' + a + '"]').dataset.snap).join()`), await ev(`['tasks', 'services', 'logs'].map((a) => document.querySelector('.dwin[data-app="' + a + '"]').dataset.snap).join()`));
  }

  // ---------- 5. A phone: the apps as pages ----------
  if (want('phone')) {
    const P = 'phone';
    for (const [id, sel] of [['tasks', '.dapp-tbody .dapp-tr'], ['services', '.dapp-tbody .dapp-tr'], ['logs', '.dapp-entry']]) {
      await open('#/desktop', { w: 390, h: 844, mobile: true, prefs: { 'page.theme': 'light' } });
      await press(`.desk-tile[data-app="${id}"]`);
      check(P, `${id}: its tile opens it as a page, with its content`, await waitFor(`location.hash === '#/desktop/${id}' && document.querySelectorAll('.dapp-page ${sel}').length >= 3`, 10000));
      check(P, `${id}: no sideways scroll of the page`, await ev(`document.documentElement.scrollWidth <= 390`), await ev(`String(document.documentElement.scrollWidth)`));
      check(P, `${id}: the bottom bar is kept`, await ev(`getComputedStyle(document.querySelector('.bottombar')).display !== 'none'`));
      await shot(`5-phone-${id}`);
    }
  }

  // ---------- 6. This computer's own system (Linux), read-only, and one process of this check ended ----------
  if (want('real')) {
    const P = 'real';
    const { createServer } = await import(path.join(ROOT, 'src/server/server.mjs'));
    const { createLoginLink } = await import(path.join(ROOT, 'src/server/loginlink.mjs'));
    const real = createServer({ demo: true }); // the demo's folders; the desktop's system parts are the real ones
    const port = PORT + 3;
    await real.listen(port, '127.0.0.1');
    const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      // "localhost": another host than the demo's 127.0.0.1, so the two sign-ins do not share a cookie.
      await chrome.viewport(1440, 900, { theme: 'light' });
      await chrome.goto(createLoginLink({ baseUrl: `http://localhost:${port}` }).url, 2500);
      await chrome.goto(`http://localhost:${port}/?r=1#/desktop/tasks`, 2500);
      check(P, 'the Task manager lists this computer\'s processes', await waitFor(`document.querySelectorAll('.dapp-page .dapp-tbody .dapp-tr').length >= 20`, 12000), String(await ev(`document.querySelectorAll('.dapp-page .dapp-tbody .dapp-tr').length`)));
      await typeIn('.dapp-page .dapp-filter', String(sleeper.pid));
      await sleep(400);
      check(P, 'this check\'s own process is found, with an end button', await waitFor(`[...document.querySelectorAll('.dapp-page .dapp-tr')].some((t) => t.dataset.key === '${sleeper.pid}' && t.querySelector('.dapp-end'))`));
      await ev(`document.querySelector('.dapp-page .dapp-tr[data-key="${sleeper.pid}"] .dapp-end').click()`);
      await waitFor(`!!document.querySelector('dialog[open]')`);
      await pressText('dialog[open] button', 'End it');
      const ended = await new Promise((r) => {
        if (sleeper.exitCode !== null || sleeper.signalCode) return r(sleeper.signalCode || 'exited');
        sleeper.once('exit', (c, sig) => r(sig || `code ${c}`));
        setTimeout(() => r(null), 5000);
      });
      check(P, 'ending it ends that process (and only that one)', ended === 'SIGTERM', String(ended));
      await typeIn('.dapp-page .dapp-filter', '');
      await ev(`(() => { const f = document.querySelector('.dapp-page .dapp-filter'); f.value = 'node'; f.dispatchEvent(new Event('input')); return true; })()`);
      await sleep(600);
      check(P, 'this dashboard itself cannot be ended from its own page', await ev(`!!document.querySelector('.dapp-page .dapp-tr[data-key="${process.pid}"] .dapp-lock') && !document.querySelector('.dapp-page .dapp-tr[data-key="${process.pid}"] .dapp-end')`));
      await chrome.goto(`http://localhost:${port}/?r=2#/desktop/services`, 2500);
      check(P, 'Services lists this computer\'s services (only read)', await waitFor(`document.querySelectorAll('.dapp-page .dapp-tbody .dapp-tr').length >= 3`, 15000));
      await pressText('.dapp-page .seg', 'The system\'s');
      check(P, 'and the system\'s', await waitFor(`document.querySelectorAll('.dapp-page .dapp-tbody .dapp-tr').length >= 10`, 15000));
      await chrome.goto(`http://localhost:${port}/?r=3#/desktop/logs`, 2500);
      check(P, 'Logs reads this computer\'s journal', await waitFor(`document.querySelectorAll('.dapp-page .dapp-entry').length >= 1 || !!document.querySelector('.dapp-page .banner')`, 15000));
      await pressText('.dapp-page .seg', 'Log files');
      check(P, 'and lists the log files it can read', await waitFor(`document.querySelectorAll('.dapp-page .dapp-file option').length >= 1`, 8000));
    } finally {
      sleeper.kill('SIGKILL');
      await real.close();
    }
  }

  await finish();
} catch (e) {
  check('run', 'the run finished', false, e.stack || e.message);
} finally {
  await done();
}
