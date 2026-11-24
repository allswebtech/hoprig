#!/usr/bin/env node
// Dev-only (not in the published package): the code editor (#/code) against VS Code's keys and ways, in a real
// browser on `hoprig demo` (its own temp folders; a made-up git project "alpha" of this check's own in the demo's
// projects folder: several languages, a change, a staged change, a big and a binary file).
//
//   TMPDIR=/tmp node tools/editor-check.mjs [--port 7680] [--out <folder>] [--only keys,flows,shots]
//
// keys:  every key of research/editor-parity.md is SENT through the DevTools protocol on a fresh page, and what
//        happened is written (keys.json, keys.md): the editor's command, nothing, or what the page did. A key the
//        browser itself keeps (Ctrl+W, Ctrl+T, Ctrl+Tab ...) reaches the page here, as it does in an installed app
//        window; in a browser tab Chrome keeps it (the table says so).
// flows: what the fixes promise, step by step (tab menu, replace across files, the terminal panel, the status bar).
// shots: the editor at 1440 px light, 390 px with touch, and dark, for a person to look at.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startCheck } from './desktop-check-lib.mjs';

const {
  OUT, want, sleep, check, chrome, ev, J, waitFor, click, rectOf, center, open, finish, done,
} = await startCheck('hoprig-editor-check');

