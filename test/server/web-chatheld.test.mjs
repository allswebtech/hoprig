// The App chat draws the wall's held-act card for a held permission ask (web/chat/asks.js askCard): the same card a
// terminal shows (web/handsoff.js heldActCard) — what the session wanted to run, why it is his, and both answers —
// with only Allow and Do not allow, no "always" and no project rule, because the owner approves this one act. The
// server side that attaches the same card.held is covered in test/chat/handsoff-chat.test.mjs.
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
function collect(n) {
  return n instanceof FakeText ? [] : [n, ...n.children.flatMap(collect)];
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, disabled: false });
    const s = new Set();
    this.classList = { toggle: () => {}, contains: (c) => s.has(c), add: (c) => s.add(c), remove: (c) => s.delete(c) };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  append(...nodes) { for (const n of nodes) this.children.push(n instanceof FakeNode ? n : new FakeText(String(n))); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  querySelectorAll(sel) { return collect(this).filter((e) => e.tag === sel); }
  focus() {}
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const texts = (n) => (n instanceof FakeText ? [n.text] : n.children.flatMap(texts));
const buttons = (root) => collect(root).filter((e) => e.tag === 'button');

const { askCard } = await import('../../web/chat/asks.js');
const { heldCard, heldRecord } = await import('../../src/askcard.mjs');

// A held permission ask as the chat delivers it: ev.card.held is exactly heldCard(heldRecord(...)) — the same object
// the server builds for a terminal's session card (src/chat/handsoff.mjs chatCard). A push, part of a longer command.
const heldEv = () => ({
  type: 'permission', request: 'req-1', tool: 'Bash', input: { command: 'cd app && npm test && git push origin main' },
  card: { key: 'k1', held: heldCard(heldRecord({ kind: 'push', why: 'push', part: 'git push origin main', partOf: true }, 'Bash', 1)) },
});
const opts = () => ({ A: '/api/chats/c1', who: 'Claude', cwd: '/w', modes: null });

test('a held permission shows the wall card in the chat: what it wanted, why it is his, both answers', () => {
  const words = texts(askCard(heldEv(), opts()));
  for (const line of [
    'A push to the main branch or a tag',
    'The session wants to run this, as part of a longer command:',
    'git push origin main',
    'This would move a default branch or a tag, which stays yours even with Hands-off on.',
    'Allow runs it this once.',
    'Do not allow: it does not run, and the session stops and waits for your message.',
    'Held by Hoprig before it ran',
  ]) assert.ok(words.includes(line), `the card says: ${line}`);
});

test('only Allow and Do not allow — no "always", no "in this project", no plan answers', () => {
  const el = askCard(heldEv(), opts());
  assert.deepEqual(buttons(el).map((b) => texts(b).join(' ').trim()), ['1 Allow', '2 Do not allow']);
  assert.doesNotMatch(texts(el).join(' '), /in this session|in this project|Always allow|Allow all edits|keep planning|Send answers/);
});

test('the number keys are only the two answers: 1 Allow, 2 Do not allow, nothing for 3', () => {
  const el = askCard(heldEv(), opts());
  assert.equal(typeof el.keys, 'function');
  assert.equal(el.keys(3), false, 'there is no third answer');
  assert.equal(el.keys(2), true, 'Do not allow is key 2 (opens the reason field)');
});

test('without a held card the same permission ask falls back to the ordinary tool view (not the wall card)', () => {
  const ev = { type: 'permission', request: 'r', tool: 'Bash', input: { command: 'npm test' }, canAlways: true, alwaysText: 'Bash(npm test)' };
  const el = askCard(ev, opts());
  const words = texts(el).join(' ');
  assert.doesNotMatch(words, /Held by Hoprig before it ran/, 'no wall card without a hold');
  assert.ok(buttons(el).some((b) => b.attrs['aria-label'] === 'More ways to allow'), 'the ordinary ask offers the wider allows, behind the arrow beside Allow');
});

test('a long act-list scrolls inside its box in the chat too, the same height rule as the session page (page-session.css)', () => {
  const css = fs.readFileSync(new URL('../../web/page-session.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-ask \.ho-held-acts \{ max-height: 32dvh; overflow: auto;/);
  assert.match(css, /@media \(max-width: 480px\) \{ \.chat-ask \.ho-held-acts \{ max-height: 22dvh; \}/);
  assert.match(css, /\.chat-ask \.ho-held-acts \.ho-held-what \{ max-height: none; \}/, 'the inner command does not double-scroll');
});
