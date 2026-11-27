// The Background tasks part above the box (web/chat/agents.js agentsStrip): the head with the count and the types, a row
// for each task that runs (type, name, what it does now, for how long, its Stop), folded for many, remembered, and the
// words of the status line and the queue's place in the dock (chat.css), without a browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

const kept = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) } });
const Ag = await import('../../web/chat/agents.js');
const St = await import('../../web/chat/statusline.js');
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

test('the head says the count and the types; nothing running hides the part', () => {
  kept.clear();
  const s = watched(Ag.agentsStrip({ stop() {}, jump() {} }));
  s.paint([]);
  assert.ok(s.el.has('hidden'));
  s.paint(four);
  assert.ok(!s.el.has('hidden'));
  assert.equal(texts(byClass(s.el, 'chat-bg-label')[0]).join(''), '4 background tasks · 2 agents · 1 shell · 1 workflow');
  s.paint([{ ...four[0], status: 'completed' }, ...four.slice(1)]);
  assert.equal(texts(byClass(s.el, 'chat-bg-label')[0]).join(''), '3 background tasks · 1 agent · 1 shell · 1 workflow', 'an ended task is gone from the part');
  assert.equal(byClass(s.el, 'chat-bg-row').length, 3);
  s.stopClock?.();
});

test('a row: type, name, what it does now, for how long (from the chat\'s clock), and a Stop named by the task', () => {
  kept.clear();
  const realNow = Date.now;
  Date.now = () => 1000 + 64_000 + 5_000; // the browser's clock is 5 s ahead of the chat's
  try {
    const s = watched(Ag.agentsStrip({ stop() {}, jump() {} }));
    s.paint(four, 5000);
    const row = byClass(s.el, 'chat-bg-row')[0];
    assert.equal(texts(byClass(row, 'chat-bg-title')[0]).join(''), 'agent a');
    assert.equal(texts(byClass(row, 'chat-bg-now')[0]).join(''), 'Reading src');
    assert.equal(texts(byClass(row, 'chat-bg-time')[0]).join(''), '1m 04s');
    assert.equal(byClass(row, 'chat-taskstop')[0].attrs['aria-label'], 'Stop agent a');
    assert.equal(byClass(row, 'chat-bg-type')[0].attrs.title, 'agent');
    assert.equal(Ag.runFor(42_000), '42 s');
    assert.equal(Ag.runFor(3_720_000), '1h 02m');
  } finally {
    Date.now = realNow;
  }
});

test('up to three tasks the list is open, more start folded; the choice is kept in this browser; a row stays while its task runs', () => {
  kept.clear();
  const s = watched(Ag.agentsStrip({ stop() {}, jump() {} }));
  s.paint(four.slice(0, 3));
  assert.ok(!s.el.has('chat-bg-folded'));
  s.paint(four);
  assert.ok(s.el.has('chat-bg-folded'), 'four: one line');
  const toggle = byClass(s.el, 'chat-bg-toggle')[0];
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  toggle.listeners.click();
  assert.equal(kept.get('pref:chat.tasks.open'), 'true');
  const s2 = watched(Ag.agentsStrip({ stop() {}, jump() {} }));
  s2.paint(four);
  assert.ok(!s2.el.has('chat-bg-folded'), 'the choice is remembered');
  const row = byClass(s2.el, 'chat-bg-row')[0];
  const stop = byClass(row, 'chat-taskstop')[0];
  s2.paint([{ ...four[0], now: 'Reading more' }, ...four.slice(1)]);
  assert.equal(byClass(s2.el, 'chat-bg-row')[0], row, 'the same row');
  assert.equal(byClass(row, 'chat-taskstop')[0], stop, 'the same Stop: the keyboard stays on it');
  assert.equal(texts(byClass(row, 'chat-bg-now')[0]).join(''), 'Reading more');
  kept.clear();
  s.stopClock?.();
});

test('a phone starts with one line, whatever the number of tasks', () => {
  kept.clear();
  globalThis.matchMedia = (q) => ({ matches: /max-width: 599px/.test(q) });
  try {
    const s = watched(Ag.agentsStrip({ stop() {}, jump() {} }));
    s.paint(four.slice(0, 1));
    assert.ok(s.el.has('chat-bg-folded'));
    byClass(s.el, 'chat-bg-toggle')[0].listeners.click();
    assert.ok(!s.el.has('chat-bg-folded'), 'a tap opens it there');
  } finally {
    delete globalThis.matchMedia;
    kept.clear();
  }
});

