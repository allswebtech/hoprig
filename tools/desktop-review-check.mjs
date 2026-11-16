#!/usr/bin/env node
// Dev-only (not in the published package): the desktop's behaviour that a review asked for, proven in a real
// browser on `hoprig demo` (sample data, nothing real) with the local Chrome headless (tools/chrome.mjs).
//
//   TMPDIR=/tmp node tools/desktop-review-check.mjs [--port 7680] [--out <folder>] [--only open,windows,…]
//
// Parts (1440 × 900, light, Taskbar; the first is the one that matters most):
//   open      one press on a desktop icon opens one window (a double click too); the way back is at the top right;
//             Desktop settings links back to the desktop
//   windows   the Sessions window is called Sessions and shows this computer's sessions; its way back stays in the
//             app; a Terminal window has none and no quick messages for Claude; closing a shell's window asks; at the window limit no shell starts
//   tables    a poll keeps the keyboard on its button and a press that spans it; services in words, asked before
//             a stop; the scope of a slow answer is dropped; Escape gives the keyboard back; safe sheets
//   ended     a Terminal window whose shell ends (`exit`, End session) offers to close and never turns into Home;
//             closing the window of a shell that has ended asks nothing
//   laptop    the Sessions window of another computer's desktop shows that computer's sessions only, has no way back
//             on its start page and no Get started; a session opened in it leads back to that list
//   phone     390 × 844, dark: a session page outside the desktop still leads back when its session ends
//   narrow    1024 × 600: a new Services or Task manager window keeps its buttons inside it
import { startCheck } from './desktop-check-lib.mjs';

const {
  want, sleep, check, chrome, ev, J, shot, waitFor, click, dblclick, mouse, key, rectOf, center, winSel, open, finish, done,
} = await startCheck('hoprig-desktop-review-check');

const store = (expr) => ev(`(() => { const s = window.__hoprigStore; return ${expr}; })()`);
const inFrame = (app, expr) => ev(`(() => { const f = document.querySelector('.dwin[data-app="${app}"] iframe'); const d = f && f.contentDocument; const w = f && f.contentWindow; if (!d) return null; return ${expr}; })()`);
const sheetButtons = () => ev(`[...document.querySelectorAll('dialog.sheet[open] button')].map((b) => b.textContent.trim())`);
const pressSheet = (text) => ev(`(() => { const b = [...document.querySelectorAll('dialog.sheet[open] button')].find((x) => x.textContent.trim() === ${J(text)}); if (b) b.click(); return !!b; })()`);
const launch = async (app) => click(...center(await rectOf(`.desk-icon[data-app="${app}"]`)));
const closeAll = () => ev(`(() => { localStorage.removeItem('pref:desktop.~'); return true; })()`);

