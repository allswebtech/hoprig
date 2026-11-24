// The line under a Claude sign-in on its provider page: a sign-in billed by use (a Console account) is named a
// sign-in, never a subscription, as its header and the Auto help already say "billed by use".
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeElement extends FakeNode {
  constructor(t) {
    super();
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...n) { this.children.push(...n); }
  replaceChildren(...n) { this.children = n; }
}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.location ??= { hostname: '127.0.0.1', pathname: '/', hash: '', origin: 'http://127.0.0.1' };

const { signinHint } = await import('../../web/accounts.js');

test('a Claude sign-in billed by use is not called a subscription; a subscription still is', () => {
  for (const kind of ['login', 'subscription']) {
    const billed = signinHint({ name: 'pro', kind, paid: true });
    assert.equal(billed, 'A Claude sign-in works with Claude Code only.');
    assert.doesNotMatch(billed, /subscription/i);
    assert.equal(signinHint({ name: 'max', kind }), 'A Claude subscription works with Claude Code only.');
  }
  assert.equal(signinHint({ name: 'key', kind: 'api', paid: true }), null, 'an API key has no such line');
});
