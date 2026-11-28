// The session list at the left of the App on a wide screen, as the Claude Code desktop app's sidebar: "+ New" at its
// top, then the sessions of every computer the dashboard knows (App sessions and terminals), grouped by folder by
// default, every row one line (the name; a dot for its state; a second line only for a session that needs the owner or failed), the one open now marked as current. The Group and sort icon shows on
// hover over the list's heading (always on a touch screen): Group by Folder, State or Computer, Sort by Recent
// activity or Name, Archived (this computer's archived App sessions, to continue one), Select to delete (several at once), Trash (Put
// back) and View all (Home, which lists them all). A row's own menu (its ⋯ button on hover or focus, always on a touch screen; a right-click; the right arrow): Open in new window, Archive, Delete. Remembered in this browser. A row's state and time are in its title. Over the chat (below SIDE_MIN_PX) the list has a head: Home and a close button. Archive asks nothing (a toast with Undo), only for a session
// that is working. Below SIDE_MIN_PX the list is not beside the chat: the head's list button opens it over the chat (overlay()). It reads the dashboard's store (store.js), the same list Home draws.
import { icon } from '../icons.js';
import { ago, api, bgCommandNote, chooseSheet, confirmSheet, fill, h, link, needsYou, prefs, stateOf, toast, worktreeOf } from '../lib.js';
import { failText } from './words.js';
import { endPaneShells } from './termpane.js';
import { deleteNow, notPickable, pickToDelete, trashSheet } from './deletes.js';
import { closeMenuOf, openMenu } from '../desktop/menu.js';
import { sessionHref } from '../sessionitem.js';
import { oneCardPerKey } from '../onecard.js';

export const SIDE_MIN_PX = 900; // the width from which the list shows (sidebar.css says the same)
/** The screen is wide enough for the list (asked each time). */
export const sideFits = () => typeof matchMedia !== 'undefined' && matchMedia(`(min-width: ${SIDE_MIN_PX}px)`).matches;

export const GROUP_BY = [['folder', 'Folder'], ['state', 'State'], ['computer', 'Computer']];
export const SORT_BY = [['recent', 'Recent activity'], ['name', 'Name']];
// The state groups, in Home's order (home.js GROUPS): what needs the owner first.
const STATES = [['needs', 'Needs you', ['attention', 'limit']], ['working', 'Working', ['working', 'starting']], ['waiting', 'Finished', ['waiting', 'ended']], ['terminals', 'Terminals', ['shell']]];

const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '') || 'No folder';
const when = (s) => s.statusAt || s.activity || s.created || 0;
/** The branch a session works on when it runs in a chat's own worktree, else null (its group is its project). */
export const branchOf = (s) => (worktreeOf(s.cwd) || {}).branch || null;
export const nameOf = (s) => s.display || s.title || s.name || '';
/**
 * Archive an App session of this computer, as the desktop app does: no question first, a toast "Archived" with Undo (which
 * opens the same conversation again). It asks only for a session that is working ("Archive anyway"). o: { chatId, working,
 * refresh() (the list is read again), gone() (the page of this session goes) } → true when it was archived.
 */
export async function archiveSession({ chatId, working = false, cwd = '', refresh = null, gone = null }) {
  if (working && !(await confirmSheet({ title: 'Archive this session?', text: 'It is working: archiving stops it. The conversation is kept.', ok: 'Archive anyway' }))) return false;
  // A session on a branch of its own (its folder is under .claude/worktrees/) with changes not committed: they stay in that
  // folder, but the owner is told first.
  if (/[\\/]\.claude[\\/]worktrees[\\/]/.test(String(cwd))) {
    const c = await api(`/api/chats/${chatId}/changes`).catch(() => null);
    if (c && c.git && c.files > 0 && !(await confirmSheet({ title: 'Archive this session?', text: `Its branch has ${c.files} change${c.files === 1 ? '' : 's'} that are not committed. They stay in its folder; archiving does not remove them.`, ok: 'Archive anyway' }))) return false;
  }
  let r;
  try {
    r = await api(`/api/chats/${chatId}/close`, {});
  } catch (e) {
    toast(failText(e), { from: e, kind: 'error' });
    return false;
  }
  endPaneShells(chatId); // the pane's own shells go with the chat
  refresh?.();
  gone?.();
  const restore = r && r.restore;
  toast('Archived', { ms: 8000, ...(restore ? { action: { label: 'Undo', run: async () => {
    try {
      await api('/api/chats', restore);
      refresh?.();
    } catch (e) {
      toast(failText(e), { from: e, kind: 'error' });
    }
  } } } : {}) });
  return true;
}

