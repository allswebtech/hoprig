// The living line: the last thing in the conversation while a turn runs (as Claude Code's spinner line sits right above
// its prompt). A small turning mark, what Claude does now (Thinking, Running: npm test, Writing), the seconds of the
// turn, and on a screen with a mouse "Esc to stop". It is where the eye is; there is no status line under the box any
// more (the branch is in the rail, the context in the ring). While an OK, a question or a plan waits there is no line:
// that card is the status. Only the words are read out by a screen reader, once per step; the seconds are not.
import { fill, h } from '../lib.js';
import { icon } from '../icons.js';
import { liveWords, took, touchScreen } from './words.js';

/**
 * o: { runs(toolId) (false for a call that waits, was refused or runs in the background) }
 * → { el, paint(v, { since }) → whether the line is shown, stop() }: while it shows, its seconds count up once a second.
 */
export function createLiveLine(o = {}) {
  const word = h('span.chat-live-word', { role: 'status', 'aria-live': 'polite' });
  const detail = h('span.chat-live-detail');
  const time = h('span.chat-live-time', { 'aria-hidden': 'true' });
  const esc = h('span.chat-live-esc', { 'aria-hidden': 'true' }, 'Esc to stop');
  const el = h('div.chat-live.hidden', h('span.chat-live-mark', { 'aria-hidden': 'true' }, icon('sparkle', { size: 14 })), h('span.chat-live-text', word, detail), time, esc);
  let since = null;
  let tick = null;
  const seconds = () => fill(time, since === null ? '' : `· ${took(Math.max(0, Date.now() - since))}`);
  return {
    el,
    paint(v, opts = {}) {
      const w = liveWords(v, { runs: o.runs });
      const shown = !!w;
      el.classList.toggle('hidden', !shown);
      clearInterval(tick);
      tick = null;
      if (!shown) {
        delete el.dataset.step;
        return false;
      }
      since = Number.isFinite(opts.since) ? opts.since : Date.now();
      el.dataset.step = w.step;
      fill(word, w.word);
      fill(detail, w.detail ? [': ', h('code.chat-live-cmd', w.detail)] : '');
      esc.classList.toggle('hidden', touchScreen());
      seconds();
      tick = setInterval(seconds, 1000);
      if (tick && typeof tick.unref === 'function') tick.unref();
      return true;
    },
    stop: () => clearInterval(tick),
  };
}
