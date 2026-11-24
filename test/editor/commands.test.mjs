// The editor's VS Code ways without a browser: its keys and chords (commands.js), which tabs a "Close ..." command
// closes and the order of pinned tabs (tabops.js), replace in a file's text (search.js), and where a dragged file may
// go in the Explorer. The page itself is proven in a real browser (tools/editor-check.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';

// Just enough of a DOM for the modules to load.
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, children: [], attrs: {}, on: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  addEventListener(type, fn) {
    (this.on[type] ||= []).push(fn);
  }
  /** What a browser does on an event: the listeners, in order (for the tests). */
  fire(type, e = {}) {
    for (const fn of this.on[type] || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...e });
  }
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
  querySelector() {
    return null;
  }
  focus() {}
}
globalThis.Node ??= FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => t,
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};

const commands = await import('../../web/editor/commands.js');
const { COMMANDS, BROWSER_LINE, createKeyReader, keyName, monacoKey, paletteLabel, strokeOf } = commands;
const { DRAG_TYPE, closesBy, dragPath, focusLost, moveBefore, regroup, stepFrom, tabTakes, toClose, wrapOf, wraps } = await import('../../web/editor/tabops.js');
const search = await import('../../web/editor/search.js');
const { replaceIn } = search;
const { mayDrop, renameSelection } = await import('../../web/editor/explorer.js');

const key = (code, mods = {}) => ({ code, key: code.replace(/^Key/, '').toLowerCase(), ...mods });

test('a keydown is named as VS Code names it, by its place on the keyboard', () => {
  assert.equal(strokeOf(key('KeyS', { ctrlKey: true })), 'Ctrl+S');
  assert.equal(strokeOf(key('KeyN', { ctrlKey: true, shiftKey: true, altKey: true })), 'Ctrl+Shift+Alt+N');
  assert.equal(strokeOf({ code: 'Backquote', key: '`', ctrlKey: true }), 'Ctrl+`');
  assert.equal(strokeOf({ code: 'KeyP', key: 'p', metaKey: true }), 'Ctrl+P', 'Cmd counts as Ctrl');
  assert.equal(strokeOf({ code: 'PageDown', key: 'PageDown', ctrlKey: true }), 'Ctrl+PageDown');
  assert.equal(strokeOf({ code: 'F1', key: 'F1' }), 'F1');
  assert.equal(keyName({ code: 'ShiftLeft', key: 'Shift' }), null, 'a modifier alone is no key');
});

test('every command has a key a browser tab leaves alone, and the one line says which keys it keeps', () => {
  const kept = ['Ctrl+W', 'Ctrl+N', 'Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageDown', 'Ctrl+PageUp'];
  for (const c of COMMANDS) {
    assert.ok(c.keys.length, c.id);
    for (const k of c.keys) for (const s of k.split(' ')) assert.ok(!kept.includes(s), `${c.id}: ${k} uses ${s}, which a browser tab keeps`);
    if (c.browser) {
      assert.ok(kept.includes(c.browser), `${c.id}: ${c.browser}`);
      assert.match(paletteLabel(c), new RegExp(`a browser tab keeps ${c.browser.replace(/\+/g, '\\+')}`));
    }
  }
  for (const k of kept) assert.ok(BROWSER_LINE.includes(k.replace('Ctrl+PageUp', 'PageUp')), k);
  // VS Code for the Web's own keys where its page names them (code.visualstudio.com/docs/setup/vscode-web).
  const of = (id) => COMMANDS.find((c) => c.id === id);
  assert.equal(of('closeEditor').keys[0], 'Ctrl+Shift+Alt+N');
  assert.equal(of('newFile').keys[0], 'Ctrl+Alt+N');
});

