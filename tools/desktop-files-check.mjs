#!/usr/bin/env node
// Dev-only (not in the published package): Files and the Editor as apps of the desktop, proven in a real browser on
// `hoprig demo` (its own temp folders; a small tree of this check's own in the demo's projects folder).
//
//   TMPDIR=/tmp node tools/desktop-files-check.mjs [--port 7680] [--out <folder>] [--only files,dock,phone,reach,laptop]
//
// Parts, the first is the one that matters most: files (Taskbar style, light, 1440 × 900: browse, open a text file
// in the Editor window, new folder, rename, copy, move, delete and put back, upload, download, pack and unpack, a
// refused path, Show in Files from the Editor, the unsaved-changes question), then dock (Dock style, dark,
// 1024 × 600), phone (390 × 844: the grid, Files as a page), reach (the setting in Settings → Security; its
// check opens /usr of this computer, read only, so its screenshots stay where they are written) and laptop (another
// computer's Files through the hub).
import fs from 'node:fs';
import path from 'node:path';
import { startCheck } from './desktop-check-lib.mjs';

const {
  OUT, want, sleep, check, chrome, ev, J, shot, waitFor, click, dblclick, rectOf, center, open, finish, done,
} = await startCheck('hoprig-desktop-files-check');

const W = '.dwin[data-app="files"]';
const press = async (sel) => click(...center(await rectOf(sel)));
const pressLabel = (sel, label) => ev(`(() => { const b = document.querySelector(${J(`${sel}[aria-label=${J(label)}]`)}); if (!b) return false; b.click(); return true; })()`);
const pressText = (sel, text) => ev(`(() => { const b = [...document.querySelectorAll(${J(sel)})].find((x) => x.textContent.trim().includes(${J(text)})); if (!b) return false; b.click(); return true; })()`);
const toast = (re) => waitFor(`[...document.querySelectorAll('.toast')].some((t) => ${re}.test(t.textContent))`, 8000);
const enter = async () => {
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 });
};
/** Type into the open sheet's field (replacing what is there) and send it. */
async function answer(text) {
  await waitFor(`!!document.querySelector('dialog[open] input.field')`);
  await ev(`(() => { const i = document.querySelector('dialog[open] input.field'); i.focus(); i.select(); return true; })()`);
  await chrome.send('Input.insertText', { text });
  await enter();
  await sleep(500);
}
const names = (win = W) => ev(`[...document.querySelectorAll(${J(`${win} .dfiles-label`)})].map((x) => x.textContent)`);
const rowSel = (name, win = W) => `${win} .dfiles-name[data-key=${J(name)}]`;
/** Choose one row by a press on it. */
const choose = async (name, win = W) => {
  await waitFor(`!!document.querySelector(${J(rowSel(name, win))})`);
  await press(rowSel(name, win));
  await sleep(200);
};
const openRow = async (name, win = W) => {
  await waitFor(`!!document.querySelector(${J(rowSel(name, win))})`);
  await dblclick(...center(await rectOf(rowSel(name, win))));
  await sleep(600);
};
const crumb = (win = W) => ev(`(document.querySelector(${J(`${win} .dfiles-crumb[aria-current]`)}) || {}).textContent || ''`);
/** Open Files on the desktop from its icon, maximised. */
async function openFiles() {
  await press('.desk-icon[data-app="files"]');
  await waitFor(`!!document.querySelector('${W} .dfiles-name')`, 10000);
  await ev(`document.querySelector('${W} .dwin-btn[data-act="square"]').click()`);
  await sleep(300);
}

// The check's own tree, inside the demo's projects folder (the demo runs in this process: HOME is its home now).
const projects = () => path.join(process.env.HOME, 'Workspace', 'projects');
function seedTree() {
  const t = path.join(projects(), 'notes');
  fs.mkdirSync(path.join(t, 'old'), { recursive: true });
  fs.writeFileSync(path.join(t, 'todo.txt'), 'buy milk\nwrite the report\n');
  fs.writeFileSync(path.join(t, 'old.txt'), 'last year\n');
  fs.writeFileSync(path.join(t, 'old', 'a.txt'), 'a\n');
  // A 2 × 2 picture (PNG).
  fs.writeFileSync(path.join(t, 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnxEIGBgYGBgYAAAX+wP9Rp0eTQAAAABJRU5ErkJggg==', 'base64'));
  const up = path.join(OUT, 'to-upload');
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, 'upload me.txt'), 'sent from the browser\n');
  return t;
}

