#!/usr/bin/env node
// Dev-only (not in the published package): what the editor's reviews found, in a real browser on `hoprig demo` (its
// own temp folders; a made-up project "shop" of this check's own in the demo's projects folder).
//
//   TMPDIR=/tmp node tools/editor-review-check.mjs [--port 7680] [--out <folder>] [--only replace,tabs,...]
//
// Parts (1440 px light first, then 390 px with touch):
//   replace   Replace All writes what its dialog counts and its preview shows (every match on a line, line by line,
//             anchors, non-ASCII whole words), skips and names a file changed since the search, keeps a late match
//             of a long line in view
//   tabs      a pinned tab stays on a middle click and the close key; the tab's own buttons take Enter; Close All
//             from the menu by keyboard leaves the keyboard somewhere; the tab menu's Reveal names no VS Code key
//   status    "Tab Size" for a file indented with tabs; several cursors as VS Code words them; Alt+Z for this file only
//   explorer  F2 selects the name without its extension; the Explorer's badge counts unsaved files; Ctrl+B with the
//             keyboard in the side bar moves it to the editor
//   keys      Ctrl+K Ctrl+Alt+C copies the path; Ctrl+1 goes to the editor; Ctrl+Shift+J in Search shows the details;
//             a tree row dropped on the code editor types nothing into the file
//   quick     with no file open, quick open lists files again once ">" is gone, and tells a screen reader its choice
//   terminal  Ctrl+P in the terminal panel opens quick open
//   phone     390 px, touch: the terminal panel keeps its key bar; Search's buttons have the kit's tap size
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startCheck } from './desktop-check-lib.mjs';

const { want, sleep, check, chrome, ev, J, waitFor, open, finish, done, shot } = await startCheck('hoprig-editor-review-check');

const SHOP = path.join(process.env.HOME, 'Workspace', 'projects', 'shop');
const put = (p, t) => {
  fs.mkdirSync(path.dirname(path.join(SHOP, p)), { recursive: true });
  fs.writeFileSync(path.join(SHOP, p), t);
};
const disk = (p) => fs.readFileSync(path.join(SHOP, p), 'utf8');
put('README.md', '# Shop\n\nThe price list.\n');
put('src/app.js', 'export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price;\n  return sum;\n}\n');
put('tabbed.js', 'function a() {\n\treturn 1;\n}\n');
put('notes.txt', 'price list\n');
put('long.txt', `${'word '.repeat(30)}and at last the price\n`);

chrome.on((j) => {
  if (j.method === 'Page.javascriptDialogOpening') chrome.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
});

