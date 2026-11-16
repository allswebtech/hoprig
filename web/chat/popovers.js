// The composer's two menus, as in Claude Code: "/" at the start of the box lists the commands (the page's own:
// compact, clear, model … and the coding tool's commands and skills, from GET /commands), "@" anywhere lists the
// files of the chat's folder (GET /files?q=). Both filter as you type and are driven by the keyboard: up and down
// choose, Enter or Tab takes, Escape closes. On a phone the menu is a sheet over the conversation, above the box (and
// so above the keyboard).
import { api, fill, h } from '../lib.js';

const FILES_WAIT_MS = 120;
const SHOWN_MAX = 50;
// The coding tool's commands the page does itself (its own entries) or that need its terminal.
const HIDDEN = new Set(['clear', 'compact', 'model', 'effort', 'resume', 'continue', 'help', 'rewind', 'login', 'logout', 'exit', 'quit', 'doctor', 'color', 'focus', 'reload-plugins', 'terminal-setup', 'vim', 'theme', 'statusline', 'ide', 'config', 'permissions']);
let seq = 0;

/** What the text before the caret asks for: { type: '/', q, from } or { type: '@', q, from } or null. */
export function menuAt(text, caret) {
  const before = String(text).slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { type: '/', q: slash[1], from: 0 };
  const at = /(^|\s)@("?[^\s"]*)$/.exec(before);
  if (at) return { type: '@', q: at[2].replace(/^"/, ''), from: before.length - at[2].length - 1 };
  return null;
}

/** The commands that match `q`, best first: the name starting with it, then the name containing it, then the words. */
export function filterCommands(list, q) {
  const s = String(q || '').toLowerCase();
  if (!s) return list;
  // The words count from three letters on: "co" would find half of every description.
  const rank = (c) => (c.name.toLowerCase().startsWith(s) ? 0 : c.name.toLowerCase().includes(s) ? 1 : s.length >= 3 && (c.description || '').toLowerCase().includes(s) ? 2 : 3);
  return list.map((c) => [c, rank(c)]).filter(([, r]) => r < 3).sort((a, b) => a[1] - b[1]).map(([c]) => c);
}

/** The coding tool's commands as menu entries, without those the page does itself. */
export const toolCommands = (list) => (list || []).filter((c) => c && c.name && !HIDDEN.has(c.name)).map((c) => ({ name: c.name, description: c.description || '', hint: c.argumentHint || '', skill: c.builtin === false }));

/** How a file is written into the message for the coding tool to read: @path, in quotes when it has a space. */
export const mention = (p) => `@${/\s/.test(p) ? `"${p}"` : p} `;

/**
 * o: { textarea, A, own() (the page's own commands: [{ name, description, run() }]), send(text) }
 * → { el, key(e) (true when the menu took the key), update(), close() }
 */
export function createMenus(o) {
  const id = `chat-menu-${++seq}`;
  const head = h('p.chat-pop-head');
  const list = h('div.chat-pop-list', { id, role: 'listbox' });
  const el = h('div.chat-pop.hidden', head, list);
  let at = null; // what is open: menuAt()
  let items = [];
  let active = 0;
  let commands = null; // the coding tool's, once asked
  let asking = null;
  let filesTimer = 0;
  let filesSeq = 0;
  const ta = o.textarea;
  ta.setAttribute('aria-autocomplete', 'list');
  ta.setAttribute('aria-controls', id);
  ta.setAttribute('aria-expanded', 'false');

  function close() {
    at = null;
    items = [];
    el.classList.add('hidden');
    ta.setAttribute('aria-expanded', 'false');
    ta.removeAttribute('aria-activedescendant');
    clearTimeout(filesTimer);
  }

  function paint(note = '') {
    el.classList.remove('hidden');
    ta.setAttribute('aria-expanded', 'true');
    const what = at.type === '/' ? 'Commands' : 'Files of this folder';
    list.setAttribute('aria-label', what);
    fill(head, h('strong', what), h('span', note || (items.length ? '↑ ↓ choose · Enter takes · Esc closes' : '')));
    fill(list, items.length ? items.map((it, n) => {
      const opt = h(`div.chat-pop-item${n === active ? '.chat-is-active' : ''}`, {
        id: `${id}-${n}`, role: 'option', 'aria-selected': String(n === active),
        onmousedown: (e) => e.preventDefault(), // the box keeps the focus (and a phone its keyboard)
        onclick: () => take(n, false),
      }, it.view);
      return opt;
    }) : h('p.chat-pop-empty', note ? '' : at.type === '/' ? 'No command matches.' : 'No file matches.'));
    if (items.length) {
      ta.setAttribute('aria-activedescendant', `${id}-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else ta.removeAttribute('aria-activedescendant');
  }

  function commandItems(q) {
    const own = o.own().map((c) => ({ ...c, own: true }));
    const all = filterCommands([...own, ...(commands || [])], q).slice(0, SHOWN_MAX);
    return all.map((c) => ({
      ...c,
      view: [h('span.chat-pop-name', `/${c.name}`, c.hint ? h('span.chat-pop-hint', ` ${c.hint}`) : null),
        h('span.chat-pop-desc', c.description || (c.skill ? 'A skill' : '')),
        h('span.chat-pop-tag', c.own ? 'Hoprig' : c.skill ? 'Skill' : 'Claude Code')],
    }));
  }

  async function showCommands() {
    items = commandItems(at.q);
    active = Math.min(active, Math.max(0, items.length - 1));
    paint(commands ? '' : 'Loading the commands…');
    if (commands || asking) return;
    asking = api(`${o.A}/commands`).then((r) => {
      commands = toolCommands(r.commands);
    }, () => {
      commands = null; // asked again next time
    }).finally(() => {
      asking = null;
      if (at && at.type === '/') showCommands();
    });
  }

  function showFiles() {
    clearTimeout(filesTimer);
    const q = at.q;
    const mine = ++filesSeq;
    if (!items.length) paint('Looking…');
    filesTimer = setTimeout(async () => {
      let files = [];
      try {
        files = (await api(`${o.A}/files?q=${encodeURIComponent(q)}`)).files || [];
      } catch (e) {
        if (mine === filesSeq && at) paint(e.message);
        return;
      }
      if (mine !== filesSeq || !at || at.type !== '@') return; // typed on meanwhile
      items = files.map((p) => {
        const cut = p.lastIndexOf('/');
        return { path: p, view: [h('span.chat-pop-name', p.slice(cut + 1)), h('span.chat-pop-desc', cut > 0 ? p.slice(0, cut) : '')] };
      });
      active = 0;
      paint();
    }, FILES_WAIT_MS);
  }

  /** Take item n: a command runs (or, with `complete` or an argument to give, goes into the box); a file goes in. */
  function take(n, complete) {
    const it = items[n];
    if (!it || !at) return;
    const v = ta.value;
    if (at.type === '@') {
      const end = ta.selectionStart;
      const put = mention(it.path);
      ta.value = v.slice(0, at.from) + put + v.slice(end).replace(/^\s+/, '');
      const caret = at.from + put.length;
      ta.setSelectionRange(caret, caret);
    } else if (it.own && !complete) {
      ta.value = '';
      close();
      ta.dispatchEvent(new Event('input'));
      return it.run();
    } else if (complete || it.hint) {
      ta.value = `/${it.name} `;
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } else {
      ta.value = '';
      close();
      ta.dispatchEvent(new Event('input'));
      return o.send(`/${it.name}`);
    }
    close();
    ta.dispatchEvent(new Event('input'));
    ta.focus();
  }

  return {
    el,
    close,
    get open() {
      return !!at;
    },
    /** After the text or the caret moved: open, filter or close. */
    update() {
      const now = ta.disabled ? null : menuAt(ta.value, ta.selectionStart);
      if (!now) return close();
      const changed = !at || at.type !== now.type || at.q !== now.q;
      if (at && at.type !== now.type) items = [];
      at = now;
      if (!changed) return;
      active = 0;
      if (at.type === '/') showCommands();
      else showFiles();
    },
    /** A key in the box: true when the open menu used it. */
    key(e) {
      if (!at) return false;
      if (e.key === 'Escape') {
        close();
        return true;
      }
      if (!items.length) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        paint();
        return true;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey)) {
        take(active, e.key === 'Tab');
        return true;
      }
      return false;
    },
  };
}
