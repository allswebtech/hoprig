// The App's diff pane (web/chat/diffpane.js), without a browser: its rows in both views, the one message its comments
// make, and that nothing is sent but by the owner's Send.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
const D = await import('../../web/chat/diffpane.js');
const hunks = [{ oldStart: 7, newStart: 7, lines: [' a', '-b', '-c', '+B', ' d', '+e'] }];

test('unified rows carry each line\'s old and new number; a hunk after the start says where it is', () => {
  assert.deepEqual(D.diffRows(hunks), [
    { kind: 'gap', line: 7 },
    { kind: 'ctx', old: 7, new: 7, text: 'a' },
    { kind: 'del', old: 8, new: null, text: 'b' },
    { kind: 'del', old: 9, new: null, text: 'c' },
    { kind: 'add', old: null, new: 8, text: 'B' },
    { kind: 'ctx', old: 10, new: 9, text: 'd' },
    { kind: 'add', old: null, new: 10, text: 'e' },
  ]);
});

test('side by side: a run of removed lines meets the added lines after it, line by line', () => {
  const rows = D.diffRows(hunks, true).slice(1);
  assert.deepEqual(rows.map((r) => [r.left && `${r.left.kind}${r.left.n}`, r.right && `${r.right.kind}${r.right.n}`]), [
    ['ctx7', 'ctx7'], ['del8', 'add8'], ['del9', null], ['ctx10', 'ctx9'], [null, 'add10'],
  ]);
});

test('the queued comments make ONE message: each names its file and line, quotes the line, then the comment', () => {
  const t = D.commentsMessage([
    { path: 'src/cart.js', side: 'new', line: 8, text: 'const total = round(sum)', body: 'Use the helper.' },
    { path: 'README.md', side: 'old', line: 3, text: 'old `title`', body: '  Keep it.  ' },
  ]);
  assert.equal(t, 'Comments on the changes in the diff:\n\nsrc/cart.js, line 8: `const total = round(sum)`\nUse the helper.\n\nREADME.md, removed line 3: `old \'title\'`\nKeep it.');
});

