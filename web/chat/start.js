// Opening a chat: the one way the dashboard starts coding (New session, Workspace, a new project, a conversation
// to continue). What is not chosen is left out, so the server uses what the last chat in that folder ran with
// (src/chat/folders.mjs), else the folder's default provider for that coding tool (src/defaultprovider.mjs) and
// Settings → New sessions.
import { api, at, cardTool, isClaudeCard, link, machine, toast } from '../lib.js';
import { store } from '../store.js';

// The coding tools a chat can run on each computer (GET /api/chats/tools; an older computer: Claude Code only).
const toolsOf = new Map();
const CLAUDE_ONLY = [{ id: 'claude', name: 'Claude Code' }];
/**
 * [{ id, name }] of computer `m`, asked once per page load. Left out: the computer whose screen is open (as api()
 * asks it); null: this one.
 */
export function chatTools(m = machine.current) {
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
export function knownChatTools(m = machine.current) {
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
 * Whether a terminal session (its card `s`, of computer `m`) offers "Open as chat": Claude Code's always; another
 * tool's where that computer has a chat for it, and also while its list is not known yet (it is asked for now; the
 * computer itself refuses a tool that is off), so the first look at a session never hides it.
 */
export const opensAsChat = (s, m) => isClaudeCard(s) || offersChat(m, cardTool(s)) !== false;

/**
 * Open a chat in `dir` on computer `m` (null: this one) and go to it. o: { tool (the coding tool; left out: the one
 * the last chat in that folder ran), sessionId (a conversation to continue; the chat that already runs it opens
 * instead), text (a first message), profile, permissionMode, model, effort, replace (the address that asked for it
 * is left out of the history: Back must not open another chat) }.
 */
export async function startChat(dir, o = {}, m = null) {
  const body = { dir };
  for (const k of ['tool', 'sessionId', 'text', 'profile', 'permissionMode', 'model', 'effort']) if (o[k]) body[k] = o[k];
  if (typeof o.lead === 'boolean') body.lead = o.lead; // "Lead model" chosen in the sheet; left out: as the folder's last chat, else Settings
  if (o.worktree === true) body.worktree = true; // "Worktree" in the sheet: Claude Code's new conversation on a branch of its own
  if (Array.isArray(o.others)) body.others = o.others; // "Use other providers": the ticks chosen in the sheet
  if (Array.isArray(o.with) && o.with.length) body.with = o.with; // "Also open": checked again on the server
  const { id, worktree } = await api(at(m, '/api/chats'), body);
  // A computer on an older version does not know the key and answers without a `worktree` field: the chat runs in the folder itself.
  if (body.worktree && !worktree) toast('That computer does not offer a branch of its own yet: the chat runs in the folder itself.', { kind: 'error', ms: 8000 });
  store.refresh();
  const to = link(`#/chat/${id}`, m);
  if (o.replace) location.replace(to);
  else location.hash = to;
  return id;
}