const MODS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const SPECIAL = {
  Enter: ['Enter', 'Enter', 13], Escape: ['Escape', 'Escape', 27], Down: ['ArrowDown', 'ArrowDown', 40], Up: ['ArrowUp', 'ArrowUp', 38],
  Tab: ['Tab', 'Tab', 9], F2: ['F2', 'F2', 113], F10: ['F10', 'F10', 121], '`': ['`', 'Backquote', 192], Space: [' ', 'Space', 32],
};
/** Send a key or a chord ("Ctrl+K Ctrl+Alt+C") through the DevTools protocol, as a keyboard does. */
async function send(chord) {
  for (const s of chord.split(' ')) {
    const parts = s.split('+');
    const name = parts.pop();
    let mods = 0;
    for (const p of parts) mods |= MODS[p];
    let key; let code; let vk;
    if (SPECIAL[name]) [key, code, vk] = SPECIAL[name];
    else if (/^[A-Za-z]$/.test(name)) [key, code, vk] = [mods & 8 ? name.toUpperCase() : name.toLowerCase(), `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
    else if (/^\d$/.test(name)) [key, code, vk] = [name, `Digit${name}`, name.charCodeAt(0)];
    else throw new Error(`no key ${name}`);
    const text = !(mods & 7) && (name === 'Enter' ? '\r' : name === 'Space' ? ' ' : '');
    await chrome.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods, ...(text ? { text } : {}) });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods });
    await sleep(150);
  }
  await sleep(500);
}
const ED = `monaco.editor.getEditors().find((x) => x.getModel() && x.getDomNode().offsetParent)`;
const hashOf = (q) => `#/code?${new URLSearchParams({ dir: SHOP, ...q })}`;
async function editor(q = { file: 'src/app.js' }, view = {}) {
  await open(hashOf(q), { w: 1440, h: 900, theme: 'light', wait: 1200, ...view });
  if (!q.file) return waitFor(`!!document.querySelector('.ed-tree [role=treeitem]')`, 10000);
  return waitFor(`!!(window.monaco && ${ED})`, 15000);
}
const focusEd = (line = 1, col = 1) => ev(`(() => { const e = ${ED}; e.focus(); e.setPosition({ lineNumber: ${line}, column: ${col} }); return true; })()`);
const focusRow = (p) => ev(`(() => { const r = [...document.querySelectorAll('.ed-tree [role=treeitem]')].find((x) => x.dataset.path === ${J(p)}); if (r) r.focus(); return !!r; })()`);
const toasts = () => ev(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
const clearToasts = () => ev(`([...document.querySelectorAll('.toast')].forEach((t) => t.remove()), true)`);
const active = () => ev(`(() => { const a = document.activeElement; return a ? a.tagName + (a.className ? '.' + String(a.className).split(' ')[0] : '') : ''; })()`);
const pref = (k) => ev(`(() => { try { return localStorage.getItem(${J(`pref:${k}`)}); } catch { return 'no storage'; } })()`);
const tabNames = () => ev(`[...document.querySelectorAll('.ed-tab')].map((t) => t.querySelector('.ed-tab-name').textContent).join(',')`);

// ---------- replace ----------
/** Search `q` in the files of `include`, Replace with `by`; `meanwhile` runs after the preview, before the press. */
async function replace(q, by, { regex = false, word = false, include = '' } = {}, meanwhile = null) {
  await ev(`(() => { const f = document.querySelectorAll('.ed-flags .ed-flag'); [false, ${word}, ${regex}].forEach((w, i) => { if ((f[i].getAttribute('aria-pressed') === 'true') !== w) f[i].click(); });
    document.querySelector('.ed-search-more').classList.remove('hidden'); document.querySelectorAll('.ed-search-glob')[0].value = ${J(include)};
    const r = document.querySelector('.ed-search-r'); r.value = ${J(by)};
    const i = document.querySelector('.ed-search-q'); i.value = ${J(q)}; i.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(400);
  await waitFor(`/result|No results/.test(document.querySelector('.ed-search .ed-panelnote').textContent)`, 8000);
  await ev(`(document.querySelector('.ed-search-r').dispatchEvent(new Event('input')), true)`);
  await sleep(300);
  const preview = await ev(`[...document.querySelectorAll('.ed-hit')].map((b) => ({ text: b.querySelector('.ed-hit-text').textContent, del: b.querySelectorAll('.ed-hit-del').length }))`);
  if (meanwhile) await meanwhile();
  await clearToasts();
  await ev(`(document.querySelector('.ed-search-replace button').click(), true)`);
  await waitFor(`!!document.querySelector('dialog[open]') || [...document.querySelectorAll('.toast')].some((t) => /Nothing to replace/.test(t.textContent))`, 8000);
  const early = await toasts();
  const dialog = await ev(`(document.querySelector('dialog[open] h2') || {}).textContent || 'no dialog'`);
  await ev(`(() => { const b = [...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === 'Replace'); if (b) b.click(); return !!b; })()`);
  if (dialog === 'no dialog') return { preview, dialog, toast: early };
  await waitFor(`[...document.querySelectorAll('.toast')].some((t) => /replaced in|skipped/.test(t.textContent))`, 8000);
  return { preview, dialog, toast: await toasts() };
}

async function replacePart() {
  put('twice.txt', 'price, price and price\none price\n');
  put('lines.txt', 'price\nlist\nprice\nend\n');
  put('anchors.txt', 'a\nb price\nb more\n');
  put('many.txt', 'price\n'.repeat(120));
  put('cafe.txt', 'café au lait\n');
  put('drift.txt', 'price one\n');
  check('replace', 'the editor opens (1440 px, light)', await editor());
  await focusEd();
  await send('Ctrl+Shift+H');
  let r = await replace('price', 'cost', { include: 'twice.txt' });
  check('replace', 'the preview strikes every match of a line', r.preview.map((x) => x.del).join(',') === '3,1', JSON.stringify(r.preview));
  check('replace', 'the dialog counts what is written: 4 matches, and 4 are written', /Replace 4 matches in 1 file/.test(r.dialog) && /^4 replaced in 1 file/.test(r.toast) && disk('twice.txt') === 'cost, cost and cost\none cost\n', `${r.dialog} / ${r.toast} / ${J(disk('twice.txt'))}`);
  await shot('1440-light-replace-twice');
  r = await replace('price', 'cost', { include: 'many.txt' });
  check('replace', 'a file with more than 50 matches: the dialog says all 120', /Replace 120 matches/.test(r.dialog) && /^120 replaced/.test(r.toast), `${r.dialog} / ${r.toast}`);
  r = await replace('price\\s*', 'cost', { regex: true, include: 'lines.txt' });
  check('replace', 'a regular expression replaces inside a line, as it was found: no line end is eaten', disk('lines.txt') === 'cost\nlist\ncost\nend\n', `${r.toast} / ${J(disk('lines.txt'))}`);
  r = await replace('^b', 'B', { regex: true, include: 'anchors.txt' });
  check('replace', '^ is the start of each line, as in the search', disk('anchors.txt') === 'a\nB price\nB more\n', `${r.dialog} / ${r.toast} / ${J(disk('anchors.txt'))}`);
  r = await replace('café', 'tea', { word: true, include: 'cafe.txt' });
  check('replace', 'Match Whole Word replaces a word with a non-ASCII letter', disk('cafe.txt') === 'tea au lait\n', `${r.toast} / ${J(disk('cafe.txt'))}`);
  r = await replace('price', 'cost', { include: 'drift.txt' }, async () => put('drift.txt', 'price two, written by another program\nprice three\n'));
  check('replace', 'a file changed on disk since the search is skipped and named', disk('drift.txt') === 'price two, written by another program\nprice three\n' && /drift\.txt \(changed on disk since the search/.test(r.toast) && r.dialog === 'no dialog', `${r.dialog} / ${r.toast} / ${J(disk('drift.txt'))}`);
  // A match late in a long line: the line's start is cut so the match is in view (VS Code keeps 26 characters).
  await ev(`(() => { const i = document.querySelector('.ed-search-q'); document.querySelectorAll('.ed-search-glob')[0].value = 'long.txt'; i.value = 'price'; i.dispatchEvent(new Event('input')); return true; })()`);
  await waitFor(`!!document.querySelector('.ed-hit[title^="long.txt"] .ed-hit-del')`, 8000);
  const late = await ev(`(() => { const t = document.querySelector('.ed-hit[title^="long.txt"] .ed-hit-text'); const d = t.querySelector('.ed-hit-del').getBoundingClientRect(); const box = t.getBoundingClientRect(); return { text: t.textContent, inView: d.right <= box.right + 1 }; })()`);
  check('replace', 'a match late in a long line stays in view, the start cut with "…"', late.inView && late.text.startsWith('…'), J(late));
  await shot('1440-light-replace-late');
  // A second match past a long line's 200-character excerpt: named in the preview, counted and written.
  put('long2.txt', `price ${'x'.repeat(600)} price end\n`);
  r = await replace('price', 'cost', { include: 'long2.txt' });
  const more = await ev(`[...document.querySelectorAll('.ed-hit-more')].map((x) => x.textContent).join(',')`).catch(() => '');
  check('replace', 'a match past a long line\'s excerpt: "+1 more on this line", and the dialog says 2', /Replace 2 matches/.test(r.dialog) && disk('long2.txt') === `cost ${'x'.repeat(600)} cost end\n` && r.preview.length === 1, `${r.dialog} / ${r.toast} / ${J(r.preview)}`);
  put('long3.txt', `price ${'x'.repeat(600)} price end\n`);
  await ev(`(() => { const i = document.querySelector('.ed-search-q'); document.querySelectorAll('.ed-search-glob')[0].value = 'long3.txt'; i.value = 'price'; i.dispatchEvent(new Event('input')); return true; })()`);
  await waitFor(`!!document.querySelector('.ed-hit[title^="long3.txt"]')`, 8000);
  const named = await ev(`(document.querySelector('.ed-hit[title^="long3.txt"] .ed-hit-more') || {}).textContent || ''`);
  check('replace', 'the preview names the match it cannot show', named === '+1 more on this line', named || J(more));
  await shot('1440-light-replace-more');
  // A word that goes on with a combining mark is another word (ripgrep's \\w): only the first line changes.
  put('hindi.txt', 'कम है\nकमी है\n');
  r = await replace('कम', 'X', { word: true, include: 'hindi.txt' });
  check('replace', 'Match Whole Word leaves "कमी" (a vowel sign after the letter) whole', disk('hindi.txt') === 'X है\nकमी है\n' && /Replace 1 match /.test(r.dialog), `${r.dialog} / ${J(disk('hindi.txt'))}`);
  // A long minified line with Regex on: the count and the write take well under a second each.
  put('min.js', `${'var a=1;'.repeat(100000)}\n`);
  const t0 = Date.now();
  r = await replace('(v)ar', '$1-let', { regex: true, include: 'min.js' });
  const took = Date.now() - t0;
  check('replace', 'a regex Replace All over a line of 100,000 matches finishes in seconds, not minutes', /Replace 100,000 matches/.test(r.dialog) && disk('min.js').startsWith('v-let a=1;v-let') && took < 15000, `${r.dialog} / ${took} ms`);
}

// ---------- tabs ----------
async function tabsPart() {
  check('tabs', 'the editor opens', await editor({ file: 'README.md' }));
  await ev(`(location.hash = ${J(hashOf({ file: 'src/app.js' }))}, true)`);
  await waitFor(`document.querySelectorAll('.ed-tab').length === 2`);
  await sleep(600);
  await focusEd();
  await send('Ctrl+K Shift+Enter');
  const pinned = await ev(`!!document.querySelector('.ed-tab.pinned')`);
  const r = await ev(`(() => { const b = document.querySelector('.ed-tab.pinned').getBoundingClientRect(); return { x: b.x + 20, y: b.y + b.height / 2 }; })()`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await chrome.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'middle', buttons: type === 'mousePressed' ? 4 : 0, clickCount: 1 });
  await sleep(400);
  check('tabs', 'a middle click leaves a pinned tab open (VS Code: preventPinnedEditorClose)', pinned && /app\.js/.test(await tabNames()), await tabNames());
  await focusEd();
  await send('Ctrl+Shift+Alt+N');
  check('tabs', 'Close Editor\'s key leaves a pinned tab open', /app\.js/.test(await tabNames()), await tabNames());
  // The tab's own Unpin and Close buttons take Enter.
  await ev(`(document.querySelector('.ed-tab.pinned .ed-tab-x').focus(), true)`);
  await send('Enter');
  check('tabs', 'Enter on a tab\'s Unpin button unpins it', !(await ev(`!!document.querySelector('.ed-tab.pinned')`)));
  await ev(`(document.querySelector('.ed-tab:not(.on) .ed-tab-x').focus(), true)`);
  await send('Space');
  check('tabs', 'Space on a tab\'s Close button closes it', (await ev(`document.querySelectorAll('.ed-tab').length`)) === 1, await tabNames());
  // The menu by keyboard: Close All, and where the keyboard is then.
  await ev(`(location.hash = ${J(hashOf({ file: 'README.md' }))}, true)`);
  await waitFor(`document.querySelectorAll('.ed-tab').length === 2 && ${ED}.getModel().getValue().startsWith('# Shop')`);
  await sleep(300);
  await ev(`(document.querySelector('.ed-tab.on').focus(), true)`);
  await send('Shift+F10');
  const menu = await ev(`[...document.querySelectorAll('.desk-menu .desk-menu-item')].map((b) => b.textContent).join('|')`);
  check('tabs', 'the tab menu\'s Reveal in Explorer View names no VS Code key (VS Code\'s Ctrl+K R opens the system\'s file manager)', /Reveal in Explorer View/.test(menu) && !/Reveal in Explorer ViewCtrl\+K R/.test(menu), menu);
  await ev(`(() => { const b = [...document.querySelectorAll('.desk-menu .desk-menu-item')].find((x) => x.textContent.startsWith('Close All')); b.focus(); return true; })()`);
  await send('Enter');
  await sleep(500);
  const where = await active();
  check('tabs', 'Close All from the menu by keyboard leaves the keyboard on the page, not on its body', (await ev(`document.querySelectorAll('.ed-tab').length`)) === 0 && where !== 'BODY' && where !== '', where);
}

// ---------- status bar, word wrap ----------
async function statusPart() {
  check('status', 'tabbed.js opens', await editor({ file: 'tabbed.js' }));
  await sleep(400);
  const st = await ev(`document.querySelector('.ed-status').textContent`);
  const tabs = await ev(`${ED}.getModel().getOptions().insertSpaces`);
  check('status', 'a file indented with tabs: "Tab Size: 2", not "Spaces: 2"', tabs === false && /Tab Size: 2/.test(st) && !/Spaces/.test(st), st);
  await ev(`(location.hash = ${J(hashOf({ file: 'src/app.js' }))}, true)`);
  await waitFor(`/app\\.js/.test(document.querySelector('.ed-tab.on').textContent)`);
  await sleep(500);
  await ev(`(() => { const e = ${ED}; e.focus(); e.setSelection({ startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 10 }); return true; })()`);
  await send('Ctrl+D');
  const multi = await ev(`document.querySelector('.ed-status').textContent`);
  check('status', 'two cursors: "2 selections (6 characters selected)", as VS Code words it', /2 selections \(6 characters selected\)/.test(multi) && !/Ln \d+, Col \d+ \(2 selections\)/.test(multi), multi);
  const before = await pref('editor.wrap');
  await focusEd();
  await send('Alt+Z');
  const on = await ev(`${ED}.getOption(monaco.editor.EditorOption.wordWrap)`);
  check('status', 'Alt+Z wraps this file and leaves the Word Wrap setting as it was', on === 'on' && (await pref('editor.wrap')) === before, `wrap ${on}, setting ${before} -> ${await pref('editor.wrap')}`);
  // A Changes tab: Alt+Z wraps the diff too, as VS Code's toggle does.
  put('.gitignore', 'node_modules\n');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=Alex', '-c', 'user.email=alex@example.invalid', ...a], { cwd: SHOP, stdio: 'ignore' });
  if (!fs.existsSync(path.join(SHOP, '.git'))) {
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'start');
  }
  put('notes.txt', `price list, now with a line long enough to wrap: ${'word '.repeat(60)}\n`);
  await ev(`(location.hash = ${J(`#/code?${new URLSearchParams({ dir: SHOP, view: 'changes', file: 'notes.txt' })}`)}, true)`);
  const diffUp = await waitFor(`!!(monaco.editor.getDiffEditors && monaco.editor.getDiffEditors().some((d) => d.getModifiedEditor().getDomNode().offsetParent))`, 10000);
  const DIFF = `monaco.editor.getDiffEditors().find((d) => d.getModifiedEditor().getDomNode().offsetParent).getModifiedEditor()`;
  const was = diffUp && await ev(`${DIFF}.getOption(monaco.editor.EditorOption.wordWrap)`);
  await ev(`(${DIFF}.focus(), true)`);
  await send('Alt+Z');
  const now = diffUp && await ev(`${DIFF}.getOption(monaco.editor.EditorOption.wordWrap)`);
  check('status', 'Alt+Z in a Changes tab wraps the diff', diffUp && was !== now && now === (was === 'on' ? 'off' : 'on'), `${was} -> ${now}`);
  await shot('1440-light-diff-wrap');
}

// ---------- the Explorer ----------
async function explorerPart() {
  check('explorer', 'the editor opens', await editor());
  await focusRow('tabbed.js');
  await send('F2');
  await waitFor(`!!document.querySelector('dialog[open] input')`, 3000);
  const sel = await ev(`(() => { const i = document.querySelector('dialog[open] input'); return [i.value, i.selectionStart, i.selectionEnd]; })()`);
  check('explorer', 'F2 selects the name without its extension', J(sel) === J(['tabbed.js', 0, 6]), J(sel));
  await send('Escape');
  await focusEd(1, 1);
  await ev(`(${ED}.trigger('k', 'type', { text: 'x' }), true)`);
  await sleep(400);
  const badge = await ev(`(document.querySelector('.ed-act[aria-label="Explorer"] .ed-badge') || {}).textContent || ''`);
  check('explorer', 'an unsaved file: the Explorer\'s icon has a badge with the count', badge === '1', badge || 'no badge');
  await ev(`(${ED}.trigger('k', 'undo'), true)`);
  await focusRow('src');
  await send('Ctrl+B');
  const where = await active();
  check('explorer', 'Ctrl+B with the keyboard in the tree hides the side bar and moves the keyboard to the editor', (await ev(`document.querySelector('.ed-wrap').classList.contains('ed-noside')`)) && /TEXTAREA|native-edit-context|monaco/i.test(where), where);
  await send('Ctrl+B');
}

// ---------- keys ----------
async function keysPart() {
  check('keys', 'the editor opens', await editor());
  await focusEd(1, 1);
  await clearToasts();
  await send('Ctrl+K Ctrl+Alt+C');
  check('keys', 'Ctrl+K Ctrl+Alt+C in the editor copies the path (Copy Path)', /Copied .*src\/app\.js|did not allow the copy/.test(await toasts()), await toasts());
  // In the code editor Ctrl+Alt+C is not Copy Path (VS Code: when !editorFocus), and AltGr+C (Windows: Ctrl+Alt with
  // AltGraph) reaches the editor untouched.
  await clearToasts();
  await focusEd(1, 1);
  await send('Ctrl+Alt+C');
  check('keys', 'Ctrl+Alt+C in the code editor copies nothing', !/Copied|did not allow the copy/.test(await toasts()), await toasts());
  const altGr = await ev(`(() => { const e = new KeyboardEvent('keydown', { key: 'ć', code: 'KeyC', ctrlKey: true, altKey: true, modifierAltGraph: true, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(e); return [e.getModifierState('AltGraph'), e.defaultPrevented]; })()`);
  await sleep(300);
  check('keys', 'AltGr+C in the code editor is left to the editor (not taken, no copy)', altGr[0] === true && altGr[1] === false && !/Copied|did not allow the copy/.test(await toasts()), `${J(altGr)} ${await toasts()}`);
  await focusRow('notes.txt');
  await send('Ctrl+Alt+C');
  check('keys', 'Ctrl+Alt+C with the keyboard in the tree copies the path', /Copied|did not allow the copy/.test(await toasts()), await toasts());
  await focusRow('notes.txt');
  await send('Ctrl+1');
  check('keys', 'Ctrl+1 from the tree gives the editor the keyboard', /TEXTAREA|native-edit-context|monaco/i.test(await active()), await active());
  await send('Ctrl+Shift+F');
  const shut = await ev(`document.querySelector('.ed-search-more').classList.contains('hidden')`);
  await send('Ctrl+Shift+J');
  check('keys', 'Ctrl+Shift+J in Search shows the files to include and leave out', shut && !(await ev(`document.querySelector('.ed-search-more').classList.contains('hidden')`)));
  // A tree row dragged onto the code editor (the data the tree sets): it opens there, nothing is typed into the file.
  await ev(`(location.hash = ${J(hashOf({ file: 'src/app.js' }))}, true)`);
  await sleep(600);
  const before = await ev(`${ED}.getModel().getValue()`);
  const at = await ev(`(() => { const d = ${ED}.getDomNode().getBoundingClientRect(); return { x: d.x + 200, y: d.y + 40 }; })()`);
  const data = { items: [{ mimeType: 'application/x-hoprig-path', data: 'notes.txt' }], dragOperationsMask: 16 }; // what the tree sets
  for (const type of ['dragEnter', 'dragOver', 'drop']) await chrome.send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data });
  await sleep(800);
  const app = await ev(`(() => { const m = monaco.editor.getModels().find((x) => x.uri.path.endsWith('app.js') || x.getValue().startsWith('export function total')); return m ? m.getValue() : null; })()`);
  check('keys', 'a tree row dropped on the code editor types nothing into the file', app === before, J(app).slice(0, 120));
}

// ---------- quick open ----------
async function quickPart() {
  check('quick', 'the editor opens with no file', await editor({}));
  await focusRow('notes.txt');
  await send('Ctrl+Shift+P');
  const named = await ev(`(() => { const i = document.querySelector('.ed-quick-q'); return [i.getAttribute('aria-label'), i.getAttribute('role'), i.getAttribute('aria-controls')]; })()`);
  await send('Down');
  const chosen = await ev(`(() => { const i = document.querySelector('.ed-quick-q'); const id = i.getAttribute('aria-activedescendant'); const o = id && document.getElementById(id); return o ? [o.classList.contains('on'), o.getAttribute('aria-label') || o.textContent] : null; })()`);
  check('quick', 'the command list is named Commands, and the chosen row is told to a screen reader', named[0] === 'Commands' && named[1] === 'combobox' && !!named[2] && chosen && chosen[0] === true && /, Ctrl/.test(chosen[1]), J([named, chosen]));
  await ev(`(() => { const i = document.querySelector('.ed-quick-q'); i.value = 'notes'; i.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(1500);
  const list = await ev(`[...document.querySelectorAll('.ed-quick-item')].map((b) => b.textContent).join('|')`);
  await send('Enter');
  await sleep(1200);
  check('quick', 'without ">" quick open lists files again, and Enter opens notes.txt', /notes\.txt/.test(await tabNames()), `${list.slice(0, 120)} / tabs: ${await tabNames()}`);
}

// ---------- the terminal panel ----------
const TERM = `document.querySelector('.ed-panelarea:not(.hidden) iframe.ed-termframe')`;
// The session page's own controls inside the panel: [what data-chrome says, the element's first class, its display].
const CHROME_PARTS = `[...${TERM}.contentDocument.querySelectorAll('[data-chrome]')].map((e) => [e.getAttribute('data-chrome'), e.className.split(' ')[0], getComputedStyle(e).display])`;
async function terminalPart() {
  check('terminal', 'the editor opens', await editor());
  await focusEd();
  await send('Ctrl+`');
  const up = await waitFor(`(() => { const f = ${TERM}; return !!(f && f.contentDocument && f.contentDocument.querySelector('.xterm-helper-textarea')); })()`, 20000);
  check('terminal', 'Ctrl+` opens the terminal panel', up);
  if (!up) return;
  await sleep(1500);
  // A headless browser has no mouse ("pointer: fine" is false), so it is emulated here; the key bar follows the frame's
  // own answer either way.
  await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'fine' }, { name: 'any-pointer', value: 'fine' }] }).catch(() => {});
  await sleep(300);
  const fine = await ev(`${TERM}.contentWindow.matchMedia('(pointer: fine)').matches`);
  const parts = await ev(CHROME_PARTS);
  check('terminal', 'the panel shows the terminal alone: the session page\'s bar, quick keys and message box are hidden by their data-chrome marker',
    ['sessbar', 'quick-row', 'composer'].every((c) => parts.some(([k, n, d]) => n === c && k === 'bar' && d === 'none')), J(parts));
  const keys = parts.find(([k]) => k === 'keys');
  check('terminal', `the key bar is hidden exactly where the frame has a mouse (pointer: fine is ${fine})`, keys && (keys[2] === 'none') === fine, J(keys));
  await chrome.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
  await shot('1440-light-terminal');
  await ev(`(${TERM}.contentDocument.querySelector('.xterm-helper-textarea').focus(), true)`);
  await send('Ctrl+P');
  check('terminal', 'Ctrl+P while the terminal has the keyboard opens quick open, as VS Code skips the shell for it', await waitFor(`!!document.querySelector('.ed-quick-veil:not(.hidden)')`, 2000));
  await send('Escape');
  await ev(`(${TERM}.contentDocument.querySelector('.xterm-helper-textarea').focus(), true)`);
  await send('Ctrl+`');
}

// ---------- 390 px, touch ----------
async function phonePart() {
  await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  try {
    check('phone', 'the editor opens at 390 px with touch', await editor({ file: 'src/app.js' }, { w: 390, h: 844, mobile: true }));
    await ev(`(document.querySelector('.ed-bar-end .btn[title="More"]').click(), true)`);
    await waitFor(`!!document.querySelector('dialog[open] .choice')`, 3000);
    await ev(`([...document.querySelectorAll('dialog[open] .choice')].find((b) => /Terminal/.test(b.textContent)).click(), true)`);
    const up = await waitFor(`(() => { const f = ${TERM}; return !!(f && f.contentDocument && f.contentDocument.querySelector('.keybar')); })()`, 20000);
    await sleep(1200);
    const bar = up && await ev(`(() => { const d = ${TERM}.contentDocument; const k = d.querySelector('.keybar'); return [getComputedStyle(k).display, k.getBoundingClientRect().height, getComputedStyle(d.querySelector('.composer') || d.body).display]; })()`);
    check('phone', 'the terminal panel keeps its key bar (Esc, Tab, Ctrl, arrows) on a touch screen', bar && bar[0] !== 'none' && bar[1] > 20, J(bar));
    const parts = up ? await ev(CHROME_PARTS) : [];
    check('phone', 'on a touch screen the panel hides the bar, quick keys and message box by their marker and keeps the key bar',
      parts.some(([k]) => k === 'bar') && parts.filter(([k]) => k === 'bar').every(([, , d]) => d === 'none') && parts.some(([k, , d]) => k === 'keys' && d !== 'none'), J(parts));
    await shot('390-light-terminal');
    await editor({ view: 'search' }, { w: 390, h: 844, mobile: true });
    await ev(`(document.querySelector('.ed-replace-toggle').click(), true)`);
    await sleep(300);
    const sizes = await ev(`[...document.querySelectorAll('.ed-search-replace .btn, .ed-flags .ed-flag, .ed-replace-toggle')].map((b) => { const r = b.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); })`);
    check('phone', 'Replace All, the Replace toggle and the three switches have the kit\'s tap size (38 px)', sizes.length === 5 && sizes.every((n) => n >= 38), J(sizes));
    await shot('390-light-search');
    await open(hashOf({ view: 'search' }), { w: 390, h: 844, mobile: true, theme: 'dark', prefs: { 'page.theme': 'dark' } });
    await waitFor(`!!document.querySelector('.ed-replace-toggle')`, 8000);
    await ev(`(() => { document.querySelector('.ed-replace-toggle').click(); const i = document.querySelector('.ed-search-q'); i.value = 'price'; i.dispatchEvent(new Event('input')); const r = document.querySelector('.ed-search-r'); r.value = 'cost'; r.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(1500);
    await shot('390-dark-search-replace');
  } finally {
    await chrome.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }
}

// Each part on its own: one that breaks off is a failure, and the next part still runs.
const PARTS = { replace: replacePart, tabs: tabsPart, status: statusPart, explorer: explorerPart, keys: keysPart, quick: quickPart, terminal: terminalPart, phone: phonePart };
for (const [name, part] of Object.entries(PARTS)) {
  if (!want(name)) continue;
  try {
    await part();
  } catch (e) {
    check(name, 'the part ran to its end', false, String(e.message).split('\n')[0]);
  }
}
await finish();
await done();
