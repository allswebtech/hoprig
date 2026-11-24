// The chat's keyboard, as in Claude Code: Enter sends and Shift+Enter makes a new line (composer.js), Escape stops
// Claude, Shift+Tab goes to the next permission mode (the terminal's key), Up in an empty box brings back the last
// message, "/" and "@" open the menus (popovers.js), a number answers the newest card (in an open menu it picks:
// menu.js), Escape twice in an empty box opens rewind, with words in it clears them into the Up history (the terminal's key). The desktop app's keys open the shortcut
// sheet (Cmd/Ctrl+/, and "?"), the mode, model and effort menus, the transcript views and the diff pane, wherever the
// browser leaves the key to the page; a key the browser keeps for itself (Chrome's published list of its shortcuts)
// gets the nearest one it leaves alone, and the sheet says why in one line.
import { h, openSheet } from '../lib.js';

const typing = (el) => !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
/** A Mac (Cmd), else Ctrl. Asked each time: a test sets the platform. */
export const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const ESC_TWICE_MS = 700;

/**
 * The desktop app's keys and where the page has them. Each: { id, keys (as the sheet writes them), mod, letter (a
 * KeyboardEvent code's letter) or slash, what, why (only where the browser keeps the desktop's key) }. mod: which
 * modifiers, exactly: 'cmd' (Cmd on a Mac, Ctrl elsewhere), 'cmd-shift', 'ctrl' (the Control key everywhere),
 * 'ctrl-shift', 'ctrl-alt'.
 */
export function desktopKeys(mac = isMac()) {
  const C = mac ? 'Cmd' : 'Ctrl';
  // The nearest key the browser leaves alone: on a Mac the Control key for Cmd (Chrome has no Control+letter key
  // there); elsewhere Alt for Shift (Chrome has no Ctrl+Alt key).
  // The reason names the desktop app's key itself, and on Windows and Linux its Mac form too (the docs write that one).
  const near = (L, keeps) => (mac
    ? { keys: `Ctrl+Shift+${L}`, mod: 'ctrl-shift', why: `The desktop app's Cmd+Shift+${L}; the browser keeps it for ${keeps}.` }
    : { keys: `Ctrl+Alt+${L}`, mod: 'ctrl-alt', why: `The desktop app's Ctrl+Shift+${L} (Cmd+Shift+${L} on a Mac); the browser keeps it for ${keeps}.` });
  return [
    { id: 'shortcuts', keys: `${C}+/`, mod: 'cmd', slash: true, what: 'These shortcuts (? too, outside the box)' },
    { id: 'mode', letter: 'M', what: 'The permission mode menu', ...near('M', mac ? 'switching browser users and payment info' : 'switching browser users') },
    { id: 'model', letter: 'I', what: 'The model menu', ...near('I', mac ? 'mailing a link to the page' : 'its developer tools') },
    { id: 'effort', letter: 'E', keys: `${C}+Shift+E`, mod: 'cmd-shift', what: 'The effort menu (the model menu at its Effort section)' },
    mac ? { id: 'view', letter: 'O', keys: 'Ctrl+O', mod: 'ctrl', what: 'The next transcript view (Normal, Thinking, Verbose)' }
      : { id: 'view', letter: 'O', keys: 'Ctrl+Alt+O', mod: 'ctrl-alt', what: 'The next transcript view (Normal, Thinking, Verbose)', why: 'The desktop app\'s Ctrl+O; the browser keeps it for opening a file.' },
    { id: 'diff', letter: 'D', what: 'Open or close the diff pane', ...near('D', 'bookmarking every tab') },
  ];
}

/** Whether event `e` is key `k` of desktopKeys(): exactly its modifiers, its letter by place (Shift and layouts). */
export function isKey(e, k) {
  const cmd = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const mods = {
    cmd: cmd && !e.altKey && (k.slash || !e.shiftKey),
    'cmd-shift': cmd && e.shiftKey && !e.altKey,
    ctrl: e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey,
    'ctrl-shift': e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey,
    // AltGr is Ctrl+Alt too: a letter it types (€, ę) is a letter, not this key.
    'ctrl-alt': e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && String(e.key).toLowerCase() === String(k.letter).toLowerCase(),
  }[k.mod];
  if (!mods) return false;
  return k.slash ? e.key === '/' || e.code === 'Slash' : e.code === `Key${k.letter}`;
}

