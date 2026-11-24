// The save sheet's key refusal offers its own way through: Move out, which names the folder beside the AI brain
// before the press, says nothing is deleted, and for a file git keeps that it leaves the git server at the next save
// while its old versions stay in the history, so a real key must be changed. Only the refused files are sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// A small stand-in for the browser DOM: what the page modules touch when they load.
class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  // What a sheet (a dialog) needs of an element: opened and closed as the browser does, with its close event.
  get classList() {
    return { add() {}, remove() {}, toggle() {} };
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    if (this.listeners.close) this.listeners.close();
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  remove() {}
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { saveWords, moveOutWords } = await import('../../web/gitsetup.js');
const repo = 'team/ai_brain on git.example.test';
const base = { count: 2, files: ['.env', 'a.md'], more: 0, all: ['.env', 'a.md'], ahead: 0, behind: 0, repo, upstream: 'origin/main' };

test('a refused new file: the button moves it to the folder the sheet names, nothing deleted', () => {
  const w = saveWords({ ...base, secret: ['.env'], secretTracked: [], movedOut: '~/Workspace/ai_brain-moved-out', moveSeen: 'a'.repeat(64) });
  assert.equal(w.button, null, 'still nothing to save');
  assert.deepEqual(w.moveOut.files, ['.env'], 'only the refused file is sent');
  assert.equal(w.moveOut.button, 'Move it out');
  assert.equal(w.moveOut.text, 'Move it out of the AI brain now, to ~/Workspace/ai_brain-moved-out');
  assert.match(w.moveOut.notes.join(' '), /^Nothing is deleted/);
  assert.doesNotMatch(w.moveOut.notes.join(' '), /history|taken out of git/, 'a new file was never on the server');
});

test('a file git keeps: it leaves the git server at the next save, its old versions stay, a real key is changed', () => {
  const w = saveWords({ ...base, files: ['notes.md', 'x.pem'], all: ['notes.md', 'x.pem'], secret: ['notes.md', 'x.pem'], secretTracked: ['notes.md'], movedOut: '~/Workspace/ai_brain-moved-out', moveSeen: 'a'.repeat(64) });
  assert.equal(w.moveOut.button, 'Move 2 files out');
  const said = w.moveOut.notes.join(' ');
  assert.match(said, new RegExp(`notes\\.md was saved before, so it is also taken out of git: the next save takes it off ${repo}\\.`));
  assert.match(said, /old versions stay in the AI brain's history there, so a real key or password in it must be changed/);
  const both = moveOutWords(['a.md', 'b.md'], ['a.md', 'b.md'], '~/x-moved-out', repo);
  assert.match(both.notes[1], /^They were saved before, so they are also taken out of git: the next save takes them off/);
});

test('an older server that names no folder: no button, the advice as before', () => {
  const w = saveWords({ ...base, secret: ['.env'], secretTracked: [] });
  assert.equal(w.moveOut, undefined);
});

test('the sheet sends only the names it showed, to the move route, on the press', () => {
  const src = fs.readFileSync(new URL('../../web/gitsetup.js', import.meta.url), 'utf8');
  assert.match(src, /api\('\/api\/workspace\/git\/brain\/moveout', \{ files: w\.moveOut\.files, seen: w\.moveOut\.seen \}\)/);
  assert.match(src, /onclick: async \(\) => \{\n\s+mv\.disabled = true;/, 'only in the button\'s press');
});
