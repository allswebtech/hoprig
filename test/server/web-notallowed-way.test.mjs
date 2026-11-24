// A computer that no longer lets this dashboard in: Setup and Health show the same "Open Computers → Add a computer"
// button as Overview.
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
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.location ??= { hostname: '127.0.0.1', pathname: '/', hash: '', origin: 'http://127.0.0.1' };
globalThis.fetch = () => new Promise(() => {});

const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));
const addLink = (nodes) => [nodes].flat().filter(Boolean).find((n) => n.tag === 'a' && /err-way/.test(n.className));
const health = await import('../../web/health.js');
const setup = await import('../../web/pcsetup.js');
const reason = 'Old box no longer lets this dashboard in. Add it again here: Computers → Add a computer.';

test('Setup: a computer that refuses us gets the Add a computer button; one that is off gets none', () => {
  const parts = setup.checkFailParts(Object.assign(new Error(reason), { code: 'computer-not-allowed', machine: 'oldbox' }));
  const a = addLink(parts);
  assert.ok(a, 'a button to add it again');
  assert.equal(a.attrs.href, '#/computers/add');
  assert.equal(texts(a).join(''), 'Add a computer');
  assert.equal(addLink(setup.checkFailParts(Object.assign(new Error('Old box does not answer.'), { code: 'offline' }))), undefined);
});

test('Health: a computer that refuses us gets the Add a computer button; the other states none', () => {
  const w = health.unreachedWords({ state: 'unauthorised', seenAt: null }, 'Old box');
  assert.ok(w.way, 'a button to add it again');
  assert.equal(w.way.attrs.href, '#/computers/add');
  assert.equal(texts(w.way).join(''), 'Add a computer');
  for (const state of ['offline', 'hostkey', 'too-old']) assert.equal(health.unreachedWords({ state, seenAt: null }, 'Old box').way, undefined, state);
  assert.match(fs.readFileSync(new URL('../../web/health.js', import.meta.url), 'utf8'), /w\.way \? h\('div\.savebar\.start', w\.way\) : null/, 'the button is drawn under the hint');
});

