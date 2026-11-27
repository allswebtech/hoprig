// A first chat keeps the composer's row short: Ultracode and Lead behind +, and the side panel's words in plain words.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
    const on = new Set();
    this.classList = { add: (c) => on.add(c), remove: (c) => on.delete(c), toggle: (c, f) => ((f ?? !on.has(c)) ? on.add(c) : on.delete(c)), contains: (c) => on.has(c) };
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
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  scrollIntoView() {}
  dispatchEvent(e) {
    this.fire(e.type);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}
globalThis.Node = FakeNode;
globalThis.innerHeight = 844;
globalThis.innerWidth = 1440;
const kept = new Map(); // the draft and the sent list (prefs); defined, so newer Node's own localStorage is not asked
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) } });
globalThis.document = {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  body: new FakeElement('body'),
  activeElement: null,
  visibilityState: 'visible',
};
const byClass = (n, c) => (n instanceof FakeText ? [] : [...(n.className.split(' ').includes(c) ? [n] : []), ...n.children.flatMap((x) => byClass(x, c))]);

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const { createComposer } = await import('../../web/chat/composer.js');
const web = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'web', 'chat', f), 'utf8');
const claude = { id: 'c1', engine: { id: 'claude', label: 'Claude Code', capabilities: { ultracode: true } }, queue: [], choices: { models: [], efforts: [], modes: ['default'] }, usage: {} };
const hidden = (c, k) => byClass(c.el, k)[0].classList.contains('hidden');
const chips = (first, v) => {
  const c = createComposer({ A: '/api/chats/c1', id: 'c1', stop() {}, compact() {}, own: () => [], firstLook: () => first });
  c.paint(v);
  return [hidden(c, 'chat-ultra'), hidden(c, 'chat-lead')];
};

test('a first chat: Ultracode and Lead are not in the chip row while both are off; later chats show them', () => {
  assert.deepEqual(chips(false, claude), [false, false], 'a computer with three chats or more: both in the row');
  assert.deepEqual(chips(true, claude), [true, true], 'a first look: both behind +');
  assert.deepEqual(chips(true, { ...claude, lead: true }), [false, false], 'one that is on stays in view');
});

test('the + menu holds Ultracode and Lead on a first look, and the page counts the chats of this computer', () => {
  const s = web('composer.js');
  assert.match(s, /tucked\(\) && !phone\(\) && caps\(v\).ultracode \? \[\{ value: 'ultra', label: 'Turn on Ultracode', sub: `Off now\. /);
  assert.match(s, /tucked\(\) && !phone\(\) && canLead\(\) \? \[\{ value: 'lead', label: 'Turn on Lead model', sub: 'Off now: /);
  assert.match(s, /else if \(pick === 'ultra'\) toggleUltra\(\);\n\s*else if \(pick === 'lead'\) toggleLead\(\);/);
  assert.match(web('page.js'), /filter\(\(s\) => s\.kind === 'chat'\)\.length < 3;\n.*createComposer\(\{[^}]*firstLook \}\)/);
});

test('the side panel says where it works and that nothing changed since the last save point; Provider and Branch stay', () => {
  const s = web('rail.js');
  assert.match(s, /h\('span', 'Where it works'\)/);
  assert.match(s, /'No changes yet since the last save point\.'/);
  assert.doesNotMatch(s, /h\('span', 'Environment'\)|Nothing changed since the last commit/);
  assert.match(s, /\['Provider', v\.profile\.label\]/);
  assert.match(s, /\['Branch', v\.branch\]/);
});
