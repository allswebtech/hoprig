// Voice typing (web/voice.js), without a browser: the microphone button's states with a stand-in for the browser's
// speech recognition (a real one cannot run here). The stand-in behaves as Chrome's does: abort() fires an "aborted"
// error and then the end. The words go into the box and are never sent by themselves; a box that is gone or hidden
// stops the microphone; one box listens at a time; words he types are never written over; a browser without
// recognition, or a page over plain http, says so; the language is this device's setting or the browser's own.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeElement } from './fakedom.mjs';

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
Object.defineProperty(globalThis, 'navigator', { value: { language: 'hi-IN' }, configurable: true, writable: true });
let coarse = false; // a touch screen
globalThis.matchMedia = (q) => ({ matches: coarse && /coarse/.test(q), addEventListener() {} });

/** A stand-in for SpeechRecognition, as Chrome behaves: the test says what was heard, and when it ends. */
class StandIn {
  static all = [];
  static get last() {
    return StandIn.all.at(-1);
  }
  constructor() {
    StandIn.all.push(this);
    this.on = false;
    this.aborted = false;
  }
  start() {
    this.on = true;
  }
  stop() {
    this.on = false;
    this.onend?.();
  }
  abort() {
    this.aborted = true;
    this.on = false;
    this.onerror?.({ error: 'aborted' });
    this.onend?.();
  }
  hear(...parts) {
    this.onresult?.({ results: parts.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) });
  }
}
/** A message box on the page (connected and drawn), counting the input events it hears. */
const box = () => {
  const t = new FakeElement('textarea');
  t.value = '';
  t.shown = true;
  t.getClientRects = () => (t.shown ? [{}] : []);
  let inputs = 0;
  t.addEventListener('input', () => inputs++);
  document.body.append(t);
  return { t, inputs: () => inputs };
};
const focused = () => document.activeElement;

test('a browser without speech recognition: the button says so in plain words and is not shown as broken', async () => {
  delete globalThis.window.SpeechRecognition;
  delete globalThis.window.webkitSpeechRecognition;
  const { micButton, VOICE_WORDS } = await import('../../web/voice.js');
  const { t } = box();
  const m = micButton(t);
  assert.equal(m.el.dataset.state, 'unsupported');
  assert.equal(m.el.attrs['aria-label'], 'Voice typing');
  assert.equal(m.el.title, 'Voice typing is not available in this browser');
  assert.equal(m.note.textContent, '', 'no error before it is tapped');
  m.el.listeners.click();
  assert.equal(m.note.textContent, VOICE_WORDS.unsupported);
  assert.match(VOICE_WORDS.unsupported, /cannot turn speech into text.*Chrome, Edge and Safari can/);
});

test('a page over plain http (no secure context): the button says the https address is needed, never "allow it in the browser"', async () => {
  globalThis.window.webkitSpeechRecognition = StandIn;
  globalThis.window.isSecureContext = false;
  try {
    const { micButton, VOICE_WORDS } = await import('../../web/voice.js');
    const { t } = box();
    const m = micButton(t);
    assert.equal(m.el.dataset.state, 'insecure');
    const before = StandIn.all.length;
    m.el.listeners.click();
    assert.equal(StandIn.all.length, before, 'no recognition is started that the browser would refuse');
    assert.equal(m.note.textContent, VOICE_WORDS.insecure);
    assert.match(VOICE_WORDS.insecure, /https address \(or this computer itself\).*Settings → Security/);
  } finally {
    delete globalThis.window.isSecureContext;
  }
});

test('speaking: the words go into the box after what was typed, as they are heard; nothing is sent', async () => {
  globalThis.window.webkitSpeechRecognition = StandIn;
  const { micButton, VOICE_WORDS } = await import('../../web/voice.js');
  const { t, inputs } = box();
  t.value = 'In the shop project';
  const m = micButton(t);
  assert.equal(m.el.dataset.state, 'idle');
  assert.equal(m.el.attrs['aria-label'], 'Voice typing', 'one fixed name');
  assert.equal(m.el.attrs['aria-pressed'], 'false');
  m.el.listeners.click();
  const r = StandIn.last;
  assert.ok(r.on);
  assert.equal(r.interimResults, true);
  assert.equal(r.lang, 'hi-IN', 'the browser\'s own language, not the page\'s');
  assert.equal(m.el.dataset.state, 'listening');
  assert.equal(m.el.attrs['aria-label'], 'Voice typing', 'the name stays; the pressed state says it listens');
  assert.equal(m.el.attrs['aria-pressed'], 'true');
  assert.equal(m.note.textContent, VOICE_WORDS.listening);
  assert.equal(m.note.hidden, undefined, 'the status line stays on the page (empty when there is nothing to say)');
  r.hear([' fix the cart', false]);
  assert.equal(t.value, 'In the shop project fix the cart');
  r.hear([' fix the cart total', true], [' today', false]);
  assert.equal(t.value, 'In the shop project fix the cart total today');
  assert.equal(inputs(), 2, 'the box hears an input event (it grows, the draft is kept)');
  m.el.listeners.click(); // stop
  assert.equal(m.el.dataset.state, 'idle');
  assert.equal(m.note.textContent, '');
  assert.equal(t.value, 'In the shop project fix the cart total today', 'the words stay for him to send');
});

