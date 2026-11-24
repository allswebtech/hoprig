// The editor's panel with its terminal (Ctrl+` and Ctrl+J, as in VS Code): the dashboard's own terminal, a new shell
// in the opened folder by the same route and rules as desktop mode's Terminal (POST /api/shells), shown as its session
// page in a frame, as a Terminal window of the desktop shows it. Hiding the panel keeps the shell running (VS Code
// does the same); the bin button ends it. A reload of the page finds the same shell again (kept per folder in this
// tab). Where the computer gives no terminal (a hub, none installed), the panel says why in one line.
import { api, at, btn, fill, h } from '../lib.js';
import { frameSrc, sessionHash } from '../desktop/apps.js';
import { strokeOf, terminalKeyReader } from './commands.js';

/** wb: { root, machine, onHide(), run(id): a command of commands.js }. */
export function createTerminal(wb) {
  const key = `hoprig.editor.terminal:${wb.machine || ''}:${wb.root}`;
  const kept = () => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const keep = (v) => {
    try {
      if (v) sessionStorage.setItem(key, v);
      else sessionStorage.removeItem(key);
    } catch {
      /* a browser without storage: a reload starts a new shell */
    }
  };
  let name = kept();
  let frame = null;
  let shown = false;
  const note = h('p.ed-panelnote.hidden', { role: 'status' });
  const box = h('div.ed-termbox');
  const el = h('section.ed-panelarea.hidden', { 'aria-label': 'Terminal' },
    h('div.ed-panelbar',
      h('h2.ed-paneltitle', 'Terminal'),
      h('div.ed-paneltools',
        btn('icon ghost small', { icon: 'trash', title: 'Kill the terminal', onclick: () => kill() }),
        btn('icon ghost small', { icon: 'x', title: 'Hide the panel (Ctrl+J)', onclick: () => hide() }))),
    note, box);

  const say = (text) => {
    fill(note, text || '');
    note.classList.toggle('hidden', !text);
  };

  async function alive(n) {
    try {
      await api(at(wb.machine, `/api/sessions/${encodeURIComponent(n)}`));
      return true;
    } catch (e) {
      return e.status !== 404;
    }
  }

  async function start() {
    if (name && (await alive(name))) return name;
    say('Starting a terminal…');
    try {
      name = (await api(at(wb.machine, '/api/shells'), { dir: wb.root })).name;
    } catch (e) {
      name = null;
      keep(null);
      say(`No terminal here: ${e.message}.`);
      return null;
    }
    keep(name);
    say('');
    return name;
  }

  function mount(n) {
    const src = frameSrc(sessionHash(n, wb.machine), location.pathname, { home: sessionHash(n, wb.machine), label: 'Terminal' });
    if (frame && frame.dataset.session === n) return;
    frame = h('iframe.ed-termframe', { src, title: 'Terminal', dataset: { session: n } });
    // The panel's keys work while the terminal has the keyboard: the frame is this same site.
    frame.addEventListener('load', () => {
      try {
        // Only the terminal, as in VS Code's panel: the session page's bar, keys and message box go (editor.css).
        frame.contentDocument.documentElement.classList.add('ed-term-panel');
        // The keys VS Code's terminal keeps from the shell (Ctrl+P, Ctrl+Shift+P, F1, Ctrl+J, Ctrl+`) run the page's
        // command; every other key is the shell's.
        const reader = terminalKeyReader();
        frame.contentWindow.addEventListener('keydown', (e) => {
          const r = reader.read(strokeOf(e));
          if (!r || !r.id) return;
          e.preventDefault();
          e.stopPropagation();
          if (r.id === 'panel' || r.id === 'terminal' || !wb.run) hide();
          else wb.run(r.id);
        }, true);
      } catch {
        /* not this site: nothing to add */
      }
      if (shown) focus();
    });
    fill(box, frame);
  }

  function focus() {
    if (!frame) return;
    frame.focus();
    try {
      frame.contentWindow.postMessage({ type: 'hoprig:keys' }, location.origin);
    } catch {
      /* still loading: its load does it */
    }
  }

  async function show() {
    shown = true;
    el.classList.remove('hidden');
    const n = await start();
    if (!shown) return;
    if (n) mount(n);
    else fill(box);
    focus();
  }

  function hide() {
    if (!shown) return;
    shown = false;
    el.classList.add('hidden');
    wb.onHide();
  }

  async function kill() {
    const n = name;
    name = null;
    keep(null);
    fill(box);
    frame = null;
    hide();
    if (n) await api(at(wb.machine, `/api/sessions/${encodeURIComponent(n)}/kill`), {}).catch(() => {});
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
