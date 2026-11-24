// Delete on the page (the server's src/chat/deletes.mjs): from a session's row menu and the session menu, several at
// once from the list's menu (Select to delete), and the trash (Put back). Before the press the sheet says what goes:
// the names, how many, and that the transcript is removed for good after 30 days. After it, a toast with Undo.
import { ago, api, closeSheet, fill, h, link, openSheet, toast } from '../lib.js';
import { failText } from './words.js';

export const KEEP_DAYS = 30;

/** The day an entry of the trash goes for good, as a date ("on 18 Dec"; with the year when it is another one). */
export function goneOn(ms, now = Date.now()) {
  const d = new Date(ms);
  const year = d.getFullYear() !== new Date(now).getFullYear();
  return `on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) })}`;
}

/** Whether `s` can be picked to delete, else why not: one at work or waiting for an OK stays. → '' or the reason */
export function notPickable(s) {
  if (s.status === 'attention') return 'Waits for your OK: answer it first';
  if (s.status === 'working' || s.status === 'starting') return 'Working: stop it first';
  return '';
}

/**
 * What the confirmation says before the press. names: the sessions' names; kind: 'session' (an App session, it
 * leaves the list) or 'conversation' (an ended one of the folder's Earlier conversations).
 */
export function deleteWords(names, kind = 'session') {
  const n = names.length;
  const what = kind === 'conversation' ? (n === 1 ? 'conversation' : 'conversations') : n === 1 ? 'session' : 'sessions';
  const from = kind === 'conversation' ? 'Earlier conversations' : 'the list';
  return {
    title: n === 1 ? `Delete this ${what}?` : `Delete ${n} ${what}?`,
    // A single session's menu offers Delete only when it is not working; several may hold one that started meanwhile.
    text: `${n === 1 ? 'It goes' : 'They go'} to the trash and ${n === 1 ? 'leaves' : 'leave'} ${from}. Put ${n === 1 ? 'it' : 'them'} back from the trash within ${KEEP_DAYS} days; after that the transcript is removed for good.${n > 1 && kind === 'session' ? ' A session that is working is not deleted.' : ''}`,
    ok: n === 1 ? 'Delete' : `Delete ${n}`,
  };
}

/** The confirmation, with the names in a list. → true when the owner pressed Delete */
export function confirmDelete(names, kind = 'session') {
  const w = deleteWords(names, kind);
  return openSheet({ title: w.title }, (close) => [
    h('ul.del-names', names.slice(0, 8).map((x) => h('li', x || 'New session')), names.length > 8 ? h('li.del-more', `and ${names.length - 8} more`) : null),
    h('p.sheet-text', w.text),
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close(false), autofocus: true }, 'Cancel'),
      h('button.btn.danger', { type: 'button', onclick: () => close(true) }, w.ok)),
  ]).then((x) => x === true);
}

const UNDO_MS = 12_000; // a toast with Undo stays this long, and while the pointer or the keyboard is on it
const editable = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));

/**
 * A toast with Undo, which Ctrl+Z (Cmd+Z) presses too while it shows (outside a text field): Undo is far down the
 * page's tab order, and the keyboard reaches it this way in time. One key presses one Undo: the newest that shows.
 */
const undos = []; // { t (the toast), undo }, oldest first
function onUndoKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || String(e.key).toLowerCase() !== 'z' || editable(e.target)) return;
  for (let i = undos.length - 1; i >= 0; i--) if (!undos[i].t.isConnected) undos.splice(i, 1);
  const last = undos.pop();
  if (!last) return document.removeEventListener('keydown', onUndoKey); // the toasts went: the key is the page's again
  e.preventDefault();
  last.t.remove();
  last.undo();
}
export function undoToast(text, undo, { ms = UNDO_MS } = {}) {
  const mine = { t: null, undo };
  mine.t = toast(text, { ms, action: { label: 'Undo', title: 'Undo (Ctrl+Z)', run: () => {
    if (undos.includes(mine)) undos.splice(undos.indexOf(mine), 1);
    undo();
  } } });
  undos.push(mine);
  document.removeEventListener('keydown', onUndoKey); // one listener for all of them
  document.addEventListener('keydown', onUndoKey);
  return mine.t;
}

/**
 * Delete `what` ({ chats: [id], conversations: [{ dir, id }] }) after the confirmation of `names`. after(): the list
 * changed; kind: what they are (deleteWords). → the server's answer, or null (cancelled or failed: a toast said why)
 */
export async function deleteNow(what, names, { after = () => {}, kind = 'session' } = {}) {
  if (!(await confirmDelete(names, kind))) return null;
  let r;
  try {
    r = await api('/api/chats/delete', what);
  } catch (e) {
    toast(failText(e), { from: e, kind: 'error', ms: 7000 });
    return null;
  }
  after();
  const n = r.deleted.length;
  const refused = r.refused.length ? ` ${r.refused.length === 1 ? 'One was not' : `${r.refused.length} were not`}: ${r.refused[0].why}` : '';
  const words = kind === 'conversation' ? 'conversations' : 'sessions';
  undoToast(`${n === 1 ? `Deleted "${r.deleted[0].title}"` : `Deleted ${n} ${words}`}.${refused}`, () => putBack(r.deleted.map((x) => x.trash), { after }));
  return r;
}

/**
 * Whether a page offers Delete for conversation `c` of a folder's list: one of Claude Code's (`tool`), ended: not the
 * one this page shows (`current`), not open in an App session (`chat`), not run by a terminal session now (`terminal`),
 * as the server marks them. The one rule of the App's Earlier conversations, the terminal session's page and the
 * Projects page.
 */
export const canDeleteConversation = (c, tool = 'claude') => tool === 'claude' && !!c && !c.current && !c.chat && !c.terminal;

