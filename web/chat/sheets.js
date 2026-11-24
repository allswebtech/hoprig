// The chat's sheets beside its head: the history of the folder (its earlier conversations; one tap continues one in
// a chat) and the rewind to before one of the owner's messages (files, conversation or both), with a confirm that
// says what each does.
import { icon } from '../icons.js';
import { TOOL_NAMES, ago, api, chooseSheet, fill, h, link, openSheet, toast } from '../lib.js';
import { store } from '../store.js';
import { failText, inFolder } from './words.js';
import { canDeleteConversation, deleteConversation } from './deletes.js';

/**
 * The folder's earlier conversations. v: the chat's state (cwd, profile, model, effort, permissionMode). q: the
 * search to start with, at: the row to focus (the sheet opened again after a delete's confirmation).
 */
export async function historySheet({ A, v, q = '', at = -1 }) {
  let list;
  let tool = 'claude';
  try {
    const r = await api(`${A}/history`);
    list = r.conversations || [];
    tool = r.tool || 'claude';
  } catch (e) {
    return toast(failText(e), { from: e, kind: 'error' });
  }
  // A conversation stays in its coding tool: the list is the chat's tool's own, and says so when it is not Claude Code.
  const sub = `In ${v.short || v.cwd}${tool !== 'claude' ? `, ${TOOL_NAMES[tool] || tool}'s conversations` : ''}. One tap continues it in the App.`;
  const pick = await openSheet({ title: 'Earlier conversations', subtitle: sub }, (close) => {
    const rows = h('div.choice-list.chat-history');
    const search = list.length > 8 ? h('input.field.chat-history-search', { type: 'search', placeholder: 'Find a conversation', 'aria-label': 'Find a conversation', autocomplete: 'off' }) : null;
    // An ended conversation (not this one, not open in another session) can be deleted here: one a terminal ran too.
    const canDelete = (c) => canDeleteConversation(c, tool);
    // The confirmation takes this sheet's place: after it (Delete or Cancel) the sheet opens again where it was.
    const remove = async (c) => {
      const query = search ? search.value.trim() : '';
      const row = [...rows.querySelectorAll('.chat-history-row')].findIndex((r) => r.dataset.id === c.id);
      await deleteConversation(v.cwd, c.id, c.title, { after: () => store.refresh() });
      historySheet({ A, v, q: query, at: row });
    };
    const paint = (q = '') => fill(rows, list.filter((c) => !q || (c.title || '').toLowerCase().includes(q.toLowerCase())).map((c) =>
      h('div.chat-history-row', { dataset: { id: c.id } },
        h(`button.choice${c.current ? '.current' : ''}`, { type: 'button', onclick: () => close(c) },
          h('span.choice-icon', icon('text')),
          h('span.choice-main', h('span.choice-label', c.title || '(no words yet)', c.current ? h('span.badge', 'This conversation') : c.chat ? h('span.badge', 'Open') : null), h('span.choice-sub', ago(c.at))),
          h('span.choice-end', icon(c.current ? 'check' : 'chevronRight'))),
        canDelete(c) ? h('button.btn.icon.ghost.chat-history-del', { type: 'button', title: `Delete "${c.title || 'Untitled conversation'}"`, 'aria-label': `Delete ${c.title || 'Untitled conversation'}`, onclick: () => remove(c) }, icon('trash', { size: 16 })) : null)));
    search?.addEventListener('input', () => paint(search.value.trim()));
    if (search && q) search.value = q;
    paint(q);
    if (at >= 0) {
      // The keyboard goes back to the row that was there (the next one, after a delete).
      const all = [...rows.querySelectorAll('.chat-history-row')];
      setTimeout(() => all[Math.min(at, all.length - 1)]?.querySelector('button')?.focus(), 0);
    }
    return [search, list.length ? rows : h('p.sheet-text', 'No conversation in this folder yet.')];
  });
  if (!pick || pick.current) return;
  if (pick.chat) {
    location.hash = link(`#/chat/${pick.chat}`);
    return;
  }
  try {
    const r = await api('/api/chats', { dir: v.cwd, ...(tool !== 'claude' ? { tool } : {}), profile: v.profile.name, sessionId: pick.id, model: v.model, effort: v.effort, permissionMode: v.permissionMode });
    store.refresh();
    location.hash = link(`#/chat/${r.id}`);
  } catch (e) {
    toast(failText(e), { from: e, kind: 'error' });
  }
}

