// Settings → Tia names, in the choice "Tia runs on", what Automatic picked now: "Automatic (now: <its label>)".
import assert from 'node:assert/strict';
import test from 'node:test';

// Just enough of a browser for the modules to load (the same stand-in as web-automations.test.mjs).
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...n) {
    this.children.push(...n);
  }
  replaceChildren(...n) {
    this.children = n;
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => ({ text: t }),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};

const tia = await import('../../web/tia.js');

test('"Automatic" says what it picked now, by the provider\'s label', () => {
  assert.equal(typeof tia.automaticWords, 'function');
  const label = (n) => ({ max: 'Claude Max', auto: 'Auto mode' })[n] || n;
  assert.equal(tia.automaticWords({ runsOn: 'max', subsLimited: null }, label), 'Automatic (now: Claude Max)');
  assert.equal(tia.automaticWords({ runsOn: 'auto', subsLimited: null }, label), 'Automatic (now: Auto mode)');
  assert.equal(tia.automaticWords({ runsOn: null, subsLimited: { names: ['max'], until: null } }, label), 'Automatic (now: none, every subscription is at its limit)');
  assert.equal(tia.automaticWords({ runsOn: null, subsLimited: null }, label), 'Automatic (now: none)');
});
