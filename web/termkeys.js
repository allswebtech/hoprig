// What a key sends in a session's terminal, where the page decides it instead of the terminal library (xterm.js).
// Plain functions and lists, nothing touches the page when this file loads: session.js uses them, and a test
// imports them directly.

/** A line feed, the byte Ctrl+J sends. Claude Code reads it as a new line in the message, not as Enter. */
export const NEW_LINE = '\n';

/**
 * The page's own answer to key event `e` in the terminal: the text to send (and the key is stopped, so the terminal
 * library sends nothing for it), '' (stopped, nothing sent), or null (the terminal library handles the key).
 * Shift+Enter: xterm.js sends a carriage return for it, the same as Enter, so Claude Code would send the message.
 * A real terminal that Claude Code supports sends a new line instead; the page sends the line feed. Never while an
 * input method is composing (the Enter then ends the composition) and not with Ctrl, Alt or Meta (other chords).
 */
export function termKey(e) {
  if (e.key !== 'Enter' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return null;
  if (e.type === 'keydown') return NEW_LINE;
  if (e.type === 'keypress') return ''; // the same key's keypress must not add an Enter after the new line
  return null;
}

/**
 * Ctrl+V (and Ctrl+Shift+V, a terminal's paste on Linux) is the paste key here, as Cmd+V is on a Mac: the terminal
 * library would send the byte of Ctrl+V and the browser would not paste, so a picture in the clipboard of the
 * computer with the browser never arrived. The page lets the browser paste instead (a file or a picture is sent and
 * its path typed; text is pasted); a paste that carries nothing still sends that byte (CTRL_V).
 * On a Mac the browser does not paste on Ctrl+V: session.js reads the clipboard's picture itself there (termdrop.js
 * clipboardPictures), and without one sends that byte.
 */
export const pasteKey = (e) => e.type === 'keydown' && e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'v' || e.key === 'V');
export const CTRL_V = '\x16';

/**
 * The key bar: keys a phone lacks, as [label, what it sends, title]. Arrows are named: their bytes depend on the program's
 * mode. Ctrl sends nothing itself (null): it holds Ctrl for the next key (stickyCtrl).
 */
export const KEY_BAR = [
  ['Esc', '\x1b', 'Escape'], ['Tab', '\t', 'Tab'], ['⇧Tab', '\x1b[Z', 'Shift+Tab: switch mode'],
  ['Ctrl', null, 'Ctrl, then a key: Ctrl+R, Ctrl+O, and Ctrl+T, Ctrl+W, Ctrl+N, which the browser keeps for itself'], ['Ctrl C', '\x03', 'Ctrl+C'],
  ['/', '/', 'Slash'], ['Enter', '\r', 'Enter'], ['New line', NEW_LINE, 'New line (Shift+Enter)'],
  ['←', 'left', 'Left'], ['↑', 'up', 'Up'], ['↓', 'down', 'Down'], ['→', 'right', 'Right'],
];

/**
 * Where a key-bar key goes: 'box' when the message box has the focus and the key is New line (the line break belongs
 * in the message being written there), else 'terminal'. The key bar keeps the focus where it was, so a phone user
 * writing in the box tapped New line and the line feed went into the program's own prompt instead.
 */
export function keyBarTarget(seq, boxHasFocus) {
  return boxHasFocus && seq === NEW_LINE ? 'box' : 'terminal';
}

/**
 * The page's title while a session is shown: its name, and the program's own title when it set one (a plain terminal
 * shows that in its tab; Claude Code names its task there). Control characters go, the length is capped.
 */
export function pageTitle(name, title) {
  const t = String(title || '').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 80);
  return t && t !== name ? `${name} · ${t}` : name;
}

/**
 * The plain lines of the session's "Keys and images" help: what a title tooltip said before, which a touch screen
 * never shows.
 */
export const KEY_HELP = [
  'Ctrl+T, Ctrl+W and Ctrl+N are kept by the browser. Turn on Keys, tap Ctrl, then the letter.',
  'Esc, Tab, Shift+Tab, the arrows and New line are on the key bar too.',
  'An image: paste it with Ctrl+V or drop it on the terminal, and its path is typed there (on a touch screen: File on the key bar). The paperclip puts it into your message instead.',
];

/**
 * Terminal input as socket frames: the server takes a frame of at most 64 KiB (src/server/terminal.mjs), and a paste of
 * a megabyte was one frame, so it was lost. 8192 characters stay under it even when every one is escaped in JSON (6
 * bytes). A frame never ends between the two halves of an emoji: a half alone arrives as a broken character.
 */
export function inputFrames(d, max = 8192) {
  const out = [];
  for (let i = 0; i < d.length;) {
    let end = Math.min(i + max, d.length);
    if (end < d.length && /[\ud800-\udbff]/.test(d[end - 1])) end--;
    out.push(d.slice(i, end));
    i = end;
  }
  return out;
}

