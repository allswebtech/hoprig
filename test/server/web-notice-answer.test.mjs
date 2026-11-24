// A notice card (Claude Code's own question before it starts) says in one sentence where it is answered and why the
// page sends him there; the question itself is the card's note (src/server/deck.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(t) {
    super();
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...n) { for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x))); }
  replaceChildren(...n) { this.children = []; this.append(...n); }
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));

const { permissionActions } = await import('../../web/lib.js');
const notice = { name: 'blog', kind: 'claude', status: 'attention', machine: null, note: 'Allow external CLAUDE.md file imports?', askCard: { kind: 'notice', notice: { type: 'imports', text: 'Allow external CLAUDE.md file imports?' } } };

test('a notice card says why the terminal is needed, and Answer opens it', () => {
  const box = permissionActions(notice);
  assert.deepEqual(texts(box), ['Claude Code asks this in its own window: press Answer to open it.', 'Answer']);
  assert.match(box.children[1].attrs.href || box.children[1].href || '', /#\/s\/blog/);
});

test('a permission card that must be answered in the terminal keeps its words', () => {
  assert.deepEqual(texts(permissionActions({ ...notice, askCard: undefined })), ['Answer in the terminal.', 'Answer']);
  assert.deepEqual(texts(permissionActions(notice, null, { here: true })), ['Answer in the terminal below.'], 'on its own page the terminal is right there');
});
