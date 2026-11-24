// Work → Today (web/workpulse.js): a running one without an estimate says nothing of it on its own row ("Since 10:39"
// only); one line under the count says it once ("No estimates yet: nothing like these has finished here."). A row
// with an estimate keeps it. A small stand-in for the browser DOM.
import assert from 'node:assert/strict';
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
    this.classList = { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  querySelector() {
    return null;
  }
  remove() {}
  append(...n) {
    for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x)));
  }
  replaceChildren(...n) {
    this.children = [];
    this.append(...n);
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};
const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));
/** Every element under n whose class name (h's "tag.class") holds cls. */
const all = (n, cls) => (n instanceof FakeText ? [] : [...(String(n.className).split(/\s+/).includes(cls) ? [n] : []), ...(n.children || []).flatMap((c) => all(c, cls))]);

const { progressParts, noEstimateLine } = await import('../../web/workpulse.js');

const none = { count: 0, shortestMs: null, longestMs: null, text: 'no time estimate yet' };
const run = (title, sinceText, basis = none, eta = { text: 'no time estimate yet', past: false }) => ({ type: 'run', id: `run:${title}`, title, project: 'shop', sinceText, basis, eta });
const progress = (running) => ({ running, waiting: [], done: [], failed: [], counts: { running: running.length, waiting: 0, done: 0, failed: 0 }, line: `${running.length} running` });

test('three running without a basis: one line under the count, and each row only its start', () => {
  const p = progress([run('Fix the cart', 'since 10:39'), run('Add a footer', 'since 10:41'), run('Speed up search', 'since 10:52')]);
  const out = progressParts(p);
  const words = texts(out);
  assert.ok(words.includes('3 running'));
  const lines = all(out, 'wk-pulse-none');
  assert.equal(lines.length, 1, 'the line is said once');
  assert.deepEqual(texts(lines[0]), ['No estimates yet: nothing like these has finished here.']);
  const subs = all(out, 'row-sub').map((n) => texts(n).join(''));
  assert.deepEqual(subs, ['Since 10:39', 'Since 10:41', 'Since 10:52']);
  assert.equal(words.filter((w) => /no time estimate/i.test(w)).length, 0, 'no row repeats it');
});

test('a row with a basis keeps its estimate; the line counts only those without', () => {
  const basis = { count: 4, shortestMs: 3_600_000, longestMs: 7_200_000, text: 'about 1 h to 2 h, from 4 like it' };
  const p = progress([run('Fix the cart', 'since 10:39', basis, { text: 'done by about 11:39 to 12:39', past: false }), run('Add a footer', 'since 10:41')]);
  const out = progressParts(p);
  const subs = all(out, 'row-sub').map((n) => texts(n).join(''));
  assert.equal(subs[0], 'Since 10:39 · done by about 11:39 to 12:39 (about 1 h to 2 h, from 4 like it)');
  assert.equal(subs[1], 'Since 10:41');
  assert.deepEqual(all(out, 'wk-pulse-none').map((n) => texts(n).join('')), ['No estimate yet for 1 of 2: nothing like it has finished here.']);
});

test('the line\'s words for one, for all, and none when each has a basis', () => {
  assert.equal(noEstimateLine([run('a', 'since 10:00')]), 'No estimate yet: nothing like it has finished here.');
  assert.equal(noEstimateLine([run('a', 'since 10:00'), run('b', 'since 10:01')]), 'No estimates yet: nothing like these has finished here.');
  assert.equal(noEstimateLine([]), null);
  assert.equal(noEstimateLine([run('a', 'since 10:00', { count: 2, text: 'about 5 min, from 2 like it' })]), null);
});