test('keys and chords become commands; a chord the code editor reads stays the editor\'s', () => {
  const r = createKeyReader();
  assert.deepEqual(r.read('Ctrl+S'), { id: 'save' });
  assert.deepEqual(r.read('Ctrl+`'), { id: 'terminal' });
  assert.deepEqual(r.read('Ctrl+B'), { id: 'sidebar' });
  assert.deepEqual(r.read('Ctrl+Shift+H'), { id: 'replaceInFiles' });
  assert.deepEqual(r.read('Ctrl+W'), { id: 'closeEditor' }, 'where the browser lets it through (an installed app), VS Code\'s key works');
  assert.equal(r.read('Ctrl+Shift+Z'), null, 'not this table\'s: the code editor\'s own redo');
  // Outside the code editor the page reads Ctrl+K chords itself.
  assert.deepEqual(r.read('Ctrl+K'), { wait: 'Ctrl+K' });
  assert.equal(r.read(null), null, 'a modifier on its way');
  assert.deepEqual(r.read('Shift+T'), { id: 'reopen' });
  assert.deepEqual([r.read('Ctrl+K'), r.read('Q')], [{ wait: 'Ctrl+K' }, { miss: 'Ctrl+K Q' }]);
  // Inside it, Ctrl+K is the editor's: its second stroke too (Ctrl+K Ctrl+S must not become Save).
  assert.equal(r.read('Ctrl+K', { inEditor: true }), null);
  assert.equal(r.pending, 'Ctrl+K');
  assert.equal(r.read('Ctrl+S', { inEditor: true }), null);
  assert.deepEqual(r.read('Ctrl+S', { inEditor: true }), { id: 'save' }, 'the next key is a key again');
});

test('a key of the table as Monaco\'s keybinding, chords included', () => {
  const KeyMod = { CtrlCmd: 1 << 11, Shift: 1 << 10, Alt: 1 << 9, chord: (a, b) => a | (b << 16) };
  const KeyCode = { KeyK: 41, KeyS: 49, KeyT: 50, Backquote: 91, PageDown: 12, Enter: 3 };
  const m = { KeyMod, KeyCode };
  assert.equal(monacoKey(m, 'Ctrl+S'), KeyMod.CtrlCmd | 49);
  assert.equal(monacoKey(m, 'Ctrl+`'), KeyMod.CtrlCmd | 91);
  assert.equal(monacoKey(m, 'Ctrl+K Shift+T'), KeyMod.chord(KeyMod.CtrlCmd | 41, KeyMod.Shift | 50));
  assert.equal(monacoKey(m, 'Ctrl+K PageDown'), KeyMod.chord(KeyMod.CtrlCmd | 41, 12));
  assert.equal(monacoKey(m, 'Ctrl+Q'), null, 'a key Monaco has no code for');
});

test('Close Others, to the Right, Saved and All leave pinned tabs; pinned tabs stand first', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((p) => ({ path: p }));
  const list = [a, b, c, d];
  const names = (x) => x.map((t) => t.path).join('');
  assert.equal(names(toClose(list, b, 'others')), 'acd');
  assert.equal(names(toClose(list, b, 'right')), 'cd');
  assert.equal(names(toClose(list, b, 'all')), 'abcd');
  assert.equal(names(toClose(list, b, 'saved', (t) => t === c)), 'abd', 'a tab with unsaved changes stays');
  d.pinned = true;
  assert.equal(names(toClose(list, b, 'all')), 'abc');
  assert.equal(names(regroup(list)), 'dabc');
  assert.equal(names(moveBefore(list, c, a)), 'dcab', 'a drag puts it there');
  assert.equal(names(moveBefore(list, a, d)), 'dacb', 'never before a pinned tab');
  assert.equal(stepFrom(list, b, 1), d, 'the next one, round the end');
  assert.equal(stepFrom(list, d, -1), b);
  assert.equal(stepFrom([a], a, 1), null);
});

