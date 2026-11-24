// The Operator page draws a link to each place a text names from the place's code (`ways`, codes of web/errorways.js,
// the table the error buttons use): on his card note, a rule, a line of Done by Tia and the sentence of what Tia does.
// An unknown code draws nothing; a link only opens the place; no sentence loses its words.
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
  // Only the plain "tag" form: what the panel's switch asks ("input").
  querySelectorAll(sel) {
    return this.children.filter((c) => c instanceof FakeElement).flatMap((c) => [...(c.tag === sel ? [c] : []), ...c.querySelectorAll(sel)]);
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
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
const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const all = (n, f) => (n instanceof FakeText ? [] : [...(f(n) ? [n] : []), ...n.children.flatMap((c) => all(c, f))]);
const links = (n) => all(n, (x) => x.tag === 'a' && x.className.split(' ').includes('op-way')).map((a) => [texts(a).join(''), a.attrs.href ?? a.href]);

const ways = await import('../../web/operator-ways.js');
const page = await import('../../web/operator.js');
const tia = await import('../../web/operator-tia.js');
const { WAYS } = await import('../../web/errorways.js');

const item = { id: 'limit-aaaaaaaaaaaa', rev: 'bbbbbbbbbbbb', kind: 'limit', class: 'stopped', subject: 'session alpha', since: null, facts: ['at a usage limit'], acts: [{ id: 'switch' }], recommended: 'switch', why: 'It waits for a provider.' };
const catalog = { switch: { label: 'Continue on the next provider', risk: 'low', effect: 'The session goes on under the next provider.' } };

test('a code of the table becomes a link to its place; an unknown code, a non-string or no list draws nothing', () => {
  assert.deepEqual(ways.placesOf(['tia-off']), [{ label: WAYS['tia-off'].label, href: WAYS['tia-off'].href, button: WAYS['tia-off'].button }]);
  assert.deepEqual(ways.placesOf(['no-such-place', 7, null]), []);
  assert.deepEqual(ways.placesOf(undefined), []);
  assert.equal(ways.placeLinks(['no-such-place']), null);
  assert.equal(ways.placeLinks(null), null);
  // Two codes for one place: one link.
  assert.equal(ways.placesOf(['tia-off', 'tia-cap']).length, 1);
  // A key of Object.prototype is no code.
  assert.deepEqual(ways.placesOf(['constructor', '__proto__', 'toString']), []);
});

test('his card note keeps its words and gets the link of its code; with an unknown code the card is as before', () => {
  const words = 'plan-x is not a provider Tia may use (Settings → Tia): the move is yours';
  const v = { his: { [item.id]: { rev: item.rev, words, ways: ['tia-off'] } } };
  const card = page.itemCard(item, catalog, () => {}, { his: tia.hisWords(item, v), hisWays: tia.hisWays(item, v) });
  assert.ok(texts(card).includes(`Yours: ${words}`), 'the sentence keeps every word');
  assert.deepEqual(links(card), [[WAYS['tia-off'].button, WAYS['tia-off'].href]]);
  // The link is an address only: no click handler that could press anything.
  const [a] = all(card, (x) => x.tag === 'a' && x.className.split(' ').includes('op-way'));
  assert.deepEqual(Object.keys(a.listeners), []);
  const unknown = { his: { [item.id]: { rev: item.rev, words, ways: ['no-such-place'] } } };
  assert.deepEqual(links(page.itemCard(item, catalog, () => {}, { his: tia.hisWords(item, unknown), hisWays: tia.hisWays(item, unknown) })), []);
  // The item changed since the note: neither the note nor its link.
  assert.equal(tia.hisWays({ ...item, rev: 'eeeeeeeeeeee' }, v), null);
});

test('a line of Done by Tia keeps its words and gets the link of its code', () => {
  const l = { at: '2026-03-10T14:00:00Z', by: 'limit', subject: 'session alpha', act: 'switch', ok: false, refused: true, result: 'plan-x is not a provider Tia may use (Settings → Tia): the move is yours', ways: ['tia-off', 'nope'] };
  const list = tia.byTiaList([l], { undoable: [], undone: {} }, () => {});
  assert.ok(texts(list).includes(`session alpha: ${l.result}`));
  assert.deepEqual(links(list), [[WAYS['tia-off'].button, WAYS['tia-off'].href]]);
});

test('a rule keeps its detail and gets the links of its codes', () => {
  const r = { id: 'limit', sentence: 'When a session stops at a usage limit, continue it on the next provider of my order.', detail: 'Only to a provider Tia may use (Settings → Tia).', act: 'switch', on: false, undo: 'move it back.', noUndo: null, ways: ['tia-off'], budget: { perHour: 4, perDay: 20, waitMinutes: 10 }, left: { hour: 4, day: 20 } };
  const panel = tia.tiaPanel({ acts: true, tia: true, active: true, said: 'Tia does by herself only what the rules that are on say.', rules: [r], projectsOut: [], his: {}, undoable: [], undone: {} }, () => {});
  assert.ok(texts(panel).some((t) => t.includes(r.detail)), 'the detail keeps its words');
  assert.ok(links(panel).some(([label, href]) => label === WAYS['tia-off'].button && href === WAYS['tia-off'].href), JSON.stringify(links(panel)));
});