try {
  // ---------- open: one press, one window; the way back at the top right ----------
  if (want('open')) {
    const P = 'open';
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': null, 'desktop.style': null, 'page.theme': 'light' } });
    await launch('logs');
    check(P, 'one click on a desktop icon opens its app', await waitFor(`document.querySelectorAll('.dwin[data-app="logs"]').length === 1`));
    await dblclick(...center(await rectOf('.desk-icon[data-app="services"]')));
    await sleep(600);
    check(P, 'a double click opens one window, not two', await ev(`document.querySelectorAll('.dwin[data-app="services"]').length === 1`));
    const back = await rectOf('.desk-back');
    check(P, 'Taskbar style: "Dashboard" is at the top right, where "Desktop mode" was', back && back.y < 40 && back.x + back.w > 1440 - 160, J(back));
    check(P, 'the Start button says "Start"', await ev(`document.querySelector('.desk-start').textContent.trim() === 'Start'`));
    check(P, 'Log files say what to do before a file is chosen', await (async () => {
      await ev(`[...document.querySelectorAll('.dwin[data-app="logs"] .seg')].find((b) => /file/i.test(b.textContent))?.click()`);
      return waitFor(`(document.querySelector('.dwin[data-app="logs"] pre.dapp-log') || {}).textContent === 'Choose a log file above to read it.'`);
    })());
    await shot('r1-open-taskbar');
    // "Desktop settings" from the desktop's menu: the settings page links back to the desktop, not to "More".
    await ev(`(() => { const a = document.querySelector('.desk-area'); a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 700, clientY: 820 })); return true; })()`);
    await waitFor(`!!document.querySelector('.desk-menu')`);
    await ev(`[...document.querySelectorAll('.desk-menu button')].find((b) => b.textContent.includes('Desktop settings')).click()`);
    check(P, 'Desktop settings opens Appearance, whose way back says "Desktop"', await waitFor(`location.hash.startsWith('#/settings/appearance') && (() => { const b = document.querySelector('.pagehead-back'); return b && b.textContent.trim() === 'Desktop'; })()`),
      await ev(`(document.querySelector('.pagehead-back') || {}).textContent`));
  }

  // ---------- windows: names, the way back, shells ----------
  if (want('windows')) {
    const P = 'windows';
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': null, 'desktop.style': null, 'page.theme': 'light' } });
    await launch('sessions');
    await waitFor(`!!document.querySelector('.dwin[data-app="sessions"] iframe')`);
    check(P, 'the Sessions window and its taskbar button are called "Sessions"', await waitFor(`document.querySelector('.dwin[data-app="sessions"] .dwin-title').textContent === 'Sessions' && document.querySelector('.desk-task').textContent.includes('Sessions')`, 6000),
      await ev(`document.querySelector('.dwin[data-app="sessions"] .dwin-title').textContent`));
    await waitFor(`(() => { const d = document.querySelector('.dwin[data-app="sessions"] iframe').contentDocument; return d && d.querySelector('main .page-title'); })()`, 6000);
    check(P, 'the page in it is titled "Sessions" and has no way back on its start page', await inFrame('sessions', `d.querySelector('main .page-title').textContent === 'Sessions' && !d.querySelector('.pagehead-back')`));
    await waitFor(`(() => { const d = document.querySelector('.dwin[data-app="sessions"] iframe').contentDocument; return d.querySelectorAll('article.card').length > 0; })()`, 8000);
    const ownCount = await store(`(s.all.find((m) => !m.machine) || { sessions: [] }).sessions.length`);
    const shown = await inFrame('sessions', `d.querySelectorAll('article.card').length`);
    check(P, 'it shows this computer\'s sessions only, with no computer chips', shown === ownCount && (await inFrame('sessions', `!d.querySelector('.mchips')`)), `${shown} of ${ownCount}`);
    check(P, 'it has no Get started (that stays on the dashboard\'s Home)', await inFrame('sessions', `!d.querySelector('.gs-area')`));
    // Open a session in it: the window takes that page's name; its way back says Sessions and leads there.
    await inFrame('sessions', `(d.querySelector('article.card a, article.card[href], article.card') || {}).click && (d.querySelector('article.card a') || d.querySelector('article.card')).click()`);
    check(P, 'a session opened in it names the window after itself', await waitFor(`(() => { const t = document.querySelector('.dwin[data-app="sessions"] .dwin-title').textContent; return t && t !== 'Sessions'; })()`, 8000));
    check(P, 'its way back says "Sessions"', await waitFor(`(() => { const d = document.querySelector('.dwin[data-app="sessions"] iframe').contentDocument; const b = d.querySelector('.pagehead-back, .sessback, .chatback'); return b && b.textContent.trim() === 'Sessions'; })()`, 6000));
    await inFrame('sessions', `d.querySelector('.pagehead-back, .sessback, .chatback').click()`);
    check(P, 'and leads back to the list, the window called Sessions again', await waitFor(`document.querySelector('.dwin[data-app="sessions"] .dwin-title').textContent === 'Sessions'`, 6000));

    // A Terminal window: a new shell, no way back inside it.
    const before = await store(`(s.all.find((m) => !m.machine) || { sessions: [] }).sessions.length`);
    await launch('terminal');
    check(P, 'Terminal opens a new shell in a window', await waitFor(`!!document.querySelector('.dwin[data-app="terminal"] iframe')`, 10000));
    await waitFor(`(() => { const d = document.querySelector('.dwin[data-app="terminal"] iframe').contentDocument; return d && d.querySelector('main .page-title'); })()`, 8000);
    check(P, 'the Terminal window has no "Home" (no way back) that would turn it into another page', await inFrame('terminal', `!!d.querySelector('.sessbar') && !d.querySelector('.pagehead-back, .sessback')`));
    check(P, 'a plain shell offers no quick messages for Claude, and its box says it types into the terminal', await waitFor(`(() => { const d = document.querySelector('.dwin[data-app="terminal"] iframe').contentDocument; const q = d.querySelector('.quick'); const t = d.querySelector('textarea.msg'); return q && q.classList.contains('hidden') && t && t.placeholder === 'Type into the terminal'; })()`, 6000));
    await shot('r2-terminal-window');
    // Closing it asks; Cancel keeps it; "Keep it running" closes the window only.
    await click(...center(await rectOf(`${winSel('terminal')} .dwin-btn[data-act="x"]`)));
    check(P, 'closing a shell\'s window asks whether the shell ends too', await waitFor(`!!document.querySelector('dialog.sheet[open]')`), J(await sheetButtons()));
    check(P, 'the keyboard starts on Cancel there', await ev(`document.activeElement && document.activeElement.textContent.trim() === 'Cancel'`));
    await shot('r2-close-shell-ask');
    await pressSheet('Cancel');
    await sleep(300);
    check(P, 'Cancel keeps the window', await ev(`document.querySelectorAll('.dwin[data-app="terminal"]').length === 1`));
    await click(...center(await rectOf(`${winSel('terminal')} .dwin-btn[data-act="x"]`)));
    await waitFor(`!!document.querySelector('dialog.sheet[open]')`);
    await pressSheet('Keep it running');
    await sleep(400);
    await store(`s.refresh(), true`);
    await sleep(1500);
    const kept = await store(`(s.all.find((m) => !m.machine) || { sessions: [] }).sessions.length`);
    check(P, '"Keep it running" closes the window and the shell stays (in Sessions)', (await ev(`document.querySelectorAll('.dwin[data-app="terminal"]').length`)) === 0 && kept === before + 1, `${before} → ${kept}`);
    await launch('terminal');
    await waitFor(`!!document.querySelector('.dwin[data-app="terminal"] iframe')`, 10000);
    const name = await ev(`decodeURIComponent((/\\/s\\/([^/?]+)$/.exec(new URL(document.querySelector('.dwin[data-app="terminal"] iframe').src).hash) || [])[1] || '')`);
    await sleep(800);
    await click(...center(await rectOf(`${winSel('terminal')} .dwin-btn[data-act="x"]`)));
    await waitFor(`!!document.querySelector('dialog.sheet[open]')`);
    await pressSheet('End the shell');
    await sleep(600);
    await store(`s.refresh(), true`);
    check(P, '"End the shell" closes the window and ends the shell', await waitFor(`!document.querySelector('.dwin[data-app="terminal"]') && !(window.__hoprigStore.all.find((m) => !m.machine) || { sessions: [] }).sessions.some((x) => x.name === ${J(name)})`, 8000), name);

    // The window limit: no shell is started past it, and the toast shows once.
    await ev(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
    // Pressed from the keyboard (the windows cover the icons by now).
    const press = (app) => ev(`document.querySelector('.desk-icon[data-app="${app}"]').click()`);
    // Files: an app of many windows (Logs, Sessions and the Task manager have one each).
    for (let i = 0; i < 14; i++) {
      await press('files');
      await sleep(120);
    }
    await sleep(400);
    const atLimit = await store(`(s.all.find((m) => !m.machine) || { sessions: [] }).sessions.length`);
    for (let i = 0; i < 3; i++) {
      await press('terminal');
      await sleep(200);
    }
    const said = await ev(`[...document.querySelectorAll('.toast')].filter((t) => t.textContent.includes('At most 12')).length`);
    await sleep(1500);
    await store(`s.refresh(), true`);
    await sleep(1500);
    const after = await store(`(s.all.find((m) => !m.machine) || { sessions: [] }).sessions.length`);
    check(P, 'at 12 windows a Terminal press starts no shell', (await ev(`document.querySelectorAll('.dwin').length`)) === 12 && after === atLimit, `${atLimit} → ${after}`);
    check(P, 'the limit is said once, not once per press (five presses past it)', said === 1, String(said));
    await shot('r2-window-limit');
    await closeAll();
  }

  // ---------- tables, services, focus ----------
  if (want('tables')) {
    const P = 'tables';
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': null, 'desktop.style': null, 'page.theme': 'light' } });
    await launch('tasks');
    await waitFor(`document.querySelectorAll('.dwin[data-app="tasks"] .dapp-end').length > 2`, 10000);
    check(P, 'the demo\'s dashboard and its tmux server show a lock, not an End button', await ev(`['1975', '1980'].every((k) => { const r = document.querySelector('.dwin[data-app="tasks"] .dapp-tr[data-key="' + k + '"]'); return r && r.querySelector('.dapp-lock') && !r.querySelector('.dapp-end'); })`));
    // The keyboard on an End button stays there across polls (every 2.5 s).
    await ev(`document.querySelector('.dwin[data-app="tasks"] .dapp-end').focus()`);
    const was = await ev(`document.activeElement.getAttribute('aria-label')`);
    await sleep(6500);
    check(P, 'the keyboard stays on its End button across three polls', await ev(`document.activeElement && document.activeElement.classList.contains('dapp-end') && document.activeElement.isConnected && document.activeElement.getAttribute('aria-label') === ${J(was)}`), await ev(`document.activeElement.tagName + ' ' + document.activeElement.className`));
    // A press that spans a poll still clicks.
    const endR = await rectOf('.dwin[data-app="tasks"] .dapp-end');
    await mouse('mouseMoved', ...center(endR), { buttons: 0 });
    await mouse('mousePressed', ...center(endR));
    await sleep(3200);
    await mouse('mouseReleased', ...center(endR));
    check(P, 'a press held across a poll still opens End', await waitFor(`!!document.querySelector('dialog.sheet[open]') && document.querySelector('dialog.sheet[open]').textContent.includes('End ')`));
    check(P, 'the End sheet starts on Cancel: Enter alone ends nothing', await ev(`document.activeElement && document.activeElement.textContent.trim() === 'Cancel'`));
    await pressSheet('Cancel');

    // Services in plain words; a stop is asked first.
    await launch('services');
    await waitFor(`document.querySelectorAll('.dwin[data-app="services"] .dapp-tbody .dapp-tr').length > 3`, 8000);
    await ev(`(() => { const w = document.querySelector('.dwin[data-app="services"]'); w.querySelector('.dwin-btn[data-act="square"]').click(); return true; })()`);
    await sleep(800);
    const words = await ev(`[...new Set([...document.querySelectorAll('.dwin[data-app="services"] .dapp-st-word')].map((e) => e.textContent))].sort()`);
    check(P, 'the state pills say Running / Stopped / Failed', words.length && words.every((w) => ['Running', 'Stopped', 'Failed'].includes(w)), J(words));
    const starts = await ev(`[...new Set([...document.querySelectorAll('.dwin[data-app="services"] .dapp-tr:not(.dapp-th)')].map((r) => r.children[3] && r.children[3].textContent))].sort()`);
    check(P, '"Starts with the computer" says Yes / No', starts.includes('Yes') && !starts.includes('enabled'), J(starts));
    check(P, 'the buttons carry their words in a wide window', await ev(`[...document.querySelectorAll('.dwin[data-app="services"] .dapp-act')].some((b) => b.querySelector('.dapp-word') && b.querySelector('.dapp-word').offsetWidth > 0 && b.textContent.includes('Restart'))`));
    check(P, 'the name that opens a service\'s log looks like a link', await ev(`getComputedStyle(document.querySelector('.dwin[data-app="services"] .dapp-link-text')).textDecorationLine.includes('underline')`));
    await shot('r3-services-words');
    await ev(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);
    await ev(`[...document.querySelectorAll('.dwin[data-app="services"] .dapp-scope, .dwin[data-app="services"] .seg')].find((b) => b.textContent === 'Yours')?.click()`);
    await sleep(800);
    await ev(`[...document.querySelectorAll('.dwin[data-app="services"] .dapp-act')].find((b) => b.textContent.includes('Stop') && b.getAttribute('aria-label').includes('backup'))?.click()`);
    const asked = await waitFor(`!!document.querySelector('dialog.sheet[open]') && document.querySelector('dialog.sheet[open]').textContent.includes('Stop backup.service?')`);
    check(P, 'Stop on one of your own services asks first, naming it', asked, J(await sheetButtons()));
    await shot('r3-stop-asks');
    await pressSheet('Cancel');
    await sleep(600);
    check(P, 'Cancel does nothing (no toast, still running)', await ev(`![...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('stopped')) && [...document.querySelectorAll('.dwin[data-app="services"] .dapp-tr')].some((r) => r.textContent.includes('backup.service') && r.textContent.includes('Running'))`));
    // SSH: the typed confirmation is red and its field is named.
    await ev(`[...document.querySelectorAll('.dwin[data-app="services"] .seg')].find((b) => b.textContent === 'The system\\'s')?.click()`);
    await waitFor(`[...document.querySelectorAll('.dwin[data-app="services"] .dapp-tr')].some((r) => r.textContent.includes('ssh.service'))`, 6000);
    await ev(`[...document.querySelectorAll('.dwin[data-app="services"] .dapp-act')].find((b) => b.getAttribute('aria-label') === 'Stop ssh.service')?.click()`);
    check(P, 'stopping SSH asks for its name, with a red button and a named field', await waitFor(`(() => { const d = document.querySelector('dialog.sheet[open]'); return d && d.querySelector('button.btn.danger') && d.querySelector('input.field[aria-label="Type ssh.service to confirm"]'); })()`), J(await sheetButtons()));
    await shot('r3-ssh-typed');
    await pressSheet('Cancel');

    // An answer for the old scope that arrives after the switch is dropped.
    await ev(`(() => {
      const real = window.fetch;
      window.fetch = (u, o) => (String(u).includes('/api/services?scope=user') ? new Promise((r) => setTimeout(r, 1500)).then(() => real(u, o)) : real(u, o));
      return true;
    })()`);
    await ev(`[...document.querySelectorAll('.dwin[data-app="services"] .seg')].find((b) => b.textContent === 'Yours')?.click()`);
    await sleep(100);
    await ev(`[...document.querySelectorAll('.dwin[data-app="services"] .seg')].find((b) => b.textContent === 'The system\\'s')?.click()`);
    await sleep(2600);
    const scopes = await ev(`[...new Set([...document.querySelectorAll('.dwin[data-app="services"] .dapp-act')].map((b) => b.dataset.scope))]`);
    check(P, 'a slow answer for the other list is dropped: every button acts on the list shown', J(scopes) === J(['system']) && (await ev(`[...document.querySelectorAll('.dwin[data-app="services"] .seg')].find((b) => b.getAttribute('aria-checked') === 'true' && /Yours|system/.test(b.textContent)).textContent`)) === 'The system\'s', J(scopes));

    // Escape gives the keyboard back: the start menu and the computer menu.
    await ev(`document.querySelector('.desk-start').focus()`);
    await key('Enter', 'Enter', 0, 13);
    await waitFor(`!!document.querySelector('.desk-pop')`);
    await key('Escape', 'Escape', 0, 27);
    check(P, 'Escape closes the start menu and the keyboard is back on Start', await waitFor(`!document.querySelector('.desk-pop') && document.activeElement && document.activeElement.classList.contains('desk-start')`));
    await ev(`document.querySelector('.desk-pc').focus()`);
    await key('Enter', 'Enter', 0, 13);
    await waitFor(`!!document.querySelector('.desk-menu')`);
    await key('Escape', 'Escape', 0, 27);
    check(P, 'Escape closes the computer menu and the keyboard is back on its button', await waitFor(`!document.querySelector('.desk-menu') && document.activeElement && document.activeElement.classList.contains('desk-pc')`));
    await closeAll();
  }

  // ---------- a shell that ends inside its Terminal window ----------
  if (want('ended')) {
    const P = 'ended';
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': null, 'desktop.style': null, 'page.theme': 'light' } });
    const frameDoc = `document.querySelector('.dwin[data-app="terminal"] iframe').contentDocument`;
    const frameHash = () => ev(`(() => { const f = document.querySelector('.dwin[data-app="terminal"] iframe'); return f ? f.contentWindow.location.hash : null; })()`);
    const titles = () => ev(`[...document.querySelectorAll('.dwin-title, .desk-task')].map((e) => e.textContent.trim())`);
    const newTerminal = async () => {
      await launch('terminal');
      await waitFor(`!!document.querySelector('.dwin[data-app="terminal"] iframe')`, 10000);
      await waitFor(`(() => { const d = ${frameDoc}; return d && d.querySelector('.sessbar') && d.querySelector('.term-overlay.hidden'); })()`, 10000);
      await sleep(500);
      return ev(`decodeURIComponent((/\\/s\\/([^/?]+)$/.exec(new URL(document.querySelector('.dwin[data-app="terminal"] iframe').src).hash) || [])[1] || '')`);
    };
    const gone = () => waitFor(`!document.querySelector('.dwin[data-app="terminal"]')`, 6000);
    const noSheet = () => ev(`!document.querySelector('dialog.sheet[open]')`);
    const noErrorToast = () => ev(`![...document.querySelectorAll('.toast.error')].length`);

    // 1. `exit` typed in the shell: the window offers to close, and stays on its own page.
    const name1 = await newTerminal();
    const hash1 = await frameHash();
    const plainShell = () => ev(`(() => { const d = ${frameDoc}; const q = d.querySelector('.quick'); return !!q && q.classList.contains('hidden'); })()`);
    check(P, 'a new shell offers no quick messages for Claude from the start', await plainShell());
    await click(...center(await rectOf(`${winSel('terminal')} .dwin-body`)));
    await sleep(300);
    await chrome.send('Input.insertText', { text: 'exit' });
    await key('Enter', 'Enter', 0, 13);
    const ended = await waitFor(`(() => { const d = ${frameDoc}; const o = d && d.querySelector('.term-overlay:not(.hidden)'); return o && o.textContent.includes('This session has ended.'); })()`, 10000);
    check(P, '`exit` in a Terminal window: the window says the session has ended', ended, name1);
    const offer = await ev(`(() => { const o = ${frameDoc}.querySelector('.term-overlay'); return [...o.querySelectorAll('a, button')].map((b) => b.textContent.trim() + (b.getAttribute('href') ? ' ' + b.getAttribute('href') : '')); })()`);
    check(P, 'it offers "Close window", not a way to Home', J(offer) === J(['Close window']), J(offer));
    check(P, 'and still none once it has ended', await plainShell());
    check(P, 'the window still shows its own session (not Home)', (await frameHash()) === hash1 && !(await titles()).includes('Home'), `${await frameHash()} ${J(await titles())}`);
    await shot('r6-terminal-ended');
    await ev(`${frameDoc}.querySelector('.term-overlay button').click()`);
    check(P, '"Close window" closes it, and asks nothing (the shell is gone)', (await gone()) && (await noSheet()) && (await noErrorToast()));

    // 2. ⋯ → End session inside a Terminal window: the window closes; it never goes to Home.
    await newTerminal();
    const seen = [];
    const watch = setInterval(async () => seen.push(await frameHash().catch(() => null)), 100);
    await ev(`${frameDoc}.querySelector('.sessbar-end button[title="More for this session"]').click()`);
    await waitFor(`!!${frameDoc}.querySelector('dialog.sheet[open] button.choice')`);
    await ev(`[...${frameDoc}.querySelectorAll('dialog.sheet[open] button.choice')].find((b) => b.textContent.includes('End session')).click()`);
    await waitFor(`!!${frameDoc}.querySelector('dialog.sheet[open] button.btn.danger')`);
    await ev(`${frameDoc}.querySelector('dialog.sheet[open] button.btn.danger').click()`);
    const closed2 = await gone();
    clearInterval(watch);
    check(P, 'End session in a Terminal window closes the window, asking nothing more', closed2 && (await noSheet()) && (await noErrorToast()));
    check(P, 'and its page never went to Home on the way', !seen.includes('#/') && !(await titles()).includes('Home'), J([...new Set(seen)]));

    // 3. The window of a shell that ended elsewhere: × closes it at once.
    const name3 = await newTerminal();
    await ev(`fetch('/api/sessions/${encodeURIComponent(name3)}/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status)`);
    await sleep(800);
    await click(...center(await rectOf(`${winSel('terminal')} .dwin-btn[data-act="x"]`)));
    const closed3 = await gone();
    check(P, '× on the window of a shell that has ended closes it without asking', closed3 && (await noSheet()) && (await noErrorToast()), J(await sheetButtons()));
    await shot('r6-ended-shell-closed');

    // 4. The shell ends while the "End the shell?" sheet is open: End closes the window, no error.
    const name4 = await newTerminal();
    await click(...center(await rectOf(`${winSel('terminal')} .dwin-btn[data-act="x"]`)));
    await waitFor(`!!document.querySelector('dialog.sheet[open]')`);
    await ev(`fetch('/api/sessions/${encodeURIComponent(name4)}/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status)`);
    await sleep(500);
    await pressSheet('End the shell');
    check(P, '"End the shell" for a shell that ended meanwhile closes the window, with no error', (await gone()) && (await noErrorToast()),
      await ev(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`));
    await closeAll();
  }

  // ---------- another computer: its Sessions only ----------
  if (want('laptop')) {
    const P = 'laptop';
    await open('#/m/laptop/desktop', { w: 1440, h: 900, prefs: { 'desktop.laptop': null, 'desktop.style': null } });
    const has = await waitFor(`window.__hoprigStore && window.__hoprigStore.all.length > 1`, 12000);
    check(P, 'the demo has a second computer', has);
    if (has) {
      await launch('sessions');
      await waitFor(`(() => { const f = document.querySelector('.dwin[data-app="sessions"] iframe'); const d = f && f.contentDocument; return d && d.querySelectorAll('article.card').length > 0; })()`, 10000);
      const want2 = await store(`(s.all.find((m) => m.machine === 'laptop') || { sessions: [] }).sessions.length`);
      const got = await inFrame('sessions', `d.querySelectorAll('article.card').length`);
      check(P, 'the Laptop\'s Sessions window shows the Laptop\'s sessions only', got === want2 && got > 0, `${got} of ${want2}`);
      check(P, 'it is called Sessions and has no computer chips', (await ev(`document.querySelector('.dwin[data-app="sessions"] .dwin-title').textContent`)) === 'Sessions' && (await inFrame('sessions', `!d.querySelector('.mchips')`)));
      const start = await inFrame('sessions', `({ hash: w.location.hash, home: new URLSearchParams(w.location.search).get('home'), back: d.querySelectorAll('.pagehead-back').length, gs: d.querySelectorAll('.gs-area').length, add: (d.querySelector('a.pagehead-primary') || {}).getAttribute && d.querySelector('a.pagehead-primary').getAttribute('href') })`);
      check(P, 'its start page has no way back: it starts where its page lands', start.hash === '#/' && start.home === '#/' && start.back === 0, J(start));
      check(P, 'it has no Get started (that is the dashboard\'s, of this computer)', start.gs === 0, J(start));
      check(P, 'its New session starts on the Laptop', start.add === '#/m/laptop/new', J(start));
      await shot('r4-laptop-sessions');
      await inFrame('sessions', `(d.querySelector('article.card a') || d.querySelector('article.card')).click()`);
      check(P, 'a Laptop session opened in it: its way back says "Sessions"', await waitFor(`(() => { const d = document.querySelector('.dwin[data-app="sessions"] iframe').contentDocument; const b = d.querySelector('.pagehead-back, .sessback, .chatback'); return b && b.textContent.trim() === 'Sessions'; })()`, 8000));
      await inFrame('sessions', `d.querySelector('.pagehead-back, .sessback, .chatback').click()`);
      await waitFor(`document.querySelector('.dwin[data-app="sessions"] .dwin-title').textContent === 'Sessions'`, 6000);
      await waitFor(`(() => { const d = document.querySelector('.dwin[data-app="sessions"] iframe').contentDocument; return d.querySelectorAll('article.card').length > 0; })()`, 8000);
      const back = await inFrame('sessions', `({ hash: w.location.hash, cards: d.querySelectorAll('article.card').length, back: d.querySelectorAll('.pagehead-back').length })`);
      check(P, 'and leads back to the Laptop\'s list, with no way back there', back.hash === '#/' && back.cards === want2 && back.back === 0, J(back));
    }
  }

  // ---------- a session page outside the desktop, on a phone: unchanged ----------
  if (want('phone')) {
    const P = 'phone';
    const made = await ev(`fetch('/api/shells', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())`);
    await open('#/workspace', { w: 390, h: 844, mobile: true, theme: 'dark', prefs: { 'page.theme': 'dark' } });
    await ev(`location.hash = ${J(`#/s/${encodeURIComponent(made.name)}`)}`);
    await waitFor(`!!document.querySelector('.term-overlay.hidden')`, 10000);
    await sleep(500);
    await ev(`fetch('/api/sessions/${encodeURIComponent(made.name)}/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status)`);
    const shown = await waitFor(`(() => { const o = document.querySelector('.term-overlay:not(.hidden)'); return o && o.textContent.includes('This session has ended.'); })()`, 10000);
    const offer = await ev(`[...document.querySelectorAll('.term-overlay a, .term-overlay button')].map((b) => [b.textContent.trim(), b.getAttribute('href')])`);
    check(P, 'outside the desktop an ended session still leads back to where it came from (Workspace)', shown && offer.length === 1 && offer[0][0] === 'Back to Workspace' && offer[0][1] === '#/workspace', J(offer));
    check(P, 'no sideways scroll', await ev(`document.documentElement.scrollWidth <= innerWidth`));
    await shot('r7-phone-dark-ended');
  }

  // ---------- 1024 × 600: the buttons of a new window inside it ----------
  if (want('narrow')) {
    const P = 'narrow';
    await open('#/desktop', { w: 1024, h: 600, prefs: { 'desktop.~': null, 'desktop.style': null, 'page.theme': 'light' } });
    for (const app of ['services', 'tasks']) {
      await launch(app);
      await waitFor(`document.querySelectorAll('.dwin[data-app="${app}"] .dapp-tbody .dapp-tr').length > 2`, 10000);
      await sleep(600);
      const fit = await ev(`(() => {
        const w = document.querySelector('.dwin[data-app="${app}"]');
        const t = w.querySelector('.dapp-table');
        const wr = w.getBoundingClientRect();
        const btns = [...w.querySelectorAll('.dapp-act, .dapp-end, .dapp-lock')].filter((b) => b.offsetWidth);
        return { win: Math.round(wr.width), table: t.clientWidth, scroll: t.scrollWidth, out: btns.filter((b) => b.getBoundingClientRect().right > wr.right - 2).length, n: btns.length };
      })()`);
      check(P, `a new ${app} window: its buttons inside it, no sideways scroll in the table`, fit.n > 0 && fit.out === 0 && fit.scroll <= fit.table + 1, J(fit));
      await shot(`r5-1024-${app}`);
      await ev(`document.querySelector('.dwin[data-app="${app}"] .dwin-btn[data-act="x"]').click()`);
      await sleep(300);
    }
  }

  await finish();
} catch (e) {
  check('run', 'the run finished', false, e.stack || e.message);
} finally {
  await done();
}
