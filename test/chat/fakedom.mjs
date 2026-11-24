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
  // Simple selectors: "tag", ".class", "tag.class", an attribute ('[data-x="v"]', "[data-x]"), a list ("a, b") and
  // a descendant ("a b"). Anything else finds nothing.
  matches(sel) {
    const parts = String(sel).split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length > 1) return parts.some((p) => this.matches(p));
    const steps = (parts[0] || '').split(/\s+(?![^[]*\])/).filter(Boolean);
    if (!steps.length || !this.matchesOne(steps.at(-1))) return false;
    let i = steps.length - 2;
    for (let x = this.parentNode; i >= 0 && x instanceof FakeElement; x = x.parentNode) if (x.matchesOne(steps[i])) i--;
    return i < 0;
  }
  matchesOne(sel) {
    const m = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(String(sel));
    if (!m) return false;
    const cls = m[2].split('.').filter(Boolean);
    const attrs = [...m[3].matchAll(/\[([\w-]+)(?:=("[^"]*"|[^\]]*))?\]/g)].map(([, k, v]) => [k, v === undefined ? null : v.startsWith('"') ? JSON.parse(v) : v]);
    return (!m[1] || this.tag === m[1]) && cls.every((c) => this.className.split(' ').includes(c)) && attrs.every(([k, v]) => (v === null ? k in this.attrs : String(this.attrs[k]) === v));
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (!(c instanceof FakeElement)) continue;
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  closest(sel) {
    for (let x = this; x instanceof FakeElement; x = x.parentNode) if (x.matches(sel)) return x;
    return null;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode.children;
    for (let i = sibs.indexOf(this) + 1; i < sibs.length; i++) if (sibs[i] instanceof FakeElement) return sibs[i];
    return null;
  }
  after(n) {
    const p = this.parentNode;
    if (!p) return;
    const sibs = p.children;
    p.insertBefore(n, sibs[sibs.indexOf(this) + 1] || null);
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
