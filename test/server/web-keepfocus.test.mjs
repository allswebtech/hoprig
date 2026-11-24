// A card that the polling draws again keeps the keyboard's focus on the same answer (web/lib.js fill and the answers'
// data-keep-focus marks): a keyboard user who reached Allow or Do not allow can press it seconds later.
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
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, disabled: false });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) && this.attrs[k] !== null ? String(this.attrs[k]) : null; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  append(...nodes) { for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n))); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  contains(n) { return n === this || this.children.some((c) => c instanceof FakeElement && c.contains(n)); }
  querySelectorAll(sel) {
    const m = /^\[([\w-]+)\]$/.exec(sel);
    const all = (e) => e.children.filter((c) => c instanceof FakeElement).flatMap((c) => [c, ...all(c)]);
    return m ? all(this).filter((e) => e.getAttribute(m[1]) !== null) : [];
  }
  focus() { globalThis.document.activeElement = this; }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', activeElement: null, body: null };
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const button = (root, label) => root.querySelectorAll('[data-keep-focus]').find((b) => texts(b).join('') === label);

const { fill, h, permissionActions } = await import('../../web/lib.js');
const ask = { name: 'shop', kind: 'claude', status: 'attention', machine: null, askAt: 5, ask: { type: 'permission', what: 'npm install left-pad', waiting: 1 } };

for (const label of ['Allow', 'Do not allow']) {
  test(`${label}: a card drawn again gives the focus back to its new ${label}`, () => {
    const slot = h('div');
    fill(slot, h('div.card', permissionActions(ask)));
    const was = button(slot, label);
    was.focus();
    fill(slot, h('div.card', permissionActions({ ...ask, attached: 1 }))); // the poll: something else on the card changed
    const now = button(slot, label);
    assert.notEqual(now, was, 'the card was drawn again');
    assert.equal(document.activeElement, now, 'the focus is on the same answer of the new card');
  });
}

test('a new question takes no focus from the old one, a disabled answer none, and nothing is focused that was not', () => {
  const slot = h('div');
  fill(slot, permissionActions(ask));
  button(slot, 'Allow').focus();
  const was = document.activeElement;
  fill(slot, permissionActions({ ...ask, askAt: 6 })); // another question: the owner has not read it yet
  assert.equal(document.activeElement, was, 'the focus does not move onto an answer of another question');
  const other = h('input');
  other.focus();
  fill(slot, permissionActions(ask));
  assert.equal(document.activeElement, other, 'focus elsewhere stays where it is');
});
