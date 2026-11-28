// The living line (web/chat/statusline.js, words.js liveWords and chatState): what Claude does now, as the last thing of the
// conversation while a turn runs; the same state words as Home's list; the jump-down button; the tail's place.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
globalThis.requestAnimationFrame ||= () => 0;
const W = await import('../../web/chat/words.js');
const L = await import('../../web/chat/statusline.js');
const { stateOf } = await import('../../web/lib.js');
const { createTimeline } = await import('../../web/chat/timeline.js');

const base = { status: 'working', turn: true, engine: { id: 'claude' }, live: [], tasks: [] };
const tool = (extra = {}) => ({ kind: 'tool', id: 't1', written: true, title: 'mock bash', command: 'npm test', runAt: 1, ...extra });

test('words per step: Thinking at the start and between steps, Running with the command, Writing, Compacting, Retrying', () => {
  assert.deepEqual(W.liveWords(base), { step: 'thinking', word: 'Thinking', detail: '', text: 'Thinking' }, 'never the generic Working');
  assert.equal(W.liveWords({ ...base, activity: 'requesting' }).step, 'thinking');
  assert.equal(W.liveWords({ ...base, live: [{ kind: 'thinking', text: 'hm' }] }).step, 'thinking');
  assert.equal(W.liveWords({ ...base, live: [{ kind: 'text', text: 'Hel' }] }).text, 'Writing');
  const run = W.liveWords({ ...base, live: [tool()] });
  assert.deepEqual([run.step, run.word, run.detail, run.text], ['running', 'Running', 'npm test', 'Running: npm test']);
  assert.equal(W.liveWords({ ...base, activity: 'compacting' }).text, 'Compacting the conversation');
  assert.equal(W.liveWords({ ...base, activity: 'retrying' }).text, 'Retrying: the provider did not answer');
  assert.equal(W.liveWords({ ...base, live: [tool({ agent: 'a1' })] }).step, 'thinking', 'a subagent\'s call is in its own card');
});

test('Running only once the call really runs: not while its OK waits, not after a no, not a start in the background', () => {
  const v = { ...base, live: [tool()] };
  assert.equal(W.liveWords(v, { runs: () => false }).step, 'thinking');
  assert.equal(W.liveWords(v, { runs: (id) => id !== 't1' }).step, 'thinking');
  assert.equal(W.liveWords(v, { runs: () => true }).step, 'running');
});

test('no line when nothing runs, while an OK, a question or a plan waits, for a terminal, and for background work only', () => {
  assert.equal(W.liveWords({ ...base, status: 'waiting', turn: false }), null);
  for (const asking of ['permission', 'question', 'plan', 'mcp']) assert.equal(W.liveWords({ ...base, status: 'attention', asking }), null, asking);
  assert.equal(W.liveWords({ ...base, terminal: { name: 'x' } }), null);
  assert.equal(W.liveWords({ ...base, turn: false, tasks: [{ status: 'running' }] }), null, 'the Background tasks line says it');
  assert.equal(W.liveWords(null), null);
});

// The shared fake DOM's classList does not toggle: this gives an element one that does.
const working = (el, start = []) => {
  const on = new Set(start);
  el.classList = { add: (c) => on.add(c), remove: (c) => on.delete(c), contains: (c) => on.has(c), toggle: (c, x) => ((x === undefined ? !on.has(c) : x) ? on.add(c) : on.delete(c)) };
  return el;
};
const shown = (line) => {
  const on = new Set(['hidden']);
  line.el.classList.toggle = (c, x) => ((x === undefined ? !on.has(c) : x) ? on.add(c) : on.delete(c));
  line.el.has = (c) => on.has(c);
  return line;
};

test('the line: the mark, the words, the seconds of the turn; the seconds are not read out; Esc to stop only with a mouse', () => {
  const real = Date.now;
  Date.now = () => 100_000;
  try {
    const line = shown(L.createLiveLine());
    assert.equal(line.paint({ ...base, live: [tool()] }, { since: 100_000 - 40_000 }), true);
    assert.ok(!line.el.has('hidden'));
    assert.equal(line.el.dataset.step, 'running');
    assert.equal(texts(byClass(line.el, 'chat-live-word')[0]).join(''), 'Running');
    assert.equal(texts(byClass(line.el, 'chat-live-cmd')[0]).join(''), 'npm test');
    assert.equal(texts(byClass(line.el, 'chat-live-time')[0]).join(''), '· 40 s');
    assert.equal(byClass(line.el, 'chat-live-time')[0].attrs['aria-hidden'], 'true', 'the seconds are not read');
    assert.equal(byClass(line.el, 'chat-live-word')[0].attrs.role, 'status', 'the words are, once per step');
    assert.equal(line.paint({ ...base }, { since: 100_000 - 65_000 }), true);
    assert.equal(line.el.dataset.step, 'thinking');
    assert.equal(texts(byClass(line.el, 'chat-live-time')[0]).join(''), '· 1 min 5 s');
    assert.equal(line.paint({ ...base, status: 'waiting', turn: false }), false);
    assert.ok(line.el.has('hidden'), 'no line when nothing runs');
    assert.equal(line.el.dataset.step, undefined);
    line.stop();
  } finally {
    Date.now = real;
  }
});

