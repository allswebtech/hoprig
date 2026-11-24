// Voice typing: a microphone button beside a message box (Tia's box, the App's composer). It uses the browser's own
// speech recognition where the browser has one (SpeechRecognition, or webkitSpeechRecognition in Chrome, Edge and
// Safari). The words go into the box as they are heard, and the owner sends them himself: a spoken sentence is never
// sent by itself, so a word heard wrong is never an action. Where the browser has no recognition the button says so
// in plain words. Hoprig never gets the audio and keeps nothing of it (the browser turns speech into text; Chrome's
// own recognition does that on its maker's service). The language is a setting of this device (Settings → Appearance).
import { icon } from './icons.js';
import { add, fill, h, link, prefs } from './lib.js';
import { panel, savedMark } from './shell.js';

export const VOICE_LANGS = [['auto', 'The browser\'s own'], ['en-US', 'English'], ['hi-IN', 'Hindi']];
/** The language chosen on this device (a browser's code, or "auto": the browser's own). */
export const voiceLang = () => {
  const v = prefs.get('voice.lang', 'auto');
  return VOICE_LANGS.some(([k]) => k === v) ? v : 'auto';
};
const recognition = () => (typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)) || null;
// The browser lets a page use the microphone only at an https address or on this computer itself (a secure context): over
// plain http on a phone it refuses, and there is no setting he could change in the browser.
const secure = () => typeof window === 'undefined' || window.isSecureContext !== false;
const touch = () => typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || matchMedia('(any-pointer: coarse)').matches);

// What the owner reads when something is in the way, by the recognition's own error codes.
export const VOICE_WORDS = {
  unsupported: 'This browser cannot turn speech into text. Chrome, Edge and Safari can; type here instead.',
  insecure: 'Voice typing needs the dashboard\'s https address (or this computer itself): over plain http the browser does not allow the microphone. Settings → Security sets up https.',
  listening: 'Listening… Your words go into the box, and you send them.',
  typed: 'Stopped listening while you type. Tap the microphone to go on.',
  'not-allowed': 'The microphone is not allowed for this page. Allow it in the browser (the icon next to the address), then tap the microphone again.',
  'service-not-allowed': 'The browser does not let this page use its speech service. Allow the microphone for this page, then tap the microphone again.',
  'no-speech': 'Nothing was heard. Tap the microphone and speak.',
  'audio-capture': 'No microphone was found on this device.',
  network: 'The browser\'s speech service could not be reached. Try again, or type.',
  'language-not-supported': 'The browser cannot hear this language. Choose another one in Settings → Appearance.',
  other: 'Voice typing stopped. Tap the microphone to try again.',
};
// The lines that name a settings page: a link under them opens it (Appearance at the voice typing panel itself).
export const VOICE_PLACE = Object.freeze({
  insecure: ['#/settings/security', 'Open Security'],
  'language-not-supported': ['#/settings/appearance?show=voice-typing', 'Open Appearance'],
});
// Where the audio goes, said plainly under the setting: not to Hoprig, but Chrome and Edge recognise on a server.
export const VOICE_PRIVACY = 'Your words appear in the box and you send them. Hoprig never gets the audio. The browser turns it into text, and Chrome and Edge do that on their maker\'s service, so what you say goes there.';
const LABEL = 'Voice typing';
const TITLE = { idle: 'Speak instead of typing', listening: 'Stop listening', unsupported: 'Voice typing is not available in this browser', insecure: 'Voice typing needs the https address' };

// One box listens at a time on a page (Tia's box beside the App's composer): a start stops the other one quietly. A page
// that is hidden or left stops listening too, so the microphone is never open for a box he cannot see.
let active = null;
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && active && active.stop());
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', () => active && active.stop());

/**
 * A microphone button for `input` (a textarea). Words are written into it as an "input" event would (the box grows,
 * a draft is kept), never sent. `noted()`: the line under it changed (its owner may keep something in sight).
 * → { el (the button), note (one line under it), stop() (a send, a box closed: quietly, nothing heard later is written),
 * dispose() (the box is gone for good) }.
 */