test('replace in a text: plain words as typed, $1 with a regular expression, a search that matches nothing is no replace', () => {
  const o = (q, x = {}) => ({ q, regex: false, caseSensitive: false, word: false, ...x });
  assert.deepEqual(replaceIn('Price and price', o('price'), 'cost'), { text: 'cost and cost', n: 2 });
  assert.deepEqual(replaceIn('Price and price', o('price', { caseSensitive: true }), 'cost'), { text: 'Price and cost', n: 1 });
  assert.deepEqual(replaceIn('price prices', o('price', { word: true }), 'cost'), { text: 'cost prices', n: 1 });
  assert.deepEqual(replaceIn('a.b', o('.'), '$&$&'), { text: 'a$&$&b', n: 1 }, 'without a regular expression "$&" is two letters');
  assert.deepEqual(replaceIn('total(a)', o('(\\w+)\\(', { regex: true }), 'sum_$1('), { text: 'sum_total(a)', n: 1 });
  assert.deepEqual(replaceIn('abc', o('x*', { regex: true }), '-'), { text: 'abc', n: 0 }, 'not a "-" between every letter');
  assert.deepEqual(replaceIn('abc', o('(', { regex: true }), '-'), { text: 'abc', n: 0 }, 'a broken regular expression changes nothing');
});

test('a regular expression replace reads $$, $&, $1, $10 and $<name> as String.replace does, in one pass over a long line', () => {
  const o = (q) => ({ q, regex: true, caseSensitive: true, word: false });
  for (const [q, by] of [['(a)(b)?', '[$2|$1|$&|$$|$0|$3]'], ['(?<x>a)(?<y>b)?', '<$<y>$<x>$<z>>'], ['(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)', '$10$11$1']]) {
    const text = 'zz abcdefghij ab a zz';
    const one = new RegExp(q, 'gu');
    assert.equal(replaceIn(text, o(q), by).text, text.replace(one, by), `${q} → ${by}`);
  }
  // A minified file: one line of 100,000 matches. Each match's replacement came from a replace over the whole line
  // (14 seconds here); now from the match itself.
  const line = 'var a=1;'.repeat(100_000);
  const start = performance.now();
  const r = replaceIn(line, o('(v)ar'), '$1-let');
  const ms = performance.now() - start;
  assert.equal(r.n, 100_000);
  assert.equal(r.text, line.replace(/(v)ar/g, '$1-let'));
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
});

test('a file or folder dragged in the Explorer: never into itself, a folder inside it, or where it is', () => {
  assert.equal(mayDrop('src/a.js', 'lib'), true);
  assert.equal(mayDrop('src/a.js', ''), true, 'the opened folder itself');
  assert.equal(mayDrop('src/a.js', 'src'), false, 'where it is already');
  assert.equal(mayDrop('src', 'src'), false);
  assert.equal(mayDrop('src', 'src/lib'), false, 'into a folder inside it');
  assert.equal(mayDrop('src', 'srcx'), true, 'a folder whose name starts the same is another folder');
});

// A made-up workbench for Replace All: closed files on a "disk" (with versions, as the file route has them) and tabs.
function fakeWb(files, open = {}) {
  const disk = new Map(Object.entries(files).map(([p, text]) => [p, { text, version: `v${text.length}` }]));
  const tabs = new Map(Object.entries(open).map(([p, text]) => [p, { path: p, text }]));
  return {
    disk,
    tabs: { fileTab: (p) => tabs.get(p) || null, textOf: (t) => t.text, putText: (t, v) => ((t.text = v), true) },
    get: async (_, { path }) => ({ ...disk.get(path) }),
    post: async (_, { path, text, version }) => {
      if (disk.get(path).version !== version) throw Object.assign(new Error('changed'), { status: 409 });
      disk.set(path, { text, version: `v${text.length}` });
    },
  };
}

test('Replace All counts what it writes: every match of a line, a file of more than 50, open and closed files', async () => {
  const o = { q: 'price', regex: false, caseSensitive: false, word: false };
  assert.deepEqual(search.hitsIn('price, price and price', o, 'cost').map((x) => [x.at, x.to]), [[0, 'cost'], [7, 'cost'], [17, 'cost']], 'the preview marks each one');
  const wb = fakeWb({ 'twice.txt': 'price, price and price\none price\n', 'many.txt': 'price\n'.repeat(120) }, { 'open.js': 'a price; b price' });
  const plan = await search.planReplace(wb, ['twice.txt', 'many.txt', 'open.js'], o, 'cost');
  assert.equal(plan.n, 4 + 120 + 2, 'the dialog\'s count');
  const r = await search.applyReplace(wb, plan, o, 'cost');
  assert.equal(r.n, plan.n, 'as many written as counted');
  assert.deepEqual([r.changed, r.inTabs, r.skipped], [['twice.txt', 'many.txt'], ['open.js'], []]);
  assert.equal(wb.disk.get('twice.txt').text, 'cost, cost and cost\none cost\n');
  assert.equal(wb.tabs.fileTab('open.js').text, 'a cost; b cost');
});

