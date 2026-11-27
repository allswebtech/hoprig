// The "Not in step" block (web/instep.js): nothing at all when everything is in step; each state is exactly one row with
// exactly one button; a press sends only what the row names.
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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n)));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  get classList() {
    return { add() {}, remove() {}, toggle() {} };
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  remove() {}
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { instepRows, instepBlock } = await import('../../web/instep.js');
const textOf = (n) => (n instanceof FakeText ? n.text : (n.children || []).map(textOf).join(' '));
const find = (n, pred, out = []) => {
  if (n instanceof FakeElement) {
    if (pred(n)) out.push(n);
    for (const c of n.children) find(c, pred, out);
  }
  return out;
};
const item = (state, extra = {}) => ({ id: `shop/code/${state}`, label: `shop/code/${state}`, project: 'shop', state, why: `why ${state}`, button: state === 'behind' ? 'Get it' : 'Show', ...extra });

test('an empty list draws nothing', () => {
  assert.equal(instepBlock({ at: 5, items: [] }), null);
  assert.equal(instepBlock(null), null);
  assert.deepEqual(instepRows({ items: [] }), []);
});

test('each state is one row with one button', () => {
  const states = ['behind', 'dirty', 'diverged', 'unpushed'];
  const list = { at: 1, items: [...states.map((s) => item(s)), { id: 'credentials', label: 'credentials', project: '', state: 'credentials', why: 'the credentials folder here is not the repository of the map', button: 'Get it' }] };
  const rows = instepRows(list);
  assert.equal(rows.length, 5);
  const block = instepBlock(list);
  const lis = find(block, (n) => n.tag === 'li');
  assert.equal(lis.length, 5, 'one row each');
  for (const li of lis) assert.equal(find(li, (n) => n.tag === 'button' || (n.tag === 'a' && /btn/.test(n.className))).length, 1, `one button in ${textOf(li)}`);
  assert.equal(rows.find((r) => r.id === 'credentials').action, 'credentials');
  assert.equal(rows.find((r) => r.id === 'shop/code/behind').action, 'get');
  assert.equal(rows.find((r) => r.id === 'shop/code/dirty').action, 'show');
  assert.match(textOf(block), /Not in step/);
});

test('a press names only its project; the credentials row sends nothing else', () => {
  const src = fs.readFileSync(new URL('../../web/instep.js', import.meta.url), 'utf8');
  assert.match(src, /api\('\/api\/pcsetup\/project\/sync', \{ name: row\.project \}\)/);
  assert.match(src, /api\('\/api\/workspace\/instep\/look', \{ project: row\.project \}\)/);
  assert.match(src, /api\('\/api\/workspace\/instep\/credentials', \{\}\)/);
  assert.doesNotMatch(src, /--push|push: true/, 'the page never pushes a main branch');
});