test('View all opens the sheet; Stop is left out where the coding tool cannot stop a task', () => {
  kept.clear();
  const s = Ag.agentsStrip({ stop() {}, jump() {}, canStop: () => false });
  s.paint(four.slice(0, 1));
  assert.equal(byClass(s.el, 'chat-taskstop').length, 0);
  assert.equal(texts(byClass(s.el, 'chat-bg-all')[0]).join(''), 'View all');
  assert.equal(typeof s.open, 'function');
});

test('the status line says only the state: Working in the background, Finished, Ready, Ended, with their dots', () => {
  const idle = { status: 'waiting', engine: { id: 'claude' }, live: [], tasks: [] };
  assert.equal(St.stateWords({ ...idle, status: 'working', turn: false, tasks: [{ status: 'running', background: true }] }), 'Working in the background');
  assert.equal(St.stateWords({ ...idle, lastEnd: 'ok', hasMessage: true }), 'Finished');
  assert.equal(St.stateWords({ ...idle, lastEnd: null, hasMessage: true }), 'Finished', 'a chat reopened with its conversation');
  assert.equal(St.stateWords({ ...idle, lastEnd: null, hasMessage: false }), 'Ready', 'nothing sent yet');
  assert.equal(St.stateWords({ ...idle, lastEnd: 'ok' }), 'Finished', 'an older computer does not say: Finished');
  assert.equal(St.stateWords({ ...idle, status: 'ended' }), 'Ended');
  assert.equal(St.statusKey({ ...idle, status: 'ended' }), 'ended');
  assert.match(css('chat.css'), /\[data-status='ended'\] \.chat-st-dot/);
});

test('the dock lays out so a long queued message cannot widen it, and the queue is a bubble, hover or touch for its actions', () => {
  const c = css('chat.css');
  assert.match(c, /\.chat-dock > \.chat-col \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(c, /\.chat-queue \{[^}]*max-height: 30vh[^}]*overflow-y: auto/);
  assert.match(c, /\.chat-queued:hover \.chat-queued-acts, \.chat-queued:focus-within \.chat-queued-acts \{ opacity: 1; \}/);
  assert.match(c, /@media \(hover: none\) \{ \.chat-queued-acts \{ opacity: 1; \} \}/);
  assert.match(c, /\.chat-queued-bubble \{[^}]*dashed/);
});

test('the actions under a sent message show on hover or focus, and on a touch screen under the newest', () => {
  const c = css('chat-input.css');
  assert.match(c, /\.chat-useracts \{[^}]*opacity: 0/);
  assert.match(c, /\.chat-userrow:hover \.chat-useracts, \.chat-userrow:focus-within \.chat-useracts \{ opacity: 1; \}/);
  assert.match(c, /@media \(hover: none\) and \(pointer: coarse\) \{[^@]*\.chat-newest \.chat-useracts/);
});

test('a task opens to its output: the row\'s name is a button named for a screen reader; the whole tree has an Output button', () => {
  kept.clear();
  const s = Ag.agentsStrip({ stop() {}, jump() {}, output: async () => ({ text: '' }) });
  s.paint(four.slice(2, 3));
  const name = byClass(s.el, 'chat-bg-title')[0];
  assert.equal(name.tag, 'button');
  assert.equal(name.attrs['aria-label'], 'Open the output of npm run dev');
  // Without a way to read it, the name still shows the call in the chat (older computers).
  const old = Ag.agentsStrip({ stop() {}, jump() {} });
  old.paint([{ ...four[2], toolId: 'tu' }]);
  assert.equal(byClass(old.el, 'chat-bg-title')[0].attrs['aria-label'], undefined);
  assert.equal(byClass(old.el, 'chat-bg-title')[0].attrs.title, 'Show in the chat');
  const tree = Ag.taskTree(four, null, () => {}, () => {});
  const outs = byClass(tree, 'btn').filter((b) => texts(b).join('') === 'Output');
  assert.equal(outs.length, 4);
  assert.equal(outs[2].attrs['aria-label'], 'Output of npm run dev');
  s.stopClock?.();
  old.stopClock?.();
  const cards = css('chat-cards.css');
  assert.match(cards, /\.chat-task-out \{[^}]*max-height[^}]*overflow: auto[^}]*white-space: pre-wrap[^}]*overflow-wrap: anywhere/, 'a long line never widens the sheet');
});
