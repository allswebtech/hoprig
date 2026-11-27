// A reply in the chat (web/chat/timeline.js): every code block has a Copy at its top right (toast Copied), a reply has
// its own Copy that gives its Markdown, and a link in it opens in a new tab.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
globalThis.requestAnimationFrame ||= () => 0;
const given = [];
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => given.push(t) } }, configurable: true });
const { createTimeline } = await import('../../web/chat/timeline.js');

const draw = (text) => {
  const scroll = new (document.createElement('div').constructor)('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude' });
  tl.apply({ reset: true, events: [{ kind: 'user', text: 'go', i: 0 }, { kind: 'text', blockId: 'b', text, i: 1 }], next: 2 });
  return tl;
};

test('a code block has a Copy that copies exactly its code and says Copied', async () => {
  given.length = 0;
  const tl = draw('Run:\n\n```sh\nnpm test\n```\n\nand see https://example.com/doc now.');
  const wrap = byClass(tl.el, 'chat-codewrap');
  assert.equal(wrap.length, 1);
  const btn = byClass(wrap[0], 'chat-codecopy')[0];
  assert.equal(btn.attrs.title, 'Copy');
  assert.ok(btn.attrs['aria-label'], 'it has a name for a screen reader');
  await btn.listeners.click();
  assert.deepEqual(given, ['npm test']);
  assert.match(texts(document.body).join(''), /Copied/);
  const a = tl.el.querySelectorAll('a')[0];
  assert.equal(a.attrs.href, 'https://example.com/doc');
  assert.equal(a.attrs.target, '_blank');
});

test('a reply has a Copy that gives its Markdown', async () => {
  given.length = 0;
  const md = 'Hello **there**\n\n- one';
  const tl = draw(md);
  const btn = byClass(tl.el, 'chat-copyreply')[0];
  assert.ok(btn && btn.attrs['aria-label']);
  await btn.listeners.click();
  assert.deepEqual(given, [md]);
});