/**
 * Delete one ended conversation of folder `dir` (one of Earlier conversations: a terminal may have run it): the one
 * way every page does it (the App's Earlier conversations, a terminal session's page, the Projects page), through the
 * server's Delete (the trash, its journal, and the rule that a conversation someone else writes is never moved).
 * → what deleteNow answered, or null
 */
export const deleteConversation = (dir, id, title, { after = () => {} } = {}) =>
  deleteNow({ conversations: [{ dir, id }] }, [title || 'Untitled conversation'], { after, kind: 'conversation' });

/**
 * Put entries back (Undo, the trash's Put back), wherever it was pressed. A toast says what was put back; one the
 * server refused says why in its own. The page that shows a session put back (it said "deleted") is drawn again here,
 * in this one place. after(opened): the list changed. → { opened (the App sessions opened again), done (the entries
 * put back), refused (entry → why) }
 */
export async function putBack(entries, { after = () => {} } = {}) {
  const opened = [];
  const done = [];
  const refused = new Map(); // entry → why
  for (const e of entries) {
    try {
      const r = await api(`/api/chats/trash/${e}/restore`, {});
      done.push(e);
      if (r.chat) opened.push(r.chat);
    } catch (err) {
      refused.set(e, failText(err));
      toast(failText(err), { from: err, kind: 'error', ms: 9000 });
    }
  }
  if (done.length) {
    const here = opened.find((id) => location.hash === link(`#/chat/${id}`));
    if (here) redraw(here);
    after(opened);
    // One App session back: Open goes to it (the trash or the toast stays where it is until then).
    toast(done.length === 1 ? 'Put back' : `Put back ${done.length}`, opened.length === 1 ? { action: { label: 'Open', run: () => openChat(opened[0]) } } : {});
  }
  return { opened, done, refused };
}

/** The page shows App session `id` again: a hash that stays the same fires no hashchange, so it is fired by hand. */
export function redraw(id) {
  const to = link(`#/chat/${id}`);
  if (location.hash === to) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = to;
}

/** Open App session `id` (a toast's Open): the trash closes; a page that shows it was drawn again by putBack(). */
export function openChat(id) {
  closeSheet();
  const to = link(`#/chat/${id}`);
  if (location.hash !== to) location.hash = to;
}

/** The trash of this computer: what was deleted, when it goes for good, Put back. */
export async function trashSheet({ after = () => {} } = {}) {
  let list;
  try {
    list = (await api('/api/chats/trash')).list || [];
  } catch (e) {
    return toast(failText(e), { from: e, kind: 'error' });
  }
  return openSheet({ title: 'Trash', subtitle: `Deleted sessions of this computer. Each is removed for good ${KEEP_DAYS} days after it was deleted.` }, () => {
    const rows = h('div.choice-list.del-trash');
    const why = new Map(); // entry → the reason a Put back was refused (it stays in the list, with it)
    const paint = () => fill(rows, list.length ? list.map((x) => h('div.choice.static.del-row', { dataset: { entry: x.id } },
      h('span.choice-main', h('span.choice-label', x.title || 'New session'), h('span.choice-sub', `${x.short} · deleted ${ago(x.at)} · removed for good ${goneOn(x.until)}`),
        why.has(x.id) ? h('span.choice-sub.del-why', why.get(x.id)) : null),
      h('button.btn.small.secondary', { type: 'button', onclick: async (e) => {
        e.currentTarget.disabled = true;
        const at = list.indexOf(x);
        const { done, refused } = await putBack([x.id], { after });
        if (done.includes(x.id)) list = list.filter((y) => y.id !== x.id);
        else why.set(x.id, `Not put back: ${refused.get(x.id) || 'try again'}`);
        paint();
        // The keyboard stays in the trash: on the next row's Put back, else on Close.
        const buttons = [...rows.querySelectorAll('button')];
        const next = buttons[Math.min(at, buttons.length - 1)];
        const sheet = rows.closest('dialog');
        const closeBtn = sheet ? [...sheet.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'Close') : null;
        (next || closeBtn)?.focus();
      } }, 'Put back'))) : h('p.sheet-text', 'The trash is empty. Delete is in a session\'s menu.'));
    paint();
    return rows;
  });
}

/**
 * Pick several of `sessions` (the list's App sessions of this computer) to delete: a check box each, Delete N.
 * → what deleteNow answered, or null
 */
export async function pickToDelete(sessions, nameOf, { after = () => {} } = {}) {
  if (!sessions.length) return toast('There is no App session of this computer to delete.');
  const picked = new Set();
  const chosen = await openSheet({ title: 'Select sessions to delete', subtitle: 'App sessions of this computer. A working one is not deleted.' }, (close) => {
    const go = h('button.btn.danger', { type: 'button', disabled: true, onclick: () => close([...picked]) }, 'Delete');
    const count = () => {
      go.disabled = !picked.size;
      fill(go, picked.size ? `Delete ${picked.size}` : 'Delete');
    };
    return [
      h('div.choice-list.del-pick', sessions.map((s) => {
        const why = notPickable(s);
        return h(`label.choice.del-row${why ? '.del-off' : ''}`,
          h('input', { type: 'checkbox', disabled: !!why, onchange: (e) => {
            if (e.target.checked) picked.add(s.chatId);
            else picked.delete(s.chatId);
            count();
          } }),
          h('span.choice-main', h('span.choice-label', nameOf(s) || 'New session'), h('span.choice-sub', why ? `${why} · ${s.short || s.cwd || ''}` : s.short || s.cwd || '')));
      })),
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'), go),
    ];
  });
  if (!chosen || !chosen.length) return null;
  const names = chosen.map((id) => nameOf(sessions.find((s) => s.chatId === id)));
  return deleteNow({ chats: chosen }, names, { after });
}
