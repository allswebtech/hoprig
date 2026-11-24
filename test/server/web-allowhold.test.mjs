// After Allow on a card: a toast says what happened ("Allowed. shop goes on."), and the answered card stays one
// second as "Allowed" before it moves, so the next card does not slide under his finger.
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
  remove() {}
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const press = (b) => b.listeners.click({ preventDefault() {}, stopPropagation() {}, currentTarget: b });

const { answeredNow, permissionActions, stateOf } = await import('../../web/lib.js');

function setup(t, answer = { ok: true, status: 200, json: async () => ({ ok: true }) }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 5_000_000 });
  document.body = new FakeElement('body');
  const fetchWas = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (u, o) => {
    sent.push([u, JSON.parse(o.body)]);
    return answer;
  };
  t.after(() => {
    globalThis.fetch = fetchWas;
    delete document.body;
  });
  return sent;
}
const toasts = () => texts(document.body).join(' ');

test('Allow: a toast with the session\'s name, and the card stays one second as "Allowed"', async (t) => {
  const sent = setup(t);
  const card = { name: 'shop', kind: 'claude', status: 'attention', machine: null, askAt: 7, statusAt: 7, ask: { type: 'permission', what: 'npm test', waiting: 1 } };
  let looks = 0;
  const box = permissionActions(card, () => looks++);
  await press(box.children[0]);
  assert.equal(sent.length, 1);
  assert.match(toasts(), /Allowed\. shop goes on\./);
  assert.deepEqual(texts(box), ['Allowed']);
  // The next look already says it works: for one second the card is still the answered one, in its place.
  const next = { ...card, status: 'working', statusAt: 9, askAt: undefined, ask: undefined };
  assert.deepEqual([stateOf(next).key, stateOf(next).text], ['attention', 'Allowed']);
  assert.deepEqual(texts(permissionActions(next)), ['Allowed'], 'no buttons come back while it stands');
  assert.equal(answeredNow(next), true);
  const before = looks;
  t.mock.timers.tick(1100);
  assert.ok(looks > before, 'the page looks again when the second is over');
  assert.deepEqual([stateOf(next).key, stateOf(next).text], ['working', 'Working'], 'then it moves to where it is');
  assert.equal(answeredNow(next), false, 'and Home sees a change, so it draws it there');
  assert.equal(permissionActions(next), null);
});

test('Do not allow: "Not allowed. shop was told no."', async (t) => {
  setup(t);
  const card = { name: 'shop', display: 'Shop site', kind: 'claude', status: 'attention', machine: 'box2', askAt: 11, ask: { type: 'permission', what: 'rm -r build', waiting: 1 } };
  const box = permissionActions(card, () => {});
  await press(box.children[box.children.length - 1]);
  assert.match(toasts(), /Not allowed\. Shop site was told no\./);
  assert.deepEqual([stateOf(card).text], ['Not allowed']);
  t.mock.timers.tick(1100);
});

test('an answer the computer refused holds nothing', async (t) => {
  setup(t, { ok: false, status: 409, json: async () => ({ error: 'No permission question is on the screen now' }) });
  const card = { name: 'cart', kind: 'claude', status: 'attention', machine: null, askAt: 3, ask: { type: 'permission', what: 'npm test', waiting: 1 } };
  const box = permissionActions(card, () => {});
  await press(box.children[0]);
  assert.equal(stateOf(card).text, 'Needs your OK');
  assert.equal(stateOf({ ...card, status: 'working' }).text, 'Working');
});

test('a chat\'s Allow says the same', async (t) => {
  setup(t);
  const card = { name: 'chat-1', display: 'Bakery', kind: 'chat', chatId: 'c1', status: 'attention', machine: null, ask: { type: 'permission', request: 'r1' } };
  const box = permissionActions(card, () => {});
  await press(box.children[0]);
  assert.match(toasts(), /Allowed\. Bakery goes on\./);
  assert.equal(stateOf({ ...card, status: 'working' }).text, 'Allowed');
  t.mock.timers.tick(1100);
  assert.equal(stateOf({ ...card, status: 'working' }).text, 'Working');
});

test('the held card keeps its place among the others: the next look\'s newer time does not move it up', async (t) => {
  setup(t);
  const { needsYouFirst } = await import('../../web/lib.js');
  const first = { name: 'cart', kind: 'claude', status: 'attention', machine: null, statusAt: 200, askAt: 200, ask: { type: 'permission', what: 'npm test', waiting: 1 } };
  const second = { name: 'app', kind: 'claude', status: 'attention', machine: null, statusAt: 100, askAt: 100, ask: { type: 'permission', what: 'npm i', waiting: 1 } };
  assert.deepEqual([second, first].sort(needsYouFirst).map((x) => x.name), ['cart', 'app']);
  await press(permissionActions(second, () => {}).children[0]);
  const next = { ...second, status: 'working', statusAt: 5_000_000, askAt: undefined, ask: undefined };
  assert.deepEqual([next, first].sort(needsYouFirst).map((x) => x.name), ['cart', 'app'], 'it stays second for its second');
  t.mock.timers.tick(1100);
});
