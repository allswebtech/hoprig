// Her answer aloud (web/voice.js `speech`), without a browser: the browser's own speech is a stand-in. A voice the
// browser marks as local is the default and an online one only when allowed; reading aloud can be switched off; stop
// ends the speech at once (the stop square on the microphone, a touch of the box, starting to talk, a new message); the
// two lines of the voice typing panel.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeElement, byClass, texts } from '../chat/fakedom.mjs';

const kept = new Map();
globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, x) => kept.set(k, String(x)) };
globalThis.Event ||= class {
  constructor(type, o = {}) {
    Object.assign(this, { type, ...o });
  }
};
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true });
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });

const voices = [
  { name: 'online-en', lang: 'en-US', localService: false },
  { name: 'local-hi', lang: 'hi-IN', localService: true },
  { name: 'local-en', lang: 'en-GB', localService: true },
];
const log = { spoken: [], cancels: 0 };
globalThis.window.speechSynthesis = {
  getVoices: () => voices,
  speak: (u) => log.spoken.push(u),
  cancel() {
    log.cancels++;
  },
};
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) {
    this.text = text;
  }
};
class StandIn {
  static all = [];
  constructor() {
    StandIn.all.push(this);
  }
  start() {}
  abort() {
    this.onend?.();
  }
}
globalThis.window.webkitSpeechRecognition = StandIn;
const V = await import('../../web/voice.js');
const { prefs } = await import('../../web/lib.js');
const { speech } = V;
const reset = () => {
  speech.stop();
  log.spoken.length = 0;
  log.cancels = 0;
  kept.clear();
};

test('she speaks with a voice marked local, in the device language; an online voice only when allowed', () => {
  reset();
  assert.equal(speech.speak('The shop is fine.'), true);
  assert.equal(log.spoken.at(-1).voice.name, 'local-en', 'local, same language, though an online English voice exists');
  assert.equal(log.spoken.at(-1).text, 'The shop is fine.');
  reset();
  voices.splice(2, 1); // no local English voice left
  try {
    assert.equal(speech.speak('Hello.'), false, 'an online voice is not used by default: she is not heard rather than sent out');
    assert.equal(log.spoken.length, 0);
    prefs.set(V.ONLINE_VOICES, true);
    assert.equal(speech.speak('Hello.'), true);
    assert.equal(log.spoken.at(-1).voice.name, 'online-en');
  } finally {
    voices.push({ name: 'local-en', lang: 'en-GB', localService: true });
  }
});

test('reading aloud can be switched off, and an empty answer is not spoken', () => {
  reset();
  prefs.set(V.READ_ALOUD, false);
  assert.equal(speech.speak('Hello.'), false);
  assert.equal(speech.available(), false);
  prefs.set(V.READ_ALOUD, true);
  assert.equal(speech.speak('   '), false);
  assert.equal(log.spoken.length, 0);
});

test('stop ends the speech at once, and the old speech ending later changes nothing', () => {
  reset();
  speech.speak('One long answer.');
  const first = log.spoken.at(-1);
  assert.equal(speech.speaking(), true);
  speech.stop();
  assert.equal(speech.speaking(), false);
  assert.ok(log.cancels >= 1, 'the browser was told to cancel');
  speech.speak('Another.');
  first.onend(); // the browser reports the first one ended after the second began
  assert.equal(speech.speaking(), true, 'the second goes on');
  log.spoken.at(-1).onend();
  assert.equal(speech.speaking(), false);
});

test('while she speaks the microphone is a stop square: a tap stops her and starts nothing; touching the box stops her', () => {
  reset();
  const t = new FakeElement('textarea');
  t.value = '';
  t.getClientRects = () => [{}];
  document.body.append(t);
  let states = 0;
  const m = V.micButton(t, { speaks: true, onState: () => states++ });
  const before = StandIn.all.length;
  assert.equal(m.state(), 'idle');
  speech.speak('Here is the answer.');
  assert.equal(m.state(), 'speaking');
  assert.equal(m.el.dataset.state, 'speaking');
  assert.equal(m.el.title, 'Stop speaking');
  assert.equal(m.el.children[0].attrs.fill, 'currentColor', 'the filled stop square, not the microphone');
  m.el.listeners.click();
  assert.equal(speech.speaking(), false);
  assert.equal(StandIn.all.length, before, 'the tap that stops her does not start listening');
  assert.equal(m.el.dataset.state, 'idle');
  assert.equal(m.el.children[0].attrs.fill, 'none');
  speech.speak('Again.');
  t.listeners.pointerdown({});
  assert.equal(speech.speaking(), false, 'a touch of the box');
  speech.speak('Again.');
  m.el.listeners.click(); // stop
  m.el.listeners.click(); // now it listens, and nothing she says is left running
  speech.speak('Once more.');
  m.stop();
  assert.ok(states > 3);
  m.dispose();
});

test('the App box leaves her speech alone', () => {
  reset();
  const t = new FakeElement('textarea');
  t.value = '';
  t.getClientRects = () => [{}];
  document.body.append(t);
  const m = V.micButton(t, { speaks: true });
  speech.speak('A long answer.');
  speech.stop(); // the stop square
  speech.speak('A long answer.');
  // A box that is not Tia's (no `speaks`) neither shows the stop square nor stops her.
  const other = V.micButton(t);
  assert.equal(other.state(), 'idle');
  other.el.listeners.click();
  assert.equal(speech.speaking(), true, 'the App box leaves her alone');
  m.dispose();
});

test('the voice typing panel has the two new lines, the answers aloud on and online voices off', () => {
  reset();
  const panel = V.voicePanel();
  const words = texts(panel).join(' ');
  assert.match(words, /Read Tia's answers aloud/);
  assert.match(words, /Allow online voices/);
  const [read, online] = byClass(panel, 'switch');
  assert.ok('checked' in read.attrs, 'on');
  assert.ok(!('checked' in online.attrs), 'off');
  read.listeners.change({ target: { checked: false } });
  assert.equal(prefs.get(V.READ_ALOUD, true), false);
  online.listeners.change({ target: { checked: true } });
  assert.equal(prefs.get(V.ONLINE_VOICES, false), true);
});
