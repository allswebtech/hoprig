// A terminal session's permission card says it the way the chat's card does: "Claude wants to run: <command>" and
// "Allow, and don't ask again for this kind of command". The command itself stays exact: it is what he says yes to.
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
    Object.assign(this, { tag: t, className: '', dataset: {}, style: {}, attrs: {}, children: [] });
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  append(...n) { for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x))); }
  replaceChildren(...n) { this.children = []; this.append(...n); }
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));

const { askNote, permissionActions } = await import('../../web/lib.js');

test('the note reads as the chat says it, the command kept exact', () => {
  assert.equal(askNote('Claude needs your permission to use Bash: npm install react-native-svg@15.8.0'), 'Claude wants to run: npm install react-native-svg@15.8.0');
  assert.equal(askNote('Claude needs your permission to use Bash'), 'Claude wants to run a command');
  assert.equal(askNote('Claude needs your permission to use Write: src/app.js'), 'Claude wants to use Write: src/app.js');
  assert.equal(askNote('Claude needs your permission'), 'Claude wants your OK');
  assert.equal(askNote('Claude asks: Should I apply the same limit to /api/cart?'), 'Claude asks: Should I apply the same limit to /api/cart?', 'any other note stays');
  assert.equal(askNote(''), '');
});

test('the second answer says "this kind of command"; the exact words stay in its tooltip', () => {
  const ask = { name: 'shop', kind: 'claude', status: 'attention', machine: null, ask: { type: 'permission', what: 'npm install', waiting: 1 } };
  const always = { key: '2', text: "Yes, and don't ask again for npm install commands", label: "Don't ask again for npm install commands" };
  const box = permissionActions({ ...ask, always });
  assert.deepEqual(texts(box), ['Allow', "Allow, and don't ask again for this kind of command", 'Do not allow', 'This kind of command: npm install']);
  assert.equal(box.children[1].attrs.title, always.text, 'the tooltip keeps the coding tool\'s own words');
  // Other answers keep their own words: they say what they allow.
  const edits = { key: '2', text: 'Yes, allow all edits during this session (shift+tab)', label: 'Allow all edits during this session' };
  assert.deepEqual(texts(permissionActions({ ...ask, always: edits })), ['Allow', 'Allow all edits during this session', 'Do not allow']);
});

test('Home\'s card and the Workspace row show the note through it', () => {
  const si = fs.readFileSync(new URL('../../web/sessionitem.js', import.meta.url), 'utf8');
  assert.equal((si.match(/askNote\(s\.note\)/g) || []).length, 2, 'the card and the row');
});
