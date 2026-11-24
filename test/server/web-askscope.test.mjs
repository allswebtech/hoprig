// The lasting answer keeps the chat's words ("Allow, and don't ask again for this kind of command"); what the rule
// covers stands under the buttons, where a phone shows it too (a phone shows no tooltip).
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
const ask = { name: 'shop', kind: 'claude', status: 'attention', machine: null, ask: { type: 'permission', what: 'npm install left-pad', waiting: 1 } };

test('the kind of command a lasting rule covers is said under the buttons', () => {
  const box = permissionActions({ ...ask, always: { key: '2', text: "Yes, and don't ask again for npm install commands", label: "Don't ask again for npm install commands" } });
  const scope = box.children.find((c) => /ok-scope/.test(c.className));
  assert.ok(scope, 'a line under the buttons');
  assert.deepEqual(texts(scope), ['This kind of command: npm install']);
  assert.equal(scope.tag, 'p', 'a line of text, not a control');
});

test('an answer that says its own scope gets no extra line', () => {
  const box = permissionActions({ ...ask, always: { key: '2', text: 'Yes, allow all edits during this session (shift+tab)', label: 'Allow all edits during this session' } });
  assert.equal(box.children.some((c) => /ok-scope/.test(c.className)), false);
  assert.equal(permissionActions(ask).children.some((c) => /ok-scope/.test(c.className)), false, 'no lasting answer, no line');
});

test('the line takes a row of its own', () => {
  assert.match(fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8'), /\.ok-scope \{ flex-basis: 100%;/);
});
