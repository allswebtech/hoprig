// Tia's box and her microphone (web/voice.js, web/tiamsg.js), without a browser: a spoken message sends itself 1.5 s
// after the last word unless the box was touched or typed into; the App's box never sends by itself; what is read
// aloud is only the answer to a spoken message; on a phone one control sits beside an empty box; no card is confirmed
// by anything heard. The recognition is a stand-in that behaves as Chrome's does.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { FakeElement } from '../chat/fakedom.mjs';

const kept = new Map();
globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, x) => kept.set(k, String(x)) };
globalThis.Event ||= class {
  constructor(type, o = {}) {
    Object.assign(this, { type, ...o });
  }
};
FakeElement.prototype.dispatchEvent = function (e) {
  this.listeners[e.type]?.(e);
  return true;
};
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true });
let coarse = false;
globalThis.matchMedia = (q) => ({ matches: coarse && /coarse/.test(q), addEventListener() {} });

class StandIn {
  static all = [];
  static get last() {
    return StandIn.all.at(-1);
  }
  constructor() {
    StandIn.all.push(this);
    this.aborted = false;
  }
  start() {}
  stop() {
    this.onend?.();
  }
  abort() {
    this.aborted = true;
    this.onerror?.({ error: 'aborted' });
    this.onend?.();
  }
  hear(...parts) {
    this.onresult?.({ results: parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) });
  }
}
globalThis.window.webkitSpeechRecognition = StandIn;
const { micButton, composerControls, AUTO_SEND_MS } = await import('../../web/voice.js');
const { turnVoice, speakable, SAY_CARD, SAY_MORE, SPEAK_MAX } = await import('../../web/tiamsg.js');

const box = () => {
  const t = new FakeElement('textarea');
  t.value = '';
  t.getClientRects = () => [{}];
  document.body.append(t);
  return t;
};
/** A box with a microphone that sends by itself (Tia's) and a counter of what was sent. */
function tiaBox() {
  const t = box();
  const sent = [];
  const m = micButton(t, { auto: (...args) => sent.push(args) });
  m.el.listeners.click();
  return { t, m, sent, r: StandIn.last };
}

test('the pause is 1.5 s', () => {
  assert.equal(AUTO_SEND_MS, 1500);
});

test('a spoken message sends itself 1.5 s after the last word, and is a spoken one', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { t, m, sent, r } = tiaBox();
    r.hear(['fix the cart total', false]);
    mock.timers.tick(1000);
    r.hear(['fix the cart total today', true]); // another word: the pause starts again
    mock.timers.tick(1499);
    assert.equal(sent.length, 0, 'not before the pause is over');
    mock.timers.tick(1);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], [], 'what was heard is the box message itself: nothing but "send" is passed on');
    assert.ok(r.aborted, 'listening ended: tap, talk, listen');
    assert.equal(m.el.dataset.state, 'idle', 'the microphone does not stay open');
    assert.equal(m.heard(), true, 'the message is marked spoken');
    mock.timers.tick(10_000);
    assert.equal(sent.length, 1, 'once');
  } finally {
    mock.timers.reset();
  }
});

test('a box he touched is not sent by itself: it waits for Send, and the message is still a spoken one', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { t, m, sent, r } = tiaBox();
    r.hear(['open the shop project', false]);
    t.listeners.pointerdown({});
    mock.timers.tick(5000);
    assert.equal(sent.length, 0);
    r.hear(['open the shop project and run the tests', true]);
    mock.timers.tick(5000);
    assert.equal(sent.length, 0, 'later words do not start the pause again');
    assert.equal(m.heard(), true);
  } finally {
    mock.timers.reset();
  }
});

test('words he typed into the box are never sent by itself and never a spoken message', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { t, m, sent, r } = tiaBox();
    r.hear(['run the checks', false]);
    t.value += ' please';
    mock.timers.tick(5000);
    assert.equal(sent.length, 0);
    assert.equal(m.heard(), false, 'typed into: it is a typed message');
    m.forget();
    assert.equal(m.heard(), false);
  } finally {
    mock.timers.reset();
  }
});

test('the App message box never sends by itself: press to send', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const t = box();
    const m = micButton(t); // the App composer: no auto
    m.el.listeners.click();
    StandIn.last.hear(['run the tests', true]);
    mock.timers.tick(60_000);
    assert.equal(t.value, 'run the tests');
    assert.equal(m.el.dataset.state, 'listening', 'still listening, nothing sent');
    assert.equal(StandIn.last.aborted, false);
  } finally {
    mock.timers.reset();
  }
});

