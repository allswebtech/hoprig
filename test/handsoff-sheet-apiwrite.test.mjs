// The first-time sheet's line for a direct call to GitHub or GitLab (web/handsoff.js OWNER_ACTS) says what the card
// says (src/wall.mjs WALL_REASON['api-write']): Hoprig read the call, which is how it knows the call can change
// something; what it cannot tell is what the call would change. And "a request" alone means nothing to a person who
// is not a programmer, since every call to GitHub is a request: the line says "a pull request".
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
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  append(...nodes) { for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n))); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { OWNER_ACTS } = await import('../web/handsoff.js');
const { WALL_TITLE, WALL_REASON } = await import('../src/wall.mjs');

test('the sheet\'s line for a direct call says Hoprig cannot tell what it would change, as the card does', () => {
  const act = OWNER_ACTS.find((a) => a.title === WALL_TITLE['api-write']);
  assert.ok(act, 'the sheet lists the direct call');
  assert.match(WALL_REASON['api-write'], /Hoprig cannot tell what it would change/, 'the card says what Hoprig cannot tell');
  assert.match(act.plain, /where Hoprig cannot tell what would change\./, 'the sheet says the same as the card');
  assert.doesNotMatch(act.plain, /cannot read/, 'Hoprig did read the call: that is how it knows the call can change something');
  assert.match(act.plain, /opening a pull request/, 'a pull request, not "a request": every call to GitHub is a request');
});
