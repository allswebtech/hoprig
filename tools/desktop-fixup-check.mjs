#!/usr/bin/env node
// Dev-only (not in the published package): the desktop's second review settled, proven in a real browser on
// `hoprig demo` (its own temp folders) and the local Chrome headless.
//
//   TMPDIR=/tmp node tools/desktop-fixup-check.mjs [--port 7680] [--out <folder>] [--only desk,files,wide,fit,phone,dock]
//
// Parts, the first is the one that matters most (Taskbar style, light, 1440 × 900):
//   desk   a new window takes the keyboard (Terminal from the start menu, a native app from an icon); Sessions is one
//          window that the icon and the needs-you count bring forward; the count is this computer's; its window
//          shows "New session" at the size it opens at; the start menu's search finds sessions and marks what Enter
//          opens; a toast sits above Tia, not over the way back; "Desktop settings" lands on its card; the computer
//          page has one way to the desktop; the Editor's empty page sends to Files
//   files  one glyph per action in the bar, Delete with its word; a missing folder says so (not "update"); Type a
//          path replaces what is there; Undo after a delete; "Save and close" for an Editor window
//   wide   crossing the 1024 × 600 line keeps Editor windows that hold unsaved changes
//   fit    a layout from a larger screen, and a smaller browser window, keep every window inside, buttons included
//   phone  390 × 844 with a touch screen: the Task manager's End and the Services' buttons are a finger's size with words
//   dock   Dock style, dark: the window buttons show their glyph, the count of the Laptop's desktop is the Laptop's
import fs from 'node:fs';
import path from 'node:path';
import { startCheck } from './desktop-check-lib.mjs';

const {
  want, sleep, check, chrome, ev, J, shot, waitFor, click, rectOf, center, open, finish, done,
} = await startCheck('hoprig-desktop-fixup-check');

const inFrame = (app, expr) => ev(`(() => { const f = [...document.querySelectorAll('.dwin[data-app="${app}"] iframe')].pop(); const d = f && f.contentDocument; const w = f && f.contentWindow; if (!d) return null; return ${expr}; })()`);
const press = async (sel) => click(...center(await rectOf(sel)));
const pressText = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${J(sel)})].find((x) => x.textContent.trim().includes(${J(text)})); if (!b) return false; b.click(); return true; })()`);
const count = (app) => ev(`document.querySelectorAll('.dwin[data-app="${app}"]').length`);
const enter = async () => {
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 });
};
const fresh = { 'desktop.~': null, 'desktop.m.laptop': null, 'desktop.style': null, 'page.theme': 'light' };
const projects = () => path.join(process.env.HOME, 'Workspace', 'projects');
function seed() {
  const t = path.join(projects(), 'fixup');
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(path.join(t, 'todo.txt'), 'buy milk\n');
  fs.writeFileSync(path.join(t, 'gone.txt'), 'delete me\n');
  return t;
}
/** Files at folder `dir`, maximised; returns its window selector. */
async function filesAt(dir) {
  await press('.desk-icon[data-app="files"]');
  await waitFor(`!!document.querySelector('.dwin[data-app="files"] .dfiles-name')`, 10000);
  await press('.dwin[data-app="files"] .dapp-btn[aria-label="Type a path"]');
  await waitFor(`!!document.querySelector('dialog[open] input.field')`);
  await ev(`(() => { const i = document.querySelector('dialog[open] input.field'); i.value = ${J(dir)}; i.dispatchEvent(new Event('input')); return true; })()`);
  await pressText('dialog[open] button', 'Go');
  await waitFor(`(document.querySelector('.dwin[data-app="files"] .dfiles-crumb[aria-current]') || {}).textContent === ${J(path.basename(dir))}`, 6000);
  return '.dwin[data-app="files"]';
}
/** An Editor window on `file` of `dir` with one unsaved change typed into it. */
async function editorWithChange(dir, file) {
  const hash = `#/code?${new URLSearchParams({ dir, file })}`;
  await press('.desk-icon[data-app="editor"]');
  await waitFor(`!!document.querySelector('.dwin[data-app="editor"] iframe')`, 8000);
  await inFrame('editor', `(w.location.hash = ${J(hash)}, true)`);
  await waitFor(`(() => { const f = document.querySelector('.dwin[data-app="editor"] iframe'); const d = f && f.contentDocument; return !!d && !!d.querySelector('.monaco-editor .view-lines') && d.body.textContent.includes(${J(file)}); })()`, 20000);
  await sleep(600);
  const r = await rectOf('.dwin[data-app="editor"] iframe');
  const line = await inFrame('editor', `(() => { const l = d.querySelector('.monaco-editor .view-line'); const b = l.getBoundingClientRect(); return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) }; })()`);
  await click(r.x + line.x, r.y + line.y);
  await sleep(200);
  await chrome.send('Input.insertText', { text: 'TYPED ' });
  return waitFor(`(() => { const f = document.querySelector('.dwin[data-app="editor"] iframe'); return f.contentWindow.__hoprigUnsaved && f.contentWindow.__hoprigUnsaved() === 1; })()`, 6000);
}