test('a regular expression replaces line by line, as the search finds: no line end is eaten, ^ is each line\'s start', () => {
  const o = (q) => ({ q, regex: true, caseSensitive: false, word: false });
  assert.deepEqual(replaceIn('price\nlist\nprice\nend\n', o('price\\s*'), 'cost'), { text: 'cost\nlist\ncost\nend\n', n: 2 });
  assert.deepEqual(replaceIn('a\nb price\nb more\n', o('^b'), 'B'), { text: 'a\nB price\nB more\n', n: 2 });
  assert.deepEqual(replaceIn('x one\r\nx two\r\n', o('x$|^x'), 'y'), { text: 'y one\r\ny two\r\n', n: 2 }, 'Windows line ends stay');
  assert.deepEqual(replaceIn('total(a) total(b)', o('(\\w+)\\('), 'sum_$1('), { text: 'sum_total(a) sum_total(b)', n: 2 }, '$1 for each match');
  assert.deepEqual(search.hitsIn('one price', o('price$'), 'cost').map((x) => x.to), ['cost'], 'the preview\'s replacement of a match is the one written');
});

test('Replace All skips and names a closed file that changed on disk after the search read it', async () => {
  const o = { q: 'price', regex: false, caseSensitive: false, word: false };
  const wb = fakeWb({ 'drift.txt': 'price one\n', 'same.txt': 'price two\n' });
  const versions = { 'drift.txt': wb.disk.get('drift.txt').version, 'same.txt': wb.disk.get('same.txt').version };
  wb.disk.set('drift.txt', { text: 'price two, written by another program\nprice three\n', version: 'changed' });
  const plan = await search.planReplace(wb, ['drift.txt', 'same.txt'], o, 'cost', versions);
  assert.deepEqual(plan.skipped.map((x) => x.path), ['drift.txt']);
  assert.match(plan.skipped[0].why, /changed on disk since the search/);
  assert.equal(plan.n, 1);
  await search.applyReplace(wb, plan, o, 'cost');
  assert.equal(wb.disk.get('drift.txt').text, 'price two, written by another program\nprice three\n', 'never written');
  assert.equal(wb.disk.get('same.txt').text, 'cost two\n');
});

test('Match Whole Word takes a word of any script, as the search finds it (JavaScript\'s \\b knows A to Z only)', () => {
  const o = { q: 'café', regex: false, caseSensitive: false, word: true };
  assert.deepEqual(replaceIn('café au lait, cafés', o, 'tea'), { text: 'tea au lait, cafés', n: 1 });
  assert.deepEqual(replaceIn('über und überall', { ...o, q: 'über' }, 'x'), { text: 'x und überall', n: 1 });
  assert.deepEqual(replaceIn('price_list price', { ...o, q: 'price' }, 'cost'), { text: 'price_list cost', n: 1 }, '_ is part of a word');
  // A word that goes on with a combining mark is another word, as ripgrep's --word-regexp has it: the vowel sign of
  // "कमी" (U+0940) and the accent of a decomposed "café" (U+0301) are not cut off.
  assert.deepEqual(replaceIn('कम है\nकमी है\n', { ...o, q: 'कम' }, 'X'), { text: 'X है\nकमी है\n', n: 1 });
  assert.deepEqual(replaceIn('cafe au lait\ncafe\u0301 noir\n', { ...o, q: 'cafe' }, 'X'), { text: 'X au lait\ncafe\u0301 noir\n', n: 1 });
  // ripgrep's \w also holds the joiners (U+200C, U+200D) and only decimal digits: a Persian word joined by U+200C and a
  // Hindi word with U+200D are not cut; "m²" is the word "m", replaced as ripgrep lists it.
  assert.deepEqual(replaceIn('می گویم\nمی\u200cخواهم\n', { ...o, q: 'می' }, 'X'), { text: 'X گویم\nمی\u200cخواهم\n', n: 1 });
  assert.deepEqual(replaceIn('क्\u200dष है\nक् है\n', { ...o, q: 'क्' }, 'X'), { text: 'क्\u200dष है\nX है\n', n: 1 });
  assert.deepEqual(replaceIn('10 m² floor\n10 m floor\n', { ...o, q: 'm' }, 'X'), { text: '10 X² floor\n10 X floor\n', n: 2 });
  assert.deepEqual(replaceIn('needle needles', { ...o, q: 'needle' }, 'X'), { text: 'X needles', n: 1 });
});

