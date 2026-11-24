// What the terminal page types for a file dropped or pasted on it (web/termdrop.js), the paste key (web/termkeys.js),
// and how the page wires them (web/session.js), as far as a test without a browser reaches.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { clipboardPictures, dragHasFiles, failWords, filesOf, pastedFiles, shellWord, typedPaths } from '../../web/termdrop.js';
import { CTRL_V, KEY_BAR, pasteKey } from '../../web/termkeys.js';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

test('a path is typed as it is when a shell takes it so, else in single quotes', () => {
  assert.equal(shellWord('/tmp/state/drops/shell/20261118-101500-ab12-shot.png'), '/tmp/state/drops/shell/20261118-101500-ab12-shot.png');
  assert.equal(shellWord('/a/my shot.png'), `'/a/my shot.png'`);
  assert.equal(shellWord(`/a/it's.png`), `'/a/it'\\''s.png'`);
  assert.equal(shellWord('/a/$HOME;rm.png'), `'/a/$HOME;rm.png'`);
  assert.equal(shellWord('/a/स्क्रीन.png'), `'/a/स्क्रीन.png'`);
});

test('several paths: one space between, one at the end, never an Enter; none: nothing', () => {
  assert.equal(typedPaths(['/a/one.png']), '/a/one.png ');
  assert.equal(typedPaths(['/a/one.png', '/a/two words.txt', '/a/three.pdf']), `/a/one.png '/a/two words.txt' /a/three.pdf `);
  assert.equal(typedPaths([]), '');
  assert.equal(typedPaths(undefined), '');
  assert.equal(typedPaths([null, '']), '');
  assert.doesNotMatch(typedPaths(['/a', '/b']), /[\r\n]/);
});

test('what a shell reads back from the typed text is each path, unchanged', { skip: process.platform === 'win32' && 'a POSIX shell' }, () => {
  const paths = ['/x/plain.png', '/x/with space.png', `/x/it's "q".png`, '/x/$(echo no).png', '/x/स्क्रीन.png'];
  const out = execFileSync('sh', ['-c', `for a in ${typedPaths(paths)}; do printf '%s\\n' "$a"; done`]).toString();
  assert.deepEqual(out.trimEnd().split('\n'), paths);
});

const file = (name, size = 1, type = 'image/png') => ({ name, size, type });
const dt = ({ files = [], items = [], types = [], text = '' } = {}) => ({ files, items, types, getData: (k) => (k === 'text/plain' ? text : '') });

test('the files of a drop or a paste: dt.files, a picture item, each once; text alone carries none', () => {
  const a = file('a.png');
  assert.deepEqual(filesOf(dt({ files: [a] })), [a]);
  assert.deepEqual(filesOf(dt({ files: [a], items: [{ kind: 'file', getAsFile: () => file('a.png') }] })), [a], 'the same file once');
  const pic = file('image.png', 40);
  assert.deepEqual(filesOf(dt({ items: [{ kind: 'string' }, { kind: 'file', getAsFile: () => pic }] })), [pic], 'a screenshot in the clipboard');
  assert.deepEqual(filesOf(dt({ types: ['text/plain'], text: 'hello' })), []);
  assert.deepEqual(filesOf(null), []);
  // A copy from a document: text, its HTML and a picture of it is a text paste; a copied picture alone is a file.
  assert.deepEqual(pastedFiles(dt({ types: ['text/plain', 'text/html', 'Files'], text: 'cells', items: [{ kind: 'file', getAsFile: () => pic }] })), []);
  assert.deepEqual(pastedFiles(dt({ types: ['Files'], items: [{ kind: 'file', getAsFile: () => pic }] })), [pic]);
  assert.deepEqual(pastedFiles(dt({ types: ['text/html', 'Files'], items: [{ kind: 'file', getAsFile: () => pic }] })), [pic], 'a picture copied from a page');
  assert.equal(dragHasFiles({ types: ['Files'] }), true);
  assert.equal(dragHasFiles({ types: ['text/plain'] }), false);
  assert.equal(dragHasFiles(null), false);
});

test('a failed upload is one plain sentence why', () => {
  assert.equal(failWords('big.mov', 413, 'the file is larger than 25 MB'), 'big.mov was not sent: the file is larger than 25 MB.');
  assert.equal(failWords('a.png', 404, 'no such session'), 'a.png was not sent: the session has ended.');
  assert.equal(failWords('a.png', 0, 'Upload failed: connection lost'), 'a.png was not sent: there is no connection to the dashboard.');
  assert.equal(failWords('a.png', 401, 'log in first'), 'a.png was not sent: you are logged out.');
});

test('Ctrl+V and Ctrl+Shift+V are the paste key; Cmd+V and Ctrl+Alt+V are not taken', () => {
  const k = (o) => ({ type: 'keydown', key: 'v', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...o });
  assert.equal(pasteKey(k({ ctrlKey: true })), true);
  assert.equal(pasteKey(k({ ctrlKey: true, shiftKey: true, key: 'V' })), true);
  assert.equal(pasteKey(k({ ctrlKey: true, type: 'keyup' })), false);
  assert.equal(pasteKey(k({ metaKey: true })), false, 'Cmd+V is the browser\'s already');
  assert.equal(pasteKey(k({ ctrlKey: true, altKey: true })), false);
  assert.equal(pasteKey(k({ ctrlKey: true, key: 'c' })), false);
  assert.equal(CTRL_V, '\x16');
});

