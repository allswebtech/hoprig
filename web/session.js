// The session view (#/s/<name>): the terminal gets the room. The header holds the way back, the session's name
// (tap: another session) with its state, the account it runs on (tap: move to another account) and one "more"
// button; everything else is in the sheet behind it, the destructive one last. A limit or a question waiting for
// your OK shows above the terminal with its one main action, in the words Home uses. Below: quick messages (one row
// that scrolls sideways), the key bar (keys a phone lacks; it folds away and remembers) and the message box.
// History: with tmux the session's terminal owns the screen, so xterm.js keeps no scrollback; wheel and touch
// scrolling are sent to the server, which scrolls the session's own history (tmux copy mode). With the built-in
// backend (capabilities.nativeScrollback) the browser's own scrollback is the history and nothing is sent. A program
// that takes the mouse (Claude Code's full-screen view) keeps its history itself: then wheel and touch go to it as
// wheel reports, and what it copies (OSC 52) goes to this device's clipboard.
// The way back is the page you came from (trail.js): Setup, when its Fix opened this session; else Home.
import { Terminal } from './vendor/xterm/lib/xterm.mjs';
import { FitAddon } from './vendor/addon-fit/lib/addon-fit.mjs';
import { Unicode11Addon } from './vendor/addon-unicode11/lib/addon-unicode11.mjs';
import { icon } from './icons.js';
import { chrome } from './sessionchrome.js';
import {
  TOOL_NAMES, ago, api, btn, bytes, cardTool, chooseSheet, closeWindow, confirmSheet, fill, h, isClaudeCard, isCodingCard, limitBox, liveBasic,
  answeredNow, kindLabel, needsYou, needsYouFirst, openSheet, permissionActions, link, machine, prefs, profileIcon, profileState, profileText, promptSheet, servesTool,
  at, bgCommandNote, stateOf, statusPill, switchProfile, toast, toolChip, url, wsUrl,
} from './lib.js';
import { pageNotify, store } from './store.js';
import { canDeleteConversation, deleteConversation } from './chat/deletes.js';
import { registeredSessionActions } from './registry.js';
import { answeredLines, exactCard, handsOffBar, heldActCard, openConsentSheet, uncoveredLine, waitWords } from './handsoff.js';
import { isStarting, markStarting, startingPill } from './newsession.js';
// A terminal whose start was stopped before the coding tool ran (the card's startStopped).
export const START_STOPPED = 'The start was stopped before the coding tool ran. The conversation is free again: continue it in the App or start it again.';
import { forgetHere, handOver, named, wayBack, windowWay } from './trail.js';
import { extrasLine, rootRefusedNext, whereNow } from './sessionitem.js';
import { CTRL_V, KEY_BAR, KEY_HELP, backToLive, inOrder, inputMessages, keyBarTarget, mayConnect, pageTitle, pasteKey, reconnectWait, stickyCtrl, termKey } from './termkeys.js';
import { clipboardPictures, dragHasFiles, failWords, filesOf, pastedFiles, typedPaths } from './termdrop.js';

// Claude Code draws for a dark terminal by default, so the terminal is dark unless the user picks otherwise.
export const TERM_THEMES = {
  dark: {
    background: '#0f1115', foreground: '#e3e6ec', cursor: '#9aa8ff', cursorAccent: '#0f1115', selectionBackground: '#33416b',
    black: '#1b1e25', red: '#ff7b72', green: '#7ee787', yellow: '#e3b341', blue: '#79a8ff', magenta: '#d2a8ff', cyan: '#56d4dd', white: '#c9d1d9',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#aff5b4', brightYellow: '#f2cc60', brightBlue: '#a5c3ff', brightMagenta: '#e2c5ff', brightCyan: '#8ee8ef', brightWhite: '#ffffff',
  },
  light: {
    background: '#fbfbfd', foreground: '#1f2328', cursor: '#4f46e5', cursorAccent: '#fbfbfd', selectionBackground: '#c9d4ff',
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0550ae', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  },
};
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
export const termTheme = () => {
  const t = prefs.get('term.theme', 'dark');
  return TERM_THEMES[t === 'system' ? (darkQuery.matches ? 'dark' : 'light') : t] || TERM_THEMES.dark;
};
export const termFont = () => prefs.get('term.font', innerWidth < 600 ? 13 : 14);
const finePointer = matchMedia('(pointer: fine)').matches; // desktop: Enter sends; phone: Enter is a new line
const onMac = /Mac/.test(navigator.userAgent);

/** Copy text; works without HTTPS too (the Clipboard API needs a secure context, execCommand does not). */
async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!fallbackEl) return false;
    fallbackEl.focus();
    fallbackEl.select();
    return document.execCommand('copy');
  }
}

