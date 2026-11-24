// The first-time question card shows only the numbers the screen gives: an answer with no number on the screen gets
// none on the card (no "1." of the page's own list), an older drawing of the question still on the screen never makes
// the card name the key that accepts, and a third option drawn first keeps each answer's own number.
import assert from 'node:assert/strict';
import { test } from 'node:test';

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
  addEventListener() {}
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
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const { noticeOnScreen } = await import('../src/askcard.mjs');
const { exactCard } = await import('../web/handsoff.js');
const textOf = (n) => (n instanceof FakeText ? n.text : n && n.children ? n.children.map(textOf).join('') : '');
const find = (n, tag, out = []) => {
  if (n && n.tag === tag) out.push(n);
  for (const c of (n && n.children) || []) find(c, tag, out);
  return out;
};
const head = [' Allow external CLAUDE.md file imports?', ' Only use Claude Code with files you trust.'];
const card = (lines) => noticeOnScreen([...head, ...lines, ' Enter to confirm · Esc to cancel'].join('\n'), { starting: true });

test('no number on the screen: the card has no "1." or "2." before an answer, and no numbered list', () => {
  const c = card([' ❯ No, disable external imports', '   Yes, allow external imports']);
  const el = exactCard(c);
  assert.equal(find(el, 'ol').length, 0, 'not an <ol>, which the browser numbers itself');
  const items = find(el, 'li').map(textOf);
  assert.deepEqual(items, ['No, disable external imports', 'Yes, allow external imports']);
  assert.doesNotMatch(c.notice.text, /press|\b\d\b/);
});

test('numbers on the screen: each answer shows the number the screen gave it', () => {
  const c = card([' ❯ 1. Yes, allow external imports', '   2. No, disable external imports']);
  assert.deepEqual(find(exactCard(c), 'li').map(textOf), ['1. Yes, allow external imports', '2. No, disable external imports']);
  assert.match(c.notice.text, /press 2 in the terminal/);
});

test('an older drawing above the live one: the card never names the key that accepts, and lists the live answers once', () => {
  const c = card(['1. No, disable external imports', '2. Yes, allow external imports', ...head, ' ❯ 1. Yes, allow external imports', '   2. No, disable external imports']);
  assert.doesNotMatch(c.notice.text, /press 1|type 1/, 'never the key of Yes on the live menu');
  assert.doesNotMatch(c.notice.text, /press \d/, 'the safe line has two numbers on the screen: no key named');
  assert.match(c.notice.text, /choose "No, disable external imports" in the terminal/);
  assert.deepEqual([c.notice.answers, c.notice.keys], [['Yes, allow external imports', 'No, disable external imports'], ['1', '2']], 'the live drawing, once');
});

test('a third option drawn first: the card says press 2 and shows "2." beside No, never its own count', () => {
  const c = card([' ❯ 1. Ask me each time', '   2. No, disable external imports', '   3. Yes, allow external imports']);
  assert.match(c.notice.text, /press 2 in the terminal/);
  assert.deepEqual(find(exactCard(c), 'li').map(textOf), ['2. No, disable external imports', '3. Yes, allow external imports']);
});
