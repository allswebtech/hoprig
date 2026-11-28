// Settings → Notifications, what Work tells (web/worktell.js): its items are lines of the one "Tell me when" list and
// wait for the page's one Save; the minutes and the digest's words are under More.
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
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(k, fn) {
    this.listeners[k] = fn;
  }
  append(...n) {
    for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x)));
  }
  replaceChildren(...n) {
    this.children = [];
    this.append(...n);
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.window ??= { dispatchEvent: () => {}, addEventListener: () => {} };
globalThis.Event ??= class {};

const { tellNotice, workTellParts } = await import('../../web/worktell.js');
const walk = (n, out = []) => {
  if (n instanceof FakeElement) {
    out.push(n);
    for (const c of n.children) walk(c, out);
  }
  return out;
};
const text = (n) => walk(n).flatMap((e) => e.children.filter((c) => c instanceof FakeText).map((c) => c.text)).join(' ');
const box = (parts, key) => parts.items.flatMap((i) => walk(i)).find((e) => e.attrs['data-key'] === key);

test("a Work item is one more line of the Tell me when list: a check box that waits for the page's one Save", () => {
  const st = { url: '', savedUrl: '', work: {} };
  const parts = workTellParts(st);
  assert.equal(parts.items.length, 5, 'four things and the digest');
  box(parts, 'work-finished').listeners.change({ target: { checked: true } });
  assert.deepEqual(st.work, { finished: true });
  box(parts, 'work-finished').listeners.change({ target: { checked: false } });
  assert.deepEqual(st.work, {}, 'what equals the default is not saved');
});

test('the minutes and the words of the digest are in the More part; a number outside its range is not kept', () => {
  const st = { work: {} };
  const parts = workTellParts(st);
  const words = parts.more.map(text).join(' ');
  assert.match(words, /Waits for your answer after/);
  assert.match(words, /A digest every/);
  assert.match(words, /Tia writes my digest/);
  const num = parts.more.flatMap((m) => walk(m)).find((e) => e.tag === 'input' && e.className.includes('wk-tell-num'));
  num.listeners.input({ target: { value: '99999' } });
  assert.deepEqual(st.work, {});
  num.listeners.input({ target: { value: '30' } });
  assert.deepEqual(st.work, { waitsMinutes: 30 });
});

test('a teller that cannot keep its record: the notice says so in plain words; when it can, nothing', async () => {
  assert.equal(tellNotice({ ok: true }), null);
  assert.equal(tellNotice(null), null);
  const n = tellNotice({ ok: false, since: '2026-11-19T12:00:00Z', error: 'EISDIR' });
  assert.match(text(n), /cannot keep its record of what it told you/);
  assert.doesNotMatch(text(n), /EISDIR/, 'no programmer words');
  const parts = workTellParts({ work: {} }, { status: async () => ({ ok: false, since: 'x', error: 'y' }) });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.match(text(parts.notice), /cannot keep its record/);
});

test('the digest switch says in plain words that Tia writes it', () => {
  const parts = workTellParts({ work: {} });
  assert.match(parts.more.map(text).join(' '), /Tia writes my digest/);
  assert.doesNotMatch(parts.more.map(text).join(' '), /Tia words my digest/);
});

test('Today\'s Needs you does not say "Nothing needs you" under a Progress that lists what waits for him', async () => {
  const { needsNoneWords } = await import('../../web/workpulse.js');
  const [title, sub] = needsNoneWords(2);
  assert.notEqual(title, 'Nothing needs you right now');
  assert.match(sub, /Progress above/);
  assert.equal(needsNoneWords(0)[0], 'Nothing needs you right now');
});