export function micButton(input, { noted = () => {} } = {}) {
  const R = recognition();
  // The line is always there and empty when there is nothing to say (CSS hides it then): a live region that appears
  // together with its text is often not read out.
  const note = h('p.voice-note', { role: 'status' });
  note.textContent = '';
  const el = h('button.btn.icon.ghost.voice-btn', { type: 'button', 'aria-label': LABEL });
  let rec = null;
  let base = ''; // what stood in the box when listening began: the words follow it
  let wrote = null; // what this button last wrote: anything else in the box now, he typed
  let byHand = false; // he pressed Stop himself: the box gets the focus back
  let state = !R ? 'unsupported' : !secure() ? 'insecure' : 'idle';
  const say = (text) => {
    note.textContent = text || '';
    const place = Object.entries(VOICE_PLACE).find(([k]) => text && VOICE_WORDS[k] === text);
    if (place) add(note, ' ', h('a', { href: link(place[1][0]) }, place[1][1]));
    noted();
  };
  const paint = () => {
    el.dataset.state = state;
    el.title = TITLE[state];
    // One fixed name with its pressed state: "Voice typing, toggle button, pressed" while it listens.
    el.setAttribute('aria-pressed', String(state === 'listening'));
    fill(el, icon(state === 'unsupported' || state === 'insecure' ? 'micOff' : 'mic', { size: 18 }));
  };
  /** Let a recognition go: none of its later events reach this box. */
  const loose = (r) => {
    r.onresult = null;
    r.onerror = null;
    r.onend = null;
    try {
      r.abort();
    } catch {
      /* ended already */
    }
  };
  const self = {
    el,
    note,
    /** Stop listening at once, without an error line: nothing heard later goes into the box. */
    stop(words = '') {
      if (!rec) {
        if (!words && note.textContent === VOICE_WORDS.typed) say(''); // a send: that line is old now
        return;
      }
      loose(rec);
      rec = null;
      state = 'idle';
      if (active === self) active = null;
      say(words);
      paint();
    },
    /** The box is gone (its page left, the panel closed for good). */
    dispose() {
      self.stop();
    },
  };
  function start() {
    if (active && active !== self) active.stop();
    say('');
    try {
      rec = new R();
      const lang = voiceLang();
      // "The browser's own": the browser's language, not the page's (an unset language falls back to <html lang>).
      const own = typeof navigator !== 'undefined' && navigator.language;
      if (lang !== 'auto') rec.lang = lang;
      else if (own) rec.lang = own;
      rec.interimResults = true;
      rec.continuous = true;
    } catch {
      rec = null;
      return say(VOICE_WORDS.other);
    }
    base = input.value && !/\s$/.test(input.value) ? `${input.value} ` : input.value;
    wrote = input.value;
    byHand = false;
    const r = rec;
    r.onresult = (e) => {
      if (rec !== r) return; // let go already (a stop, another box): its words are not this box's any more
      // A box he cannot see any more (its page left, the box closed): nothing goes in, and the microphone goes off.
      if (input.isConnected === false || (typeof input.getClientRects === 'function' && !input.getClientRects().length)) return self.stop();
      // He typed while it listened: his words are kept, and listening stops (a heard word never writes over them).
      if (input.value !== wrote) return self.stop(VOICE_WORDS.typed);
      // Every result of this listening, the final ones and the one still being heard: the box shows them all.
      let words = '';
      for (let i = 0; i < e.results.length; i++) words += e.results[i][0].transcript;
      input.value = base + words.replace(/^\s+/, '');
      wrote = input.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    // "aborted" is a stop this page made (a send, a box closed): not an error to show.
    r.onerror = (e) => (e && e.error === 'aborted' ? null : say(VOICE_WORDS[e && e.error] || VOICE_WORDS.other));
    r.onend = () => {
      if (rec !== r) return;
      rec = null;
      state = 'idle';
      if (active === self) active = null;
      if (note.textContent === VOICE_WORDS.listening) say('');
      paint();
      // Only after his own Stop, in a box he sees, and not on a touch screen (the keyboard would cover the chat).
      if (byHand && input.isConnected !== false && !touch()) input.focus();
      byHand = false;
    };
    try {
      r.start();
      state = 'listening';
      active = self;
      say(VOICE_WORDS.listening);
    } catch {
      rec = null;
      say(VOICE_WORDS.other);
    }
    paint();
  }
  el.addEventListener('click', () => {
    if (state === 'unsupported' || state === 'insecure') return say(VOICE_WORDS[state]);
    if (state === 'listening') {
      byHand = true;
      return rec && rec.stop();
    }
    start();
  });
  paint();
  return self;
}

/** Settings → Appearance: the language voice typing listens for, on this device. */
export function voicePanel() {
  const mark = savedMark();
  const el = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Voice typing language' });
  const paint = () => fill(el, VOICE_LANGS.map(([v, label]) => h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(voiceLang() === v), onclick: (e) => {
    e.preventDefault();
    prefs.set('voice.lang', v);
    paint();
    mark.show();
  } }, h('span', label))));
  paint();
  return panel({ id: 'voice-typing', icon: 'mic', title: 'Voice typing', desc: 'The microphone in Tia\'s box and in the App\'s message box. Saved on this device only.' },
    h('div.fieldrow', h('span.field-label', 'Language', mark), el,
      h('span.hint', recognition() ? VOICE_PRIVACY : 'This browser cannot turn speech into text: the microphone says so. Chrome, Edge and Safari can.')));
}
