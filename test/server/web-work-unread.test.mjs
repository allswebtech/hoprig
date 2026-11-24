// Work after a failed first load: Try again is the one thing to press, so the page has no main button (Add task
// would go nowhere). Once the list is read, the main button is back.
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
    this.classList = { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains() { return false; }
  remove() {}
  append(...n) { for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x))); }
  replaceChildren(...n) { this.children = []; this.append(...n); }
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.location ??= { hash: '#/work', pathname: '/', search: '', protocol: 'http:', hostname: 'localhost', replace() {} };
const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));

await import('../../web/work.js');
const { pageById } = await import('../../web/registry.js');
const settle = () => new Promise((r) => setTimeout(r, 30));

async function open(t, answers, sub = 'tasks') {
  const fetchWas = globalThis.fetch;
  globalThis.fetch = async () => answers.shift();
  t.after(() => (globalThis.fetch = fetchWas));
  const frames = [];
  const stop = pageById('work').render({ frame: (o) => frames.push(o), sub, query: new URLSearchParams() });
  t.after(() => stop && stop());
  await settle();
  return frames;
}
const fail = { ok: false, status: 500, json: async () => ({ error: 'the list could not be read' }) };

test('a failed first load: no main button, and Try again on the page', async (t) => {
  const frames = await open(t, [fail]);
  const last = frames[frames.length - 1];
  assert.equal(last.primary, null, 'no Add task over a list that could not be read');
  assert.match(texts(last.body[2]).join(' '), /could not read your task list/);
});

test('the list read: the main button is there', async (t) => {
  const frames = await open(t, [{ ok: true, status: 200, json: async () => ({ items: [], projects: [], runs: {}, today: '2026-11-21' }) }]);
  assert.equal(frames[frames.length - 1].primary.label, 'Add task');
});
