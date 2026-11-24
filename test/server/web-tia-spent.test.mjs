// Settings → Tia's cap card (web/tia.js spentWords): what is counted and why, that it stays counted until the day
// ends, and what he can do (zero is "$0", as the page's money() writes it). Never "held for work under way" when nothing is under way.
import assert from 'node:assert/strict';
import test from 'node:test';

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

test('ten terminal starts against a $5 cap: counted $0.50 each until the day ends; raise it or wait', () => {
  assert.equal(typeof tia.spentWords, 'function');
  const s = tia.spentWords({ cap: 5, today: { spent: 0, held: 5, unmeasured: 10 } });
  assert.equal(s, 'Today: $0 spent. 10 starts, moves or messages of sessions on a provider billed by use whose cost Hoprig could not measure count $0.50 each, $5.00 in all; they stay counted until the day ends. $5.00 of your $5.00 daily limit is used. The daily limit is reached: raise it, or wait for tomorrow.');
  assert.doesNotMatch(s, /under way/);
});

test('one start, room left; no cap; nothing yet', () => {
  assert.equal(tia.spentWords({ cap: 5, today: { spent: 0.2, held: 0.5, unmeasured: 1 } }), 'Today: $0.20 spent. One start, move or message of a session on a provider billed by use whose cost Hoprig could not measure counts $0.50; it stays counted until the day ends. $0.70 of your $5.00 daily limit is used. When the daily limit is reached, raise it, or wait for tomorrow.');
  assert.doesNotMatch(tia.spentWords({ cap: 5, today: { spent: 0, held: 0.5, unmeasured: 1 } }), /\beach\b|in all/, 'one act: one figure');
  assert.equal(tia.spentWords({ cap: null, today: { spent: 0, held: 0, unmeasured: 0 } }), 'Today: $0 spent. No daily limit for paid use: everything paid asks you first, and Tia does not answer in her chat while she runs on a provider that costs money.');
  assert.equal(tia.spentWords({ cap: 5, today: { spent: 0, held: 0, unmeasured: 0 } }), 'Today: $0 spent. $0 of your $5.00 daily limit is used.');
});

test('no word he does not know: no "act", and the folds say what is in them', () => {
  // "used" and "spent" never stand side by side with two figures: spent first, then the part of the limit used.
  for (const t of [{ spent: 0, held: 0.5, unmeasured: 1 }, { spent: 0.2, held: 1, unmeasured: 2 }]) assert.doesNotMatch(tia.spentWords({ cap: 5, today: t }), /used \(/);
  for (const t of [{ spent: 0, held: 0.5, unmeasured: 1 }, { spent: 0, held: 1, unmeasured: 2 }]) for (const cap of [null, 5]) assert.doesNotMatch(tia.spentWords({ cap, today: t }), /\bacts?\b/);
});

test('less than $0.50 of room is not "reached": it says there is no room for another $0.50', () => {
  const s = tia.spentWords({ cap: 0.5, today: { spent: 0.01, held: 0, unmeasured: 0 } });
  assert.equal(s, 'Today: $0.01 spent. $0.01 of your $0.50 daily limit is used. The daily limit has no room for another $0.50: raise it, or wait for tomorrow.');
  assert.doesNotMatch(s, /reached|\bcap\b/);
});

test('parts that hold a budget are said as such, apart from the $0.50 each', () => {
  const s = tia.spentWords({ cap: 5, today: { spent: 0.2, held: 2, unmeasured: 1, parts: 2, partsHeld: 1.5 } });
  assert.equal(s, 'Today: $0.20 spent. One start, move or message of a session on a provider billed by use whose cost Hoprig could not measure counts $0.50; it stays counted until the day ends. $1.50 is held for 2 parts that run now (a part is a piece of a task that a session handed to another provider); when a part ends, what it cost counts in its place. $2.20 of your $5.00 daily limit is used. When the daily limit is reached, raise it, or wait for tomorrow.');
  assert.match(tia.spentWords({ cap: 5, today: { spent: 0, held: 1, unmeasured: 0, parts: 1, partsHeld: 1 } }), /^Today: \$0 spent\. \$1\.00 is held for a part that runs now \(a part is a piece of a task that a session handed to another provider\); /);
});