/** The sheet's rows: [keys, what, why?]. Keys read Cmd on a Mac, Ctrl elsewhere. */
export function shortcuts(mac = isMac()) {
  const K = Object.fromEntries(desktopKeys(mac).map((k) => [k.id, k]));
  const row = (id) => [K[id].keys, K[id].what, K[id].why];
  return [
    ['Enter', 'Send the message (also while Claude works: it reads it after its current step); on a touch screen a new line (the Send button sends)'],
    ['Shift+Enter', 'A new line'],
    ['Esc', 'Stop Claude (the turn ends; background tasks go on) or a running ! command; in an open menu: close it'],
    ['Esc Esc', 'In an empty box: rewind to before one of your messages. With words in the box: clear them (Up brings them back)'],
    row('shortcuts'),
    row('mode'),
    row('model'),
    row('effort'),
    row('view'),
    row('diff'),
    ['1 … 9', 'In an open menu: pick its item. Else: answer the newest card that waits for you (also from an empty box)'],
    ['↑ ↓', 'In an open menu: move. In an empty box: your earlier messages'],
    ['Shift+Tab', 'The next permission mode (as in the terminal)'],
    ['/', 'Commands at the start of the box: compact, clear, model, skills …'],
    ['@', 'A file of this folder, for the coding tool to read'],
    ['! at the start', 'A shell command in the session\'s folder; its output goes with your next message'],
  ];
}
/** The table as the sheet shows it (the platform it runs on). */
export const SHORTCUTS = shortcuts();

const keyCell = (k) => k.split(' ').map((w, n) => (n === 0 || /^[↑↓/@?]$|^\d|^Esc$|^…$|^Shift\+|^Ctrl\+|^Cmd\+/.test(w) ? h('kbd', w) : ` ${w}`));
const keyRows = (list) => list.flatMap(([k, what, why]) => [h('dt', keyCell(k)), h('dd', what, why ? h('span.chat-keys-why', why) : null)]);

export function shortcutsSheet() {
  return openSheet({ title: 'Keyboard shortcuts', subtitle: 'In the App, as in the Claude Code desktop app. Where the browser keeps one of its keys, the nearest free key does it, and the line under it says why.' }, () => [
    h('dl.chat-keys', keyRows(shortcuts())),
  ]);
}

/**
 * /help, as Claude Code's: help and the commands. own: the page's own ([{ name, hint?, description }]); tool: a promise
 * of the coding tool's (popovers.js commands()). The commands come by name, the keys under them.
 */
export async function helpSheet(own, tool) {
  let theirs = [];
  try {
    theirs = (await tool) || [];
  } catch {
    /* the page's own and the keys still help */
  }
  const names = new Set(own.map((c) => c.name));
  const all = [...own, ...theirs.filter((c) => !names.has(c.name))].sort((a, b) => a.name.localeCompare(b.name));
  return openSheet({ title: 'Help', subtitle: 'Type / at the start of the box for a command, @ for a file, ! for a shell command.' }, () => [
    h('h3.chat-help-h', 'Commands'),
    h('dl.chat-keys.chat-help-cmds', all.flatMap((c) => [h('dt', h('code', `/${c.name}`), c.hint ? ` ${c.hint}` : ''), h('dd', c.description || (c.skill ? 'A skill' : ''))])),
    h('h3.chat-help-h', 'Keyboard shortcuts'),
    h('dl.chat-keys', keyRows(shortcuts())),
  ]);
}

/**
 * The page's own keys (the box handles its own in composer.js). o: { working(), stop(), stopShell() (a "!" command
 * runs: it is stopped → true), nextMode(), openAsk(), box (the message box: while it is empty a number answers the
 * open card, as in Claude Code), menu(id) (the desktop keys' menus: 'mode', 'model', 'effort'), view() (the next
 * transcript view), diff() (open or close the diff pane), rewind(), clearDraft() (Esc Esc with words in the box) } → remove(). While a composer menu is open
 * (menu.js) its own keys take every plain key first; a sheet (a dialog) has the keys to itself.
 */
export function installKeys(o) {
  let escAt = 0; // the last Escape in an empty box with nothing to stop: a second one soon after opens rewind
  const onKey = (e) => {
    if (document.querySelector('dialog[open]')) return; // a sheet has the keys
    if (e.defaultPrevented) return; // a part of the page took the key already (the diff pane's Esc closes the pane)
    const k = desktopKeys().find((x) => isKey(e, x));
    if (k) {
      e.preventDefault();
      if (k.id === 'shortcuts') shortcutsSheet();
      else if (k.id === 'view') o.view && o.view();
      else if (k.id === 'diff') o.diff && o.diff();
      else o.menu && o.menu(k.id);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return; // the browser's own keys
    const el = document.activeElement;
    if (e.key === 'Escape' && o.stopShell && o.stopShell()) {
      e.preventDefault(); // a "!" command runs: Esc stops it first, as its Stop button does
      return;
    }
    if (e.key === 'Escape' && o.working()) {
      e.preventDefault();
      o.stop();
      escAt = 0;
      return;
    }
    // Escape twice in the box, as in the terminal: in an empty box rewind; with words in it they are cleared and kept
    // in the box's history, so Up brings them back.
    if (e.key === 'Escape' && el === o.box && (el.value ? o.clearDraft : o.rewind)) {
      const now = Date.now();
      if (now - escAt < ESC_TWICE_MS) {
        escAt = 0;
        e.preventDefault();
        if (el.value) o.clearDraft();
        else o.rewind();
      } else escAt = now;
      return;
    }
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