test('a send stops listening at once, with no error line: nothing heard later goes into the emptied box', async () => {
  const { micButton } = await import('../../web/voice.js');
  const { t } = box();
  const m = micButton(t);
  m.el.listeners.click();
  const r = StandIn.last;
  r.hear(['do the cart fix', true]);
  const late = r.onresult;
  m.stop();
  t.value = '';
  late?.({ results: [Object.assign([{ transcript: 'late words' }], { isFinal: true })] });
  assert.equal(t.value, '');
  assert.ok(r.aborted);
  assert.equal(m.el.dataset.state, 'idle');
  assert.equal(m.note.textContent, '', 'Chrome\'s "aborted" after our own stop is not "Voice typing stopped"');
});

test('the box is gone or hidden while it listens: the microphone stops and no word reaches the box', async () => {
  const { micButton } = await import('../../web/voice.js');
  // The page is left: its cleanup disposes the button.
  const a = box();
  const m = micButton(a.t);
  m.el.listeners.click();
  const r = StandIn.last;
  const late = r.onresult;
  m.dispose();
  assert.ok(r.aborted, 'the recognition is aborted');
  late?.({ results: [Object.assign([{ transcript: 'words in the room' }], { isFinal: true })] });
  assert.equal(a.t.value, '');
  // A box closed (hidden) or taken off the page without a word from its owner: the next result stops it, unwritten.
  for (const go of [(t) => (t.shown = false), (t) => t.remove()]) {
    const b = box();
    const n = micButton(b.t);
    n.el.listeners.click();
    const s = StandIn.last;
    go(b.t);
    s.hear(['words in the room', true]);
    assert.equal(b.t.value, '');
    assert.ok(s.aborted);
    assert.equal(n.el.dataset.state, 'idle');
  }
});

test('one box listens at a time: a start in another box stops the first one quietly', async () => {
  const { micButton } = await import('../../web/voice.js');
  const a = box();
  const b = box();
  const ma = micButton(a.t);
  const mb = micButton(b.t);
  ma.el.listeners.click();
  const ra = StandIn.last;
  mb.el.listeners.click();
  const rb = StandIn.last;
  assert.ok(ra.aborted && !ra.on, 'the first recognition is off');
  assert.ok(rb.on);
  assert.deepEqual([ma.el.dataset.state, mb.el.dataset.state], ['idle', 'listening']);
  assert.equal(ma.note.textContent, '', 'no error line in the first box');
  mb.stop();
});

test('words he types while it listens are kept: listening stops, and the next words heard do not write over them', async () => {
  const { micButton, VOICE_WORDS } = await import('../../web/voice.js');
  const { t } = box();
  t.value = 'In the shop project';
  const m = micButton(t);
  m.el.listeners.click();
  const r = StandIn.last;
  r.hear([' fix the cart', false]);
  t.value += ' (typed: today)';
  r.hear([' fix the cart total', true]);
  assert.equal(t.value, 'In the shop project fix the cart (typed: today)');
  assert.ok(r.aborted);
  assert.equal(m.el.dataset.state, 'idle');
  assert.equal(m.note.textContent, VOICE_WORDS.typed);
  m.stop(); // he sends what he typed
  assert.equal(m.note.textContent, '', 'that line is gone with the send');
});

test('the focus goes back to the box only after his own Stop, and not on a touch screen', async () => {
  const { micButton } = await import('../../web/voice.js');
  const { t } = box();
  const other = box().t;
  const m = micButton(t);
  const reset = () => other.focus();
  // A pause or an error ends it: no focus (on a phone that would open the keyboard).
  reset();
  m.el.listeners.click();
  StandIn.last.onerror({ error: 'no-speech' });
  StandIn.last.onend();
  assert.equal(focused(), other, 'not after an error');
  // His own Stop on a desktop: the box gets the focus, to go on typing.
  m.el.listeners.click();
  m.el.listeners.click();
  assert.equal(focused(), t);
  // His own Stop on a touch screen: no keyboard over the chat.
  coarse = true;
  reset();
  m.el.listeners.click();
  m.el.listeners.click();
  assert.equal(focused(), other);
  coarse = false;
});

test('the language is this device\'s setting; an error is said in plain words', async () => {
  const { micButton, voiceLang, VOICE_WORDS } = await import('../../web/voice.js');
  localStorage.setItem('pref:voice.lang', JSON.stringify('en-US'));
  assert.equal(voiceLang(), 'en-US');
  const { t } = box();
  const m = micButton(t);
  m.el.listeners.click();
  assert.equal(StandIn.last.lang, 'en-US');
  StandIn.last.onerror({ error: 'not-allowed' });
  assert.equal(m.note.textContent, VOICE_WORDS['not-allowed']);
  StandIn.last.onend();
  assert.equal(m.note.textContent, VOICE_WORDS['not-allowed'], 'the reason stays after it ended');
  localStorage.setItem('pref:voice.lang', JSON.stringify('xx-YY'));
  assert.equal(voiceLang(), 'auto', 'only the offered languages');
});

test('the setting says where the audio goes: not to Hoprig, but to the maker\'s service in Chrome and Edge', async () => {
  const { VOICE_PRIVACY } = await import('../../web/voice.js');
  assert.match(VOICE_PRIVACY, /Hoprig never gets the audio\. The browser turns it into text, and Chrome and Edge do that on their maker's service, so what you say goes there\./);
});

test('on a phone the microphone is a finger\'s size (44 px), as the Send button beside it', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 899px\) \{ \.btn\.icon\.voice-btn \{ width: 44px; min-height: 44px; \} \}/);
});