/** An App session of this computer that Delete takes: Claude Code's (another coding tool's is archived). */
export const deletable = (s) => s.kind === 'chat' && (s.machine ?? null) === null && (s.tool || 'claude') === 'claude';

/**
 * The list's groups. machines: the store's (store.all: { machine, machineLabel, status, sessions }); o: { group
 * ('folder' | 'state' | 'computer'), sort ('recent' | 'name'), multi (several computers: a folder group names its
 * computer) } → [{ key, label, sub (a computer's name or ''), title (the folder's path), needs (how many need the
 * owner), sessions }]. A computer that cannot be reached adds nothing (Home says why).
 */
export function sideGroups(machines, { group = 'folder', sort = 'recent', multi = false } = {}) {
  // One row per conversation (onecard.js), as on Home.
  const all = oneCardPerKey((machines || []).filter((m) => m && m.status === 'online').flatMap((m) => (m.sessions || []).map((s) => ({ ...s, machine: s.machine ?? m.machine ?? null, machineLabel: s.machineLabel || m.machineLabel || 'This computer' }))));
  const bySort = sort === 'name' ? (a, b) => nameOf(a).localeCompare(nameOf(b)) || when(b) - when(a) : (a, b) => when(b) - when(a) || nameOf(a).localeCompare(nameOf(b));
  const groups = new Map();
  const put = (key, made, s) => {
    if (!groups.has(key)) groups.set(key, { key, ...made, sessions: [] });
    groups.get(key).sessions.push(s);
  };
  for (const s of all) {
    if (group === 'state') {
      const st = stateOf(s).key;
      const g = STATES.find(([, , keys]) => keys.includes(st)) || STATES[2];
      put(g[0], { label: g[1], sub: '', title: '' }, s);
    } else if (group === 'computer') put(`m:${s.machine ?? '~'}`, { label: s.machineLabel, sub: '', title: '' }, s);
    else {
      // A chat in its own worktree is listed under its project, not as a project of its own.
      const wt = worktreeOf(s.cwd);
      const dir = wt ? wt.project : s.cwd || '';
      put(`${s.machine ?? '~'}|${dir}`, { label: base(dir), sub: multi ? s.machineLabel : '', title: (wt ? String(s.short || '').replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '') : s.short) || dir }, s);
    }
  }
  const out = [...groups.values()];
  for (const g of out) {
    g.sessions.sort(bySort);
    g.needs = g.sessions.filter(needsYou).length;
  }
  if (group === 'state') out.sort((a, b) => STATES.findIndex((x) => x[0] === a.key) - STATES.findIndex((x) => x[0] === b.key));
  else if (sort === 'name') out.sort((a, b) => a.label.localeCompare(b.label) || a.sub.localeCompare(b.sub));
  else out.sort((a, b) => when(b.sessions[0]) - when(a.sessions[0]));
  return out;
}

/** What Select to delete offers: Claude Code's App sessions of this computer, newest first (store: store.js). */
export const deletableHere = (store) => ((store.all || []).find((m) => (m.machine ?? null) === null) || { sessions: [] }).sessions
  .map((s) => ({ ...s, machine: s.machine ?? null })).filter(deletable).sort((a, b) => when(b) - when(a));

/** Is `s` the session open now? current: { chat (its id), machine (null: this computer) } */
export const isCurrent = (s, current) => !!current && s.kind === 'chat' && s.chatId === current.chat && (s.machine ?? null) === (current.machine ?? null);

/**
 * The session `d` rows on from the open one (1: the next, -1: the previous) in the list's order as drawn (`groups`:
 * sideGroups), round at the ends, as the desktop app's Ctrl+Shift+] and [ go. Null with fewer than two sessions.
 */
export function sessionAfter(groups, current, d) {
  const rows = (groups || []).flatMap((g) => g.sessions);
  if (rows.length < 2) return null;
  const i = rows.findIndex((s) => isCurrent(s, current));
  if (i < 0) return d > 0 ? rows[0] : rows[rows.length - 1];
  return rows[(i + (d > 0 ? 1 : -1) + rows.length) % rows.length];
}

