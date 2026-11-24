// The session list at the left of the App on a wide screen, as the Claude Code desktop app's sidebar: "+ New" at its
// top, then the sessions of every computer the dashboard knows (App sessions and terminals), grouped by folder by
// default, the ones that need the owner marked, the one open now marked as current. The Group and sort icon shows on
// hover over the list's heading (always on a touch screen): Group by Folder, State or Computer, Sort by Recent
// activity or Name, Archived (this computer's archived App sessions, to continue one), Select to delete (several at once), Trash (Put
// back) and View all (Home, which lists them all). A row's own menu (its ⋯ button on hover or focus, always on a touch screen; a right-click; the right arrow): Open in new window, Archive, Delete. Remembered in this browser. Below SIDE_MIN_PX there is
// no list: the head's Back goes to Home, as before. It reads the dashboard's store (store.js), the same list Home draws.
import { icon } from '../icons.js';
import { ago, api, bgCommandNote, chooseSheet, confirmSheet, fill, h, link, needsYou, prefs, stateOf, toast } from '../lib.js';
import { failText } from './words.js';
import { deleteNow, notPickable, pickToDelete, trashSheet } from './deletes.js';
import { closeMenuOf, openMenu } from '../desktop/menu.js';
import { sessionHref } from '../sessionitem.js';

export const SIDE_MIN_PX = 900; // the width from which the list shows (sidebar.css says the same)
/** The screen is wide enough for the list (asked each time). */
export const sideFits = () => typeof matchMedia !== 'undefined' && matchMedia(`(min-width: ${SIDE_MIN_PX}px)`).matches;

export const GROUP_BY = [['folder', 'Folder'], ['state', 'State'], ['computer', 'Computer']];
export const SORT_BY = [['recent', 'Recent activity'], ['name', 'Name']];
// The state groups, in Home's order (home.js GROUPS): what needs the owner first.
const STATES = [['needs', 'Needs you', ['attention', 'limit']], ['working', 'Working', ['working', 'starting']], ['waiting', 'Waiting', ['waiting', 'ended']], ['terminals', 'Terminals', ['shell']]];

const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '') || 'No folder';
const when = (s) => s.statusAt || s.activity || s.created || 0;
export const nameOf = (s) => s.display || s.title || s.name || '';
/** An App session of this computer that Delete takes: Claude Code's (another coding tool's is archived). */
export const deletable = (s) => s.kind === 'chat' && (s.machine ?? null) === null && (s.tool || 'claude') === 'claude';

/**
 * The list's groups. machines: the store's (store.all: { machine, machineLabel, status, sessions }); o: { group
 * ('folder' | 'state' | 'computer'), sort ('recent' | 'name'), multi (several computers: a folder group names its
 * computer) } → [{ key, label, sub (a computer's name or ''), title (the folder's path), needs (how many need the
 * owner), sessions }]. A computer that cannot be reached adds nothing (Home says why).
 */
export function sideGroups(machines, { group = 'folder', sort = 'recent', multi = false } = {}) {
  const all = (machines || []).filter((m) => m && m.status === 'online').flatMap((m) => (m.sessions || []).map((s) => ({ ...s, machine: s.machine ?? m.machine ?? null, machineLabel: s.machineLabel || m.machineLabel || 'This computer' })));
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
    else put(`${s.machine ?? '~'}|${s.cwd || ''}`, { label: base(s.cwd), sub: multi ? s.machineLabel : '', title: s.short || s.cwd || '' }, s);
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
 * o: { store (store.js: all, multi, subscribe), current: { chat, machine }, newSession() (the "+ New" button) }
 * → { el, stop() }
 */
export function createSidebar(o) {
  let group = prefs.get('chat.side.group', 'folder');
  let sort = prefs.get('chat.side.sort', 'recent');
  if (!GROUP_BY.some(([k]) => k === group)) group = 'folder';
  if (!SORT_BY.some(([k]) => k === sort)) sort = 'recent';
  let menu = null;
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
      subtitle: list.length ? 'Of this computer. Choose one to continue its conversation in a new session.' : 'Nothing archived on this computer yet. Archive is in a session\'s menu.',
      items: list.map((x, i) => ({ value: String(i), label: x.title || 'Untitled session', sub: `${x.short} · ${ago(x.at)}`, icon: 'archive' })),
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
      items.push({ label: 'Archive', icon: 'archive', run: async () => {
        if (!(await confirmSheet({ title: 'Archive this session?', text: 'It stops if it is working and leaves the list. The conversation is kept: continue it from Archived in this list\'s menu.', ok: 'Archive' }))) return;
        try {
          await api(`/api/chats/${s.chatId}/close`, {});
          o.store.refresh?.();
          if (isCurrent(s, o.current)) location.hash = link('#/');
        } catch (err) {
          toast(failText(err), { from: err, kind: 'error' });
        }
      } });
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

  let last = '';
  function paint() {
    const machines = o.store.all || [];
    const multi = !!o.store.multi;
    const groups = sideGroups(machines, { group, sort, multi });
    // Drawn again only when something it shows changed (the store asks every few seconds); the times are kept fresh.
    const key = JSON.stringify([group, sort, multi, groups.map((g) => [g.key, g.label, g.sub, g.sessions.map((s) => [s.machine, s.name, nameOf(s), stateOf(s).key, s.chatId])])]);
    if (key === last) {
      for (const t of list.querySelectorAll('[data-at]')) t.textContent = ago(Number(t.dataset.at));
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
        return h('li.chat-side-item', h(`a.chat-side-row.st-${st.key}${needs ? '.needs' : ''}${cur ? '.current' : ''}`, {
          href: sessionHref(s), ...(cur ? { 'aria-current': 'page' } : {}), oncontextmenu: (e) => rowMenu(e, s),
          title: `${nameOf(s)}: ${st.text}${multi && group !== 'computer' && !g.sub ? ` · ${s.machineLabel}` : ''}`,
        },
        h('span.chat-side-dot', { 'aria-hidden': 'true' }),
        h('span.chat-side-name', nameOf(s)),
        h('span.chat-sr', `, ${st.text}${bgCommandNote(s) ? `. ${bgCommandNote(s)}` : ''}`), // the state the dot shows (and a background command, if any), for a screen reader
        s.kind !== 'chat' ? h('span.chat-side-kind', { title: 'A terminal session' }, icon('terminal', { size: 12 })) : null,
        needs ? h('span.chat-side-needs', st.key === 'limit' ? 'Limit' : 'Needs you') : at ? h('span.chat-side-at', { dataset: { at } }, ago(at)) : null),
        h('button.btn.icon.ghost.chat-side-more', { type: 'button', tabindex: '-1', title: 'More', 'aria-label': `More for ${nameOf(s)}`, 'aria-haspopup': 'menu', onclick: (e) => rowMenu(e, s) }, icon('more', { size: 15 })));
      })))));
    rove();
  }
  const unsubscribe = o.store.subscribe(() => paint());
  return {
    el,
    stop() {
      unsubscribe();
      closeMenuOf(menu);
    },
  };
}
