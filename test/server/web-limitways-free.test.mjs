// The limit card's words: "free" reads as "no cost" to many, so no label that can end in "costs money per use" says
// "free". Auto mode says it goes on with the next provider that has room.
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
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  append(...n) { for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x))); }
  replaceChildren(...n) { this.children = []; this.append(...n); }
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const find = (n, tag) => (n instanceof FakeText ? [] : [...(n.tag === tag ? [n] : []), ...n.children.flatMap((c) => find(c, tag))]);

const { limitBox } = await import('../../web/lib.js');
const s = { name: 'shop', canSwitch: true, limit: { text: 'limit reached' }, profile: { name: 'max' } };
const auto = { name: 'auto', label: 'Auto', kind: 'auto', virtual: true };
const max = { name: 'max', label: 'Claude Max', kind: 'subscription', autoPlace: 0, limited: { until: 1 } };
const api = { name: 'api', label: 'API (pay as you go)', kind: 'api', paid: true, autoPlace: 1 };
const team = { name: 'team', label: 'Team plan', kind: 'subscription', autoPlace: 2 };

test('Auto whose next stop costs money does not call it free', () => {
  const words = find(limitBox(s, [auto, max, api]), 'button').map((b) => texts(b).join(''));
  assert.ok(words.includes('Go on with the next provider that has room each time (next: API (pay as you go) · costs money per use)'), words.join(' | '));
  for (const w of words) assert.doesNotMatch(w, /\bfree\b/i, w);
});

test('no label of the card says "free", whichever way is next', () => {
  for (const ps of [[auto, max, team, api], [auto, max, api, team], [auto, max]]) {
    for (const b of find(limitBox(s, ps), 'button')) assert.doesNotMatch(texts(b).join(''), /\bfree\b/i);
  }
});
