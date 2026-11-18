// The page tests' small stand-in for the browser DOM (what lib.js's h/fill/add and the views use), installed as the
// globals Node, document on import. Not a test file itself (the runner takes only *.test.mjs).
export class FakeNode {}
export class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
export class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: { setProperty() {} }, attrs: {}, children: [], listeners: {} });
    this.classList = { add: (c) => (this.className += ` ${c}`), remove: () => {}, toggle: () => {}, contains: (c) => this.className.split(' ').includes(c) };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  // A node knows its parent, and counts how often it was taken out of one (`taken`): the browser moves the keyboard's
  // focus off a control taken out, also one put back at once (fill → replaceChildren).
  append(...nodes) {
    for (const n of nodes) this.insertBefore(n instanceof FakeNode ? n : new FakeText(String(n)), null);
  }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.take(n);
    const i = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(i < 0 ? this.children.length : i, 0, n);
    n.parentNode = this;
    return n;
  }
  take(n) {
    this.children = this.children.filter((c) => c !== n);
    n.parentNode = null;
    n.taken = (n.taken || 0) + 1;
  }
  replaceChildren(...nodes) {
    for (const c of [...this.children]) this.take(c);
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.take(this);
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  get isConnected() {
    return document.body.contains(this);
  }
  // The keyboard's focus: document.activeElement, the body when the focused node left the page (as a browser does).
  focus() {
    focused = this;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
}
let focused = null;
globalThis.Node = FakeNode;
globalThis.document = {
  get activeElement() {
    return focused && focused.isConnected ? focused : document.body;
  },
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
  body: new FakeElement('body'), // where a toast goes
};
export const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
export const byClass = (n, c) => (n instanceof FakeText ? [] : [...(n.className.split(' ').includes(c) ? [n] : []), ...n.children.flatMap((x) => byClass(x, c))]);
globalThis.window ||= { addEventListener() {}, removeEventListener() {} };
