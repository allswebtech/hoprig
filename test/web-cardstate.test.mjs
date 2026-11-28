// A Home card says its state in words on the card itself, under any group heading, and its last line is plain text.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';


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
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  append(...nodes) { for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n))); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));

const { sessionCard } = await import('../web/sessionitem.js');
const now = Date.now();
const card = (o, heading) => sessionCard({ name: 'shop', kind: 'claude', tool: 'claude', status: 'working', statusAt: now - 120000, lastMessage: '**Done** with `cart.js`', ...o }, [], () => {}, false);

test('the state is said on the card under the heading that names it too', () => {
  assert.ok(texts(card({}, 'working')).join('').includes('Working'));
  assert.ok(texts(card({ status: 'waiting' }, 'waiting')).join('').includes('Finished'));
});

test('the last line of the card is plain', () => {
  const t = texts(card({ status: 'waiting' }, 'waiting')).join('|');
  assert.ok(t.includes('Done with cart.js'));
  assert.ok(!t.includes('**') && !t.includes('`'));
});

const all = (n, f) => (n instanceof FakeText ? [] : [...(f(n) ? [n] : []), ...n.children.flatMap((c) => all(c, f))]);

test('the command of a permission card is mono, with each word whole: it breaks only at spaces', () => {
  const c = card({ status: 'attention', note: 'Claude needs your permission to use Bash: npm install left-pad-lite@2.1.0' });
  const code = all(c, (n) => n.tag === 'code' && n.className === 'card-cmd');
  assert.equal(code.length, 1);
  assert.equal(texts(code[0]).join(''), 'npm install left-pad-lite@2.1.0');
  assert.deepEqual(all(code[0], (n) => n.className === 'cmd-word').map((n) => texts(n).join('')), ['npm', 'install', 'left-pad-lite@2.1.0']);
  assert.ok(texts(c).join('').includes('Claude wants to run: '));
  const long = card({ status: 'attention', note: `Claude needs your permission to use Bash: cat ${'x'.repeat(60)}` });
  assert.equal(all(long, (n) => n.className === 'cmd-word').length, 1, 'a word wider than a card is left to break where it must');
});

test('a short title is marked so its pill stays at its right; a long one is not', async () => {
  const { shortTitle } = await import('../web/sessionitem.js');
  assert.equal(shortTitle('Plan the trip'), true);
  assert.equal(shortTitle('Rewrite the order summary so it reads well on a very small phone screen'), false);
  assert.equal(all(card({ display: 'Plan the trip' }), (n) => n.className === 'card-name short').length, 1);
});