// ---------- the project ----------
const projects = () => path.join(process.env.HOME, 'Workspace', 'projects');
const ALPHA = path.join(projects(), 'alpha');
const APP = 'export function total(items) {\n  let sum = 0;\n  for (const i of items) sum += i.price;\n  return sum;\n}\n\nexport function count(items) {\n  return items.length;\n}\n';
function seed() {
  fs.mkdirSync(path.join(ALPHA, 'src'), { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: ALPHA, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(ALPHA, 'src', 'app.js'), APP);
  fs.writeFileSync(path.join(ALPHA, 'src', 'style.css'), 'body { color: red; }\n.price { font-weight: bold; }\n');
  fs.writeFileSync(path.join(ALPHA, 'data.json'), '{"name":"alpha","price":3}\n');
  fs.writeFileSync(path.join(ALPHA, 'tool.py'), 'def total(items):\n    return sum(i.price for i in items)\n');
  fs.writeFileSync(path.join(ALPHA, 'README.md'), '# Alpha\n\nThe price of a shop item.\n');
  fs.writeFileSync(path.join(ALPHA, 'notes.txt'), 'price list\n');
  g('add', '.');
  g('-c', 'user.name=Alex', '-c', 'user.email=alex@example.com', 'commit', '-qm', 'first');
  fs.writeFileSync(path.join(ALPHA, 'README.md'), '# Alpha\n\nThe price of a shop item, changed.\n'); // a change
  fs.writeFileSync(path.join(ALPHA, 'tool.py'), 'def total(items):\n    return sum(i.price for i in items)  # staged\n');
  g('add', 'tool.py'); // a staged change
  fs.writeFileSync(path.join(ALPHA, 'big.log'), 'a line of a big log with a price in it\n'.repeat(60_000)); // 2.3 MB
  fs.writeFileSync(path.join(ALPHA, 'logo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnxEIGBgYGBgYAAAX+wP9Rp0eTQAAAABJRU5ErkJggg==', 'base64'));
}
seed();
const resetApp = () => fs.writeFileSync(path.join(ALPHA, 'src', 'app.js'), APP);

// A dialog ("leave this page?") is answered yes: the check goes from page to page on purpose.
chrome.on((j) => {
  if (j.method === 'Page.javascriptDialogOpening') chrome.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
});
// Every keydown the page gets is noted before the page's own listeners, and whether something took it.
await chrome.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__keys = []; addEventListener("keydown", (e) => window.__keys.push(e), true);' });

const hashOf = (q) => `#/code?${new URLSearchParams({ dir: ALPHA, ...q })}`;
async function openEditor(q = { file: 'src/app.js' }, view = {}) {
  await open(hashOf(q), { w: 1440, h: 900, theme: 'light', wait: 1200, ...view });
  const ok = await waitFor(`!!(window.monaco && monaco.editor.getEditors().some((e) => e.getModel() && e.hasWidgetFocus && e.getDomNode().offsetParent))`, 15000);
  return ok;
}
const focusEditor = (line = 2, col = 3) => ev(`(() => { const e = monaco.editor.getEditors().find((x) => x.getModel() && x.getDomNode().offsetParent); e.focus(); e.setPosition({ lineNumber: ${line}, column: ${col} }); return true; })()`);

// ---------- keys ----------
const MODS = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
const SPECIAL = {
  Up: ['ArrowUp', 'ArrowUp', 38], Down: ['ArrowDown', 'ArrowDown', 40], Left: ['ArrowLeft', 'ArrowLeft', 37], Right: ['ArrowRight', 'ArrowRight', 39],
  PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34], Tab: ['Tab', 'Tab', 9], Enter: ['Enter', 'Enter', 13], Escape: ['Escape', 'Escape', 27],
  Delete: ['Delete', 'Delete', 46], Home: ['Home', 'Home', 36], End: ['End', 'End', 35], Space: [' ', 'Space', 32],
  '`': ['`', 'Backquote', 192], '/': ['/', 'Slash', 191], '\\': ['\\', 'Backslash', 220], '=': ['=', 'Equal', 187], '-': ['-', 'Minus', 189], ',': [',', 'Comma', 188],
  '[': ['[', 'BracketLeft', 219], ']': [']', 'BracketRight', 221],
};
for (let i = 1; i <= 12; i++) SPECIAL[`F${i}`] = [`F${i}`, `F${i}`, 111 + i];
/** One stroke of a chord ("Ctrl+Shift+P") as a DevTools key event. */
function stroke(s) {
  const parts = s.split('+');
  const name = parts.pop() || '+';
  let mods = 0;
  for (const p of parts) mods |= MODS[p];
  let key; let code; let vk;
  if (SPECIAL[name]) [key, code, vk] = SPECIAL[name];
  else if (/^[A-Za-z]$/.test(name)) [key, code, vk] = [mods & 8 ? name.toUpperCase() : name.toLowerCase(), `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)];
  else if (/^\d$/.test(name)) [key, code, vk] = [name, `Digit${name}`, name.charCodeAt(0)];
  else throw new Error(`no key ${name}`);
  return { key, code, vk, mods };
}
async function send(chord) {
  for (const s of chord.split(' ')) {
    const k = stroke(s);
    await chrome.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.mods });
    await chrome.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.mods });
    await sleep(120);
  }
  await sleep(700);
}

// What the page shows now, to compare before and after a key.
const SNAP = `(() => {
  const ed = window.monaco && monaco.editor.getEditors().find((e) => e.getModel() && e.getDomNode().offsetParent);
  const m = ed && ed.getModel();
  const shown = (s) => [...document.querySelectorAll(s)].some((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden');
  const qi = [...document.querySelectorAll('.quick-input-widget')].find((x) => x.style.display !== 'none' && x.getClientRects().length > 0);
  const qin = qi && qi.querySelector('input');
  const panel = document.querySelector('.ed-panelarea');
  return {
    text: m ? m.getValue() : null,
    cursors: ed ? ed.getSelections().length : 0,
    sel: ed && m ? ed.getSelections().map((s) => m.getValueInRange(s)).join('|').slice(0, 40) : '',
    pos: ed && ed.getPosition() ? ed.getPosition().lineNumber + ':' + ed.getPosition().column : '',
    quickOpen: shown('.ed-quick-veil:not(.hidden)'),
    palette: qi ? ((qin && qin.value) || '') + ' [' + ((qin && qin.placeholder) || '').slice(0, 40) + ']' : '',
    find: shown('.find-widget.visible'),
    replace: !!document.querySelector('.find-widget.visible.replaceToggled'),
    view: (document.querySelector('.ed-act.on') || {}).ariaLabel || '',
    side: !document.querySelector('.ed-wrap.ed-noside'),
    panel: !!(panel && !panel.classList.contains('hidden')),
    tabs: [...document.querySelectorAll('.ed-tab')].map((t) => (t.querySelector('.ed-tab-name') || t).textContent.trim() + (t.classList.contains('on') ? '*' : '') + (t.classList.contains('dirty') ? '!' : '') + (t.classList.contains('preview') ? '~' : '')).join(','),
    wrap: ed ? ed.getOption(monaco.editor.EditorOption.wordWrap) : '',
    tabFocus: ed ? ed.getOption(monaco.editor.EditorOption.tabFocusMode) : false,
    row: (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.path) || '',
    sheet: (document.querySelector('dialog[open] h2') || {}).textContent || '',
    menu: shown('.desk-menu') ? [...document.querySelectorAll('.desk-menu .desk-menu-item')].map((b) => b.textContent.trim()).join('|').slice(0, 120) : '',
    toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|').slice(0, 120),
    font: ed ? ed.getOption(monaco.editor.EditorOption.fontSize) : 0,
    focus: (() => { const a = document.activeElement; return a ? (a.tagName + '.' + String(a.className || '')).slice(0, 50) : ''; })(),
    search: (document.querySelector('.ed-search-q') || {}).value || '',
    status: (document.querySelector('.ed-status') || {}).textContent || '',
    keys: (window.__keys || []).map((e) => e.key + (e.defaultPrevented ? ' (taken)' : ' (not taken)')).join(', '),
  };
})()`;

/** In words: what differs between two snapshots. */
function effect(a, b) {
  const out = [];
  if (a.text !== b.text) out.push(b.text === null ? 'the file left the editor' : `the text changed (${(a.text || '').split('\n').length} → ${(b.text || '').split('\n').length} lines)`);
  if (a.cursors !== b.cursors) out.push(`${b.cursors} cursors`);
  if (a.sel !== b.sel && b.sel) out.push(`selected "${b.sel}"`);
  if (a.pos !== b.pos && a.text === b.text) out.push(`cursor ${a.pos} → ${b.pos}`);
  if (b.quickOpen && !a.quickOpen) out.push('Go to file opened');
  if (b.palette && b.palette !== a.palette) out.push(`Monaco's quick input: ${b.palette}`);
  if (b.find && !a.find) out.push(b.replace ? 'find and replace opened' : 'find opened');
  else if (a.find && !b.find) out.push('find closed');
  if (a.wrap !== b.wrap) out.push(`word wrap ${b.wrap}`);
  if (a.tabFocus !== b.tabFocus) out.push(`Tab moves focus: ${b.tabFocus ? 'on' : 'off'}`);
  if (b.row && a.row !== b.row) out.push(`the Explorer row ${b.row} has the keyboard`);
  else if (b.replace && !a.replace) out.push('replace opened');
  if (a.view !== b.view) out.push(`view: ${b.view}`);
  if (a.side !== b.side) out.push(b.side ? 'side bar shown' : 'side bar hidden');
  if (a.panel !== b.panel) out.push(b.panel ? 'panel opened' : 'panel closed');
  if (a.tabs !== b.tabs) out.push(`tabs: ${b.tabs}`);
  if (b.sheet && b.sheet !== a.sheet) out.push(`sheet: ${b.sheet}`);
  if (b.menu && b.menu !== a.menu) out.push(`menu: ${b.menu}`);
  if (b.toast && b.toast !== a.toast) out.push(`toast: ${b.toast}`);
  if (a.font !== b.font) out.push(`font ${a.font} → ${b.font}`);
  if (a.search !== b.search) out.push(`search box: "${b.search}"`);
  if (!out.length) out.push('nothing');
  return out.join('; ');
}

// [id, what (as VS Code's page calls it), chord, set-up before the key]
const KEYS = [
  ['K1', 'Save', 'Ctrl+S', 'dirty'],
  ['K2', 'Save all', 'Ctrl+K S', 'dirty'],
  ['K3', 'Quick open, go to file', 'Ctrl+P'],
  ['K4', 'Command palette', 'Ctrl+Shift+P'],
  ['K5', 'Command palette (second key)', 'F1'],
  ['K6', 'Find', 'Ctrl+F'],
  ['K7', 'Replace', 'Ctrl+H'],
  ['K8', 'Find next', 'F3', 'find'],
  ['K9', 'Find in files', 'Ctrl+Shift+F'],
  ['K10', 'Replace in files', 'Ctrl+Shift+H'],
  ['K11', 'Go to line', 'Ctrl+G'],
  ['K12', 'Go to symbol in the file', 'Ctrl+Shift+O'],
  ['K13', 'Show all symbols', 'Ctrl+T'],
  ['K14', 'Add the next match to the selection', 'Ctrl+D', 'word'],
  ['K15', 'Select all matches', 'Ctrl+Shift+L', 'word'],
  ['K16', 'Insert a cursor below (Linux)', 'Shift+Alt+Down'],
  ['K17', 'Insert a cursor below (Windows key)', 'Ctrl+Alt+Down'],
  ['K18', 'Move the line down', 'Alt+Down'],
  ['K19', 'Copy the line down (Linux)', 'Ctrl+Shift+Alt+Down'],
  ['K20', 'Copy the line down (Windows key)', 'Shift+Alt+Down'],
  ['K21', 'Delete the line', 'Ctrl+Shift+K'],
  ['K22', 'Toggle a line comment', 'Ctrl+/'],
  ['K23', 'Toggle a block comment', 'Ctrl+Shift+A', 'word'],
  ['K24', 'Format the document (Linux)', 'Ctrl+Shift+I', 'messy'],
  ['K25', 'Format the document (Windows key)', 'Shift+Alt+F', 'messy'],
  ['K26', 'Format the selection', 'Ctrl+K Ctrl+F', 'messy-sel'],
  ['K27', 'Undo', 'Ctrl+Z', 'dirty'],
  ['K28', 'Redo', 'Ctrl+Shift+Z', 'undone'],
  ['K29', 'Redo (second key)', 'Ctrl+Y', 'undone'],
  ['K30', 'Split the editor', 'Ctrl+\\'],
  ['K31', 'Close the editor', 'Ctrl+W'],
  ['K32', 'Close the editor (VS Code for the Web)', 'Ctrl+Shift+Alt+N'],
  ['K33', 'Close all editors', 'Ctrl+K Ctrl+W'],
  ['K34', 'Reopen the closed editor', 'Ctrl+Shift+T', 'closed'],
  ['K35', 'Next editor', 'Ctrl+PageDown', 'two'],
  ['K36', 'Previous editor', 'Ctrl+PageUp', 'two'],
  ['K37', 'Next editor in the group (second key)', 'Ctrl+K Ctrl+PageDown', 'two'],
  ['K38', 'Open the next editor (recent)', 'Ctrl+Tab', 'two'],
  ['K39', 'Zoom in', 'Ctrl+='],
  ['K40', 'Zoom out', 'Ctrl+-'],
  ['K41', 'Toggle the side bar', 'Ctrl+B'],
  ['K42', 'Toggle the panel', 'Ctrl+J'],
  ['K43', 'Toggle the terminal', 'Ctrl+`'],
  ['K44', 'New file', 'Ctrl+N'],
  ['K45', 'New file (VS Code for the Web)', 'Ctrl+Alt+N'],
  ['K46', 'Show Explorer', 'Ctrl+Shift+E', 'search-view'],
  ['K47', 'Show Source Control', 'Ctrl+Shift+G'],
  ['K48', 'Copy the path of the active file', 'Ctrl+K P'],
  ['K49', 'Reveal the active file in the Explorer', 'Ctrl+K R', 'collapsed'],
  ['K50', 'Keep the preview editor open', 'Ctrl+K Enter', 'preview'],
  ['K51', 'Settings', 'Ctrl+,'],
  ['K52', 'Toggle word wrap', 'Alt+Z'],
  ['K53', 'Toggle Tab moves focus', 'Ctrl+M'],
  ['K54', 'Close the find widget', 'Escape', 'find'],
  ['K55', 'Go to the matching bracket', 'Ctrl+Shift+\\'],
  ['K56', 'Select the line', 'Ctrl+L'],
  ['K57', 'Trigger a suggestion', 'Ctrl+Space'],
  ['K58', 'Rename symbol', 'F2'],
  ['K59', 'Go to definition', 'F12'],
];

async function setUp(kind) {
  if (kind === 'dirty') await ev(`(() => { const e = monaco.editor.getEditors().find((x) => x.getModel() && x.getDomNode().offsetParent); e.trigger('k', 'type', { text: 'x' }); return true; })()`);
  if (kind === 'undone') {
    await ev(`(() => { const e = monaco.editor.getEditors().find((x) => x.getModel() && x.getDomNode().offsetParent); e.trigger('k', 'type', { text: 'x' }); e.trigger('k', 'undo'); return true; })()`);
  }
  if (kind === 'word') await ev(`(() => { const e = monaco.editor.getEditors().find((x) => x.getModel() && x.getDomNode().offsetParent); e.setSelection({ startLineNumber: 1, startColumn: 26, endLineNumber: 1, endColumn: 31 }); return true; })()`);
  if (kind === 'find') {
    await send('Ctrl+F');
    await ev(`(() => { const e = monaco.editor.getEditors().find((x) => x.getModel() && x.getDomNode().offsetParent); e.focus(); return true; })()`);
  }
  if (kind === 'messy' || kind === 'messy-sel') {
    await ev(`(async () => { location.hash = ${J(hashOf({ file: 'data.json' }))}; await new Promise((r) => setTimeout(r, 1500)); const e = monaco.editor.getEditors().find((x) => x.getModel() && x.getDomNode().offsetParent); e.focus(); ${kind === 'messy-sel' ? 'e.setSelection(e.getModel().getFullModelRange());' : ''} return true; })()`);
  }
  if (kind === 'two' || kind === 'closed') {
    await ev(`(async () => { location.hash = ${J(hashOf({ file: 'README.md' }))}; await new Promise((r) => setTimeout(r, 1200)); return true; })()`);
    if (kind === 'closed') await ev(`(() => { const x = [...document.querySelectorAll('.ed-tab')].find((t) => t.textContent.includes('README.md')); x.querySelector('.ed-tab-x').click(); return true; })()`);
    await sleep(500);
    await focusEditor(1, 1);
  }
  if (kind === 'search-view') await send('Ctrl+Shift+F');
  if (kind === 'collapsed') await ev(`(() => { const b = [...document.querySelectorAll('.ed-explorer .ed-paneltools button')].find((x) => /Close every folder|Collapse/.test(x.title)); if (b) b.click(); return true; })()`);
  if (kind === 'preview') {
    await ev(`(async () => { const r = [...document.querySelectorAll('.ed-tree [role=treeitem]')].find((x) => x.dataset.path === 'notes.txt'); r.click(); await new Promise((r) => setTimeout(r, 1200)); return true; })()`);
    await focusEditor(1, 1);
  }
  await ev(`(window.__keys = [], true)`);
}

// Keys Chrome takes for itself and that end the page under test (Ctrl+W closed it in the first run): not sent.
const ENDS_PAGE = new Set(['Ctrl+W', 'Ctrl+Shift+W', 'Ctrl+Shift+Q']);
const FROM = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : null;
async function keysPart() {
  const rows = [];
  for (const [id, what, chord, kind] of KEYS) {
    if (FROM && KEYS.findIndex((k) => k[0] === id) < KEYS.findIndex((k) => k[0] === FROM)) continue;
    if (chord.split(' ').some((x) => ENDS_PAGE.has(x))) {
      rows.push({ id, what, chord, result: 'not sent: Chrome closes the tab (the first run lost its page to it)' });
      continue;
    }
    resetApp();
    if (!(await openEditor())) {
      rows.push({ id, what, chord, result: 'the editor did not open' });
      continue;
    }
    await focusEditor();
    await setUp(kind);
    const a = await ev(SNAP);
    await send(chord);
    const b = await ev(SNAP);
    const result = `${effect(a, b)} · keys: ${b.keys || 'none reached the page'}`;
    rows.push({ id, what, chord, result });
    console.log(`${id} ${chord} (${what}): ${result}`);
  }
  const tag = FROM ? `-from-${FROM}` : '';
  fs.writeFileSync(path.join(OUT, `keys${tag}.json`), J(rows, null, 1));
  fs.writeFileSync(path.join(OUT, `keys${tag}.md`), rows.map((r) => `| ${r.id} | ${r.chord} | ${r.what} | ${r.result.replace(/\|/g, '/')} |`).join('\n') + '\n');
  check('keys', `${rows.length} keys sent`, rows.length > 0);
}

// ---------- flows and screenshots: in the module beside this one (filled with the fixes) ----------
const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), await chrome.shot());
const ctx = { OUT, ALPHA, APP, sleep, check, chrome, ev, J, waitFor, click, rectOf, center, open, openEditor, focusEditor, send, SNAP, hashOf, resetApp, shot };

try {
  if (want('keys')) await keysPart();
  const more = path.join(path.dirname(new URL(import.meta.url).pathname), 'editor-check-flows.mjs');
  if (fs.existsSync(more) && (want('flows') || want('shots'))) {
    const m = await import(more);
    if (want('flows')) await m.flows(ctx);
    if (want('shots')) await m.shots(ctx);
  }
  await finish();
} catch (e) {
  check('run', 'the check ran to its end', false, e.stack || e.message);
}
await done();
