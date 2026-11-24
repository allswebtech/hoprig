// How a message reads in Tia's conversation: his and hers told apart at a glance; her text drawn through the text-only
// Markdown path (mdtext.js: paragraphs, lists, small tables, code), never as HTML, and a link in it stays text (a page
// of the dashboard comes as an open card); a code block has Copy; a long answer is folded after about a screen's
// height with "Show more"; the time on the day's first message and on a tap.
import { icon } from './icons.js';
import { copyText, h, toast } from './lib.js';
import { mdView } from './mdtext.js';

// About a phone screen of text: a longer answer is folded (CSS max-height on .tia-msg.folded), "Show more" opens it.
export const FOLD_CHARS = 1400;
export const FOLD_LINES = 32;
export const isLong = (text) => String(text).length > FOLD_CHARS || String(text).split('\n').length > FOLD_LINES;

const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (t) => new Date(t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
const dayKey = (t) => new Date(t).toDateString();

/** Her text as nodes: Markdown as text, each code block with a Copy button. */
export function herText(text) {
  const md = mdView(text, { breaks: true, code: (code) => h('div.tia-codewrap', h('pre.md-code', code),
    h('button.btn.small.ghost.tia-copy', { type: 'button', 'aria-label': 'Copy this', onclick: async () => toast((await copyText(code)) ? 'Copied' : 'Select it and copy it by hand') }, icon('copy', { size: 15 }), h('span', 'Copy'))) });
  md.className = `${md.className} tia-md`;
  return md;
}

/**
 * One message. who: "owner" | "tia". `at`: its time. `day`: the time of the message before it (or null), so the day's
 * first message carries the day and the time; any other shows its time on a tap.
 */
export function messageView(who, text, { at = null, before = null } = {}) {
  const first = at && (!before || dayKey(before) !== dayKey(at));
  // The day's first time is centred over the day (class "day"); any other sits at its own message's side.
  const stamp = at ? h(`time.tia-time${first ? '.day' : ''}`, { datetime: new Date(at).toISOString(), hidden: !first }, first ? `${day(at)}, ${time(at)}` : time(at)) : null;
  const body = who === 'owner' ? h('div.tia-owntext', text) : herText(text);
  const long = who !== 'owner' && isLong(text);
  const moreLabel = h('span', 'Show more');
  const more = long ? h('button.btn.small.ghost.tia-more', { type: 'button', 'aria-expanded': 'false', onclick: (e) => {
    e.stopPropagation();
    const open = msg.classList.toggle('folded') === false;
    more.setAttribute('aria-expanded', String(open));
    moreLabel.textContent = open ? 'Show less' : 'Show more';
  } }, icon('down', { size: 15 }), moreLabel) : null;
  // A message is no Tab stop: a keyboard reaches the cards and the box without passing every message. A tap shows its
  // time; a screen reader hears who said it and when from the row's name.
  const msg = h(`div.tia-msg.${who === 'owner' ? 'owner' : 'tia'}${long ? '.folded' : ''}`, {
    onclick: (e) => {
      if (!stamp || first || e.target.closest('a, button, summary, pre, table')) return;
      stamp.hidden = !stamp.hidden;
    },
  }, body, more);
  // Long by its length is only a guess: on a wide screen the answer may fit its folded height whole. Measured once it is
  // drawn and again when its width changes; when nothing is hidden, the fade and "Show more" go (class "fits").
  if (long && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (!msg.classList.contains('folded')) return; // he opened it: left as it is
      msg.classList.toggle('fits', body.scrollHeight <= body.clientHeight + 2);
    }).observe(body);
  }
  const said = who === 'owner' ? 'You said' : 'Tia said';
  return h(`article.tia-row.${who === 'owner' ? 'owner' : 'tia'}`, { 'aria-label': at ? `${said} at ${time(at)}` : said }, stamp, msg);
}
