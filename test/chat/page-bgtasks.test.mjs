// The Background tasks line above the box (web/chat/agents.js agentsStrip): ONE line (the task in words, or the count and
// the kinds) that opens the tasks sheet; the chat's state words; and the queue's place in the conversation (chat.css),
// without a browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

const kept = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) } });
const Ag = await import('../../web/chat/agents.js');
const W = await import('../../web/chat/words.js');
const fs = await import('node:fs');
const css = (f) => fs.readFileSync(new URL(`../../web/chat/${f}`, import.meta.url), 'utf8');

// The shared fake DOM's classList does not toggle: this one does, for the part's own element.
const watched = (s) => {
  const on = new Set();
  s.el.classList.toggle = (c, x) => (x === undefined ? !on.has(c) : x) ? on.add(c) : on.delete(c);
  s.el.has = (c) => on.has(c);
  return s;
};
const T = (id, type, extra = {}) => ({ taskId: id, type, status: 'running', title: `${type} ${id}`, background: true, startedAt: 1000, ...extra });
const four = [T('a', 'agent', { now: 'Reading src' }), T('b', 'agent'), T('c', 'shell', { title: 'npm run dev' }), T('d', 'workflow', { title: 'release-check' })];

test('one line: the one task in words, or the counts and kinds; nothing running hides it; the seconds of one task count', () => {
  const s = watched(Ag.agentsStrip({ stop() {}, jump() {} }));
  s.paint([]);
  assert.ok(s.el.has('hidden'));
  const realNow = Date.now;
  Date.now = () => 1000 + 125_000 + 5_000; // the browser's clock is 5 s ahead of the chat's
  try {
    s.paint(four.slice(2, 3), 5000);
    assert.ok(!s.el.has('hidden'));
    assert.equal(texts(byClass(s.el, 'chat-bg-label')[0]).join(''), 'npm run dev · 2 min 5 s', 'the task and for how long, from the chat\'s clock');
    assert.equal(byClass(s.el, 'chat-bg-line')[0].attrs['aria-label'], 'Background tasks: npm run dev · 2 min 5 s. Open');
  } finally {
    Date.now = realNow;
  }
  const many = Array.from({ length: 23 }, (_, i) => T(`t${i}`, i < 15 ? 'shell' : 'workflow'));
  s.paint(many);
  assert.equal(texts(byClass(s.el, 'chat-bg-label')[0]).join(''), '23 in the background: 15 shells, 8 workflows');
  s.paint(four);
  assert.equal(texts(byClass(s.el, 'chat-bg-label')[0]).join(''), '4 in the background: 2 agents, 1 shell, 1 workflow');
  s.paint([{ ...four[0], status: 'completed' }, ...four.slice(1)]);
  assert.equal(texts(byClass(s.el, 'chat-bg-label')[0]).join(''), '3 in the background: 1 agent, 1 shell, 1 workflow', 'an ended task is gone from the line');
  s.stopClock?.();
});

test('there is no list, no fold and no View all of its own: the one line is a button that opens the tasks sheet with each Stop', async () => {
  const { FakeElement } = await import('./fakedom.mjs');
  FakeElement.prototype.showModal = function showModal() { this.open = true; };
  FakeElement.prototype.close = function close() { this.open = false; };
  const s = Ag.agentsStrip({ stop() {}, jump() {}, output: async () => ({ text: '' }) });
  s.paint(four);
  assert.equal(byClass(s.el, 'chat-bg-row').length, 0);
  assert.equal(byClass(s.el, 'chat-bg-all').length, 0);
  assert.equal(byClass(s.el, 'chat-bg-toggle').length, 0);
  const line = byClass(s.el, 'chat-bg-line')[0];
  assert.equal(line.tag, 'button', 'a real button');
  line.listeners.click();
  await new Promise((r) => setImmediate(r));
  const sheet = texts(document.body).join(' ');
  assert.match(sheet, /Background tasks/);
  assert.equal(document.body.querySelectorAll('button.chat-taskstop').length, 4, 'each task has its Stop in the sheet');
  s.stopClock?.();
});

test('Stop is left out of the sheet where the coding tool cannot stop a task', async () => {
  const s = Ag.agentsStrip({ stop() {}, jump() {}, canStop: () => false });
  s.paint(four.slice(0, 1));
  assert.equal(byClass(s.el, 'chat-taskstop').length, 0);
  assert.equal(typeof s.open, 'function');
  s.stopClock?.();
});

test('the status words of a chat are Home\'s: Working in the background, Finished, Ready, Ended', () => {
  const idle = { status: 'waiting', engine: { id: 'claude' }, live: [], tasks: [] };
  assert.equal(W.chatState({ ...idle, status: 'working', turn: false, tasks: [{ status: 'running', background: true }] }).text, 'Working in the background');
  assert.equal(W.chatState({ ...idle, lastEnd: 'ok', hasMessage: true }).text, 'Finished');
  assert.equal(W.chatState({ ...idle, lastEnd: null, hasMessage: true }).text, 'Finished', 'a chat reopened with its conversation');
  assert.equal(W.chatState({ ...idle, lastEnd: null, hasMessage: false }).text, 'Ready', 'nothing sent yet');
  assert.equal(W.chatState({ ...idle, lastEnd: 'ok' }).text, 'Finished', 'an older computer does not say: Finished');
  assert.equal(W.chatState({ ...idle, status: 'ended' }).key, 'ended');
});

test('the dock lays out so a long queued message cannot widen it; the queue is a bubble in the conversation, hover or touch for its actions', () => {
  const c = css('chat.css');
  assert.match(c, /\.chat-dock > \.chat-col \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(c, /\.chat-tail \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(c, /\.chat-queued:hover \.chat-queued-acts, \.chat-queued:focus-within \.chat-queued-acts \{ opacity: 1; \}/);
  assert.match(c, /@media \(hover: none\) \{ \.chat-queued-acts \{ opacity: 1; \} \}/);
  assert.match(c, /\.chat-queued-bubble \{[^}]*dashed[^}]*var\(--chat-bubble\)/);
  assert.doesNotMatch(c, /\.chat-queued-bubble \{[^}]*(--accent|border-bottom-right-radius)/, 'the sent bubble\'s look: no accent, no tail');
});

test('the actions under a sent message show on hover or focus, and on a touch screen under the newest', () => {
  const c = css('chat-input.css');
  assert.match(c, /\.chat-useracts \{[^}]*opacity: 0/);
  assert.match(c, /\.chat-userrow:hover \.chat-useracts, \.chat-userrow:focus-within \.chat-useracts \{ opacity: 1; \}/);
  assert.match(c, /@media \(hover: none\) and \(pointer: coarse\) \{[^@]*\.chat-newest \.chat-useracts/);
});

test('the whole tree has an Output button for each task, named for a screen reader', () => {
  const tree = Ag.taskTree(four, null, () => {}, () => {});
  const outs = byClass(tree, 'btn').filter((b) => texts(b).join('') === 'Output');
  assert.equal(outs.length, 4);
  assert.equal(outs[2].attrs['aria-label'], 'Output of npm run dev');
  const cards = css('chat-cards.css');
  assert.match(cards, /\.chat-task-out \{[^}]*max-height[^}]*overflow: auto[^}]*white-space: pre-wrap[^}]*overflow-wrap: anywhere/, 'a long line never widens the sheet');
});
