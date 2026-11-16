// Opening a chat: the one way the dashboard starts coding (New session, Workspace, a new project, a conversation
// to continue). What is not chosen is left out, so the server uses what the last chat in that folder ran with
// (src/chat/folders.mjs), else the folder's default provider (src/defaultprovider.mjs) and Settings → New-session defaults.
import { api, at, link } from '../lib.js';
import { store } from '../store.js';

/**
 * Open a chat in `dir` on computer `m` (null: this one) and go to it. o: { sessionId (a conversation to continue;
 * the chat that already runs it opens instead), text (a first message), profile, permissionMode, model, effort,
 * replace (the address that asked for it is left out of the history: Back must not open another chat) }.
 */
export async function startChat(dir, o = {}, m = null) {
  const body = { dir };
  for (const k of ['sessionId', 'text', 'profile', 'permissionMode', 'model', 'effort']) if (o[k]) body[k] = o[k];
  const { id } = await api(at(m, '/api/chats'), body);
  store.refresh();
  const to = link(`#/chat/${id}`, m);
  if (o.replace) location.replace(to);
  else location.hash = to;
  return id;
}