test('the terminal page: a drop anywhere is stopped, files go up and their paths are typed, paste and File do the same', () => {
  const src = fs.readFileSync(path.join(WEB, 'session.js'), 'utf8');
  // The whole page, not only the terminal's box; taken off again when the page closes.
  for (const ev of ['dragenter', 'dragover', 'drop']) {
    assert.match(src, new RegExp(`window\\.addEventListener\\('${ev}', on\\w+\\);`), ev);
    assert.match(src, new RegExp(`window\\.removeEventListener\\('${ev}', on\\w+\\);`), `${ev} removed`);
  }
  const onDrop = src.slice(src.indexOf('const onDrop = '), src.indexOf('const onPaste = '));
  assert.match(onDrop, /e\.preventDefault\(\);\s*if \(files\.length\) return sendFiles\(files\);/);
  // A paste is looked at before the terminal library's handler, which takes text only.
  assert.match(src, /wrap\.addEventListener\('paste', onPaste, \{ capture: true \}\);/);
  const onPaste = src.slice(src.indexOf('const onPaste = '), src.indexOf("window.addEventListener('dragenter'"));
  assert.match(onPaste, /pastedFiles\(e\.clipboardData\)/);
  assert.match(onPaste, /sendFiles\(files\);/);
  // The paste key goes to the browser's paste (Ctrl+V reaches the clipboard's picture).
  assert.match(src, /if \(pasteKey\(e\)\) \{ ctrlV = performance\.now\(\); return false; \}/);
  // …and on a Mac, where the browser pastes on Cmd+V only, the page reads the clipboard itself, before that line.
  assert.match(src, /if \(onMac && pasteKey\(e\)\) \{ e\.preventDefault\(\); macCtrlV\(\); return false; \}\n\s*if \(pasteKey\(e\)\)/);
  assert.match(src, /async function macCtrlV\(\) \{\n\s*const files = await clipboardPictures\(navigator\.clipboard\);\n\s*if \(disposed\) return;\n\s*if \(files\.length\) sendFiles\(files\);\n\s*else input\(CTRL_V\);/);
  assert.match(onPaste, /performance\.now\(\) - ctrlV < 1000/, 'an empty paste sends Ctrl+V only after the key itself');
  // Uploads go to the drop route; only what arrived is typed, as typedPaths makes it; a failure is said.
  const send = src.slice(src.indexOf('const sendFiles = '), src.indexOf("dropInput.addEventListener('change'"));
  assert.match(send, /upload\(f, `\$\{base\}\/drop\/upload`\)/);
  assert.match(send, /const text = typedPaths\(paths\);\s*if \(text\) await typeIntoTerminal\(text\);/);
  assert.match(send, /failWords\(/);
  assert.match(send, /say\(`Uploading/);
  // File in the key bar on a touch screen opens the picker of its own input.
  assert.match(src, /finePointer \? null : h\('button\.key', \{ type: 'button', dataset: \{ act: 'file' \}/);
  assert.match(src, /if \(b\.dataset\.act === 'file'\) return dropInput\.click\(\);/);
  // The progress of an upload: the page's XHR reports it, and a failure carries its status.
  assert.match(src, /xhr\.upload\.onprogress/);
  assert.match(src, /\{ status: xhr\.status \}/);
  const css = fs.readFileSync(path.join(WEB, 'page-session.css'), 'utf8');
  const fileCols = Number(/\.keybar\.has-file \{ grid-template-columns: repeat\((\d+),/.exec(css)[1]);
  assert.equal(fileCols, KEY_BAR.length + 2, 'one more column on a wide touch screen: every key, Paste and File');
});

test('Ctrl+V on a Mac: the clipboard\'s pictures as files; none, a refusal or no such reading gives nothing', async () => {
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  const item = (types, blob) => ({ types, getType: async (t) => { assert.ok(types.includes(t)); return blob; } });
  const got = await clipboardPictures({ read: async () => [item(['text/plain'], new Blob(['x'])), item(['text/html', 'image/png'], png), item(['image/svg+xml'], new Blob(['<svg/>'], { type: 'image/svg+xml' }))] });
  assert.deepEqual(got.map((f) => [f.name, f.type, f.size]), [['image.png', 'image/png', 4], ['image.svgxml', 'image/svg+xml', 6]]);
  assert.ok(got[0] instanceof File);
  assert.deepEqual(await clipboardPictures({ read: async () => [item(['text/plain'], new Blob(['only text']))] }), [], 'text alone: nothing, the program gets the key');
  assert.deepEqual(await clipboardPictures({ read: async () => { throw new DOMException('denied', 'NotAllowedError'); } }), [], 'the person said no');
  assert.deepEqual(await clipboardPictures({}), [], 'a browser without it');
  assert.deepEqual(await clipboardPictures(null), []);
});

