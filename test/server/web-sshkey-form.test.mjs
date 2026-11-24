// Add a computer by its key file: Address, User and the key first; the SSH port (22) under a closed Advanced; the
// word "passphrase" said in plain words.
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
  get classList() {
    return { add() {}, remove() {}, toggle() {} };
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

const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));
const all = (n) => (n instanceof FakeElement ? [n, ...n.children.flatMap(all)] : []);
const { byKey } = await import('../../web/sshkey.js');

test('the SSH port is only under a closed Advanced, with 22 filled in', () => {
  const form = byKey(() => true, () => {});
  const nodes = all(form);
  const fold = nodes.find((e) => e.tag === 'details');
  assert.ok(fold, 'a details fold');
  assert.ok(!fold.open && !('open' in fold.attrs), 'closed at first');
  assert.equal(texts(fold.children[0]).join(''), 'Advanced');
  const port = all(fold).find((e) => e.attrs['aria-label'] === 'SSH port');
  assert.ok(port, 'the port field is inside the fold');
  assert.equal(port.value ?? port.attrs.value, '22');
  const outside = nodes.filter((e) => !all(fold).includes(e));
  assert.ok(!outside.some((e) => e.attrs['aria-label'] === 'SSH port'), 'no port field outside the fold');
  assert.ok(outside.some((e) => e.attrs['aria-label'] === 'Address') && outside.some((e) => e.attrs['aria-label'] === 'User'));
});

test('"passphrase" is said in plain words', () => {
  const words = texts(byKey(() => true, () => {})).join(' ');
  assert.match(words, /A key with a passphrase \(a password of its own that is asked each time the key is used\) cannot be used\./);
});