test('a result\'s line: its indent goes, and a match late in a long line keeps 12 characters before it', () => {
  const o = { q: 'price', regex: false, caseSensitive: false, word: false };
  const at = (line) => search.previewCut(line, search.hitsIn(line, o));
  assert.equal(at('    let price = 1;'), 4, 'the indent');
  assert.equal(at('price  '), 0);
  const long = `${'word '.repeat(30)}and at last the price`;
  assert.equal(at(long), long.indexOf('price') - 12, 'the match stays in view');
  assert.equal(at('  no hit here'), 2);
});

test('a result cut from a long line names the matches its excerpt leaves out, as many as Replace All writes', () => {
  const o = { q: 'price', regex: false, caseSensitive: false, word: false };
  const line = `price ${'x'.repeat(600)} price end`;
  const excerpt = { text: line.slice(0, 200), cut: 0, count: 2 }; // what the server sends for this line
  const hits = search.hitsIn(excerpt.text, o, 'cost');
  assert.equal(hits.length, 1, 'the excerpt shows one');
  assert.equal(search.moreOn(excerpt, hits), 1, 'and says one more');
  assert.equal(hits.length + search.moreOn(excerpt, hits), replaceIn(line, o, 'cost').n, 'together what is written');
  assert.equal(search.moreOn({ text: 'price and price' }, search.hitsIn('price and price', o)), 0, 'a whole line: nothing more');
});

test('a pinned tab stays on a middle click and on the Close Editor key; its button and the menu close it', () => {
  const pinned = { path: 'a', pinned: true };
  const plain = { path: 'b' };
  for (const how of ['middle', 'key']) {
    assert.equal(closesBy(pinned, how), false, how);
    assert.equal(closesBy(plain, how), true, how);
  }
  assert.equal(closesBy(pinned, 'button'), true);
  assert.equal(closesBy(pinned, 'menu'), true);
});

test('F2 in the Explorer selects a file\'s name without its extension, a folder\'s whole name', () => {
  assert.deepEqual(renameSelection('tabbed.js', false), [0, 6]);
  assert.deepEqual(renameSelection('archive.tar.gz', false), [0, 11], 'up to the last dot');
  assert.deepEqual(renameSelection('.env', false), [0, 4], 'a name that starts with its dot');
  assert.deepEqual(renameSelection('Makefile', false), [0, 8]);
  assert.deepEqual(renameSelection('lib.d', true), [0, 5], 'a folder');
});

test('Alt+Z\'s word wrap belongs to the open file; the others follow the Word Wrap setting', () => {
  const toggled = { path: 'a', wrap: 'on' };
  const other = { path: 'b' };
  assert.equal(wrapOf(toggled, false), 'on');
  assert.equal(wrapOf(other, false), 'off', 'the setting, unchanged');
  assert.equal(wrapOf(other, true), 'on');
  assert.equal(wrapOf({ path: 'c', wrap: 'off' }, true), 'off');
});

test('Alt+Z wraps a Changes tab and a compare tab too, as VS Code\'s toggle does in a diff', () => {
  for (const kind of ['file', 'diff', 'compare']) assert.equal(wraps({ kind, path: 'a' }), true, kind);
  assert.equal(wraps({ kind: 'diff', path: 'a', note: ['A binary file'] }), false, 'a note has no text to wrap');
  assert.equal(wraps(null), false);
});