/**
 * o: { store (store.js: all, multi, subscribe), current: { chat, machine }, newSession() (the "+ New" button), onOverlay(on) (the
 * list opened or closed over the chat) }
 * → { el, stop() }
 */
export function createSidebar(o) {
  let group = prefs.get('chat.side.group', 'folder');
  let sort = prefs.get('chat.side.sort', 'recent');
  if (!GROUP_BY.some(([k]) => k === group)) group = 'folder';
  if (!SORT_BY.some(([k]) => k === sort)) sort = 'recent';
  let menu = null;
  let over = null; // the list opened over the chat below SIDE_MIN_PX: { scrim, off() }
  // One tab stop for the whole list (the open session, else the first), the arrow keys inside it: with many sessions
  // the keyboard would otherwise tab through every row before it reaches the chat.
  const list = h('nav.chat-side-list', { 'aria-label': 'Sessions (arrow keys move between them, right arrow opens a row\'s menu)', onkeydown: (e) => {
    const rows = [...list.querySelectorAll('.chat-side-row')];
    const i = rows.indexOf(e.target);
    if (i < 0) return;
    // The row's menu from the keyboard: the ⋯ button's (the menu key opens it as a right-click).
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      return rows[i].parentNode.querySelector('.chat-side-more')?.click();
    }
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null;
    if (to === null || !rows[to]) return;
    e.preventDefault();
    for (const r of rows) r.setAttribute('tabindex', r === rows[to] ? '0' : '-1');
    rows[to].focus();
  } });
  function rove() {
    const rows = [...list.querySelectorAll('.chat-side-row')];
    const stop = rows.find((r) => r.classList.contains('current')) || rows[0];
    for (const r of rows) r.setAttribute('tabindex', r === stop ? '0' : '-1');
  }
  const sortBtn = h('button.btn.icon.ghost.chat-side-sort', { type: 'button', title: 'Group and sort', 'aria-label': 'Group and sort', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => sortMenu() }, icon('sort', { size: 15 }));
  const el = h('aside.chat-side', { 'aria-label': 'Session list' },
    // Over the chat only (sidebar.css): the way Home and the way out, as the Claude apps' drawer has them.
    h('div.chat-side-over-head',
      h('a.btn.ghost.chat-side-home', { href: link('#/'), onclick: () => overlay(false) }, icon('home', { size: 18 }), h('span', 'Home')),
      h('button.btn.icon.ghost.chat-side-close', { type: 'button', title: 'Close the list', 'aria-label': 'Close the list', onclick: () => overlay(false) }, icon('x', { size: 18 }))),
    h('div.chat-side-top', h('button.btn.secondary.chat-side-new', { type: 'button', onclick: () => o.newSession() }, icon('plus', { size: 16 }), h('span', 'New'))),
    h('div.chat-side-head', h('span', 'Sessions'), sortBtn),
    list);

  function sortMenu() {
    const r = sortBtn.getBoundingClientRect();
    const multi = !!o.store.multi;
    const set = (k, x) => () => {
      if (k === 'group') group = x;
      else sort = x;
      prefs.set(`chat.side.${k}`, x);
      paint();
    };
    menu = openMenu(r.left, r.bottom + 4, [
      { label: 'Group by', icon: 'grid', items: GROUP_BY.filter(([k]) => k !== 'computer' || multi || group === 'computer').map(([k, label]) => ({ label, checked: group === k, run: set('group', k) })) },
      { label: 'Sort by', icon: 'clock', items: SORT_BY.map(([k, label]) => ({ label, checked: sort === k, run: set('sort', k) })) },
      null,
      { label: 'Archived', icon: 'archive', run: () => archivedSheet() },
      { label: 'Select to delete', icon: 'checkAll', run: () => pickHere() },
      { label: 'Trash', icon: 'trashBack', run: () => trashSheet({ after: () => o.store.refresh?.() }) },
      { label: 'View all', icon: 'home', run: () => { location.hash = link('#/'); } },
    ], 'Group and sort', { from: sortBtn });
  }

  // The archived App sessions of this computer (GET /api/chats/archived): one is continued in a new App session.
  async function archivedSheet() {
    let list;
    try {
      list = (await api('/api/chats/archived')).list || [];
    } catch (e) {
      return toast(failText(e), { from: e, kind: 'error' });
    }
    const pick = await chooseSheet({
      title: 'Archived sessions',
      subtitle: list.length ? 'Of this computer. Choose one to unarchive it: its conversation goes back to the list.' : 'Nothing archived on this computer yet. Archive is in a session\'s menu.',
      items: list.map((x, i) => ({ value: String(i), label: x.title || 'Untitled session', sub: `${x.short} · ${ago(x.at)}`, icon: 'archive', badge: 'Unarchive' })),
    });
    if (pick === null || pick === undefined || !list[Number(pick)]) return;
    const x = list[Number(pick)];
    try {
      const r = await api('/api/chats', { dir: x.cwd, tool: x.tool, profile: x.profile, sessionId: x.conversationId });
      location.hash = link(`#/chat/${r.id}`);
    } catch (e) {
      toast(failText(e), { from: e, kind: 'error' });
    }
  }

  // Select to delete: the open session among the deleted ones goes Home, as the row's and the session's Delete do.
  async function pickHere() {
    const r = await pickToDelete(mineHere(), nameOf, { after: () => o.store.refresh?.() });
    if (r && o.current && r.deleted.some((x) => x.chat === o.current.chat) && (o.current.machine ?? null) === null) location.hash = link('#/');
  }

  // A row's own menu, as the desktop app's: its ⋯ button (on hover, on the keyboard's focus, always on a touch
  // screen), a right-click or the keyboard's menu key. Open in a new window; Archive and Delete for an App session here.
  function rowMenu(e, s) {
    e.preventDefault();
    e.stopPropagation?.();
    const items = [{ label: 'Open in new window', icon: 'external', run: () => window.open(link(sessionHref(s)), '_blank', 'noopener') }];
    if (s.kind === 'chat' && (s.machine ?? null) === null) {
      items.push({ label: 'Archive', icon: 'archive', run: () => archiveSession({ chatId: s.chatId, cwd: s.cwd, working: ['working', 'starting'].includes(stateOf(s).key), refresh: () => o.store.refresh?.(), gone: () => isCurrent(s, o.current) && (location.hash = link('#/')) }) });
    }
    if (deletable(s)) {
      const why = notPickable(s);
      items.push({ label: 'Delete', icon: 'trash', danger: true, ...(why ? { label: `Delete (${why.charAt(0).toLowerCase()}${why.slice(1)})`, disabled: true } : {}), run: async () => {
        const r = await deleteNow({ chats: [s.chatId] }, [nameOf(s)], { after: () => o.store.refresh?.() });
        if (r && r.deleted.length && isCurrent(s, o.current)) location.hash = link('#/');
      } });
    }
    const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : (() => {
      const r = e.currentTarget.getBoundingClientRect();
      return { x: r.left, y: r.bottom + 4 };
    })();
    menu = openMenu(at.x, at.y, items, nameOf(s), { from: e.currentTarget });
  }

  // The App sessions of this computer in the list, newest first: what Select to delete offers.
  const mineHere = () => deletableHere(o.store);

  // The state, the time, the computer and the branch are in the row's title: the row itself is the name and a dot.
  const rowTitle = (head, at, tail) => `${head}${Number(at) ? ` · ${ago(Number(at))}` : ''}${tail}`;
  /** The second line: only for a session that needs the owner (an OK, a question, a limit) or failed. */
  const secondLine = (s, st) => (needsYou(s) || s.endedInError ? { text: st.text, bad: !['attention', 'limit'].includes(st.key) } : null);
  let last = '';
  function paint() {
    const machines = o.store.all || [];
    const multi = !!o.store.multi;
    const groups = sideGroups(machines, { group, sort, multi });
    // Drawn again only when something it shows changed (the store asks every few seconds); the times are kept fresh.
    const key = JSON.stringify([group, sort, multi, groups.map((g) => [g.key, g.label, g.sub, g.sessions.map((s) => [s.machine, s.name, nameOf(s), stateOf(s).key, s.chatId])])]);
    if (key === last) {
      for (const a of list.querySelectorAll('a[data-at]')) a.title = rowTitle(a.dataset.head, a.dataset.at, a.dataset.tail);
      return;
    }
    last = key;
    if (!groups.length) return fill(list, h('p.chat-side-empty', 'No sessions yet.'));
    fill(list, groups.map((g) => h('section.chat-side-group', { 'aria-label': g.label },
      h('h2.chat-side-ghead', { title: `${g.title || g.label}${g.sub ? ` · ${g.sub}` : ''}` }, // both names whole, where either is cut
        group === 'folder' ? icon('folder', { size: 13 }) : null,
        h('span.chat-side-glabel', g.label), g.sub ? h('span.chat-side-gsub', g.sub) : null,
        g.needs ? h('span.chat-side-gneeds', { title: `${g.needs} need${g.needs === 1 ? 's' : ''} you` }, String(g.needs)) : null),
      h('ul', g.sessions.map((s) => {
        const st = stateOf(s);
        const cur = isCurrent(s, o.current);
        const needs = needsYou(s);
        const at = when(s);
        const head = `${nameOf(s)}: ${st.text}`;
        const tail = `${multi && group !== 'computer' && !g.sub ? ` · ${s.machineLabel}` : ''}${branchOf(s) ? ` · ${branchOf(s)}` : ''}`;
        const second = secondLine(s, st);
        return h('li.chat-side-item', h(`a.chat-side-row.st-${st.key}${needs ? '.needs' : ''}${cur ? '.current' : ''}`, {
          href: sessionHref(s), ...(cur ? { 'aria-current': 'page' } : {}), oncontextmenu: (e) => rowMenu(e, s),
          title: rowTitle(head, at, tail), dataset: { head, at: at || '', tail },
        },
        h('span.chat-side-dot', { 'aria-hidden': 'true' }),
        // One line: the name. Only what needs the owner or failed says so under it, in words (as Claude Code's rows
        // are only the name and a status circle).
        h('span.chat-side-text',
          h('span.chat-side-name', nameOf(s)),
          second ? h(`span.chat-side-meta${second.bad ? '.bad' : ''}`, { 'aria-hidden': 'true' }, second.text) : null),
        h('span.chat-sr', `, ${st.text}${bgCommandNote(s) ? `. ${bgCommandNote(s)}` : ''}`), // the state the dot shows (and a background command, if any), for a screen reader
        s.kind !== 'chat' ? h('span.chat-side-kind', { title: 'A terminal session' }, icon('terminal', { size: 12 })) : null),
        h('button.btn.icon.ghost.chat-side-more', { type: 'button', tabindex: '-1', title: 'More', 'aria-label': `More for ${nameOf(s)}`, 'aria-haspopup': 'menu', onclick: (e) => rowMenu(e, s) }, icon('more', { size: 15 })));
      })))));
    rove();
  }
  const unsubscribe = o.store.subscribe(() => paint());
  el.addEventListener('click', (e) => over && e.target.closest && e.target.closest('a.chat-side-row') && overlay(false)); // a row chosen: the list goes
  // Narrower than SIDE_MIN_PX (a phone, a half-screen window): the list is over the chat; a tap outside it or Escape closes it.
  function overlay(on = !over) {
    const wrap = el.parentNode;
    if (!wrap || on === !!over) return !!over;
    if (!on) {
      over.off();
      return false;
    }
    const scrim = h('div.chat-side-scrim', { onclick: () => overlay(false) });
    const key = (e) => {
      if (e.key === 'Escape') overlay(false);
    };
    const opener = document.activeElement;
    el.after(scrim);
    wrap.classList.add('chat-side-over');
    o.onOverlay?.(true);
    document.addEventListener('keydown', key);
    over = { off() {
      scrim.remove();
      wrap.classList.remove('chat-side-over');
      document.removeEventListener('keydown', key);
      over = null;
      o.onOverlay?.(false);
      if (opener && opener.isConnected && opener !== document.body) opener.focus();
    } };
    (list.querySelector('.chat-side-row[tabindex="0"]') || list.querySelector('.chat-side-row') || el.querySelector('button'))?.focus();
    return true;
  }
  return {
    el,
    overlay,
    /** Open the next (1) or the previous (-1) session of the list (the keys Ctrl+Shift+] and [). */
    go(d) {
      const s = sessionAfter(sideGroups(o.store.all || [], { group, sort, multi: !!o.store.multi }), o.current, d);
      if (s) location.hash = sessionHref(s);
    },
    stop() {
      over?.off();
      unsubscribe();
      closeMenuOf(menu);
    },
  };
}
