// Home as the Desktop's Sessions window draws it: the store already holds the computers when web/home.js is loaded, so
// its subscription runs at once, before the rest of the file has run. Everything it uses must be defined by then
// ("Cannot access andList before initialization" left the Sessions window empty).
import assert from 'node:assert/strict';
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
globalThis.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
globalThis.CustomEvent = class {};
globalThis.location = { pathname: '/', hash: '' };

test('loading Home with the computers already in the store does not throw', async () => {
  const { store } = await import('../../web/store.js');
  const machine = { machine: null, machineLabel: 'Desk', status: 'online', sessions: [], profiles: [{ name: 'max', label: 'Max', kind: 'subscription', usage: { fiveHour: { pct: 96 } } }] };
  Object.defineProperty(store, 'all', { value: [machine, { ...machine, machine: 'lap', machineLabel: 'Laptop' }], configurable: true });
  store.subscribe = (fn) => {
    fn(store.data, store.error);
    return () => {};
  };
  const home = await import('../../web/home.js');
  assert.equal(typeof home.viewHome, 'function');
  assert.equal(home.accountsLine(store.all, false).warn, true);
});
