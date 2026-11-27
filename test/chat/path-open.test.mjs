// A file path in the chat opens Hoprig's editor at that file and line, with the desktop's menu (web/chat/pathmenu.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass } from './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
globalThis.requestAnimationFrame ||= () => 0;
const P = await import('../../web/chat/pathmenu.js');
const { toolCard, rePaths } = await import('../../web/chat/tools.js');
const { createTimeline } = await import('../../web/chat/timeline.js');

test('what is a path of the folder: relative or absolute inside it, with a line; words, addresses and outside paths are not', () => {
  const s = P.pathSpec('src/cart.js:12', '/p');
  assert.deepEqual([s.rel, s.abs, s.name, s.line], ['src/cart.js', '/p/src/cart.js', 'cart.js', 12]);
  assert.equal(P.pathSpec('/p/src/a.ts#L7', '/p').rel, 'src/a.ts');
  assert.equal(P.pathSpec('/p/src/a.ts#L7', '/p').line, 7);
  assert.equal(P.pathSpec('./README.md', '/p').rel, 'README.md');
  for (const no of ['npm test', 'Array.map', 'https://x.org/a.js', '/etc/hosts', '../up/a.js', '~/a.js', 'src/', 'foo']) assert.equal(P.pathSpec(no, '/p'), null, no);
});

test('the editor address has the folder, file and line', () => {
  assert.match(P.fileLink('/p', 'src/cart.js', { line: 12 }), /^#\/code\?dir=%2Fp&file=src%2Fcart\.js&line=12$/);
  assert.match(P.fileLink('/p', 'a.js', { view: 'changes' }), /view=changes/);
});

test('the menu: Attach as context, Open in > Editor / Source control, Copy > Absolute path / Relative path / Filename', () => {
  const items = P.pathItems('/p', P.pathSpec('src/cart.js', '/p'));
  assert.deepEqual(items.map((x) => x.label), ['Attach as context', 'Open in', 'Copy']);
  assert.deepEqual(items[1].items.map((x) => x.label), ['Editor', 'Source control']);
  assert.deepEqual(items[2].items.map((x) => x.label), ['Absolute path', 'Relative path', 'Filename']);
  let got = null;
  document.addEventListener = (k, f) => (got = [k, f]);
  const sent = [];
  globalThis.CustomEvent = class { constructor(type, init) { Object.assign(this, { type }, init); } };
  document.dispatchEvent = (e) => sent.push(e);
  items[0].run();
  assert.equal(sent[0].type, 'chat-attach-path');
  assert.equal(sent[0].detail.path, 'src/cart.js');
  void got;
});

test('a tool card\'s path is a button, a search\'s folder is text; the folder said later is used when it is pressed', () => {
  const edit = toolCard({ id: 'e', name: 'Edit', toolKind: 'edit', input: { file_path: '/p/src/cart.js', old_string: 'a', new_string: 'b' } }, { cwd: '/p' });
  const b = byClass(edit, 'chat-pathbtn');
  assert.ok(b.length >= 1);
  assert.equal(b[0].dataset.pathfile, '/p/src/cart.js');
  const read = toolCard({ id: 'r', name: 'Read', toolKind: 'read', input: { file_path: '/p/a.md', offset: 40 } }, { cwd: '/p' });
  assert.equal(byClass(read, 'chat-pathbtn')[0].dataset.line, '40');
  const grep = toolCard({ id: 'g', name: 'Grep', toolKind: 'search', input: { pattern: 'x', path: '/p/src' } }, { cwd: '/p' });
  assert.equal(byClass(grep, 'chat-pathbtn').length, 0);
  const early = toolCard({ id: 'e2', name: 'Edit', toolKind: 'edit', input: { file_path: '/p/src/b.js', old_string: 'a', new_string: 'b' } }, { cwd: '' });
  const eb = byClass(early, 'chat-pathbtn')[0];
  assert.ok(eb, 'drawn before the folder is known, still a button');
  rePaths({ querySelectorAll: () => [eb] }, '/p'); // (the stand-in DOM does not select by data-)
  assert.equal(eb.dataset.cwd, '/p');
});

test('a `path` in Claude\'s text is a button, other code stays code', () => {
  const scroll = new (document.createElement('div').constructor)('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude' });
  tl.apply({ reset: true, events: [{ kind: 'user', text: 'go', i: 0 }, { kind: 'text', blockId: 'b', text: 'See `src/cart.js:12` and run `npm test`.', i: 1 }], next: 2 });
  assert.equal(byClass(tl.el, 'chat-pathbtn').length, 1);
  assert.equal(tl.el.querySelectorAll('code').length, 1);
});