/**
 * Terminal input as socket messages, in frames (inputFrames). A bracketed paste is flagged (`paste: true`): xterm.js
 * wraps a paste in its marks itself, in one piece, when the program asked for bracketed paste, and the server holds
 * only flagged frames until the end mark. Clipboard text that holds a start mark of its own, pasted into a program
 * that did not ask (copied terminal output, a hostile page), is sent as keys: held, it waited for an end mark that
 * never came, and every key after it was lost.
 */
export function inputMessages(d) {
  const paste = d.length >= 12 && d.startsWith('\x1b[200~') && d.endsWith('\x1b[201~');
  return inputFrames(d).map((part) => (paste ? { t: 'in', d: part, paste: true } : { t: 'in', d: part }));
}

/**
 * Terminal input in the order it was typed. While the history view is open (tmux copy mode) a key first closes it,
 * and that takes a request: a key typed meanwhile went straight on, tmux took it as a copy-mode command, and the first
 * key came last. Every send now waits for the one before and for `ready()` (the view closed), run when its turn comes.
 */
export function inOrder(ready) {
  let chain = Promise.resolve();
  return (send) => (chain = chain.then(() => ready()).catch(() => {}).then(send).catch(() => {}));
}

/**
 * How long the page waits before it connects the terminal again, or null: it stops. `state` ({ retry, quick }) is the
 * page's, `code` the socket's close code, `lived` how long it was open (0: it never opened). The wait doubles from
 * 500 ms up to 10 s and starts again only after a socket that lived a while: one that opened and was closed at once
 * reset it, and an attach that tmux ends as soon as it starts (4001, "detached", while the session runs) made the
 * page connect twice a second for ever. After a few of those in a row the page stops and says so.
 */
export const QUICK_MS = 2000;
export const QUICK_TRIES = 5;
export function reconnectWait(state, { code, lived }) {
  if (lived >= QUICK_MS) Object.assign(state, { retry: 0, quick: 0 });
  else if (code === 4001) state.quick++;
  if (state.quick >= QUICK_TRIES) return null;
  return Math.min(10_000, 500 * 2 ** state.retry++);
}

/**
 * Whether the page may open the terminal's socket again: not while the one it has is still connecting or open. Two
 * quick clicks on "Try again" opened two; the first stayed attached after the page was left, and every screen update
 * was written twice. (0 and 1 are WebSocket.CONNECTING and OPEN.)
 */
export const mayConnect = (ws) => !ws || (ws.readyState !== 0 && ws.readyState !== 1);

/**
 * Before a key goes, the history view goes back to live. Wheel lines not sent yet are dropped, and a scroll request
 * under way is waited for: tmux is in copy mode as soon as it takes the request, but the view counts as open only
 * when the answer came, and a key sent meanwhile was eaten by copy mode.
 */
export async function backToLive(scroller) {
  scroller.pending = 0;
  await scroller.flushing;
  return scroller.offset > 0 ? scroller.exit() : scroller.exiting;
}

/**
 * The key bar's Ctrl, then the next key: the control byte a keyboard's Ctrl gives with it ("r" -> Ctrl+R). A phone has
 * no Ctrl key, and a browser keeps Ctrl+T, Ctrl+W and Ctrl+N for itself, so this is the way to them. A key that has no
 * control byte (an arrow, a word from the phone's suggestions) goes as it is.
 */
export function withCtrl(d) {
  if (d === ' ') return '\x00';
  if (typeof d !== 'string' || d.length !== 1 || !/[a-zA-Z@[\\\]^_?]/.test(d)) return d;
  return d === '?' ? '\x7f' : String.fromCharCode(d.toUpperCase().charCodeAt(0) & 0x1f);
}

/** The key bar's Ctrl: pressed, the next key goes with Ctrl, then it lets go; a second press lets go too. */
export function stickyCtrl() {
  let on = false;
  let button = null;
  const paint = () => button && button.setAttribute('aria-pressed', String(on));
  return {
    get on() { return on; },
    /** Let go without a key: the person went to the message box, where Ctrl does nothing. */
    release() {
      if (!on) return;
      on = false;
      paint();
    },
    toggle(b) {
      button = b;
      on = !on;
      paint();
    },
    /** Input `d` with Ctrl when it is held. A focus or mouse report is not a key: it goes as it is and Ctrl stays. */
    apply(d) {
      if (!on || /^\x1b\[(?:[IO]$|<|M)/.test(d)) return d;
      on = false;
      paint();
      const arrow = /^\x1b[[O]([ABCD])$/.exec(d);
      return arrow ? `\x1b[1;5${arrow[1]}` : withCtrl(d); // Ctrl+arrow: a word left or right
    },
  };
}