test('Esc to stop is said only on a fine pointer', () => {
  const mm = globalThis.matchMedia;
  try {
    for (const coarse of [true, false]) {
      globalThis.matchMedia = (q) => ({ matches: coarse && /coarse/.test(q) });
      const line = shown(L.createLiveLine());
      const esc = working(byClass(line.el, 'chat-live-esc')[0]);
      line.paint({ ...base });
      assert.equal(esc.classList.contains('hidden'), coarse, coarse ? 'touch: no key said' : 'mouse: Esc to stop');
      line.stop();
    }
  } finally {
    globalThis.matchMedia = mm;
  }
});

test('chatState says the same words as Home\'s list (lib.js stateOf) for every state of a chat', () => {
  const idle = { status: 'waiting', engine: { id: 'claude' }, live: [], tasks: [] };
  const cases = [
    [{ ...base }, { status: 'working' }],
    [{ ...base, turn: false }, { status: 'working', background: true }],
    [{ ...idle, status: 'attention', asking: 'permission' }, { status: 'attention' }],
    [{ ...idle, status: 'attention', asking: 'question' }, { status: 'attention', ask: { type: 'question' } }],
    [{ ...idle, status: 'attention', asking: 'plan' }, { status: 'attention', ask: { type: 'plan' } }],
    [{ ...idle, lastEnd: 'ok', hasMessage: true }, { status: 'waiting', lastMessage: 'x' }],
    [{ ...idle, hasMessage: false }, { status: 'waiting' }],
    [{ ...idle, lastError: 'boom', lastEnd: 'error', hasMessage: true }, { status: 'waiting', endedInError: true, lastMessage: 'x' }],
    [{ ...idle, lastEnd: 'limit', hasMessage: true }, { status: 'waiting', limit: { at: 1 }, lastMessage: 'x' }],
    [{ ...idle, status: 'ended' }, { status: 'ended' }],
    [{ ...idle, terminal: { name: 'x' } }, { kind: 'shell' }],
  ];
  for (const [chat, session] of cases) {
    const a = W.chatState(chat);
    const b = stateOf(session);
    assert.equal(a.text, b.text, JSON.stringify(chat));
  }
  assert.deepEqual(['working', 'background', 'attention', 'finished', 'ready', 'error', 'limit', 'ended', 'terminal'], cases.map(([c]) => W.chatState(c).key).filter((k, i, all) => all.indexOf(k) === i));
  assert.equal(W.chatState({ ...idle, lastEnd: 'stopped', hasMessage: true }).key, 'stopped', 'the owner\'s Stop: its own key, the words of Finished');
  assert.equal(W.chatState({ ...idle, lastEnd: 'stopped', hasMessage: true }).text, 'Finished');
});

const draw = (events, o = {}) => {
  const scroll = new (document.createElement('div').constructor)('div');
  Object.assign(scroll, { scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude', ...o });
  tl.apply({ reset: true, events: events.map((e, i) => ({ i, ...e })), next: events.length });
  return tl;
};

test('the tail comes after the list, before the screen reader line: the living line and the queue go there', () => {
  const tl = draw([{ kind: 'user', text: 'Add a cart page', messageId: 'm1' }]);
  const kids = tl.el.children.map((c) => c.className.split(' ').filter((x) => x.startsWith('chat-')).join(' '));
  assert.ok(kids.indexOf('chat-tail') > kids.indexOf('chat-list'), kids.join(' | '));
  assert.ok(kids.indexOf('chat-tail') < kids.indexOf('chat-sr'));
  assert.equal(tl.tail, tl.el.children[kids.indexOf('chat-tail')]);
});

test('the jump-down button says the step while a turn runs, Needs your OK where one waits, else New messages', () => {
  let now = null;
  const scroll = new (document.createElement('div').constructor)('div');
  Object.assign(scroll, { scrollHeight: 2000, scrollTop: 0, clientHeight: 400 });
  const tl = createTimeline({ scroll, A: '/x', cwd: () => '/p', canRewind: () => false, who: () => 'Claude', down: () => now });
  working(tl.downBtn, ['hidden']);
  tl.apply({ reset: true, events: [{ i: 0, kind: 'text', blockId: 'b1', text: 'hi' }], next: 1 });
  scroll.listeners.scroll(); // the owner scrolled up
  const label = () => texts(tl.downBtn).join('');
  let n = 1;
  const news = () => tl.apply({ events: [{ i: n++, kind: 'text', blockId: `b${n}`, text: 'more' }] });
  news();
  assert.equal(label(), 'New messages');
  now = { text: 'Thinking' };
  news();
  assert.equal(label(), 'Thinking');
  now = { text: 'Running' };
  tl.status();
  assert.equal(label(), 'Running', 'a new step is said at once, without news');
  now = { text: 'Needs your OK', attention: true };
  tl.status();
  assert.equal(label(), 'Needs your OK');
  assert.ok(tl.downBtn.classList.contains('chat-down-ask'), 'amber');
  now = null;
  tl.status();
  assert.ok(!tl.downBtn.classList.contains('chat-down-ask'));
});
