// The limit card: one main button, the first free account; every other way under "Other ways"; a paid one always
// ends in "· costs money per use" whatever its label says; Auto mode is said in plain words.
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
const label = (b) => texts(b).join('');

const { limitBox } = await import('../../web/lib.js');
const s = { name: 'shop', canSwitch: true, limit: { text: 'limit reached' }, profile: { name: 'max' } };
const profiles = [
  { name: 'auto', label: 'Auto', kind: 'auto', virtual: true },
  { name: 'max', label: 'Claude Max', kind: 'subscription', autoPlace: 0, limited: { until: 1 } },
  { name: 'team', label: 'Team plan', kind: 'subscription', autoPlace: 1 },
  { name: 'api', label: 'API (pay as you go)', kind: 'api', paid: true, autoPlace: 2 },
  { name: 'key', label: 'Claude API', kind: 'api', paid: true },
];

test('one main button outside the fold; the rest under "Other ways"', () => {
  const box = limitBox(s, profiles);
  const fold = find(box, 'details');
  assert.equal(fold.length, 1, 'one fold');
  assert.equal(label(find(fold[0], 'summary')[0]), 'Other ways');
  const inFold = new Set(find(fold[0], 'button'));
  const outside = find(box, 'button').filter((b) => !inFold.has(b));
  assert.deepEqual(outside.map((b) => [/primary/.test(b.className), label(b)]), [[true, 'Continue on Team plan']]);
  assert.deepEqual([...inFold].map((b) => [/primary/.test(b.className), label(b)]), [
    [false, 'Go on with the next provider that has room each time (next: Team plan)'],
    [false, 'Continue on API (pay as you go) · costs money per use'],
    [false, 'Continue on Claude API · costs money per use'],
  ]);
});

test('every paid way says it costs money, whatever its label', () => {
  const words = find(limitBox(s, profiles), 'button').map(label);
  for (const w of words.filter((x) => /API/.test(x) && !/next:/.test(x))) assert.match(w, / · costs money per use$/, w);
  assert.ok(!words.some((w) => /paid per use|Continue on Auto/.test(w)), 'the old words are gone');
  // Auto mode whose next stop is a paid one says so too.
  const paidNext = limitBox(s, [profiles[0], profiles[1], { ...profiles[3], autoPlace: 1 }]);
  assert.ok(find(paidNext, 'button').map(label).includes('Go on with the next provider that has room each time (next: API (pay as you go) · costs money per use)'));
});

test('no free account: nothing is folded away and nothing leads', () => {
  const box = limitBox(s, [profiles[1], profiles[4]]);
  assert.equal(find(box, 'details').length, 0);
  assert.deepEqual(find(box, 'button').map((b) => [/primary/.test(b.className), label(b)]), [[false, 'Continue on Claude API · costs money per use']]);
});

test('opening the fold does not open the session behind the card', () => {
  const summary = find(find(limitBox(s, profiles), 'details')[0], 'summary')[0];
  let stopped = false;
  summary.listeners.click({ stopPropagation: () => (stopped = true) });
  assert.equal(stopped, true);
});
