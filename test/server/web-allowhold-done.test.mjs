// The card held a second after Allow: its "Allowed" line is plain text with a green check, never drawn like a button
// (no focus ring), and its pill takes the colour of a done answer, not the waiting one of a question.
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
const find = (n, cls) => (n instanceof FakeText ? [] : [...(String(n.className).split(' ').includes(cls) ? [n] : []), ...n.children.flatMap((c) => find(c, cls))]);
const press = (b) => b.listeners.click({ preventDefault() {}, stopPropagation() {}, currentTarget: b });

const { permissionActions, stateOf, statusPill } = await import('../../web/lib.js');
const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 9_000_000 });
  document.body = new FakeElement('body');
  const fetchWas = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  t.after(() => {
    globalThis.fetch = fetchWas;
    delete document.body;
  });
}

test('after Allow the held pill has the done colour and the line is plain text', async (t) => {
  setup(t);
  const card = { name: 'shop', kind: 'claude', status: 'attention', machine: null, askAt: 7, statusAt: 7, ask: { type: 'permission', what: 'npm test', waiting: 1 } };
  const box = permissionActions(card, () => {});
  assert.equal(statusPill(card).className.includes('st-done'), false, 'a question waiting keeps its own colour');
  await press(box.children[0]);
  const pill = statusPill(card);
  assert.ok(pill.className.split(' ').includes('st-done'), pill.className);
  assert.equal(stateOf(card).text, 'Allowed');
  const line = find(box, 'ok-done')[0];
  assert.ok(line, 'the held line');
  assert.ok(line.className.split(' ').includes('ok-allowed'), 'its check is the green one');
  assert.notEqual(line.tag, 'button');
  assert.deepEqual(texts(line), ['Allowed']);
  t.mock.timers.tick(1100);
});

test('Not allowed keeps no done colour', async (t) => {
  setup(t);
  const card = { name: 'cart', kind: 'claude', status: 'attention', machine: null, askAt: 3, ask: { type: 'permission', what: 'rm -r build', waiting: 1 } };
  const box = permissionActions(card, () => {});
  await press(box.children[box.children.length - 1]);
  assert.equal(stateOf(card).text, 'Not allowed');
  assert.equal(statusPill(card).className.includes('st-done'), false);
  t.mock.timers.tick(1100);
});

test('the style sheet: the done pill is green, the answer line has no focus ring', () => {
  assert.match(css, /\.st-done\.pill \{ background: var\(--ok-soft\); color: var\(--ok\); \}/);
  assert.match(css, /\.ok-how:focus, \.ok-how:focus-visible \{ outline: none; box-shadow: none; \}/);
  assert.match(css, /\.ok-how\.ok-allowed \.icon \{ color: var\(--ok\); \}/);
});
