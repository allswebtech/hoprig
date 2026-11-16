// The chat's sheets beside its head: the history of the folder (its earlier conversations; one tap continues one in
// a chat) and the rewind of files to before one of the owner's messages, with a confirm that says what happens.
import { icon } from '../icons.js';
import { ago, api, chooseSheet, fill, h, link, openSheet, toast } from '../lib.js';
import { store } from '../store.js';
import { inFolder } from './words.js';

/** The folder's earlier conversations. v: the chat's state (cwd, profile, model, effort, permissionMode). */
export async function historySheet({ A, v }) {
  let list;
  try {
    list = (await api(`${A}/history`)).conversations || [];
  } catch (e) {
    return toast(e.message, { kind: 'error' });
  }
  const pick = await openSheet({ title: 'Earlier conversations', subtitle: `In ${v.short || v.cwd}. One tap continues it in a chat.` }, (close) => {
    const rows = h('div.choice-list.chat-history');
    const search = list.length > 8 ? h('input.field.chat-history-search', { type: 'search', placeholder: 'Find a conversation', 'aria-label': 'Find a conversation', autocomplete: 'off' }) : null;
    const paint = (q = '') => fill(rows, list.filter((c) => !q || (c.title || '').toLowerCase().includes(q.toLowerCase())).map((c) =>
      h(`button.choice${c.current ? '.current' : ''}`, { type: 'button', onclick: () => close(c) },
        h('span.choice-icon', icon('text')),
        h('span.choice-main', h('span.choice-label', c.title || '(no words yet)', c.current ? h('span.badge', 'This chat') : c.chat ? h('span.badge', 'Open') : null), h('span.choice-sub', ago(c.at))),
        h('span.choice-end', icon(c.current ? 'check' : 'chevronRight')))));
    search?.addEventListener('input', () => paint(search.value.trim()));
    paint();
    return [search, list.length ? rows : h('p.sheet-text', 'No conversation in this folder yet.')];
  });
  if (!pick || pick.current) return;
  if (pick.chat) {
    location.hash = link(`#/chat/${pick.chat}`);
    return;
  }
  try {
    const r = await api('/api/chats', { dir: v.cwd, profile: v.profile.name, sessionId: pick.id, model: v.model, effort: v.effort, permissionMode: v.permissionMode });
    store.refresh();
    location.hash = link(`#/chat/${r.id}`);
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
}

const excerpt = (s, n = 140) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Undo the file changes since a message: say which files first, then do it on a yes. m: { messageId, text } */
export async function rewindFiles({ A, cwd, m }) {
  let r;
  try {
    r = await api(`${A}/rewind`, { messageId: m.messageId, dryRun: true });
  } catch (e) {
    return toast(e.message, { kind: 'error' });
  }
  if (!r.canRewind || !r.files.length) {
    return openSheet({ title: 'Nothing to rewind', subtitle: `“${excerpt(m.text, 80)}”` }, (close) => [
      h('p.sheet-text', r.error && !/no changes/i.test(r.error) ? `Claude Code cannot rewind to this message: ${r.error}.` : 'Claude has not changed a file since this message (or not in a way it can undo).'),
      h('div.sheet-actions', h('button.btn.primary', { type: 'button', onclick: () => close() }, 'OK')),
    ]);
  }
  // What the rewind itself does to the lines (Claude Code's own count).
  const counts = Number.isFinite(r.insertions) && Number.isFinite(r.deletions) && (r.insertions || r.deletions) ? ` (+${r.insertions} −${r.deletions} lines)` : '';
  const ok = await openSheet({ title: 'Rewind the files?', subtitle: `To how they were before “${excerpt(m.text, 80)}”` }, (close) => [
    h('p.sheet-text', `${r.files.length === 1 ? 'This file goes back to how it was' : `These ${r.files.length} files go back to how they were`} before that message${counts}. Changes made by hand to ${r.files.length === 1 ? 'it' : 'them'} since are lost too.`),
    h('ul.chat-rewind-files', r.files.slice(0, 30).map((f) => h('li', inFolder(f, cwd))), r.files.length > 30 ? h('li', `… and ${r.files.length - 30} more`) : null),
    h('p.sheet-text', 'The conversation is not changed: Claude still remembers what it did after that message. Tell it in your next message.'),
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'),
      h('button.btn.danger', { type: 'button', onclick: () => close(true) }, 'Rewind the files')),
  ]);
  if (ok !== true) return;
  try {
    const done = await api(`${A}/rewind`, { messageId: m.messageId });
    if (!done.canRewind) throw new Error(done.error || 'Claude Code could not rewind');
    toast(`Rewound ${done.files.length === 1 ? '1 file' : `${done.files.length} files`}`);
  } catch (e) {
    toast(e.message, { kind: 'error' });
  }
}

/** The more menu's Rewind: choose one of the owner's messages (newest first), then rewindFiles. */
export async function chooseRewind({ A, cwd, messages }) {
  const list = messages.filter((x) => x.messageId).slice(-30).reverse();
  if (!list.length) return toast('No message to rewind to yet', { kind: 'error' });
  const id = await chooseSheet({
    title: 'Rewind files to before…',
    subtitle: 'Claude Code undoes its file changes since the message you choose. The conversation stays as it is.',
    items: list.map((x) => ({ value: x.messageId, label: excerpt(x.text, 90) || '(a picture)', icon: 'text' })),
  });
  const m = id && list.find((x) => x.messageId === id);
  if (m) await rewindFiles({ A, cwd, m });
}
