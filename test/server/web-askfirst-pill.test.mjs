// A session at Claude Code's own question before it starts (a notice read off its screen) says so in its pill:
// "Asks you first", not "Needs your OK" (there is nothing to allow on the card). Trust keeps its own words.
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
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => ({ text: t }), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { stateOf, needsYou } = await import('../../web/lib.js');
const notice = (type) => ({ name: 'shop', kind: 'claude', status: 'attention', askCard: { kind: 'notice', notice: { type, text: 'Allow external CLAUDE.md file imports?' } } });

test('a notice before the start reads "Asks you first"', () => {
  for (const type of ['imports', 'bypass', 'choice']) {
    assert.equal(stateOf(notice(type)).text, 'Asks you first', type);
    assert.equal(stateOf(notice(type)).key, 'attention', 'still under Needs you');
    assert.equal(needsYou(notice(type)), true);
  }
});

test('trust and a permission keep their own words', () => {
  assert.equal(stateOf(notice('trust')).text, 'Trust this folder?');
  assert.equal(stateOf({ name: 'shop', kind: 'claude', status: 'attention', ask: { type: 'permission', what: 'npm test' } }).text, 'Needs your OK');
  assert.equal(stateOf({ name: 'shop', kind: 'claude', status: 'attention' }).text, 'Needs your OK', 'a notification alone');
  assert.equal(stateOf({ name: 'shop', kind: 'claude', status: 'attention', ask: { type: 'question' } }).text, 'Needs your answer');
});