test('a phone shows one control beside an empty box where there were two; a desktop shows both', () => {
  assert.deepEqual(composerControls({ touch: true, empty: true, state: 'idle' }), { mic: true, send: false });
  assert.deepEqual(composerControls({ touch: true, empty: true, state: 'speaking' }), { mic: true, send: false }, 'the stop square');
  assert.deepEqual(composerControls({ touch: true, empty: false, state: 'idle' }), { mic: false, send: true }, 'Send comes back with text');
  assert.deepEqual(composerControls({ touch: true, empty: false, state: 'listening' }), { mic: false, send: true });
  assert.deepEqual(composerControls({ touch: false, empty: true, state: 'idle' }), { mic: true, send: true });
  assert.deepEqual(composerControls({ touch: true, empty: true, state: 'insecure' }), { mic: true, send: true }, 'the microphone that cannot work keeps its place to say why');
  coarse = true;
  try {
    const m = micButton(box());
    assert.equal(m.state(), 'idle');
  } finally {
    coarse = false;
  }
});

test('only the answer to a spoken message is read aloud: a typed one never is', () => {
  const typed = turnVoice();
  typed.begin(false);
  for (const e of [{ kind: 'owner', text: 'hi' }, { kind: 'text', text: 'Hello, the shop is fine.' }]) assert.equal(typed.see(e), null);
  assert.equal(typed.see({ kind: 'done', ok: true }), null);
  const spoken = turnVoice();
  spoken.begin(true);
  assert.equal(spoken.see({ kind: 'owner', text: 'hi' }), null);
  assert.equal(spoken.see({ kind: 'text', text: 'Let me look.' }), null);
  assert.equal(spoken.see({ kind: 'text', text: 'The shop is fine.' }), null);
  assert.equal(spoken.see({ kind: 'done', ok: true }), 'The shop is fine.', 'her final words only');
  assert.equal(spoken.see({ kind: 'done', ok: true }), null, 'once');
});

test('a history drawn on a reload, a failed turn and a notice are never read aloud', () => {
  const idle = turnVoice();
  for (const e of [{ kind: 'owner', text: 'hi' }, { kind: 'text', text: 'Old answer.' }, { kind: 'done', ok: true }]) assert.equal(idle.see(e), null);
  const failed = turnVoice();
  failed.begin(true);
  failed.see({ kind: 'owner', text: 'hi' });
  failed.see({ kind: 'text', text: 'Half an answer' });
  assert.equal(failed.see({ kind: 'done', ok: false }), null);
  const notice = turnVoice();
  notice.begin(true);
  notice.see({ kind: 'owner', text: 'hi' });
  notice.see({ kind: 'notice', code: 'x' });
  assert.equal(notice.see({ kind: 'done', ok: true }), null);
  const old = turnVoice();
  old.begin(true);
  assert.equal(old.see({ kind: 'text', text: 'An older turn finishing late.' }), null, 'before his message is in the conversation');
  assert.equal(old.see({ kind: 'done', ok: true }), null);
});

test('a turn that ends in a card says that the card needs his tap, and nothing heard can confirm it', () => {
  const v = turnVoice();
  v.begin(true);
  v.see({ kind: 'owner', text: 'start the tests in shop' });
  v.see({ kind: 'text', text: 'I can start them for you.' });
  v.see({ kind: 'tool_result', id: 'a', card: 'c1' });
  assert.equal(v.see({ kind: 'done', ok: true }), `I can start them for you. ${SAY_CARD}`);
  assert.equal(SAY_CARD, 'This needs your tap on the card.');
  // The microphone only ever calls `auto` with no words, and exposes nothing that decides a card.
  const { m } = tiaBox();
  assert.deepEqual(Object.keys(m).sort(), ['dispose', 'el', 'forget', 'heard', 'note', 'state', 'stop']);
  const only = turnVoice();
  only.begin(true);
  only.see({ kind: 'owner', text: 'x' });
  only.see({ kind: 'tool_result', id: 'b', card: 'c2' });
  assert.equal(only.see({ kind: 'done', ok: true }), SAY_CARD, 'a card with no words of hers');
});

test('what is read aloud is plain and cut at the limit, with the rest left on the screen', () => {
  const table = 'Here:\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\nSee [the page](https://example.com/x) and **this**.';
  assert.deepEqual(speakable(table), { text: 'Here: See the page and this.', cut: false });
  const long = `${'The shop has many orders today. '.repeat(40)}`;
  const s = speakable(long);
  assert.equal(s.cut, true);
  assert.ok(s.text.length <= SPEAK_MAX, `${s.text.length} characters`);
  assert.match(s.text, /orders today\.$/, 'cut at the end of a sentence');
  const v = turnVoice();
  v.begin(true);
  v.see({ kind: 'owner', text: 'x' });
  v.see({ kind: 'text', text: long });
  assert.ok(v.see({ kind: 'done', ok: true }).endsWith(SAY_MORE));
  assert.deepEqual(speakable('word '.repeat(300)).cut, true);
  assert.ok(speakable(`${'a'.repeat(900)}`).text.length <= SPEAK_MAX, 'no space to cut at');
});