test('nothing goes by itself: the pane sends only on the owner\'s Send, and nothing while no comment waits', async () => {
  const sent = [];
  const pane = D.createDiffPane({ A: '/api/chats/x', send: async (t) => sent.push(t), editor() {} });
  assert.deepEqual(pane.comments(), []);
  // Cmd/Ctrl+Enter with no comment queued sends nothing.
  pane.el.listeners.keydown({ key: 'Enter', ctrlKey: true, preventDefault() {}, stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent, []);
  // The one place that sends is the Send of the queued comments (an Enter in a comment box only queues).
  const src = fs.readFileSync(new URL('../../web/chat/diffpane.js', import.meta.url), 'utf8');
  assert.equal(src.match(/o\.send\(/g).length, 1, 'one call that sends');
  assert.match(src, /async function sendAll\(\) \{\n    if \(!queued\.length\) return;\n    const text = commentsMessage\(queued\);\n    try \{\n      const r = await o\.send\(text\);/);
  assert.match(src, /if \(e\.key === 'Enter' && !e\.shiftKey && !e\.metaKey && !e\.ctrlKey && !e\.isComposing\) \{\n        e\.preventDefault\(\);\n        addComment\(editing\);/, 'Enter in the box adds the comment to the queue');
});

test('the title bar\'s Changes and the rail\'s Changes card open the pane; the editor stays one press away', () => {
  const page = fs.readFileSync(new URL('../../web/chat/page.js', import.meta.url), 'utf8');
  assert.match(page, /changes: \(\) => act\.diff\(\)/, 'the rail\'s card');
  assert.match(page, /diff: \(\) => diffPane\.open\(\)/);
  const head = fs.readFileSync(new URL('../../web/chat/header.js', import.meta.url), 'utf8');
  assert.match(head, /barBtn\('Changes', 'git', [^\n]*o\.act\.diff \? o\.act\.diff\(\)/, 'the title bar\'s Changes');
  const src = fs.readFileSync(new URL('../../web/chat/diffpane.js', import.meta.url), 'utf8');
  assert.match(src, /'Open the changes in the editor', onclick: \(\) => o\.editor\(\)/);
  const html = fs.readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /href="chat\/diffpane\.css"/);
});

test('a phone: the session menu\'s Changes opens the pane', async () => {
  globalThis.location ||= { hash: '', search: '', pathname: '/' };
  const { sessionItems } = await import('../../web/chat/header.js');
  const ch = sessionItems({ title: 't', cwd: '/w/a', profile: { label: 'P' } }, { phone: true }).find((x) => x.label === 'Changes');
  assert.equal(ch.value, 'diff');
  assert.equal(sessionItems({ title: 't', cwd: '/w/a' }, {}).find((x) => x.value === 'diff'), undefined, 'a wide screen keeps Open in → Changes for the editor');
});

test('Esc that closes the diff pane is the pane\'s only: it never reaches the page\'s Esc, which stops Claude\'s turn', async () => {
  const pane = D.createDiffPane({ A: '/api/chats/x', send: async () => ({}), editor() {} });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ git: false }) });
  await pane.open();
  assert.equal(pane.isOpen(), true);
  let stopped = 0;
  let defaultPrevented = false;
  const e = { key: 'Escape', preventDefault() { defaultPrevented = true; }, stopPropagation() { stopped++; } };
  pane.el.listeners.keydown(e);
  assert.equal(pane.isOpen(), false, 'the pane closes');
  assert.equal(stopped, 1, 'and the key goes no further');
  // The page's keys (keys.js) leave a key alone that a part of the page took already.
  const { installKeys } = await import('../../web/chat/keys.js');
  let docKey = null;
  const before = document.addEventListener;
  document.addEventListener = (type, fn) => type === 'keydown' && (docKey = fn);
  document.querySelector ||= () => null;
  const stops = [];
  try {
    installKeys({ working: () => true, stop: () => stops.push('turn'), stopShell: () => false, nextMode() {}, openAsk: () => null, box: null });
  } finally {
    document.addEventListener = before;
  }
  docKey({ key: 'Escape', defaultPrevented: true, preventDefault() {} });
  assert.deepEqual(stops, [], 'no stop of the turn');
  docKey({ key: 'Escape', defaultPrevented: false, preventDefault() {} });
  assert.deepEqual(stops, ['turn'], 'Esc elsewhere still stops it');
  assert.ok(defaultPrevented);
});

test('the focus stays in the pane after a comment is added or removed, and goes back to Changes when the pane closes', async () => {
  globalThis.fetch = async (u) => {
    const url = String(u);
    const json = url.includes('/changes') ? { git: true, files: 1, added: 1, removed: 0, list: [{ path: 'a.js', added: 1, removed: 0, new: false }] }
      : { path: 'a.js', new: false, binary: false, hunks: [{ oldStart: 1, newStart: 1, lines: [' x', '+y'] }], cut: false };
    return { ok: true, status: 200, json: async () => json };
  };
  const pane = D.createDiffPane({ A: '/api/chats/x', send: async () => ({}), editor() {} });
  const changesBtn = document.createElement('button');
  document.body.append(changesBtn, pane.el);
  changesBtn.focus();
  await pane.open();
  const plusOf = (n) => pane.el.querySelectorAll('.dp-plus').find((b) => b.getAttribute('aria-label') === `Comment on line ${n}`);
  const plus = plusOf(2);
  plus.listeners.click({ currentTarget: plus });
  const ta = pane.el.querySelector('textarea');
  assert.equal(document.activeElement, ta, 'the comment box has the focus');
  ta.value = 'Name it better';
  ta.listeners.keydown({ key: 'Enter', shiftKey: false, preventDefault() {}, stopPropagation() {} });
  assert.equal(pane.comments().length, 1);
  assert.equal(document.activeElement, plusOf(2), 'after Enter: the line\'s +, inside the pane (not the page)');
  assert.ok(pane.el.contains(document.activeElement));
  pane.el.querySelector('.dp-note-x').listeners.click({});
  assert.equal(pane.comments().length, 0);
  assert.equal(document.activeElement, plusOf(2), 'after Remove: the line\'s + again');
  plusOf(2).listeners.click({ currentTarget: plusOf(2) });
  pane.el.querySelector('textarea').listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(document.activeElement, plusOf(2), 'a comment box closed with Esc gives the focus back to its line');
  // A box open and the focus on its Cancel or in the diff text: Esc closes the box and goes no further (the page's
  // Esc would stop Claude's turn: keys.js leaves a key alone whose default was prevented).
  plusOf(2).listeners.click({ currentTarget: plusOf(2) });
  pane.el.querySelector('.dp-box').querySelector('button').focus(); // Cancel
  const esc = { key: 'Escape', defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  pane.el.listeners.keydown(esc);
  assert.deepEqual([esc.defaultPrevented, esc.stopped], [true, true], 'the key is the pane\'s only, also with a comment box open');
  assert.equal(pane.el.querySelector('textarea'), null, 'the comment box closed');
  assert.equal(pane.isOpen(), true, 'the pane stays open');
  assert.equal(document.activeElement, plusOf(2), 'the focus is back on the line');
  pane.el.listeners.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(pane.isOpen(), false);
  assert.equal(document.activeElement, changesBtn, 'closed: the focus is back on what opened it');
  pane.el.remove();
  changesBtn.remove();
});

test('the file list never grows wider than the pane: a long name is cut, its counts stay in view', () => {
  const css = fs.readFileSync(new URL('../../web/chat/diffpane.css', import.meta.url), 'utf8');
  assert.match(css, /\.dp-files \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.dp-files > li \{ min-width: 0; \}/);
  assert.match(css, /\.dp-file-n \{ flex: none;/, 'the counts never shrink');
});

test('a name that starts with a dot reads as written: the path is isolated left to right inside the cut-at-the-start name', async () => {
  globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => (String(u).includes('/changes')
    ? { git: true, files: 1, added: 1, removed: 0, list: [{ path: '.env.example', added: 1, removed: 0, new: true }] }
    : { path: '.env.example', new: true, binary: false, hunks: [{ oldStart: 0, newStart: 1, lines: ['+A=1'] }], cut: false }) });
  const pane = D.createDiffPane({ A: '/api/chats/x', send: async () => ({}), editor() {} });
  await pane.open();
  const name = pane.el.querySelector('.dp-file-name');
  const inner = name.children[0];
  assert.equal(inner.tag, 'bdi');
  assert.equal(inner.getAttribute('dir'), 'ltr');
  assert.deepEqual(inner.children.map((c) => c.text), ['.env.example']);
});

test('a screen reader reaches and names each line\'s +, and hears whether a line was added or removed', async () => {
  globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => (String(u).includes('/changes')
    ? { git: true, files: 1, added: 1, removed: 1, list: [{ path: 'a.js', added: 1, removed: 1, new: false }] }
    : { path: 'a.js', new: false, binary: false, hunks: [{ oldStart: 1, newStart: 1, lines: [' x', '-y', '+z'] }], cut: false }) });
  for (const split of [false, true]) {
    const pane = D.createDiffPane({ A: '/api/chats/x', send: async () => ({}), editor() {} });
    await pane.open();
    if (split) {
      pane.el.querySelectorAll('.dp-seg')[1].listeners.click({});
    }
    const hidden = (n) => {
      for (let x = n; x; x = x.parentNode) if (x.getAttribute && x.getAttribute('aria-hidden') === 'true') return true;
      return false;
    };
    const pluses = pane.el.querySelectorAll('.dp-plus');
    assert.ok(pluses.length >= 2, `${split ? 'side by side' : 'unified'}: the + buttons`);
    assert.ok(pluses.every((b) => !hidden(b)), 'no + inside aria-hidden');
    const said = pane.el.querySelectorAll('.chat-sr').map((x) => x.children.map((c) => c.text).join(''));
    assert.deepEqual(said.filter((t) => /Added|Removed/.test(t)), ['Removed: ', 'Added: ']);
    assert.ok(pane.el.querySelectorAll('.dp-m').every((m) => m.getAttribute('aria-hidden') === 'true' && m.getAttribute('aria-label') === null));
  }
});

test('a finger: the pane\'s buttons and the Home note\'s are 44 px, and a line is tall enough that its + never overlaps the next', () => {
  const css = fs.readFileSync(new URL('../../web/chat/diffpane.css', import.meta.url), 'utf8');
  const coarse = css.slice(css.lastIndexOf('@media (pointer: coarse)'));
  assert.match(coarse, /\.dp-plus \{[^}]*height: 26px;/);
  assert.match(coarse, /\.dp-n \{[^}]*min-height: 28px;/, 'line ≥ the + (26 px)');
  // Two classes each, as .btn.icon and .btn.small have: one class lost to them (measured 38 and 30 px on a phone).
  assert.match(coarse, /\.dp-head \.dp-close, \.dp-head \.dp-editor \{ width: 44px; min-height: 44px; \}/);
  assert.match(coarse, /\.dp-foot \.dp-send, \.dp-box-actions \.btn, \.dp-note \.btn \{ min-height: 44px; \}/);
  const style = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  assert.match(style, /@media \(pointer: coarse\) \{ \.bypass-note \.btn \{ min-height: 44px; \} \}/);
});