test('Copy Path has VS Code\'s keys, as Copy Relative Path has its pair', () => {
  const r = createKeyReader();
  assert.deepEqual(r.read('Ctrl+Alt+C'), { id: 'copyPath' });
  assert.deepEqual([r.read('Ctrl+K'), r.read('Ctrl+Alt+C')], [{ wait: 'Ctrl+K' }, { id: 'copyPath' }]);
  assert.deepEqual([r.read('Ctrl+K'), r.read('P')], [{ wait: 'Ctrl+K' }, { id: 'copyPath' }]);
  assert.deepEqual(r.read('Ctrl+Shift+Alt+C'), { id: 'copyRelativePath' });
});

test('Ctrl+Alt+C copies the path only where nothing is typed; a key with AltGr is a letter, never a command', () => {
  // Windows reports AltGr as Ctrl+Alt: AltGr+C is "ć" on a Polish keyboard, AltGr+N is "ń".
  const altGr = (code, key) => ({ code, key, ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' });
  assert.equal(strokeOf(altGr('KeyC', 'ć')), null);
  assert.equal(strokeOf(altGr('KeyN', 'ń')), null);
  assert.equal(strokeOf({ ...altGr('KeyC', 'c'), getModifierState: () => false }), 'Ctrl+Alt+C', 'Ctrl and Alt held, no AltGr');
  const r = createKeyReader();
  assert.equal(r.read('Ctrl+Alt+C', { inEditor: true }), null, 'in the code editor (VS Code: when !editorFocus)');
  assert.equal(r.read('Ctrl+Alt+C', { inText: true }), null, 'in a text box');
  assert.equal(r.read('Ctrl+Shift+Alt+C', { inText: true }), null);
  assert.deepEqual(r.read('Ctrl+Alt+C'), { id: 'copyPath' }, 'elsewhere it is Copy Path');
  assert.deepEqual([r.read('Ctrl+K', { inText: true }), r.read('Ctrl+Alt+C', { inText: true })], [{ wait: 'Ctrl+K' }, { id: 'copyPath' }], 'the chord still works in text');
  const copy = COMMANDS.find((c) => c.id === 'copyPath');
  assert.deepEqual(commands.editorKeys(copy), ['Ctrl+K P', 'Ctrl+K Ctrl+Alt+C'], 'the code editor is given the chords, not the key that types');
});

test('Enter and Space on a tab show it; on its Close or Unpin button they press the button', () => {
  const tab = {};
  const button = {};
  assert.equal(tabTakes({ key: 'Enter', target: tab, currentTarget: tab }), true);
  assert.equal(tabTakes({ key: ' ', target: tab, currentTarget: tab }), true);
  assert.equal(tabTakes({ key: 'Enter', target: button, currentTarget: tab }), false, 'the button\'s own click');
  assert.equal(tabTakes({ key: ' ', target: button, currentTarget: tab }), false);
  assert.equal(tabTakes({ key: 'a', target: tab, currentTarget: tab }), false);
});

test('quick open opened with ">" lists files again once ">" is gone, and Enter opens the typed file, not a command', async () => {
  const opened = [];
  const ran = [];
  const wb = { get: async () => ({ files: ['notes.txt', 'src/app.js'], truncated: false }), tabs: { paths: () => [], open: (p) => opened.push(p) } };
  const q = search.createQuickOpen(wb);
  q.commands([{ id: 'save', label: 'File: Save', keys: ['Ctrl+S'], run: () => ran.push('save') }]);
  await q.open('>');
  const input = q.el.children[0].children[0];
  input.value = 'notes';
  input.fire('input');
  input.fire('keydown', { key: 'Enter' }); // before the list is here: nothing is picked
  await new Promise((r) => setTimeout(r, 0));
  input.fire('keydown', { key: 'Enter' });
  assert.deepEqual(ran, [], 'no command ran');
  assert.deepEqual(opened, ['notes.txt']);
});

test('quick open is a combobox: named for what it lists, the chosen row told as the arrows move, a command\'s name in parts', async () => {
  const wb = { get: async () => ({ files: ['notes.txt', 'src/app.js'], truncated: false }), tabs: { paths: () => [], open() {} } };
  const q = search.createQuickOpen(wb);
  q.commands([{ id: 'save', label: 'File: Save', keys: ['Ctrl+S'], run() {} }, { id: 'newFile', label: 'File: New File...', keys: ['Ctrl+Alt+N'], browser: 'Ctrl+N', run() {} }]);
  await q.open('>');
  const input = q.el.children[0].children[0];
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-controls'), 'ed-quick-list');
  assert.equal(input.getAttribute('aria-label'), 'Commands');
  assert.equal(input.getAttribute('aria-activedescendant'), 'ed-quick-opt-0');
  input.fire('keydown', { key: 'ArrowDown' });
  assert.equal(input.getAttribute('aria-activedescendant'), 'ed-quick-opt-1');
  assert.equal(search.commandName({ label: 'File: New File...', keys: ['Ctrl+Alt+N'], browser: 'Ctrl+N' }), 'File: New File..., Ctrl+Alt+N (a browser tab keeps Ctrl+N)');
  input.value = 'notes';
  input.fire('input');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(input.getAttribute('aria-label'), 'Go to file');
});

test('a dragged tab or tree row carries its path under the page\'s own type, never as text a drop would type', async () => {
  const fs = await import('node:fs');
  const set = {};
  const dt = { setData: (k, v) => (set[k] = v) };
  dragPath(dt, 'src/app.js');
  assert.deepEqual(set, { [DRAG_TYPE]: 'src/app.js' });
  assert.equal(dt.effectAllowed, 'move');
  for (const f of ['tabs.js', 'explorer.js']) {
    const src = fs.readFileSync(new URL(`../../web/editor/${f}`, import.meta.url), 'utf8');
    assert.ok(!/setData\('text\/plain'/.test(src), `${f} sets no text/plain`);
    assert.match(src, /dragPath\(/, f);
  }
});

test('the keyboard is lost when it is on the body, on an element that left the page, or in a side bar being hidden', () => {
  const body = { isConnected: true };
  const side = { contains: (x) => x === inSide };
  const inSide = { isConnected: true };
  const elsewhere = { isConnected: true };
  assert.equal(focusLost(body, body), true);
  assert.equal(focusLost(null, body), true);
  assert.equal(focusLost({ isConnected: false }, body), true, 'a closed tab');
  assert.equal(focusLost(inSide, body, side), true, 'in the side bar that hides');
  assert.equal(focusLost(elsewhere, body, side), false);
  assert.equal(focusLost(inSide, body), false, 'the side bar stays');
});

test('in the terminal panel the page takes VS Code\'s skip-shell keys only; the rest is the shell\'s', () => {
  const r = commands.terminalKeyReader();
  assert.deepEqual(r.read('Ctrl+P'), { id: 'quickOpen' });
  assert.deepEqual(r.read('Ctrl+Shift+P'), { id: 'palette' });
  assert.deepEqual(r.read('F1'), { id: 'palette' });
  assert.deepEqual(r.read('Ctrl+`'), { id: 'terminal' });
  assert.deepEqual(r.read('Ctrl+J'), { id: 'panel' });
  for (const k of ['Ctrl+C', 'Ctrl+D', 'Ctrl+K', 'Ctrl+B', 'Ctrl+Shift+E', 'Ctrl+S', 'Ctrl+R']) assert.equal(r.read(k), null, `${k} goes to the shell`);
});

test('VS Code keys a user presses early: Ctrl+Shift+J shows the search details, Ctrl+1 goes to the editor', () => {
  const r = createKeyReader();
  assert.deepEqual(r.read('Ctrl+Shift+J'), { id: 'searchDetails' });
  assert.deepEqual(r.read('Ctrl+1'), { id: 'focusEditor' });
  assert.match(BROWSER_LINE, /Ctrl\+Shift\+Tab/, 'the line names the key the browser keeps for its previous tab');
});

test('the tab menu\'s Reveal in Explorer View names no key: VS Code\'s Ctrl+K R is the system\'s file manager', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../web/editor/tabs.js', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.includes("label: 'Reveal in Explorer View'"));
  assert.ok(line && !/keys:/.test(line), line);
});
