// The composer's Send, without a browser: a message on its way is sent once. The page itself is proven in a real
// browser; here the part that decides whether a second tap or Enter sends the same message again.
import assert from 'node:assert/strict';
import test from 'node:test';

// A small stand-in for the browser DOM: what lib.js's h/fill and the composer use.
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
    Object.assign(this, { tag, className: '', dataset: {}, style: { setProperty() {} }, attrs: {}, children: [], listeners: {}, value: '', disabled: false, scrollHeight: 20 });
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(k, fn) {
    (this.listeners[k] ||= []).push(fn);
  }
  fire(k, e = {}) {
    for (const fn of this.listeners[k] || []) fn({ preventDefault() {}, stopPropagation() {}, currentTarget: this, ...e });
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {}
  focus() {}
  click() {}
  setSelectionRange() {}
  querySelector() {
    return new FakeElement('span');
  }
  querySelectorAll() {
    return [];
  }
}
globalThis.Node = FakeNode;
globalThis.innerHeight = 844;
const kept = new Map(); // the draft and the sent list (prefs); defined, so newer Node's own localStorage is not asked
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) } });
globalThis.document = {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  body: new FakeElement('body'),
  activeElement: null,
  visibilityState: 'visible',
};
const byClass = (n, c) => (n instanceof FakeText ? [] : [...(n.className.split(' ').includes(c) ? [n] : []), ...n.children.flatMap((x) => byClass(x, c))]);

// POST /send is held until the test lets it go; every call is counted.
const posts = [];
let release = () => {};
globalThis.fetch = async (u, o) => {
  if (String(u).endsWith('/send')) {
    posts.push(JSON.parse(o.body));
    await new Promise((r) => (release = r));
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const { createComposer } = await import('../../web/chat/composer.js');
const idle = { id: 'c1', tool: 'opencode', queue: [], choices: { models: [], efforts: [], modes: ['default'] }, usage: {} };

test('Send: a message on its way is sent once, even when a state update of the chat comes in meanwhile', async () => {
  const c = createComposer({ A: '/api/chats/c1', id: 'c1', stop() {}, compact() {}, own: () => [] });
  const send = byClass(c.el, 'chat-send')[0];
  c.paint(idle);
  c.textarea.value = 'hello once';
  c.textarea.fire('input');
  assert.equal(send.disabled, false);

  send.fire('click');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posts.length, 1);
  assert.equal(send.disabled, true, 'disabled while the message is on its way');

  c.paint({ ...idle, effort: 'high' }); // the chat's state changes (a setting, a turn's progress)
  assert.equal(send.disabled, true, 'a state update keeps it disabled: the box still holds the same text');
  send.fire('click');
  c.textarea.fire('keydown', { key: 'Enter', shiftKey: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posts.length, 1, 'neither a second tap nor Enter sends it again');

  release();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(send.disabled, false, 'Send is back once the POST returned');
  assert.equal(c.textarea.value, '', 'the box is emptied');
  assert.deepEqual(posts, [{ text: 'hello once' }]);

  c.paint({ ...idle, toolOff: true });
  assert.equal(send.disabled, true, 'read only still disables Send');
  c.paint(idle);
  assert.equal(send.disabled, false);
});