try {
  const tree = seedTree();
  // ---------- 1. Files: Taskbar, light, 1440 × 900 ----------
  if (want('files')) {
    const P = 'files';
    const dl = path.join(OUT, 'downloads');
    fs.mkdirSync(dl, { recursive: true });
    await chrome.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': null, 'desktop.style': null, 'page.theme': 'light', 'files.hidden': null } });
    check(P, 'Files and the Editor are apps on the desktop', await ev(`!!document.querySelector('.desk-icon[data-app="files"]') && !!document.querySelector('.desk-icon[data-app="editor"]')`));
    await openFiles();
    check(P, 'it opens at the top of what it reaches, with the folders first', (await crumb()) === 'projects' && (await names()).includes('notes'), J(await names()));
    check(P, 'it says how far it reaches', await ev(`document.querySelector('${W} .dfiles-reach').textContent.includes('Files reaches one folder')`));
    await openRow('notes');
    check(P, 'a double press opens a folder; name, size, date and kind are shown', (await crumb()) === 'notes' && await waitFor(`(() => { const r = [...document.querySelectorAll('${W} .dapp-tbody .dapp-tr')].find((x) => x.textContent.includes('todo.txt')); return r && /26 B/.test(r.textContent) && /TXT file/.test(r.textContent); })()`), await ev(`document.querySelector('${W}').textContent.slice(0, 400)`));
    check(P, 'the window is called after its app and its folder', await waitFor(`document.querySelector('${W} .dwin-title').textContent === 'Files · notes'`));
    await shot('1-files-notes');

    // A text file opens in the Editor, as a window of the desktop.
    await openRow('todo.txt');
    check(P, 'a text file opens in an Editor window', await waitFor(`!!document.querySelector('.dwin[data-app="editor"] iframe')`, 8000));
    const edOk = await waitFor(`(() => { const f = document.querySelector('.dwin[data-app="editor"] iframe'); const d = f && f.contentDocument; return !!d && !!d.querySelector('.monaco-editor') && d.body.textContent.includes('todo.txt') && f.contentWindow.location.hash.includes('file=todo.txt'); })()`, 20000);
    check(P, 'the Editor shows that file, in bare mode', edOk && (await ev(`new URLSearchParams(document.querySelector('.dwin[data-app="editor"] iframe').contentWindow.location.search).get('bare')`)) === '1');
    await sleep(800);
    await shot('2-editor-window');
    // Show in Files from the Editor's Explorer: a Files window at that folder with the file chosen.
    const shown = await ev(`(async () => {
      const d = document.querySelector('.dwin[data-app="editor"] iframe').contentDocument;
      const row = [...d.querySelectorAll('.ed-tree [role="treeitem"]')].find((r) => r.textContent.includes('old.txt'));
      if (!row) return 'no row';
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
      await new Promise((r) => setTimeout(r, 400));
      const b = [...d.querySelectorAll('dialog[open] .choice')].find((x) => x.textContent.includes('Show in Files'));
      if (!b) return 'no item';
      b.click();
      return 'ok';
    })()`);
    check(P, 'the Editor\'s Explorer has "Show in Files"', shown === 'ok', shown);
    check(P, 'it opens Files at that folder with the file chosen', await waitFor(`(() => { const ws = [...document.querySelectorAll('${W}')]; const w = ws[ws.length - 1]; return ws.length === 2 && !!w.querySelector('.dapp-picked .dfiles-name[data-key="old.txt"]'); })()`, 8000));
    await ev(`(() => { const ws = [...document.querySelectorAll('${W}')]; ws[ws.length - 1].querySelector('.dwin-btn[data-act="x"]').click(); return true; })()`);
    // Closing an Editor window with unsaved changes asks first (the editor says how many).
    await ev(`(() => { document.querySelector('.dwin[data-app="editor"] iframe').contentWindow.__hoprigUnsaved = () => 1; document.querySelector('.dwin[data-app="editor"] .dwin-btn[data-act="x"]').click(); return true; })()`);
    check(P, 'closing an Editor window with unsaved changes asks first', await waitFor(`!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').textContent.includes('Close without saving')`));
    await pressText('dialog[open] button', 'Cancel');
    await sleep(300);
    check(P, 'Cancel keeps the window', await ev(`!!document.querySelector('.dwin[data-app="editor"]')`));
    await ev(`(() => { document.querySelector('.dwin[data-app="editor"] iframe').contentWindow.__hoprigUnsaved = () => 0; document.querySelector('.dwin[data-app="editor"] .dwin-btn[data-act="x"]').click(); return true; })()`);
    await waitFor(`!document.querySelector('.dwin[data-app="editor"]')`);
    await ev(`(() => { const w = document.querySelector('${W}'); if (w.getAttribute('aria-current') !== 'true') document.querySelector('.desk-task[data-id="' + w.dataset.id + '"]').click(); return true; })()`);
    await sleep(300);

    // New folder, rename, copy, move.
    await pressText(`${W} .dfiles-tool`, 'New folder');
    await answer('drafts');
    check(P, 'New folder makes it, and chooses it', fs.existsSync(path.join(tree, 'drafts')) && await waitFor(`!!document.querySelector('${W} .dapp-picked .dfiles-name[data-key="drafts"]')`));
    await choose('todo.txt');
    await pressLabel(`${W} .dfiles-act`, 'Rename');
    await answer('todo-renamed.txt');
    check(P, 'Rename', fs.existsSync(path.join(tree, 'todo-renamed.txt')) && !fs.existsSync(path.join(tree, 'todo.txt')) && await waitFor(`!!document.querySelector('${rowSel('todo-renamed.txt')}')`));
    await choose('todo-renamed.txt');
    await pressLabel(`${W} .dfiles-act`, 'Copy to…');
    check(P, '"Copy to" shows a folder picker', await waitFor(`[...document.querySelectorAll('dialog[open] .dfiles-pick')].some((b) => b.textContent.includes('drafts'))`));
    await shot('3-files-copy-to');
    await pressText('dialog[open] .dfiles-pick', 'drafts');
    await waitFor(`document.querySelector('dialog[open] .dfiles-pickpath').textContent.endsWith('drafts')`);
    await pressText('dialog[open] button', 'Copy here');
    check(P, 'Copy to a folder', await toast(/Copied todo-renamed\.txt/) && fs.existsSync(path.join(tree, 'drafts', 'todo-renamed.txt')) && fs.existsSync(path.join(tree, 'todo-renamed.txt')));
    await choose('dot.png');
    await pressLabel(`${W} .dfiles-act`, 'Move to…');
    await waitFor(`[...document.querySelectorAll('dialog[open] .dfiles-pick')].some((b) => b.textContent.includes('drafts'))`);
    await pressText('dialog[open] .dfiles-pick', 'drafts');
    await waitFor(`document.querySelector('dialog[open] .dfiles-pickpath').textContent.endsWith('drafts')`);
    await pressText('dialog[open] button', 'Move here');
    check(P, 'Move to a folder', await toast(/Moved dot\.png/) && fs.existsSync(path.join(tree, 'drafts', 'dot.png')) && !fs.existsSync(path.join(tree, 'dot.png')));

    // A picture shows in a small viewer.
    await openRow('drafts');
    await openRow('dot.png');
    check(P, 'a picture shows in a viewer', await waitFor(`(() => { const i = document.querySelector('dialog[open] .dfiles-viewer img'); return !!i && i.complete && i.naturalWidth === 2; })()`));
    await shot('4-files-picture');
    await pressText('dialog[open] button', 'Close');
    await press(`${W} .dapp-btn[aria-label="Up one folder"]`);
    await waitFor(`${J('notes')} === (document.querySelector('${W} .dfiles-crumb[aria-current]') || {}).textContent`);

    // Delete into the trash, and put it back.
    await choose('old.txt');
    await pressText(`${W} .dfiles-delete`, 'Delete');
    check(P, 'Delete moves it to the trash', await toast(/to the trash/) && !fs.existsSync(path.join(tree, 'old.txt')));
    await pressText(`${W} .dfiles-tool`, 'Trash');
    check(P, 'the Trash shows it with where it was', await waitFor(`[...document.querySelectorAll('${W} .dapp-tbody .dapp-tr')].some((r) => r.textContent.includes('old.txt') && r.textContent.includes('notes'))`));
    await shot('5-files-trash');
    await pressText(`${W} .dapp-tbody button`, 'Put back');
    check(P, 'Put back brings it back where it was', await toast(/old\.txt is back/) && fs.readFileSync(path.join(tree, 'old.txt'), 'utf8') === 'last year\n');
    await pressText(`${W} button`, 'Back to the files');
    await waitFor(`!!document.querySelector('${rowSel('old.txt')}')`);

    // Upload with the button's file field, then download it.
    const input = await chrome.send('Runtime.evaluate', { expression: `document.querySelector('${W} input[type="file"]')` });
    await chrome.send('DOM.setFileInputFiles', { objectId: input.result.objectId, files: [path.join(OUT, 'to-upload', 'upload me.txt')] });
    check(P, 'Upload puts the file in the folder shown', await toast(/Uploaded upload me\.txt/) && fs.readFileSync(path.join(tree, 'upload me.txt'), 'utf8') === 'sent from the browser\n');
    check(P, 'and chooses it', await waitFor(`!!document.querySelector('${W} .dapp-picked .dfiles-name[data-key="upload me.txt"]')`));
    const before = await ev('location.href');
    await pressLabel(`${W} .dfiles-act`, 'Download');
    const got = path.join(dl, 'upload me.txt');
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      await sleep(250);
      ok = fs.existsSync(got) && fs.readFileSync(got, 'utf8') === 'sent from the browser\n';
    }
    check(P, 'Download saves the same bytes as a file', ok);
    check(P, 'the download never leaves the desktop', (await ev('location.href')) === before && await ev(`!!document.querySelector('${W}')`));
    // A file dropped on the window from the browser's computer is uploaded the same way.
    const dropped = await ev(`(() => {
      const el = document.querySelector('${W} .dapp-files');
      if (!el) return 'no Files body';
      const dt = new DataTransfer();
      dt.items.add(new File(['dropped in\\n'], 'dropped.txt', { type: 'text/plain' }));
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const shown = el.classList.contains('dfiles-drop');
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return shown && !el.classList.contains('dfiles-drop') ? 'ok' : 'no drop mark';
    })()`);
    let landed = false;
    for (let i = 0; i < 40 && !landed; i++) {
      await sleep(250);
      landed = fs.existsSync(path.join(tree, 'dropped.txt')) && fs.readFileSync(path.join(tree, 'dropped.txt'), 'utf8') === 'dropped in\n';
    }
    check(P, `a file dropped on the window is uploaded there (${dropped})`, dropped === 'ok' && landed);

    // Pack into an archive and unpack it.
    await choose('drafts');
    await pressLabel(`${W} .dfiles-act`, 'Pack into an archive');
    await answer('drafts');
    check(P, 'Pack makes a .tar.gz next to it', await toast(/Packed into drafts\.tar\.gz/) && fs.existsSync(path.join(tree, 'drafts.tar.gz')));
    await openRow('drafts.tar.gz');
    check(P, 'an archive offers to unpack it', await waitFor(`!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').textContent.includes('Unpack')`));
    await pressText('dialog[open] button', 'Unpack');
    check(P, 'Unpack makes a new folder next to it', await toast(/Unpacked into drafts \(2\)/) && fs.readFileSync(path.join(tree, 'drafts (2)', 'drafts', 'todo-renamed.txt'), 'utf8').includes('buy milk'));
    await shot('6-files-packed');

    // Find by name in this folder.
    await press(`${W} .dapp-filter`);
    await chrome.send('Input.insertText', { text: 'renamed' });
    await enter();
    check(P, 'find by name lists the matches with their folders', await waitFor(`document.querySelectorAll('${W} .dfiles-where').length === 3`), J(await names()));
    await shot('7-files-find');
    await ev(`(() => { const f = document.querySelector('${W} .dapp-filter'); f.value = ''; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);

    // A path it may not open is refused, in words.
    await press(`${W} .dapp-btn[aria-label="Type a path"]`);
    await answer('/etc');
    check(P, 'a path outside the reach is refused in plain words', await waitFor(`/not one the dashboard may show/i.test(document.querySelector('${W} .dapp-error') ? document.querySelector('${W} .dapp-error').textContent : '')`));
    check(P, 'and nothing outside was listed', !(await names()).includes('passwd'));
    await shot('8-files-refused');
    // The layout keeps the folder: a reload opens Files where it was.
    await sleep(600);
    await open('#/desktop', { w: 1440, h: 900 });
    check(P, 'a reload brings the Files window back at its folder', await waitFor(`(document.querySelector('${W} .dfiles-crumb[aria-current]') || {}).textContent === 'notes'`, 10000));
    await finish();
  }

  // ---------- 2. Dock, dark, 1024 × 600 ----------
  if (want('dock')) {
    const P = 'dock';
    await open('#/desktop', { w: 1024, h: 600, theme: 'dark', prefs: { 'desktop.~': null, 'desktop.style': 'dock', 'page.theme': 'dark' } });
    await openFiles();
    check(P, 'Files in the Dock style, dark', await ev(`document.body.dataset.deskStyle === 'dock' && document.documentElement.getAttribute('data-theme') === 'dark' && !!document.querySelector('${W} .dfiles-name')`));
    await openRow('notes');
    check(P, 'a double press opens a folder', await waitFor(`(document.querySelector('${W} .dfiles-crumb[aria-current]') || {}).textContent === 'notes'`), await ev(`document.querySelector('${W}').textContent.slice(0, 300)`));
    await choose('old.txt');
    check(P, 'the chosen row and its actions fit the window', await ev(`(() => { const w = document.querySelector('${W}').getBoundingClientRect(); return [...document.querySelectorAll('${W} .dfiles-tools button, ${W} .dfiles-more')].every((b) => { const r = b.getBoundingClientRect(); return r.right <= w.right + 1 && r.width > 0; }); })()`));
    check(P, 'nothing scrolls sideways', await ev(`document.documentElement.scrollWidth <= innerWidth`));
    await shot('9-dock-dark-1024');
    await finish();
  }

  // ---------- 3. the phone: the grid, Files as a page ----------
  if (want('phone')) {
    const P = 'phone';
    await open('#/desktop', { w: 390, h: 844, mobile: true, prefs: { 'page.theme': 'light' } });
    check(P, 'the grid has Files and the Editor', await ev(`!!document.querySelector('.desk-tile[data-app="files"]') && !!document.querySelector('.desk-tile[data-app="editor"]') && !document.querySelector('.dwin')`));
    await press('.desk-tile[data-app="files"]');
    check(P, 'Files opens as a page', await waitFor(`location.hash.startsWith('#/desktop/files') && !!document.querySelector('.dapp-files .dfiles-name')`, 8000));
    await openRow('notes', '.dapp-files');
    check(P, 'the page\'s address follows its folder', await waitFor(`decodeURIComponent(location.hash).includes('/notes')`));
    check(P, 'nothing scrolls sideways', await ev(`document.documentElement.scrollWidth <= innerWidth`));
    await shot('10-phone-files');
    await finish();
  }

  // ---------- 4. how far Files reaches: Settings → Security ----------
  if (want('reach')) {
    const P = 'reach';
    await open('#/settings/security', { w: 1440, h: 900, prefs: { 'page.theme': 'light' } });
    check(P, 'Settings → Security has "Files reach", the allowed folders by default', await waitFor(`(() => { const p = document.getElementById('reach'); return !!p && p.querySelector('[aria-checked="true"]').textContent === 'Allowed folders'; })()`));
    await shot('12-settings-reach');
    await pressText('#reach .seg', 'Everything');
    check(P, 'Everything asks first', await waitFor(`!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').textContent.includes('Let Files open everything?')`));
    await pressText('dialog[open] button', 'Open everything');
    check(P, 'Everything is saved', await waitFor(`document.querySelector('#reach [aria-checked="true"]').textContent === 'Everything'`));
    await open('#/desktop', { w: 1440, h: 900, prefs: { 'desktop.~': null } });
    await openFiles();
    await press(`${W} .dapp-btn[aria-label="Type a path"]`);
    await answer('/usr');
    check(P, 'then Files opens folders outside the home folder', await waitFor(`(document.querySelector('${W} .dfiles-crumb[aria-current]') || {}).textContent === 'usr'`) && await ev(`document.querySelector('${W} .dfiles-reach').textContent.includes('everything your user can open')`));
    await open('#/settings/security', { w: 1440, h: 900 });
    await waitFor(`!!document.getElementById('reach')`);
    await pressText('#reach .seg', 'Allowed folders');
    check(P, 'and back to the allowed folders', await waitFor(`document.querySelector('#reach [aria-checked="true"]').textContent === 'Allowed folders'`));
    await finish();
  }

  // ---------- 5. another computer through the hub ----------
  if (want('laptop')) {
    const P = 'laptop';
    await open('#/m/laptop/desktop', { w: 1440, h: 900, prefs: { 'desktop.m.laptop': null, 'desktop.style': null, 'page.theme': 'light' } });
    await openFiles();
    check(P, 'the Laptop\'s Files is read through the hub', await waitFor(`performance.getEntriesByType('resource').some((e) => e.name.includes('/m/laptop/api/files/list'))`) && (await names()).length > 0, J(await names()));
    const input = await chrome.send('Runtime.evaluate', { expression: `document.querySelector('${W} input[type="file"]')` });
    await chrome.send('DOM.setFileInputFiles', { objectId: input.result.objectId, files: [path.join(OUT, 'to-upload', 'upload me.txt')] });
    check(P, 'an upload goes to the Laptop through the hub', await toast(/Uploaded upload me\.txt/) && await ev(`performance.getEntriesByType('resource').some((e) => e.name.includes('/m/laptop/api/files/upload'))`));
    await shot('11-laptop-files');
    await finish();
  }
} catch (e) {
  check('run', 'no step threw', false, e.stack);
} finally {
  await done();
}