/** Open the session view in `app`. Returns the cleanup function. */
export function openSession(app, name) {
  document.body.classList.add('term-mode');
  store.viewing = name;
  pageNotify.setTitleBase(name);
  named(name);
  const inWindow = windowWay(); // a window of the desktop: the way back stays in its app, none where it starts
  const way = inWindow || wayBack() || { hash: '#/', label: 'Home' };
  const base = `/api/sessions/${encodeURIComponent(name)}`;
  let session = null;
  let profiles = [];
  let disposed = false;

  // ---------- layout ----------
  const otherBadge = h('span.count.hidden');
  // On another computer, say which one, next to the name (one line, cut before the name is).
  const where = h('span.sesswhere');
  const titleBtn = h('button.titlebtn', { type: 'button', 'aria-label': 'Switch to another session', onclick: () => switcher() },
    h('span.titlebtn-name', name, where), icon('chevronDown', { size: 16 }), otherBadge);
  const profileBtn = h('button.profilebtn.hidden', { type: 'button', title: 'Move to another provider', onclick: () => moveAccount() },
    icon('user', { size: 16 }), h('span.profilebtn-label', '…'), icon('chevronDown', { size: 14 }));
  // The way to the App: one visible control in the head (registered by the App chat, chat/page.js), shown only where
  // this conversation can open there. It was a row inside More.
  const openApp = registeredSessionActions().find((a) => a.id === 'open-chat');
  const openBtn = h('button.btn.small.secondary.sessopen.hidden', { type: 'button', 'aria-label': 'Open in App', onclick: () => openApp.run({ name, machine: machine.current }) },
    icon('text', { size: 16 }), h('span.sessopen-label', h('span.sessopen-long', 'Open in '), 'App'));
  let offeredFor; // the conversation the button was last asked about
  const statusSlot = h('div.sess-state');
  const toolSlot = h('span.sess-tool'); // the coding tool's name, beside the session's name (not a line of its own on a phone)
  const needSlot = h('div.sess-need'); // a limit, or a question waiting for your OK: above the terminal
  const overlay = h('div.term-overlay', h('div.spinner', { 'aria-hidden': 'true' }), h('span', 'Connecting…'));
  const liveBtn = h('button.btn.small.primary.live.hidden', { type: 'button', onclick: () => scroller.exit() }, icon('down', { size: 16 }), h('span', 'Back to live'));
  const termEl = h('div.term-el');
  // Where a copy goes on plain http, where the browser has no clipboard API (execCommand needs a selection).
  const clipEl = h('textarea.term-clip', { readOnly: true, tabindex: '-1', 'aria-hidden': 'true' });
  const box = h('div.term-box', termEl, overlay, liveBtn, clipEl);
  const quick = h('div.quick', { role: 'toolbar', 'aria-label': 'Quick messages' });
  // The key bar folds away; the choice is kept on this device. Without one: shown on a phone (no Esc, Tab or
  // arrows there), hidden where there is a mouse and a keyboard (the real keys do it).
  let keysOn = prefs.get('session.keys', !finePointer);
  const keysBtn = h('button.chip.keys-toggle', { type: 'button', 'aria-pressed': String(keysOn), title: 'Show or hide the key bar: Esc, Tab, Ctrl and the keys a browser keeps for itself (Ctrl, then T, W or N)', onpointerdown: (e) => e.preventDefault(), onclick: () => {
    keysOn = !keysOn;
    prefs.set('session.keys', keysOn);
    paintKeys();
  } }, icon('grid', { size: 14 }), h('span', 'Keys'));
  const keybar = h('div.keybar', { role: 'toolbar', 'aria-label': 'Keys', ...chrome('keys') },
    KEY_BAR.map(([label, seq, title]) => h('button.key', { type: 'button', dataset: seq === null ? { act: 'ctrl' } : { seq }, ...(seq === null && { 'aria-pressed': 'false' }), title, 'aria-label': title }, label)),
    h('button.key', { type: 'button', dataset: { act: 'paste' }, title: 'Paste into the terminal' }, icon('clipboard', { size: 16 }), h('span', 'Paste')),
    // A touch screen has no drop and no file in its clipboard: File opens the device's own picker (photos, camera, files).
    finePointer ? null : h('button.key', { type: 'button', dataset: { act: 'file' }, title: 'Send a file: it goes to the session\'s computer and its path is typed', 'aria-label': 'Send a file' }, icon('upload', { size: 16 }), h('span', 'File')));
  keybar.classList.toggle('has-file', !finePointer);
  const dropInput = h('input.hidden', { type: 'file', multiple: true });
  const textarea = h('textarea.msg', {
    rows: 1,
    'aria-label': 'Message', autocapitalize: 'sentences', enterkeyhint: finePointer ? 'send' : 'enter',
  });
  // The full hint only where it fits on one line; a narrow screen (a phone, a split window) gets the short one.
  const narrow = matchMedia('(max-width: 599px)');
  // "Message Codex" in a Codex session (the card's tool; Claude until the first look at the sessions).
  const toolName = () => (session && !isClaudeCard(session) && TOOL_NAMES[cardTool(session)]) || 'Claude';
  // A plain shell (no coding tool in it, e.g. a Terminal window of the desktop): the box types into the terminal,
  // and the quick messages, which are words for the coding tool, are not offered. A coding tool started in it
  // brings them back.
  let plain = false;
  const placeholder = () => (textarea.placeholder = plain ? 'Type into the terminal'
    : !narrow.matches && finePointer ? `Message ${toolName()} — Enter sends, Shift+Enter new line` : `Message ${toolName()}`);
  placeholder();
  narrow.addEventListener('change', placeholder);
  const fileInput = h('input.hidden', { type: 'file', multiple: true });
  const sendBtn = h('button.btn.primary.icon.send', { type: 'button', 'aria-label': 'Send', title: 'Send', onclick: () => sendMessage() }, icon('send', { size: 20 }));
  const attachBtn = h('button.btn.icon.ghost', { type: 'button', 'aria-label': 'Attach a file', title: 'Attach a file or an image: it goes into the session folder and its path into your message', onclick: () => fileInput.click() }, icon('paperclip'));
  const status = h('div.upload-status.hidden', { role: 'status' });

  const quickRow = h('div.quick-row', chrome(), quick, keysBtn);
  const paintKeys = () => {
    keybar.classList.toggle('hidden', !keysOn);
    keysBtn.setAttribute('aria-pressed', String(keysOn));
  };
  paintKeys();
  const wrap = h('div.term-wrap',
    h('header.sessbar', chrome(),
      inWindow === null ? null : h('a.btn.ghost.sessback', { href: way.hash, 'aria-label': `Back to ${way.label}`, title: `Back to ${way.label}` }, icon('back'), h('span.sessback-label', way.label)),
      h('div.sess-title', h('div.sess-name-row', titleBtn, toolSlot), h('div.sess-sub', statusSlot)),
      h('div.sessbar-end', openApp ? openBtn : null, profileBtn, btn('icon ghost', { icon: 'more', title: 'More for this session', onclick: () => menu() }))),
    needSlot,
    box,
    quickRow,
    keybar,
    status,
    h('div.composer', chrome(), attachBtn, textarea, sendBtn, fileInput, dropInput),
  );
  fill(app, wrap);

  // Height follows the *visual* viewport, so the message box stays above an open phone keyboard (iOS does not
  // resize the layout for the keyboard; Android does with interactive-widget=resizes-content).
  const vv = window.visualViewport;
  const onViewport = () => {
    if (!vv) return;
    wrap.style.setProperty('--vvh', `${vv.height}px`);
    wrap.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : '';
  };
  vv?.addEventListener('resize', onViewport);
  vv?.addEventListener('scroll', onViewport);
  onViewport();

  // ---------- terminal ----------
  const term = new Terminal({
    allowProposedApi: true, // needed by the Unicode 11 addon
    // Noto Sans Mono and FreeMono after Liberation Mono: they hold the rounded corners of a coding tool's frames and
    // its marks ⎿ ⇧, which Liberation Mono lacks; without them Linux took a wide CJK font for those (the test says).
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "Noto Sans Mono", FreeMono, monospace',
    fontSize: termFont(),
    lineHeight: 1.1,
    scrollback: 0, // set to 5000 below when the backend has no history of its own
    cursorBlink: false,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true, // Option+drag selects on a Mac while the program has the mouse (Shift elsewhere)
    theme: termTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(termEl);
  // What a plain terminal shows of the program: its title in the tab, and its bell as a short flash of the frame.
  term.onTitleChange((t) => pageNotify.setTitleBase(pageTitle(name, t)));
  let bellTimer = null;
  term.onBell(() => {
    box.classList.add('bell');
    clearTimeout(bellTimer);
    bellTimer = setTimeout(() => box.classList.remove('bell'), 300);
  });
  const applyTerm = () => {
    term.options.theme = termTheme();
    term.options.fontSize = termFont();
    box.style.setProperty('--term-bg', term.options.theme.background);
    refit();
  };
  darkQuery.addEventListener('change', applyTerm);

  // Your last presses: only right after one may the program copy. A press in the terminal (a mouse selection) always
  // counts; a key (Claude Code's /copy) only while the program has the mouse and draws everything itself, so a file a
  // plain shell prints after Enter cannot replace what you copied.
  let lastPointer = 0;
  let lastKey = 0;
  for (const ev of ['pointerdown', 'pointerup']) box.addEventListener(ev, () => (lastPointer = Date.now()), { capture: true });
  wrap.addEventListener('keydown', () => (lastKey = Date.now()), { capture: true });
  const mayCopy = () => Date.now() - lastPointer < 5000 || (appScrolls() && Date.now() - lastKey < 5000);
  // Keys the page answers itself (termkeys.js) are stopped: nothing follows them. Ctrl/Cmd+C copies a selection.
  let ctrlV = -Infinity; // when Ctrl+V was last pressed (onPaste: an empty paste then sends its byte)
  term.attachCustomKeyEventHandler((e) => {
    const own = termKey(e);
    if (own !== null) { e.preventDefault(); if (own) input(own); return false; }
    // A Mac's browser pastes on Cmd+V only, and Ctrl+V is Claude Code's key for a picture in the clipboard: the page
    // reads the clipboard itself; without a picture (or a yes from the person) the program gets the key as before.
    if (onMac && pasteKey(e)) { e.preventDefault(); macCtrlV(); return false; }
    if (pasteKey(e)) { ctrlV = performance.now(); return false; } // not stopped: the browser pastes, and onPaste takes it
    if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key === 'c' && term.hasSelection()) {
      copyText(term.getSelection());
      term.clearSelection();
      return false;
    }
    return true;
  });

  // Copy from the program: Claude Code's full-screen view copies what you select with the mouse as OSC 52 (inside
  // tmux it hands it to tmux, which passes it on). Only writes are taken, a program never reads this clipboard, and
  // only within a few seconds of your own press in the terminal: output alone cannot replace what you copied.
  term.parser.registerOscHandler(52, (data) => {
    const b64 = data.slice(data.indexOf(';') + 1);
    if (!data.includes(';') || !b64 || b64 === '?' || b64.length > 4_000_000 || !mayCopy()) return true;
    let text = '';
    try {
      text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    } catch {
      return true;
    }
    if (text) {
      // The copy may take the focus (the plain-http fallback selects a hidden box): it goes back where it was.
      const before = document.activeElement;
      clipEl.value = text;
      copyText(text, clipEl).then((ok) => {
        clipEl.value = '';
        if (before && before !== clipEl && before !== document.body && before.isConnected && typeof before.focus === 'function') before.focus({ preventScroll: true });
        else if (finePointer) term.focus();
        return ok;
      }).then((ok) => (ok
        ? toast('Copied', { ms: 1500 })
        : toast(`Not copied: the browser refused. Hold ${onMac ? 'Option' : 'Shift'} while you select, then copy.`, { kind: 'error', ms: 6000 })));
    }
    return true;
  });

  // ---------- WebSocket ----------
  let ws = null;
  const again = { retry: 0, quick: 0 }; // reconnectWait's count
  let retryTimer = null;
  const sendWs = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  const ctrl = stickyCtrl(); // the key bar's Ctrl, for the next key
  // Typing goes to the program, not to the history view: it is closed first, also when an open or a close is under way.
  const ordered = inOrder(() => backToLive(scroller));
  async function input(d) {
    d = ctrl.apply(d);
    return ordered(() => {
      for (const m of inputMessages(d)) sendWs(m); // a long paste in frames the server takes
    });
  }
  term.onData((d) => input(d));
  // Mouse reports in the oldest encoding are bytes (a column past 95 is above 127): sent as such, not as UTF-8.
  term.onBinary((d) => ordered(() => sendWs({ t: 'bin', d })));

  const showOverlay = (...kids) => {
    fill(overlay, kids);
    overlay.classList.remove('hidden');
  };

  function connect() {
    if (disposed || !mayConnect(ws)) return;
    clearTimeout(retryTimer);
    fit.fit();
    ws = new WebSocket(wsUrl(`/ws/term?${new URLSearchParams({ name, cols: term.cols, rows: term.rows })}`));
    let opened = 0; // when it opened
    ws.onopen = () => {
      opened = Date.now();
      term.reset(); // the server redraws the whole screen on attach
      overlay.classList.add('hidden');
      sendWs({ t: 'resize', cols: term.cols, rows: term.rows });
    };
    ws.onmessage = (e) => term.write(e.data);
    ws.onclose = async (e) => {
      if (disposed) return;
      const exists = await api(base).then(() => true, (err) => err.status !== 404);
      if (!exists || e.code === 4000) {
        forgetHere();
        // A window that started on this session has no page to go back to: it offers to close instead.
        showOverlay(icon('check', { size: 28 }), h('p', 'This session has ended.'), inWindow === null
          ? h('button.btn.primary', { type: 'button', onclick: () => closeWindow() }, 'Close window')
          : h('a.btn.primary', { href: way.hash }, way.hash === '#/' ? 'Back to sessions' : `Back to ${way.label}`));
        return;
      }
      const wait = reconnectWait(again, { code: e.code, lived: opened ? Date.now() - opened : 0 });
      if (wait === null) {
        // tmux ends every attach at once (a hook or a setting of its config) while the session runs on
        showOverlay(h('p', 'tmux closes this view as soon as it opens. The session is still running.'),
          h('button.btn.primary', { type: 'button', onclick: () => { Object.assign(again, { retry: 0, quick: 0 }); connect(); } }, 'Try again'));
        return;
      }
      showOverlay(h('div.spinner', { 'aria-hidden': 'true' }), h('span', opened ? 'Connection lost — reconnecting…' : 'Reconnecting…'));
      retryTimer = setTimeout(connect, wait);
    };
  }

  // Size: refit whenever the box changes (rotation, phone keyboard opening or closing, window resize).
  let fitTimer = null;
  function refit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      const before = `${term.cols}x${term.rows}`;
      fit.fit();
      if (`${term.cols}x${term.rows}` !== before) sendWs({ t: 'resize', cols: term.cols, rows: term.rows });
    }, 60);
  }
  const ro = new ResizeObserver(refit);
  ro.observe(box);

  // ---------- history scrolling (wheel and touch) ----------
  const scroller = {
    offset: 0,
    pending: 0,
    busy: false,
    flushing: null, // the scroll requests, while they run: keys wait for them
    exiting: null, // the request that closes the view, while it runs: keys wait for it
    gen: 0, // one more each time the view goes back to live: an answer from before that changes nothing
    queue(lines) {
      if (!lines) return;
      if (lines < 0 && this.offset <= 0 && this.pending <= 0) return; // already live
      this.pending += lines;
      this.flush();
    },
    flush() {
      if (this.busy || !this.pending) return;
      this.busy = true;
      const run = (async () => {
        while (this.pending) {
          const n = this.pending;
          const g = this.gen;
          this.pending = 0;
          try {
            await api(`${base}/scroll`, { action: n > 0 ? 'up' : 'down', lines: Math.abs(n) });
            if (g === this.gen) this.offset = Math.max(0, this.offset + n);
            else if (n > 0) await api(`${base}/scroll`, { action: 'exit' }).catch(() => {}); // back to live meanwhile: tmux too
          } catch {
            /* the next gesture tries again */
          }
          liveBtn.classList.toggle('hidden', this.offset <= 0);
        }
        this.busy = false;
      })();
      this.flushing = run;
      run.then(() => this.flushing === run && (this.flushing = null));
    },
    exit() {
      this.gen++;
      this.pending = 0;
      this.offset = 0;
      liveBtn.classList.add('hidden');
      const p = api(`${base}/scroll`, { action: 'exit' }).catch(() => {});
      this.exiting = p;
      p.then(() => this.exiting === p && (this.exiting = null));
      return p;
    },
  };
  const cellHeight = () => Math.max(8, box.clientHeight / Math.max(1, term.rows));
  let nativeScroll = false; // set from the backend's capabilities in the first state update
  // The program asked for the mouse with wheel reports (Claude Code's full-screen view): it scrolls its own history.
  // (X10, the oldest mode, has no wheel: xterm.js would turn a wheel into arrow keys there.)
  const appScrolls = () => ['vt200', 'drag', 'any'].includes(term.modes.mouseTrackingMode);
  let replaying = false;
  /**
   * `n` lines of wheel (negative: up, to older lines) for the program, at the point (x, y). They go through xterm.js
   * as wheel events of one line each, so it encodes them as the program asked; xterm.js alone would send one report
   * per wheel event, one line for a whole notch.
   */
  function wheelToApp(n, x, y) {
    const screen = term.element && term.element.querySelector('.xterm-screen');
    if (!screen) return;
    const r = screen.getBoundingClientRect();
    const clientX = Math.min(Math.max(x, r.left + 1), r.right - 1);
    const clientY = Math.min(Math.max(y, r.top + 1), r.bottom - 1);
    replaying = true;
    try {
      for (let i = 0; i < Math.min(Math.abs(n), 30); i++) {
        term.element.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.sign(n), deltaMode: WheelEvent.DOM_DELTA_LINE, clientX, clientY, bubbles: true, cancelable: true }));
      }
    } finally {
      replaying = false;
    }
  }
  let wheelAcc = 0;
  term.attachCustomWheelEventHandler((e) => {
    if (replaying) return true; // ours, from wheelToApp
    const app = appScrolls();
    if (nativeScroll && !app) return true; // xterm.js scrolls its own buffer
    if (app && scroller.offset > 0) scroller.exit();
    wheelAcc += e.deltaMode === 1 ? e.deltaY * cellHeight() : e.deltaY;
    const lines = Math.trunc(wheelAcc / cellHeight());
    if (lines) {
      wheelAcc -= lines * cellHeight();
      if (app) wheelToApp(lines, e.clientX, e.clientY);
      else scroller.queue(-lines);
    }
    e.preventDefault();
    return false;
  });
  let touchY = null;
  let touchAcc = 0;
  box.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      touchY = e.touches[0].clientY;
      touchAcc = 0;
    }
  }, { passive: true, capture: true });
  box.addEventListener('touchmove', (e) => {
    if (touchY === null || e.touches.length !== 1) return;
    const t = e.touches[0];
    const app = appScrolls();
    if (nativeScroll && !app) return;
    if (app && scroller.offset > 0) scroller.exit();
    touchAcc += t.clientY - touchY;
    touchY = t.clientY;
    const lines = Math.trunc(touchAcc / cellHeight());
    if (lines) {
      touchAcc -= lines * cellHeight();
      if (app) wheelToApp(-lines, t.clientX, t.clientY); // finger down = older lines = wheel up
      else scroller.queue(lines);
    }
    e.preventDefault();
  }, { passive: false, capture: true });
  box.addEventListener('touchend', () => (touchY = null), { capture: true });

  // ---------- key bar ----------
  keybar.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus (and the phone keyboard) where it is
  keybar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'paste') return pasteIntoTerminal();
    if (b.dataset.act === 'ctrl') return ctrl.toggle(b);
    if (b.dataset.act === 'file') return dropInput.click();
    let seq = b.dataset.seq;
    if (keyBarTarget(seq, document.activeElement === textarea) === 'box') {
      textarea.setRangeText(seq, textarea.selectionStart, textarea.selectionEnd, 'end');
      prefs.set(draftKey, textarea.value);
      return grow();
    }
    const arrows = { up: 'A', down: 'B', right: 'C', left: 'D' };
    if (arrows[seq]) seq = (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + arrows[seq];
    input(seq);
  });

  async function pasteIntoTerminal() {
    let text = null;
    try {
      text = await navigator.clipboard.readText(); // HTTPS (or localhost) and the user's permission
    } catch {
      text = await promptSheet({ title: 'Paste', text: 'Long-press in the box, choose Paste, then send it to the terminal.', ok: 'Send to terminal', multiline: true });
    }
    if (text) term.paste(text); // bracketed paste when the program asked for it; input() closes the history view first
  }

  async function stop() {
    try {
      await api(`${base}/key`, { key: 'Escape', owner: true }); // the owner's own stop button (server.mjs)
      toast(`Asked ${toolName()} to stop`);
    } catch (e) {
      toast(e, { kind: 'error' });
    }
  }

  // ---------- text of the session (select and copy on a phone) ----------
  async function showText() {
    let text = '';
    try {
      ({ text } = await api(`${base}/history?lines=2000`));
    } catch (e) {
      return toast(e, { kind: 'error' });
    }
    await openSheet({ title: 'Text of this session', subtitle: 'Select what you need, or copy everything.', wide: true }, (close) => {
      const area = h('textarea.history', { readOnly: true, value: `${text.replace(/\s+$/, '')}\n`, spellcheck: 'false' });
      setTimeout(() => (area.scrollTop = area.scrollHeight), 0);
      return [
        area,
        h('div.sheet-actions',
          h('button.btn.secondary', { type: 'button', onclick: () => close() }, 'Close'),
          h('button.btn.primary', {
            type: 'button',
            onclick: async () => toast((await copyText(area.value, area)) ? 'Copied' : 'Copy did not work — select and copy by hand', { kind: 'info' }),
          }, icon('copy', { size: 18 }), h('span', 'Copy all'))),
      ];
    });
  }

  // ---------- message box ----------
  const draftKey = `draft:${name}`;
  textarea.value = prefs.get(draftKey, '');
  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, innerHeight * 0.3)}px`;
  };
  textarea.addEventListener('input', () => {
    prefs.set(draftKey, textarea.value);
    grow();
  });
  // The key bar's Ctrl is for the terminal's next key: held while the person writes here, it turned a key typed in
  // the terminal minutes later into a chord (u became Ctrl+U, which clears the prompt).
  textarea.addEventListener('focus', () => ctrl.release());
  textarea.addEventListener('input', () => ctrl.release());
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && ((finePointer && !e.shiftKey) || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      sendMessage();
    }
  });
  grow();

  async function sendText(text) {
    await api(`${base}/send`, { text, owner: true }); // the owner's own message: typed as he wrote it (server.mjs)
    scroller.gen++;
    scroller.offset = 0;
    liveBtn.classList.add('hidden');
  }

  async function sendMessage() {
    const text = textarea.value.replace(/\s+$/, '');
    if (!text) return textarea.focus();
    sendBtn.disabled = true;
    try {
      await sendText(text);
      textarea.value = '';
      prefs.set(draftKey, '');
      grow();
    } catch (e) {
      toast(`Not sent: ${e.message}`, { kind: 'error' });
    } finally {
      sendBtn.disabled = false;
      textarea.focus();
    }
  }

  // ---------- quick actions ----------
  let quickKey = '';
  function renderQuick(actions) {
    const key = JSON.stringify(actions);
    if (key === quickKey) return;
    quickKey = key;
    fill(quick, actions.map((a) =>
      h('button.chip', {
        type: 'button',
        title: a.text,
        onpointerdown: (e) => e.preventDefault(),
        onclick: async () => {
          try {
            await sendText(a.text);
            toast(`Sent “${a.label}”`);
          } catch (e) {
            toast(e, { kind: 'error' });
          }
        },
      }, a.label)),
    h('a.chip.ghost', { href: link('#/settings/appearance'), title: 'Edit quick messages' }, icon('pencil', { size: 14 }), h('span', 'Edit')));
    quickRow.classList.toggle('no-quick', !actions.length);
  }

  // ---------- uploads ----------
  const insertText = (t) => {
    const s = textarea.selectionStart ?? textarea.value.length;
    const before = textarea.value.slice(0, s);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    textarea.value = `${before}${sep}${t} ${textarea.value.slice(textarea.selectionEnd ?? s)}`;
    prefs.set(draftKey, textarea.value);
    grow();
  };
  function upload(file, to = `${base}/upload`) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); // XHR, not fetch: it reports upload progress
      xhr.open('POST', url(to));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'upload'));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) status.textContent = `Uploading ${file.name}: ${Math.round((e.loaded / e.total) * 100)}% of ${bytes(e.total)}`;
      };
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* not JSON */
        }
        if (xhr.status === 200) resolve(body);
        else reject(Object.assign(new Error(body.error || `Upload failed (${xhr.status})`), { status: xhr.status }));
      };
      xhr.onerror = () => reject(Object.assign(new Error('Upload failed: connection lost'), { status: 0 }));
      xhr.send(file);
    });
  }
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    attachFiles(files);
  });
  async function attachFiles(files) {
    status.classList.remove('hidden');
    for (const f of files) {
      try {
        const r = await upload(f);
        insertText(r.path);
        toast(`${f.name} is in the session folder; its path is in your message`);
      } catch (e) {
        toast(e, { kind: 'error' });
      }
    }
    status.classList.add('hidden');
    textarea.focus();
  }

  // ---------- a file dropped or pasted on the terminal ----------
  // As a terminal does on a drop: the path is typed at the prompt (no Enter), and the coding tool reads the file from
  // there. The file is on the computer with the browser, so it goes to the session's computer first (server.mjs
  // /drop/upload); one line says how far it is, one sentence why it failed. Several files: one after another.
  let statusTimer = null;
  const say = (text, error = false) => {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.classList.toggle('error', error);
    status.classList.remove('hidden');
    if (error) statusTimer = setTimeout(() => status.classList.add('hidden'), 10_000);
  };
  async function typeIntoTerminal(text) {
    // As a terminal's drop: a bracketed paste when the program asked for it. term.paste ends in input(), so the path
    // waits for the keys typed before it and for the history view to close, in the same line as every key.
    term.paste(text);
    if (finePointer) term.focus();
  }
  let sending = Promise.resolve();
  async function macCtrlV() {
    const files = await clipboardPictures(navigator.clipboard);
    if (disposed) return;
    if (files.length) sendFiles(files);
    else input(CTRL_V);
  }
  const sendFiles = (files) => (sending = sending.then(async () => {
    const paths = [];
    const failed = [];
    for (const f of files) {
      say(`Uploading ${f.name || 'a file'}…`);
      try {
        paths.push((await upload(f, `${base}/drop/upload`)).path);
      } catch (e) {
        failed.push(failWords(f.name || 'The file', e.status ?? 0, e.message));
      }
    }
    if (disposed) return;
    const text = typedPaths(paths);
    if (text) await typeIntoTerminal(text);
    if (failed.length) say(failed.join(' '), true);
    else status.classList.add('hidden');
  }));
  dropInput.addEventListener('change', () => {
    const files = [...dropInput.files];
    dropInput.value = '';
    if (files.length) sendFiles(files);
  });
  // The whole page: a file dropped anywhere is sent, never opened by the browser in its place. Text dragged into
  // the message box lands there as always; text dropped anywhere else is typed into the terminal.
  const onDragOver = (e) => {
    if (e.target === textarea && !dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e) => {
    const files = filesOf(e.dataTransfer);
    if (!files.length && e.target === textarea) return;
    e.preventDefault();
    if (files.length) return sendFiles(files);
    const text = e.dataTransfer && e.dataTransfer.getData('text/plain');
    if (text) typeIntoTerminal(text);
  };
  // A paste whose clipboard holds files or a picture: in the message box as the paperclip does, else into the
  // terminal as a drop. Text stays with the terminal library (or the box). Before the terminal library's own
  // handler (capture), which pastes text only.
  const onPaste = (e) => {
    const files = pastedFiles(e.clipboardData);
    if (!files.length) {
      const empty = !e.clipboardData || ![...(e.clipboardData.types || [])].length;
      if (empty && performance.now() - ctrlV < 1000 && e.target !== textarea && box.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        input(CTRL_V); // the paste key with nothing to paste: the program gets Ctrl+V, as before
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.target === textarea) return attachFiles(files);
    sendFiles(files);
  };
  window.addEventListener('dragenter', onDragOver);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('drop', onDrop);
  wrap.addEventListener('paste', onPaste, { capture: true });

  // ---------- state from the shared poller ----------
  let infoKey = '';
  const unsubscribe = store.subscribe((d) => {
    if (!d) return;
    fill(where, machine.current && store.multi ? ` · ${d.machineLabel}` : null);
    // The providers this session's coding tool may use (a conversation stays in its tool; Auto mode is Claude Code's).
    const here = d.sessions.find((x) => x.name === name);
    profiles = d.profiles.filter((p) => servesTool(p, cardTool(here) || 'claude'));
    const caps = (d.backend && d.backend.capabilities) || {};
    if (caps.nativeScrollback && !nativeScroll) {
      nativeScroll = true;
      term.options.scrollback = 5000;
    }
    const s = d.sessions.find((x) => x.name === name);
    // The quick messages that fit the session's coding tool: a "/" command is Claude Code's.
    renderQuick((d.quickActions || []).filter((a) => !s || isClaudeCard(s) || !isCodingCard(s) || !String(a.text || '').trim().startsWith('/')));
    // What Home calls "Needs you" (home.js GROUPS): needs your OK, or at a limit. Waiting for a message is not it.
    const others = d.sessions.filter((x) => x.name !== name && needsYou(x)).length;
    otherBadge.textContent = String(others);
    otherBadge.classList.toggle('hidden', !others);
    otherBadge.title = `${others} other session${others === 1 ? '' : 's'} need${others === 1 ? 's' : ''} you`;
    if (!s) {
      // Gone: its conversation may stand somewhere else now (handed to the App from another tab): an old address opens
      // it where it is now, in the place of this one (trail.js handOver).
      const now = !disposed && session && whereNow(d.sessions, { name, key: session.key, sessionId: session.sessionId });
      if (now) handOver(`#/${now.kind === 'chat' ? `chat/${now.chatId}` : `s/${encodeURIComponent(now.name)}`}`, machine.current);
      return;
    }
    const toolBefore = cardTool(session);
    session = s;
    if (openApp && s.sessionId !== offeredFor) {
      offeredFor = s.sessionId;
      Promise.resolve(openApp.describe ? openApp.describe({ name, machine: machine.current }) : {}).then((r) => openBtn.classList.toggle('hidden', r === null), () => {});
    }
    if (cardTool(s) !== toolBefore) placeholder();
    // An answer sent a moment ago is part of what the banner shows (lib.js answeredNow), not of the card.
    const key = JSON.stringify([s, profiles, answeredNow({ ...s, machine: machine.current })]);
    if (key === infoKey) return;
    infoKey = key;
    // Started from this page a moment ago, and Claude has not reported yet: "Starting", not "Terminal".
    const starting = isStarting(s, machine.current);
    profileBtn.classList.toggle('hidden', !isCodingCard(s));
    if ((s.kind === 'shell') !== plain) {
      plain = s.kind === 'shell';
      placeholder();
      quick.classList.toggle('hidden', plain);
    }
    fill(profileBtn, icon(profileIcon(s.profile), { size: 16 }), h('span.profilebtn-label', profileText(s)), icon('chevronDown', { size: 14 }));
    fill(statusSlot, starting ? startingPill(s) : statusPill(s, { time: false }), liveBasic(s), extrasLine(s, 'span.card-extras.sess-extras'));
    fill(toolSlot, toolChip(s));
    const before = needSlot.offsetHeight;
    fill(needSlot, limitBox(s, profiles, moved) || (stateOf(s).key === 'attention' ? needsOk(s) : stateOf(s).key === 'failed' ? didNotStart(s) : null), answeredLines(s.handsOffDone, { askAt: stateOf(s).key === 'attention' ? s.askAt : 0, onToggle: () => refit() }), handsBar(s), s.handsOff && s.handsOff.uncovered ? uncoveredLine([name], { linked: false }) : null, allowedNote(s), bgCommandNote(s) ? h('p.sess-ok-text.sess-bg-note', bgCommandNote(s)) : null, startStoppedNote(s));
    if (needSlot.offsetHeight !== before) refit();
  });

  // ---------- jump to another session ----------
  async function switcher() {
    const d = store.data;
    if (!d) return;
    const pick = await chooseSheet({
      title: 'Sessions',
      items: [...d.sessions].sort(needsYouFirst).map((x) => ({
        value: x.name,
        label: x.display || x.name,
        sub: `${stateOf(x).text}${x.profile ? ` · ${x.profile.label}` : ''}`,
        icon: x.kind === 'chat' ? 'text' : isCodingCard(x) ? 'sparkle' : 'terminal',
        current: x.name === name,
        badge: x.name !== name && needsYou(x) ? '●' : '',
      })),
    });
    const chat = pick && d.sessions.find((x) => x.name === pick && x.kind === 'chat');
    if (chat) location.hash = link(`#/chat/${chat.chatId}`);
    else if (pick && pick !== name) location.hash = link(`#/s/${encodeURIComponent(pick)}`);
  }

  // ---------- terminal look (per device) ----------
  async function terminalLook() {
    await openSheet({ title: 'Terminal look', subtitle: 'Saved on this device' }, () => {
      const seg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Terminal colours' });
      const size = h('span.fontsize', `${termFont()} px`);
      const paint = () => {
        const cur = prefs.get('term.theme', 'dark');
        fill(seg, [['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'System', 'refresh']].map(([v, label, ic]) =>
          h('button.seg', { type: 'button', role: 'radio', 'aria-checked': String(cur === v), onclick: () => { prefs.set('term.theme', v); paint(); applyTerm(); } }, icon(ic, { size: 16 }), h('span', label))));
        size.textContent = `${termFont()} px`;
      };
      const step = (d) => {
        prefs.set('term.font', Math.min(22, Math.max(9, termFont() + d)));
        paint();
        applyTerm();
      };
      paint();
      return [
        h('div.field-label', 'Colours'), seg,
        h('div.field-label', 'Text size'),
        h('div.stepper-inline', btn('icon secondary', { icon: 'minus', title: 'Smaller', onclick: () => step(-1) }), size, btn('icon secondary', { icon: 'plus', title: 'Larger', onclick: () => step(1) })),
      ];
    });
  }

  // ---------- a question waiting for your OK: its answers above the terminal (lib.js permissionActions) ----------
  function needsOk(s) {
    // A question or a plan: the exact card from the tool's own data (src/askcard.mjs) instead of the one-line note.
    const exact = s.askCard && s.askCard.kind !== 'permission' ? exactCard(s.askCard) : null;
    // An act the wall held (a push, a release, administrator rights…): what, why it is his, what each answer does.
    const held = !exact && s.ask && s.ask.type === 'permission' ? heldActCard(s.held) : null;
    // A loop's or an hour's stop is said once, by the bar below with its button (handsBar).
    const wait = (s.handsWait === 'loop' || s.handsWait === 'hour') && s.handsOff && s.handsOff.loop ? '' : waitWords(s.handsWait);
    // More than one question or plan waits: this card is one of them, the terminal shows its own first.
    const more = exact && s.ask && s.ask.type !== 'permission' && s.ask.waiting > 1
      ? h('p.sess-ok-text.ho-more', `More than one question waits (${s.ask.waiting}): this is one of them. Answer them in the terminal below, in the order it shows.`) : null;
    return h('div.sess-ok', { role: 'alert' },
      h('div.sess-ok-head', icon('alert', { size: 18 }), h('strong', stateOf(s).text)),
      more,
      exact || held || (s.note ? h('p.sess-ok-text', s.note) : null),
      wait ? h('p.sess-ok-text.ho-wait', wait) : null,
      permissionActions({ ...s, machine: machine.current }, () => store.refresh(), { here: true }));
  }

  // The coding tool ended at its start (src/startfail.mjs): what it printed last, and where the rest is.
  function didNotStart(s) {
    return h('div.sess-ok.sess-failed', { role: 'alert' },
      h('div.sess-ok-head', icon('alert', { size: 18 }), h('strong', stateOf(s).text)),
      s.note ? h('p.sess-ok-text', s.note) : null,
      rootRefusedNext(s.note) ? h('p.sess-ok-text', h('a', { href: '#/settings/root' }, rootRefusedNext(s.note))) : null,
      h('p.sess-ok-text.hint', 'The terminal below shows all it printed. Start the session again once the cause is fixed.'));
  }

  // ---------- Hands-off for this session (web/handsoff.js): its state and the one press that stops it ----------
  function handsBar(s) {
    if (!s || !isClaudeCard(s) || !s.handsOff) return null;
    // Shown while it is on, after the session's own switch was used (so it can be turned on again), after a loop's
    // stop or an update; off and never set: in the menu only.
    if (!s.handsOff.on && !s.handsOff.loop && !s.handsOff.stale && !s.handsOff.own && !s.handsOff.stopped) return null;
    return handsOffBar(s.handsOff, async (on) => {
      const r = await api(at(machine.current, '/api/handsoff/session'), { name, on });
      if (on === true) openConsentSheet(); // the first time any switch is turned on, this browser sees the sheet once
      return r;
    }, () => store.refresh());
  }

  // The start was stopped before the terminal's shell read its line (Ctrl+C: src/server/deck.mjs #stopped).
  function startStoppedNote(s) {
    return s.startStopped ? h('p.sess-allowed.sess-stopped', START_STOPPED) : null;
  }

  // ---------- what Hoprig allowed by itself in bypass mode (the run record's `allowed`, src/hook.mjs) ----------
  // The newest in one line; the earlier ones (up to four) when the line is opened.
  function allowedNote(s) {
    const list = Array.isArray(s.allowed) ? s.allowed.filter((a) => a && a.tool) : [];
    if (!list.length) return null;
    const at = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    // The command itself for the shell (no tool name), and where it ran when not in the session's folder.
    const named = (a) => (a.by === 'all' ? 'Allowed without asking (Allow everything): ' : 'Allowed by Hoprig in bypass mode: ');
    const line = (a) => `${a.tool && a.tool !== 'Bash' ? `${a.tool}: ` : ''}${a.what || a.tool}${a.folder ? ` · in ${a.folder}` : ''} · ${at(a.at)}`;
    const newest = list[list.length - 1];
    const earlier = list.slice(0, -1).reverse();
    const head = h('span', h('strong', named(newest)), line(newest));
    if (!earlier.length) return h('p.sess-allowed', { role: 'status' }, head);
    return h('details.sess-allowed', { role: 'status', ontoggle: () => refit() }, h('summary', head), h('ul', earlier.map((a) => h('li', line(a)))));
  }

  // A second session in the same folder, on that folder's default provider: no provider is sent, so the server
  // chooses it (the one started there last, else the Providers page's order: src/defaultprovider.mjs). An older
  // computer (its state has no `recommendedIn`) refuses a start without a provider: it gets its recommended one, as
  // New session does.
  async function startAnother(s) {
    try {
      const d = store.data || {};
      const older = !('recommendedIn' in d) && d.recommended ? { profile: d.recommended } : {};
      const { name: next } = await api('/api/sessions', { dir: s.cwd, mode: 'new', ...older });
      markStarting(machine.current, next);
      store.refresh();
      location.hash = link(`#/s/${encodeURIComponent(next)}`);
    } catch (e) {
      toast(e, { kind: 'error', ms: 7000 });
    }
  }

  // Moved to another account: Claude restarts in the same terminal; until it reports, it reads "Starting".
  function moved() {
    markStarting(machine.current, name);
    store.refresh();
  }

  // ---------- the account: move to another one ----------
  async function moveAccount() {
    const s = session;
    if (!s) return;
    if (!s.canSwitch) return toast('The session has not reported its conversation yet. Try again in a moment.', { kind: 'error' });
    const tool = cardTool(s) || 'claude';
    const pick = await chooseSheet({
      title: 'Move to another provider',
      subtitle: tool === 'claude'
        ? 'The conversation continues where it is.'
        : `The conversation stays in ${TOOL_NAMES[tool] || tool}: only its providers are listed. Auto mode is for Claude Code only.`,
      items: profiles.map((p) => ({
        value: p.name,
        label: p.label,
        sub: p.virtual ? profileState(p).text : `${kindLabel(p)} · ${profileState(p).text}`,
        icon: profileIcon(p),
        current: s.profile && p.name === s.profile.name,
        // One that is not signed in is shown with why, and cannot be picked (Providers signs it in).
        disabled: (s.profile && p.name === s.profile.name) || p.signedIn === false,
      })),
    });
    const p = profiles.find((x) => x.name === pick);
    if (p && (await switchProfile(s, p))) moved();
  }

  // ---------- the folder's ended conversations: Delete as the App's (deletes.js deleteConversation) ----------
  /** The conversation this terminal runs is not listed (it is not ended); the server refuses one a terminal runs too. */
  let earlierShown = null; // the Earlier conversations sheet open now (a token), so an Undo draws it again
  async function earlierSheet(s) {
    let list;
    try {
      list = ((await api(`/api/folders/sessions?${new URLSearchParams({ path: s.cwd })}`)).sessions || []).filter((c) => c.id !== s.sessionId);
    } catch (e) {
      return toast(e, { kind: 'error' });
    }
    const name = (c) => (c.title && c.title !== '(untitled)' ? c.title : 'Untitled conversation');
    const mine = {};
    earlierShown = mine;
    const sheet = openSheet({ title: 'Earlier conversations', subtitle: `In ${s.short || s.cwd}. Deleted ones go to the trash for 30 days.` }, (close) => [
      list.length ? h('div.choice-list', list.map((c) => h('div.choice.static.del-row',
        h('span.choice-main', h('span.choice-label', name(c)), h('span.choice-sub', ago(c.at))),
        // Open in an App session or run by another terminal: not an ended conversation (deletes.js canDeleteConversation).
        canDeleteConversation(c) ? h('button.btn.icon.ghost.small.ses-pastdel', { type: 'button', title: `Delete "${name(c)}"`, 'aria-label': `Delete ${name(c)}`, onclick: () => close(c) }, icon('trash', { size: 16 }))
          : h('span.badge', c.chat ? 'Open in the App' : 'Runs in a terminal'))))
        : h('p.sheet-text', 'No other conversation in this folder.'),
    ]);
    const picked = await sheet;
    if (earlierShown === mine) earlierShown = null;
    if (!picked) return;
    // After the Delete the list again, without it; after its Undo, with it again where the list is open still.
    let deleting = true;
    await deleteConversation(s.cwd, picked.id, name(picked), { after: () => {
      store.refresh();
      if (deleting || earlierShown) earlierSheet(s);
    } });
    deleting = false;
  }

  // ---------- more: everything else, each with a word; ending the session last ----------
  async function menu() {
    const s = session;
    const working = s && isCodingCard(s) && s.status === 'working';
    const pref = s && s.preferred && !s.limit && profiles.find((p) => p.name === s.preferred);
    // Rows features add (registry.js registerSessionAction, e.g. the queue), with their state if it comes quickly.
    const me = { name, machine: machine.current };
    const quick = (p) => Promise.race([Promise.resolve().then(() => p), new Promise((r) => setTimeout(() => r({}), 700))]);
    const extra = (await Promise.all(registeredSessionActions().filter((a) => a.id !== 'open-chat').map(async (a) => {
      const d = a.describe ? await quick(a.describe(me)).catch(() => ({})) : {};
      return d === null ? null : { value: `action:${a.id}`, label: d.label || a.label, sub: d.sub ?? a.sub, icon: a.icon };
    }))).filter(Boolean);
    const what = await chooseSheet({
      title: name,
      items: [
        working ? { value: 'stop', label: `Stop ${isClaudeCard(s) ? 'Claude' : TOOL_NAMES[cardTool(s)] || 'it'}`, sub: 'Interrupts the reply it is writing (Esc)', icon: 'stop' } : null,
        pref ? { value: 'back', label: `Move back to ${pref.label}`, sub: 'It is free again', icon: 'swap' } : null,
        s && isClaudeCard(s) && s.cwd ? { value: 'another', label: 'Start another session here', sub: `A new Claude Code session in ${s.short || s.cwd}`, icon: 'plus' } : null,
        ...extra,
        s && isClaudeCard(s) && s.cwd ? { value: 'earlier', label: 'Earlier conversations', sub: 'Ended ones in this folder: delete one you do not need', icon: 'text' } : null,
        s && isClaudeCard(s) && s.handsOff ? { value: 'handsoff', label: s.handsOff.on ? 'Stop Hands-off' : 'Turn on Hands-off', sub: s.handsOff.on ? 'Hoprig stops answering for you in this session' : 'Hoprig answers what the tool marks as recommended, or with your note', icon: 'sparkle' } : null,
        { value: 'attach', label: 'Attach a file', sub: 'Upload into this folder; its path goes into your message', icon: 'paperclip' },
        { value: 'text', label: 'Text of this session', sub: 'Select and copy', icon: 'copy' },
        { value: 'look', label: 'Terminal look', sub: 'Colours and text size', icon: 'sun' },
        { value: 'keys', label: 'Keys and images', sub: 'Ctrl+T, Ctrl+W, Ctrl+N and pasting an image', icon: 'grid' },
        { value: 'rename', label: 'Rename', sub: 'The name shown everywhere', icon: 'pencil' },
        { value: 'kill', label: 'End session', sub: 'Stops everything running in it', icon: 'trash', danger: true },
      ].filter(Boolean),
    });
    const action = what && what.startsWith('action:') && registeredSessionActions().find((a) => `action:${a.id}` === what);
    if (action) return action.run(me);
    if (what === 'stop') stop();
    else if (what === 'back') (await switchProfile(s, pref)) && moved();
    else if (what === 'another') startAnother(s);
    else if (what === 'earlier') earlierSheet(s);
    else if (what === 'handsoff') {
      const turningOn = !s.handsOff.on;
      try {
        await api(at(machine.current, '/api/handsoff/session'), { name, on: turningOn });
        if (turningOn) openConsentSheet(); // shown once per browser, the first time a switch is turned on
        toast(turningOn ? 'Hands-off is on for this session' : 'Hands-off stopped for this session');
        store.refresh();
      } catch (e) {
        toast(e, { kind: 'error' });
      }
    } else if (what === 'attach') fileInput.click();
    else if (what === 'text') showText();
    else if (what === 'look') terminalLook();
    else if (what === 'keys') openSheet({ title: 'Keys and images' }, () => KEY_HELP.map((line) => h('p', line)));
    else if (what === 'rename') {
      const next = await promptSheet({
        title: 'Rename session', value: name, ok: 'Rename',
        check: (v) => (/^[A-Za-z0-9_][A-Za-z0-9_-]{0,39}$/.test(v) ? '' : 'Letters, digits, - and _ only (up to 40), not starting with -.'),
      });
      if (next && next !== name) {
        try {
          await api(`${base}/rename`, { name: next });
          toast(`Renamed to ${next}`);
          store.refresh();
          location.replace(link(`#/s/${encodeURIComponent(next)}`));
        } catch (e) {
          toast(e, { kind: 'error' });
        }
      }
    } else if (what === 'kill') {
      const ok = await confirmSheet({
        title: `End "${name}"?`,
        text: 'Everything running in this session stops. A coding tool\'s conversation can be continued later from the project\'s page.',
        ok: 'End session',
        danger: true,
      });
      if (ok) {
        try {
          await api(`${base}/kill`, {});
          toast(`${name} ended`);
          store.refresh();
          forgetHere();
          // In a window started on this session the window closes (else the overlay above stays); never Home.
          if (inWindow !== null) location.hash = way.hash;
          else closeWindow();
        } catch (e) {
          toast(e, { kind: 'error' });
        }
      }
    }
  }

  applyTerm();
  connect();
  if (finePointer) term.focus();

  return () => {
    disposed = true;
    unsubscribe();
    store.viewing = null;
    clearTimeout(retryTimer);
    clearTimeout(fitTimer);
    ro.disconnect();
    narrow.removeEventListener('change', placeholder);
    window.removeEventListener('dragenter', onDragOver);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('drop', onDrop);
    clearTimeout(statusTimer);
    vv?.removeEventListener('resize', onViewport);
    vv?.removeEventListener('scroll', onViewport);
    darkQuery.removeEventListener('change', applyTerm);
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    term.dispose();
    document.body.classList.remove('term-mode');
  };
}
