// A message the owner sent (web/chat/timeline.js, chat.css, chat-input.css): a neutral bubble, folded after 8 lines, files
// inside it, Copy and Rewind to here under it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
globalThis.requestAnimationFrame ||= () => 0;
const given = [];
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => given.push(t) } }, configurable: true });
const { createTimeline } = await import('../../web/chat/timeline.js');
const css = (f) => fs.readFileSync(new URL(`../../web/chat/${f}`, import.meta.url), 'utf8');

const draw = (text, { rewind = true, attachments = [] } = {}) => {
  const scroll = new (document.createElement('div').constructor)('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const rewound = [];
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => rewind, rewind: (r) => rewound.push(r), who: () => 'Claude' });
  tl.apply({ reset: true, events: [{ kind: 'user', text, messageId: 'm1', attachments, i: 0 }], next: 1 });
  return { tl, rewound };
};
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1} of a made-up note`).join('\n');

test('a message of 9 lines folds with Show more; one of 8 lines has no button', () => {
  const nine = byClass(draw(lines(9)).tl.el, 'chat-more');
  assert.equal(nine.length, 1);
  assert.equal(texts(nine[0]).join(''), 'Show more');
  assert.equal(byClass(draw(lines(8)).tl.el, 'chat-more').length, 0);
  assert.equal(byClass(draw('Add a cart page').tl.el, 'chat-more').length, 0);
});

test('Show more opens it in place, Show less closes it, and aria-expanded says which', () => {
  const { tl } = draw(lines(12));
  const btn = byClass(tl.el, 'chat-more')[0];
  const body = byClass(tl.el, 'chat-usertext')[0];
  assert.equal(btn.attrs['aria-expanded'], 'false');
  assert.equal(body.dataset.fold, 'closed');
  btn.listeners.click();
  assert.equal(btn.attrs['aria-expanded'], 'true');
  assert.equal(body.dataset.fold, 'open');
  assert.equal(texts(btn).join(''), 'Show less');
  btn.listeners.click();
  assert.equal(btn.attrs['aria-expanded'], 'false');
  assert.equal(texts(btn).join(''), 'Show more');
  assert.equal(btn.tag, 'button', 'a real button: Enter and Space work');
});

test('Copy and Rewind to here are under the bubble, named, and do their work', async () => {
  given.length = 0;
  const { tl, rewound } = draw('Add a cart page');
  const row = byClass(tl.el, 'chat-userrow')[0];
  const kinds = row.children.map((c) => c.className.split(' ').find((k) => k === 'chat-user' || k === 'chat-useracts'));
  assert.deepEqual(kinds, ['chat-user', 'chat-useracts'], 'the bubble first, the actions after it, nothing beside it');
  const copy = byClass(row, 'chat-copybtn')[0];
  const back = byClass(row, 'chat-rewindbtn')[0];
  assert.equal(copy.attrs['aria-label'], 'Copy this message');
  assert.equal(back.attrs['aria-label'], 'Rewind to here');
  assert.match(back.attrs.title, /^Rewind to here/);
  await copy.listeners.click();
  assert.deepEqual(given, ['Add a cart page']);
  assert.match(texts(document.body).join(''), /Copied/);
  back.listeners.click();
  assert.deepEqual(rewound, [{ messageId: 'm1', text: 'Add a cart page' }]);
});

test('a chat that cannot rewind still has Copy; a tap on a bubble shows its actions, a tap elsewhere hides them', () => {
  const { tl } = draw('hello', { rewind: false });
  assert.equal(byClass(tl.el, 'chat-rewindbtn').length, 0);
  assert.equal(byClass(tl.el, 'chat-copybtn').length, 1);
  const find = (n) => (n.listeners && n.listeners.click && !n.tag.startsWith('button') && n.className.includes('chat-list') ? n : (n.children || []).map(find).find(Boolean));
  const list = find(tl.el);
  assert.ok(list, 'the list listens for taps');
  const row = byClass(tl.el, 'chat-userrow')[0];
  const set = new Set();
  row.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), toggle: (c, f) => (f === undefined ? !set.delete(c) && set.add(c) : f ? set.add(c) : set.delete(c)), contains: (c) => set.has(c) };
  list.querySelectorAll = (q) => (q.includes('chat-acts-on') ? (set.has('chat-acts-on') ? [row] : []) : []);
  const on = () => set.has('chat-acts-on');
  const tap = (inBubble) => list.listeners.click({ target: { closest: (q) => (q === '.chat-userrow' ? row : q === '.chat-user' ? (inBubble ? {} : null) : null) } });
  tap(true);
  assert.ok(on(), 'shown after a tap on the bubble');
  tap(false);
  assert.ok(!on(), 'hidden by a tap elsewhere');
  tap(true);
  tap(true);
  assert.ok(!on(), 'a second tap on the bubble hides it again');
});

test('the bubble is neutral, never the accent; the actions sit under it and show on hover or a tap', () => {
  const c = css('chat.css');
  const bubble = c.match(/\n\.chat-user \{([^}]*)\}/)[1];
  assert.match(bubble, /background: var\(--chat-bubble\)/);
  assert.match(bubble, /color: var\(--text\)/);
  assert.doesNotMatch(bubble, /accent/);
  assert.match(bubble, /border-radius: 16px/);
  assert.match(bubble, /max-width: min\(600px, 85%\)/);
  assert.doesNotMatch(c.match(/\.chat-startfold[^{]*\{[^}]*\}/g).join(''), /accent/);
  assert.match(c, /--chat-bg: var\(--surface\); --chat-bubble: var\(--surface-3\); --chat-well: var\(--surface-3\)/);
  assert.match(c, /--chat-bg: var\(--bg\); --chat-bubble: var\(--surface-2\); --chat-well: var\(--surface\)/);
  assert.match(c, /line-clamp: 8/);
  const i = css('chat-input.css');
  assert.match(i, /\.chat-userrow \{[^}]*flex-direction: column; align-items: flex-end/);
  assert.match(i, /\.chat-useracts \{[^}]*opacity: 0/);
  assert.match(i, /\.chat-userrow:hover \.chat-useracts, \.chat-userrow:focus-within \.chat-useracts \{ opacity: 1; \}/);
  assert.match(i, /@media \(hover: none\) and \(pointer: coarse\) \{[^@]*\.chat-newest \.chat-useracts, \.chat-acts-on \.chat-useracts \{ display: flex; \}/);
  assert.doesNotMatch(i.match(/\.chat-user \.chat-files \.chip \{[^}]*\}/)[0], /accent|255 255 255/);
});
