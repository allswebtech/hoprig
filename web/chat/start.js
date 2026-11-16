// Opening a chat: the one way the dashboard starts coding (New session, Workspace, a new project, a conversation
// to continue). What is not chosen is left out, so the server uses what the last chat in that folder ran with
// (src/chat/folders.mjs), else the provider recommended now and Settings → New-session defaults.
import { api, at, link } from '../lib.js';
import { store } from '../store.js';

// The coding tools a chat can run on each computer (GET /api/chats/tools; an older computer: Claude Code only).
const toolsOf = new Map();
const CLAUDE_ONLY = [{ id: 'claude', name: 'Claude Code' }];
/** [{ id, name }] of computer `m` (null: this one), asked once per page load. */
export function chatTools(m = null) {
  const key = m || '~';
  if (!toolsOf.has(key)) {
    toolsOf.set(key, api(at(m, '/api/chats/tools')).then((r) => (Array.isArray(r && r.tools) && r.tools.length ? r.tools : CLAUDE_ONLY), () => CLAUDE_ONLY).then((list) => {
      known.set(key, list);
      return list;
    }));
  }
  return toolsOf.get(key);
}
const known = new Map();
/** The same, when it is known already (else Claude Code only, and it is asked for). */
export function knownChatTools(m = null) {
  const key = m || '~';
  if (!known.has(key)) chatTools(m);
  return known.get(key) || CLAUDE_ONLY;
}
/** Whether computer `m` offers a chat for coding tool `tool`: true or false when known, else null (it is asked for). */
export function offersChat(m, tool) {
  const key = m || '~';
  if (!known.has(key)) {
    chatTools(m);
    return null;
  }
  return known.get(key).some((t) => t.id === tool);
}

/**
 * Open a chat in `dir` on computer `m` (null: this one) and go to it. o: { tool (the coding tool; left out: the one
 * the last chat in that folder ran), sessionId (a conversation to continue; the chat that already runs it opens
 * instead), text (a first message), profile, permissionMode, model, effort, replace (the address that asked for it
 * is left out of the history: Back must not open another chat) }.
 */
export async function startChat(dir, o = {}, m = null) {
  const body = { dir };
  for (const k of ['tool', 'sessionId', 'text', 'profile', 'permissionMode', 'model', 'effort']) if (o[k]) body[k] = o[k];
  const { id } = await api(at(m, '/api/chats'), body);
  store.refresh();
  const to = link(`#/chat/${id}`, m);
  if (o.replace) location.replace(to);
  else location.hash = to;
  return id;
}
