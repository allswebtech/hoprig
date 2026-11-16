// The chat's keyboard, as in Claude Code: Enter sends and Shift+Enter makes a new line (composer.js), Escape stops
// Claude, Shift+Tab goes to the next permission mode, Up in an empty box brings back the last message, "/" and "@"
// open the menus (popovers.js), a number answers the newest card, "?" shows the list below.
import { h, openSheet } from '../lib.js';


const typing = (el) => !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export const SHORTCUTS = [
  ['Enter', 'Send the message (while Claude works: queue it); on a touch screen a new line (the Send button sends)'],
  ['Shift+Enter', 'A new line'],
  ['Esc', 'Stop Claude (the turn ends; background tasks go on), or close a menu'],
  ['Shift+Tab', 'The next permission mode'],
  ['↑ in an empty box', 'Your last message again (↑ and ↓ go through the earlier ones)'],
  ['/', 'Commands at the start of the box: compact, clear, model, skills …'],
  ['@', 'A file of this folder, for Claude to read'],
  ['1 … 9', 'Answer the newest card that waits for you (also from an empty message box)'],
  ['?', 'This list (when the box does not have the keys)'],
];

export function shortcutsSheet() {
  return openSheet({ title: 'Keyboard shortcuts', subtitle: 'In the chat, as in Claude Code.' }, () => [
    h('dl.chat-keys', SHORTCUTS.flatMap(([k, what]) => [h('dt', k.split(' ').map((w, n) => (n === 0 || /^[↑↓/@?]$|^\d|^Esc$|^Shift\+/.test(w) ? h('kbd', w) : ` ${w}`))), h('dd', what)])),
  ]);
}

/**
 * The page's own keys (the box handles its own in composer.js). o: { working(), stop(), nextMode(), openAsk(), box (the
 * message box: while it is empty a number answers the open card, as in Claude Code) } → remove()
 */
export function installKeys(o) {
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return; // a sheet has the keys
    if (e.key === 'Escape' && o.working()) {
      e.preventDefault();
      o.stop();
      return;
    }
    const el = document.activeElement;
    // The box keeps the focus after a message: a number typed into it while it is empty answers the open card.
    if (/^[1-9]$/.test(e.key) && el === o.box && !el.value && !e.isComposing) {
      const card = o.openAsk();
      if (card && card.keys(Number(e.key))) e.preventDefault();
      return;
    }
    if (typing(el)) return;
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      o.nextMode();
    } else if (e.key === '?') {
      e.preventDefault();
      shortcutsSheet();
    } else if (/^[1-9]$/.test(e.key)) {
      const card = o.openAsk();
      if (card && card.keys(Number(e.key))) e.preventDefault();
    }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

/**
 * The messages sent from this chat, for Up and Down in the box: the newest last, at most 50, kept per chat.
 * store: { get(), set(list) } → { push(text), up(current), down(current) } (up/down give the text to show, or null).
 */
export function recall(store) {
  let list = store.get() || [];
  let at = -1; // the entry shown (from the newest back), -1: none
  return {
    push(text) {
      list = [...list.filter((x) => x !== text), text].slice(-50);
      store.set(list);
      at = -1;
    },
    /** Up: the box is empty or still shows an entry unchanged. */
    up(current) {
      if (current && current !== list[list.length - 1 - at]) return null;
      if (at + 1 >= list.length) return null;
      at += 1;
      return list[list.length - 1 - at];
    },
    down(current) {
      if (at < 0 || current !== list[list.length - 1 - at]) return null;
      at -= 1;
      return at < 0 ? '' : list[list.length - 1 - at];
    },
    reset() {
      at = -1;
    },
  };
}