const excerpt = (s, n = 140) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Rewind to before one of the owner's messages, as Claude Code's own rewind menu words it: Restore code (Claude's
 * changes to files since), Restore conversation (it goes on from before the message, which comes back into the box;
 * the old one stays in History), Restore code and conversation, Never mind. A dry run first says what each would do;
 * the code choices show only where there are changes to undo, as in Claude Code. Its Summarize from here / up to here
 * are not offered: the coding tool's stream protocol has no request for them (only rewind_files). m: { messageId,
 * text }; conversation: the coding tool can; put(text): back into the box.
 */
export async function rewindSheet({ A, cwd, m, conversation = false, put }) {
  let r;
  try {
    r = await api(`${A}/rewind`, { messageId: m.messageId, dryRun: true, files: true, conversation });
  } catch (e) {
    return toast(failText(e), { from: e, kind: 'error' });
  }
  const files = r.canRewind && r.files.length ? r.files : [];
  const conv = r.conversation || null;
  if (!files.length && !conv) {
    return openSheet({ title: 'Nothing to rewind', subtitle: `“${excerpt(m.text, 80)}”` }, (close) => [
      h('p.sheet-text', r.error && !/no changes/i.test(r.error) ? `Claude Code cannot rewind to this message: ${r.error}.` : 'Claude has not changed a file since this message (or not in a way it can undo).'),
      h('div.sheet-actions', h('button.btn.primary', { type: 'button', onclick: () => close() }, 'OK')),
    ]);
  }
  // What the rewind itself does to the lines (Claude Code's own count).
  const counts = Number.isFinite(r.insertions) && Number.isFinite(r.deletions) && (r.insertions || r.deletions) ? ` (+${r.insertions} −${r.deletions} lines)` : '';
  const choice = await openSheet({ title: 'Rewind to before this message?', subtitle: `“${excerpt(m.text, 80)}”` }, (close) => [
    files.length ? [
      h('p.sheet-text', h('strong', 'Code: '), `${files.length === 1 ? 'this file goes back to how it was' : `these ${files.length} files go back to how they were`} before that message${counts}. Changes made by hand to ${files.length === 1 ? 'it' : 'them'} since are lost too.`),
      h('ul.chat-rewind-files', files.slice(0, 30).map((f) => h('li', inFolder(f, cwd))), files.length > 30 ? h('li', `… and ${files.length - 30} more`) : null),
    ] : h('p.sheet-text', h('strong', 'Code: '), 'Claude has not changed a file since this message.'),
    conv ? h('p.sheet-text', h('strong', 'Conversation: '), `it goes on from before this message (${conv.messages === 1 ? 'this message goes' : `this and ${conv.messages - 1} later ${conv.messages === 2 ? 'message go' : 'messages go'}`}), and the message comes back into the box to change or send again. The conversation as it is now stays in History.`) : null,
    h('div.sheet-actions.chat-rewind-actions',
      // Claude Code's order: both first, then the conversation, the code, and Never mind.
      files.length && conv ? h('button.btn.danger', { type: 'button', onclick: () => close({ files: true, conversation: true }) }, 'Restore code and conversation') : null,
      conv ? h('button.btn.secondary', { type: 'button', onclick: () => close({ files: false, conversation: true }) }, 'Restore conversation') : null,
      files.length ? h('button.btn.secondary', { type: 'button', onclick: () => close({ files: true, conversation: false }) }, 'Restore code') : null,
      h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Never mind')),
  ]);
  if (!choice || typeof choice !== 'object') return;
  try {
    const done = await api(`${A}/rewind`, { messageId: m.messageId, ...choice });
    if (choice.files && !done.canRewind) throw new Error(done.error || 'Claude Code could not rewind');
    if (choice.conversation && done.conversation && put) put(done.conversation.text || m.text);
    toast(choice.conversation ? (choice.files ? 'Restored the code and the conversation to before your message' : 'Restored the conversation to before your message') : `Restored the code: ${done.files.length === 1 ? '1 file' : `${done.files.length} files`}`);
  } catch (e) {
    toast(failText(e), { from: e, kind: 'error' });
  }
}

/** The more menu's Rewind: choose one of the owner's messages (newest first), then rewindSheet. */
export async function chooseRewind({ A, cwd, messages, conversation, put }) {
  const list = messages.filter((x) => x.messageId).slice(-30).reverse();
  if (!list.length) return toast('No message to rewind to yet', { kind: 'error' });
  const id = await chooseSheet({
    title: 'Rewind to before…',
    subtitle: 'Choose one of your messages: then the code, the conversation or both go back to before it.',
    items: list.map((x) => ({ value: x.messageId, label: excerpt(x.text, 90) || '(a picture)', icon: 'text' })),
  });
  const m = id && list.find((x) => x.messageId === id);
  if (m) await rewindSheet({ A, cwd, m, conversation, put });
}
