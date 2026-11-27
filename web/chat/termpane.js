// The terminal pane under the chat, as the desktop app's Terminal button opens one: a real shell in the session's
// folder, on the session's computer. It is the dashboard's own terminal, a new shell by the route and the rules of the
// editor's terminal (POST /api/shells), shown as its session page in a frame. Hiding the pane (the button, Ctrl+`) keeps
// every shell running with its history; + adds a tab with a new shell; the bin ends the tab's shell, and so does archiving the chat. A reload finds the
// same shells again (kept per chat in this tab). Where the computer gives no terminal, the pane says why in one line.
import { add as addTo, api, btn, fill, h, machine } from '../lib.js';
import { frameSrc, sessionHash } from '../desktop/apps.js';

const keyOf = (id) => `hoprig.chat.terminals:${id}`;
/** The chat is archived: the shells its pane holds (kept per chat in this tab) end with it, as a tab's bin ends its own. */
export function endPaneShells(id) {
  let names = [];
  try {
    const l = JSON.parse(sessionStorage.getItem(keyOf(id)) || '[]');
    names = Array.isArray(l) ? l.filter((x) => typeof x === 'string') : [];
    sessionStorage.removeItem(keyOf(id));
  } catch {
    /* a browser without storage keeps none */
  }
  return Promise.all(names.map((n) => api(`/api/sessions/${encodeURIComponent(n)}/kill`, {}).catch(() => {})));
}

/** o: { id (the chat's), cwd(): the session's folder (on the computer the page is on, lib.js machine), onToggle(on) }. */
export function createTermPane(o) {
  const key = keyOf(o.id);
  const keptNames = () => {
    try {
      const l = JSON.parse(sessionStorage.getItem(key) || '[]');
      return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const tabs = []; // { name, label, frame, button }
  let at = -1; // the tab shown
  let shown = false;
  let count = 0; // the labels: Terminal 1, 2 …
  let first = true; // the first look at the kept shells
  const keep = () => {
    try {
      if (tabs.length) sessionStorage.setItem(key, JSON.stringify(tabs.map((t) => t.name)));
      else sessionStorage.removeItem(key);
    } catch {
      /* a browser without storage: a reload starts a new shell */
    }
  };
  const note = h('p.chat-term-note.hidden', { role: 'status' });
  const bar = h('div.chat-term-tabs', { role: 'tablist', 'aria-label': 'Terminals' });
  const box = h('div.chat-term-box');
  const el = h('section.chat-termpane.hidden', { 'aria-label': 'Terminal' },
    h('div.chat-term-bar', bar,
      h('div.chat-term-tools',
        btn('icon ghost small chat-term-add', { icon: 'plus', title: 'New terminal', 'aria-label': 'New terminal', onclick: () => add() }),
        btn('icon ghost small chat-term-kill', { icon: 'trash', title: 'End this terminal', 'aria-label': 'End this terminal', onclick: () => kill() }),
        btn('icon ghost small chat-term-hide', { icon: 'x', title: 'Hide the terminal (Ctrl+`)', 'aria-label': 'Hide the terminal', onclick: () => hide() }))),
    note, box);

  const say = (text) => {
    fill(note, text || '');
    note.classList.toggle('hidden', !text);
  };

  async function alive(name) {
    try {
      await api(`/api/sessions/${encodeURIComponent(name)}`);
      return true;
    } catch (e) {
      return e.status !== 404;
    }
  }

  function paintTabs() {
    fill(bar, tabs.map((t, n) => {
      t.button.setAttribute('aria-selected', String(n === at));
      t.button.classList.toggle('on', n === at);
      return t.button;
    }));
    tabs.forEach((t, n) => t.frame.classList.toggle('hidden', n !== at));
  }

  function focus() {
    const t = tabs[at];
    if (!t) return;
    t.frame.focus();
    try {
      t.frame.contentWindow.dispatchEvent(new Event('resize')); // a frame shown again fits its terminal to its size
      t.frame.contentWindow.postMessage({ type: 'hoprig:keys' }, location.origin);
    } catch {
      /* still loading: its load does it */
    }
  }

  function select(n) {
    at = n;
    paintTabs();
    if (shown) focus();
  }

  function mount(name) {
    count += 1;
    const hash = sessionHash(name, machine.current);
    const src = frameSrc(hash, location.pathname, { home: hash, label: 'Terminal' });
    const frame = h('iframe.chat-term-frame', { src, title: `Terminal ${count}`, dataset: { session: name } });
    const t = { name, frame, button: null };
    t.button = h('button.chat-term-tab', { type: 'button', role: 'tab', onclick: () => select(tabs.indexOf(t)) }, `Terminal ${count}`);
    frame.addEventListener('load', () => {
      try {
        // Only the terminal: the session page's bar, keys and message box go (editor.css, as in the editor's panel).
        frame.contentDocument.documentElement.classList.add('ed-term-panel');
        // Ctrl+` hides the pane while the shell has the keyboard (the frame is this same site); every other key is the shell's.
        frame.contentWindow.addEventListener('keydown', (e) => {
          if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'Backquote') {
            e.preventDefault();
            e.stopPropagation();
            hide();
          }
        }, true);
      } catch {
        /* not this site: nothing to add */
      }
      if (shown && tabs[at] === t) focus();
    });
    tabs.push(t);
    addTo(box, frame);
    return tabs.length - 1;
  }

  async function add() {
    say('Starting a terminal…');
    try {
      const { name } = await api('/api/shells', { dir: o.cwd(), chat: o.id });
      say('');
      select(mount(name));
      keep();
    } catch (e) {
      say(`No terminal here: ${e.message}.`);
    }
  }

  async function show() {
    shown = true;
    el.classList.remove('hidden');
    o.onToggle && o.onToggle(true);
    if (first) {
      first = false;
      for (const name of keptNames()) if (await alive(name)) mount(name);
      if (tabs.length) {
        keep();
        select(tabs.length - 1);
      }
    }
    if (!shown) return;
    if (!tabs.length) await add();
    else {
      paintTabs();
      focus();
    }
  }

  function hide() {
    if (!shown) return;
    shown = false;
    el.classList.add('hidden');
    o.onToggle && o.onToggle(false);
  }

  async function kill() {
    const t = tabs[at];
    if (!t) return hide();
    tabs.splice(at, 1);
    t.frame.remove();
    at = tabs.length - 1;
    keep();
    paintTabs();
    if (!tabs.length) hide();
    else if (shown) focus();
    await api(`/api/sessions/${encodeURIComponent(t.name)}/kill`, {}).catch(() => {});
  }

  return {
    el,
    get shown() {
      return shown;
    },
    toggle: () => (shown ? hide() : show()),
    show,
    hide,
  };
}
