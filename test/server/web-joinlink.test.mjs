// The line to paste on the other computer: the page way first, Hoprig's install page named in the first step, and the
// terminal command with the fingerprint's note folded under a closed "For the terminal".
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
const { pasteSteps, INSTALL_PAGE } = await import('../../web/joinlink.js');

const c = { line: 'https://pc.example.com#join=K7QM-4XP2', note: 'The fingerprint is that of this hub\'s own certificate authority.' };
const cmd = 'hoprig join https://pc.example.com K7QM-4XP2 --fingerprint AB:CD';

test('the first step installs Hoprig on the other computer, with a link to the install page', () => {
  const [first] = pasteSteps(c, cmd, '10:30');
  const words = first.flatMap(texts).join('');
  assert.match(words, /^Install Hoprig on the other computer first/);
  const a = first.flatMap(all).find((e) => e.tag === 'a');
  assert.ok(a, 'a link in the first step');
  assert.equal(a.attrs.href, INSTALL_PAGE);
  assert.match(INSTALL_PAGE, /^https:\/\/hoprig\.com\/docs\/install\/$/);
});

test('the terminal command and the fingerprint note are only under a closed "For the terminal"', () => {
  const list = pasteSteps(c, cmd, '10:30');
  const nodes = list.flat().flatMap(all);
  const fold = nodes.find((e) => e.tag === 'details');
  assert.ok(fold, 'a details fold');
  assert.ok(!fold.open && !('open' in fold.attrs), 'closed at first');
  assert.equal(texts(fold.children[0]).join(''), 'For the terminal');
  const inside = texts(fold).join(' ');
  assert.match(inside, /hoprig join/);
  assert.match(inside, /certificate authority/);
  // Outside the fold: the line to paste, and neither the command nor the note.
  const withoutFold = (n) => (n === fold ? [] : n instanceof FakeText ? [n.text] : (n.children || []).flatMap(withoutFold));
  const seen = list.flat().flatMap(withoutFold).join(' ');
  assert.doesNotMatch(seen, /hoprig join|certificate authority|terminal/);
  assert.match(seen, /#join=K7QM-4XP2/);
});

test('with no note the fold holds the command alone', () => {
  const fold = pasteSteps({ line: c.line }, cmd, '10:30').flat().flatMap(all).find((e) => e.tag === 'details');
  assert.doesNotMatch(texts(fold).join(' '), /certificate/);
  assert.match(texts(fold).join(' '), /hoprig join/);
});
