// What the page takes from the answer of a Refresh: the time counts only when some account gave figures, and one
// account's own press shows that account's result, never another one's.
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const W = await import('../../web/providerwords.js');

test('the line says limits were read only when some account gave figures', () => {
  assert.equal(W.figuresAt({ at: 7, results: [{ name: 'a', read: 'none', error: 'x' }, { name: 'b', read: 'signin' }] }), null);
  assert.equal(W.figuresAt({ at: 7, results: [{ name: 'a', read: 'none' }, { name: 'b', read: 'figures' }] }), 7);
  assert.equal(W.figuresAt({ at: 7, results: [] }), null);
  assert.equal(W.figuresAt(null), null);
});

test('one account result is the one of its own name, or none', () => {
  const r = { results: [{ name: 'a', ok: false, error: 'a failed' }, { name: 'b', ok: true, read: 'figures' }] };
  assert.equal(W.resultOf(r, 'b').read, 'figures');
  assert.equal(W.resultOf(r, 'a').error, 'a failed');
  assert.equal(W.resultOf(r, 'c'), null);
  assert.equal(W.resultOf({}, 'a'), null);
});

test('the page uses both', () => {
  const s = fs.readFileSync('web/accounts.js', 'utf8');
  assert.match(s, /figuresAt\(r\)/);
  assert.match(s, /resultOf\(r, a\.name\)/);
  assert.ok(!/readAt = r\.at \|\| Date\.now\(\)/.test(s));
  assert.ok(!/\(r\.results \|\| \[\]\)\[0\]/.test(s));
});

test('the reading line counts only the accounts Refresh asks', () => {
  const ok = { kind: 'subscription', signedIn: true };
  assert.equal(W.askedByRefresh(ok), true);
  assert.equal(W.askedByRefresh({ kind: 'login', signedIn: null }), true);
  assert.equal(W.askedByRefresh({ kind: 'subscription', signedIn: false, signedOut: true }), false, 'signed out');
  assert.equal(W.askedByRefresh({ kind: 'login', signedIn: false }), false, 'signed out');
  assert.equal(W.askedByRefresh({ kind: 'subscription', signedIn: false, signinRefused: { at: 1 } }), true, 'a refused one is asked again');
  assert.equal(W.askedByRefresh({ kind: 'login', signedIn: true, paid: true }), false, 'billed by use');
  assert.equal(W.askedByRefresh({ kind: 'subscription', hub: true, signedIn: true }), false);
  assert.equal(W.askedByRefresh({ kind: 'api' }), false);
  const s = fs.readFileSync('web/accounts.js', 'utf8');
  assert.match(s, /filter\(askedByRefresh\)\.length/);
  assert.match(s, /reading && askedByRefresh\(a\)/);
});