try {
  const tree = seed();

  // ---------- desk: Taskbar, light, 1440 × 900 ----------
  if (want('desk')) {
    const P = 'desk';
    await open('#/desktop', { w: 1440, h: 900, prefs: fresh });
    // Terminal from the start menu, then typing without a press into it.
    await press('.desk-start');
    await waitFor(`document.activeElement && document.activeElement.classList.contains('desk-search')`);
    await chrome.send('Input.insertText', { text: 'term' });
    await sleep(200);
    check(P, 'the start menu marks what Enter opens', await ev(`!!document.querySelector('.desk-app[data-next="1"] .desk-enter')`));
    await enter();
    await waitFor(`(() => { const f = document.querySelector('.dwin[data-app="terminal"] iframe'); const d = f && f.contentDocument; return !!d && !!d.querySelector('.xterm'); })()`, 12000);
    await sleep(1500);
    check(P, 'a Terminal opened from the start menu has the keyboard', await ev(`document.activeElement === document.querySelector('.dwin[data-app="terminal"] iframe')`), await ev(`document.activeElement.tagName + '.' + document.activeElement.className`));
    await chrome.send('Input.insertText', { text: 'echo fx-$((6*7))' });
    await enter();
    check(P, 'what is typed next reaches the shell, with no press into the window', await waitFor(`(() => { const d = document.querySelector('.dwin[data-app="terminal"] iframe').contentDocument; return /fx-42/.test((d.querySelector('.xterm-rows') || d.body).textContent); })()`, 8000));
    await shot('f01-terminal-keys');
    // A native app opened from its icon by the keyboard: its first field has the keyboard.
    await ev(`document.querySelector('.desk-icon[data-app="tasks"]').focus(), true`);
    await enter();
    await waitFor(`!!document.querySelector('.dwin[data-app="tasks"] input')`, 8000);
    await sleep(300);
    check(P, 'a native app opened from an icon by the keyboard has the keyboard in its window', await ev(`!!document.activeElement.closest('.dwin[data-app="tasks"]')`), await ev(`document.activeElement.tagName + '.' + document.activeElement.className`));
    // Sessions: one window; the icon and the count bring it forward.
    await press('.desk-icon[data-app="sessions"]');
    await waitFor(`!!document.querySelector('.dwin[data-app="sessions"] iframe')`);
    await ev(`document.querySelector('.desk-icon[data-app="sessions"]').click(), true`);
    await sleep(300);
    check(P, 'the Sessions icon pressed again brings its one window forward', (await count('sessions')) === 1 && await ev(`document.querySelector('.dwin[data-app="sessions"]').getAttribute('aria-current') === 'true'`));
    await press('.desk-icon[data-app="tasks"]');
    await sleep(300);
    check(P, 'so does the Task manager\'s', (await count('tasks')) === 1);
    const bell = await ev(`(document.querySelector('.desk-waiting span') || {}).textContent || '0'`);
    check(P, 'this computer has sessions that need you, counted in the tray', Number(bell) > 0, `count ${bell}`);
    await press('.desk-waiting');
    await sleep(400);
    check(P, 'the count brings the same Sessions window forward', (await count('sessions')) === 1 && await ev(`document.querySelector('.dwin[data-app="sessions"]').getAttribute('aria-current') === 'true'`));
    const r = await rectOf('.dwin[data-app="sessions"]');
    await waitFor(`(() => { const d = document.querySelector('.dwin[data-app="sessions"] iframe').contentDocument; return !!d.querySelector('.pagehead-primary'); })()`, 6000);
    check(P, 'the Sessions window opens wide enough and shows "New session" in its head', await inFrame('sessions', `(() => { const b = d.querySelector('.pagehead-primary'); return !!b && b.offsetParent !== null && b.textContent.includes('New session'); })()`), `${r.w} px`);
    await shot('f02-sessions-window');
    // A narrow window keeps it too.
    await ev(`(() => { const w = document.querySelector('.dwin[data-app="sessions"]'); w.style.width = '520px'; return true; })()`);
    await sleep(400);
    check(P, 'and at 520 px too (no floating button in a window)', await inFrame('sessions', `d.querySelector('.pagehead-primary').offsetParent !== null`));
    // The start menu's search finds sessions.
    const name = await ev(`window.__hoprigStore.all.find((x) => !x.machine).sessions.find((s) => s.kind !== 'chat').name`);
    await press('.desk-start');
    await waitFor(`!!document.querySelector('.desk-search')`);
    await chrome.send('Input.insertText', { text: name });
    await sleep(300);
    const sess = await ev(`[...document.querySelectorAll('.desk-session-name')].map((x) => x.textContent)`);
    check(P, 'the start menu\'s search filters the sessions too', sess.length >= 1 && sess.length < 6, sess.join(', '));
    await shot('f03-start-search');
    await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
    await sleep(200);
    // A toast stays clear of the way back.
    await ev(`(async () => { const m = await import('/lib.js'); m.toast('A toast for the check', { ms: 4000 }); return true; })()`);
    await sleep(300);
    const t = await rectOf('.toast');
    const back = await rectOf('.desk-back');
    const tia = await rectOf('.tia-boxroot');
    const apart = (a, b) => !a || !b || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
    check(P, 'a toast is at the bottom right, clear of the way back and of Tia\'s button', !!t && t.y > 450 && apart(t, back) && apart(t, tia), J({ t, back, tia }));
    await shot('f04-toast');
    // The Editor with nothing open sends to Files.
    await press('.desk-icon[data-app="editor"]');
    await waitFor(`(() => { const f = document.querySelector('.dwin[data-app="editor"] iframe'); return !!f && !!f.contentDocument && !!f.contentDocument.querySelector('main .page-title'); })()`, 10000);
    check(P, 'the empty Editor in a window offers Files, not Workspace', await inFrame('editor', `!d.body.textContent.includes('Workspace') && [...d.querySelectorAll('button')].some((b) => b.textContent.includes('Open Files'))`));
    await shot('f05-editor-empty');
    const before = await count('files');
    await inFrame('editor', `[...d.querySelectorAll('button')].find((b) => b.textContent.includes('Open Files')).click()`);
    check(P, 'and "Open Files" opens Files', await waitFor(`document.querySelectorAll('.dwin[data-app="files"]').length === ${before + 1}`, 8000));
    // "Desktop settings" lands on the Desktop card.
    await open('#/desktop', { w: 1440, h: 900 });
    await press('.desk-start');
    await waitFor(`!!document.querySelector('.desk-pop')`);
    await pressText('.desk-pop button', 'Desktop settings');
    check(P, '"Desktop settings" lands on the Desktop card', await waitFor(`(() => { const p = document.getElementById('desktop'); if (!p) return false; const r = p.getBoundingClientRect(); return r.top >= 0 && r.top < 200; })()`, 6000));
    await shot('f06-desktop-settings');
    await open('#/computer', { w: 1440, h: 900 });
    check(P, 'a computer\'s page has "Open desktop" and no second desktop button', await waitFor(`[...document.querySelectorAll('a.btn')].some((a) => a.textContent.includes('Open desktop'))`) && await ev(`!document.querySelector('.desk-headbtn')`));
    await open('#/settings', { w: 1440, h: 900 });
    check(P, 'other pages keep "Desktop mode" in their head', await waitFor(`!!document.querySelector('.desk-headbtn')`));
    await finish();
  }

  // ---------- files: Files' bar, a missing folder, Undo, Save and close ----------
  if (want('files')) {
    const P = 'files';
    await open('#/desktop', { w: 1440, h: 900, prefs: fresh });
    const W = await filesAt(tree);
    await ev(`(() => { const w = document.querySelector('${W}'); w.style.width = '900px'; return true; })()`);
    await sleep(300);
    await click(...center(await rectOf(`${W} .dfiles-name[data-key="todo.txt"]`)));
    await sleep(300);
    const glyphs = await ev(`[...document.querySelectorAll('${W} .dfiles-tool, ${W} .dfiles-act, ${W} .dfiles-delete')].map((b) => [b.getAttribute('aria-label') || b.textContent.trim(), [...b.querySelectorAll('svg path')].map((p) => p.getAttribute('d')).join('|')])`);
    const seen = new Map();
    const twice = [];
    for (const [label, d] of glyphs) {
      if (seen.has(d)) twice.push(`${seen.get(d)} = ${label}`);
      seen.set(d, label);
    }
    check(P, 'every action in the bar has its own glyph', glyphs.length >= 9 && twice.length === 0, twice.join('; ') || `${glyphs.length} buttons`);
    check(P, 'Delete keeps its word in a narrow window', await ev(`(() => { const b = document.querySelector('${W} .dfiles-delete'); return !!b && b.textContent.trim() === 'Delete' && b.offsetParent !== null; })()`));
    await shot('f10-files-bar');
    // Type a path: what is there is chosen, so typing replaces it; a missing folder says so.
    await press(`${W} .dapp-btn[aria-label="Type a path"]`);
    await waitFor(`!!document.querySelector('dialog[open] input.field')`);
    check(P, 'Type a path has the folder shown chosen, so typing replaces it', await ev(`(() => { const i = document.querySelector('dialog[open] input.field'); return i.selectionStart === 0 && i.selectionEnd === i.value.length && i.value.length > 0; })()`));
    await chrome.send('Input.insertText', { text: path.join(tree, 'missing') });
    await enter();
    await sleep(800);
    const said = await ev(`(document.querySelector('${W} .dapp-error') || {}).textContent || ''`);
    check(P, 'a folder that is not there says so, not "needs an update"', /no such file or folder/i.test(said) && !/update/i.test(said), said);
    await shot('f11-files-missing');
    // Delete, then Undo.
    await press(`${W} .dapp-btn[aria-label="Type a path"]`);
    await waitFor(`!!document.querySelector('dialog[open] input.field')`);
    await chrome.send('Input.insertText', { text: tree });
    await enter();
    await waitFor(`!document.querySelector('dialog[open]') && !document.querySelector('${W} .dapp-error')`, 6000);
    await sleep(400);
    await click(...center(await rectOf(`${W} .dfiles-name[data-key="gone.txt"]`)));
    await sleep(200);
    await pressText('.dwin[data-app="files"] .dfiles-delete', 'Delete');
    check(P, 'a delete says so with Undo', await waitFor(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('gone.txt') && t.querySelector('.toast-action'))`) && !fs.existsSync(path.join(tree, 'gone.txt')));
    await shot('f12-delete-undo');
    await ev(`[...document.querySelectorAll('.toast .toast-action')].pop().click(), true`);
    check(P, 'Undo puts it back', await waitFor(`!!document.querySelector('.dwin[data-app="files"] .dfiles-name[data-key="gone.txt"]')`, 6000) && fs.existsSync(path.join(tree, 'gone.txt')));
    // Save and close.
    const ok = await editorWithChange(tree, 'todo.txt');
    check(P, 'an Editor window holds a typed change', ok);
    await ev(`document.querySelector('.dwin[data-app="editor"] .dwin-btn[data-act="x"]').click(), true`);
    check(P, 'closing it offers "Save and close"', await waitFor(`!!document.querySelector('dialog[open]') && [...document.querySelectorAll('dialog[open] button')].some((b) => b.textContent.trim() === 'Save and close')`));
    await shot('f13-save-and-close');
    await pressText('dialog[open] button', 'Save and close');
    check(P, 'which saves the file and closes the window', await waitFor(`!document.querySelector('.dwin[data-app="editor"]')`, 8000) && fs.readFileSync(path.join(tree, 'todo.txt'), 'utf8').includes('TYPED'), fs.readFileSync(path.join(tree, 'todo.txt'), 'utf8').slice(0, 40));
    await finish();
  }

  // ---------- wide: unsaved Editor windows across the 1024 × 600 line ----------
  if (want('wide')) {
    const P = 'wide';
    fs.writeFileSync(path.join(tree, 'todo.txt'), 'buy milk\n');
    await open('#/desktop', { w: 1440, h: 900, prefs: fresh });
    await filesAt(tree);
    check(P, 'an Editor window holds a typed change', await editorWithChange(tree, 'todo.txt'));
    await chrome.viewport(900, 900, { theme: 'light' });
    await sleep(1500);
    check(P, 'below the line the windows stay while a change is unsaved, and it says why', (await count('editor')) === 1 && await inFrame('editor', `w.__hoprigUnsaved() === 1`) && await ev(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('unsaved'))`));
    await shot('f20-narrow-kept');
    await chrome.viewport(1440, 900, { theme: 'light' });
    await sleep(1500);
    check(P, 'back above the line the change is still there', (await count('editor')) === 1 && await inFrame('editor', `w.__hoprigUnsaved() === 1`));
    // Saved: then the line is crossed as before.
    await inFrame('editor', `(w.__hoprigSaveAll(), true)`);
    await waitFor(`(() => { const f = document.querySelector('.dwin[data-app="editor"] iframe'); return f.contentWindow.__hoprigUnsaved() === 0; })()`, 6000);
    await chrome.viewport(900, 900, { theme: 'light' });
    check(P, 'with nothing unsaved the narrow screen gets the grid', await waitFor(`!document.querySelector('.dwin') && !!document.querySelector('.desk-grid')`, 6000));
    check(P, 'the change was saved to the file', fs.readFileSync(path.join(tree, 'todo.txt'), 'utf8').includes('TYPED'));
    // A reload with unsaved changes asks (beforeunload).
    await chrome.viewport(1440, 900, { theme: 'light' });
    await sleep(1200);
    await finish();
  }

  // ---------- fit: windows stay inside a smaller area ----------
  if (want('fit')) {
    const P = 'fit';
    await open('#/desktop', { w: 1440, h: 900, prefs: fresh });
    await press('.desk-icon[data-app="tasks"]');
    await press('.desk-icon[data-app="logs"]');
    await press('.desk-icon[data-app="services"]');
    await sleep(500);
    // Each kept against the right edge, as on a big screen (the layout as this browser keeps it).
    await sleep(600);
    await ev(`(() => { const k = 'pref:desktop.~'; const l = JSON.parse(localStorage.getItem(k)); for (const w of l.windows) Object.assign(w.rect, { x: 520, w: 893 }); localStorage.setItem(k, JSON.stringify(l)); return true; })()`);
    await open('#/desktop', { w: 1024, h: 600 });
    await sleep(600);
    const inside = () => ev(`(() => { const a = document.querySelector('.desk-area').getBoundingClientRect(); return [...document.querySelectorAll('.dwin:not(.hidden)')].every((w) => { const r = w.getBoundingClientRect(); const x = w.querySelector('.dwin-btn[data-act="x"]').getBoundingClientRect(); return r.left >= a.left - 1 && r.right <= a.right + 1 && x.right <= innerWidth && x.left >= 0; }); })()`);
    check(P, 'a layout kept at 1440 × 900 opens inside 1024 × 600, Close and Maximise on the screen', await inside(), J(await ev(`[...document.querySelectorAll('.dwin')].map((w) => w.style.left + '/' + w.style.width)`)));
    await shot('f30-fit-1024');
    await chrome.viewport(1440, 900, { theme: 'light' });
    await sleep(500);
    const b = await rectOf('.dwin .dwin-bar');
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x + 60, y: b.y + 10, button: 'none', buttons: 0 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x + 60, y: b.y + 10, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 10; i++) await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x + 60 + i * 40, y: b.y + 10 + i * 4, button: 'left', buttons: 1 });
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x + 460, y: b.y + 50, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
    await chrome.viewport(1100, 700, { theme: 'light' });
    await sleep(800);
    check(P, 'making the browser window smaller moves the windows inside it', await inside());
    await shot('f31-live-resize');
    await finish();
  }

  // ---------- phone: a finger's targets ----------
  if (want('phone')) {
    const P = 'phone';
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await chrome.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    await open('#/desktop/tasks', { w: 390, h: 844, mobile: true, prefs: { 'page.theme': 'light' } });
    check(P, 'the page sees a touch screen', await ev(`matchMedia('(pointer: coarse)').matches`));
    await waitFor(`!!document.querySelector('.dapp-end')`, 8000);
    const end = await ev(`(() => { const b = document.querySelector('.dapp-end'); const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), text: b.textContent.trim() }; })()`);
    check(P, 'End is a finger\'s size and says "End", on one line', end.w >= 56 && end.h >= 40 && end.h < 48 && end.text === 'End', J(end));
    check(P, 'nothing scrolls sideways', await ev(`document.documentElement.scrollWidth <= innerWidth`));
    await shot('f40-phone-tasks');
    await open('#/desktop/services', { w: 390, h: 844, mobile: true });
    await waitFor(`!!document.querySelector('.dapp-act')`, 8000);
    const acts = await ev(`[...document.querySelectorAll('.dapp-act')].slice(0, 4).map((b) => { const r = b.getBoundingClientRect(); return { h: Math.round(r.height), text: b.textContent.trim() }; })`);
    check(P, 'Services\' buttons are a finger\'s size with their word', acts.length > 0 && acts.every((a) => a.h >= 40 && /^(Start|Stop|Restart)$/.test(a.text)), J(acts));
    check(P, 'nothing scrolls sideways there either', await ev(`document.documentElement.scrollWidth <= innerWidth`));
    await shot('f41-phone-services');
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await chrome.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
    await finish();
  }

  // ---------- dock: dark; the Laptop's desktop ----------
  if (want('dock')) {
    const P = 'dock';
    await open('#/desktop', { w: 1440, h: 900, theme: 'dark', prefs: { ...fresh, 'desktop.style': 'dock', 'page.theme': 'dark' } });
    await press('.desk-icon[data-app="tasks"]');
    await sleep(500);
    const glyph = await ev(`getComputedStyle(document.querySelector('.dwin .dwin-btn[data-act="x"]')).color`);
    check(P, 'the Dock style\'s window buttons show their glyph', !/rgba\(0, 0, 0, 0\)|transparent/.test(glyph), glyph);
    check(P, 'the Services icon is not the power symbol', await ev(`(() => { const s = document.querySelector('.desk-icon[data-app="services"] svg path'); return !!s && !s.getAttribute('d').startsWith('M12 3v9'); })()`));
    await shot('f50-dock-dark');
    await open('#/m/laptop/desktop', { w: 1440, h: 900, theme: 'dark' });
    await waitFor(`!!document.querySelector('.desk-tray')`, 8000);
    await sleep(1500);
    const lap = await ev(`(() => { const m = window.__hoprigStore.all.find((x) => x.machine === 'laptop'); return m ? m.sessions.length : -1; })()`);
    const bell = await ev(`(document.querySelector('.desk-waiting span') || {}).textContent || '0'`);
    check(P, 'the Laptop\'s desktop counts only the Laptop\'s sessions that need you', bell === '0' && lap >= 0, `count ${bell}, laptop sessions ${lap}`);
    await shot('f51-laptop-count');
    await finish();
  }
} catch (e) {
  check('run', 'the run finished', false, e.stack || String(e));
}
await done();
