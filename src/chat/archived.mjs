// The App's archived sessions, as the desktop app's Archived list: a session the owner archived (Archive, or the old
// one after Clear) keeps its conversation, and this list names it so it can be continued in a new App session (POST
// /api/chats with its sessionId). Kept in <stateDir>/chat-archived.json, the newest ARCHIVED_MAX; one entry per
// conversation. Only what is needed to continue it is kept: no messages.
//   GET /api/chats/archived   → { list: [{ id, cwd, short, conversationId, title, tool, profile, at }] } newest first,
//                               without the ones open in a session again
import fs from 'node:fs';
import { tilde } from '../paths.mjs';

export const ARCHIVED_MAX = 100;

/** o: { file() (where it is kept), openChatOf(conversationId) → an open chat's id or null } */
export function archivedSessions({ file, openChatOf = () => null }) {
  const read = () => {
    try {
      const list = JSON.parse(fs.readFileSync(file(), 'utf8'));
      return Array.isArray(list) ? list.filter((x) => x && typeof x.conversationId === 'string' && typeof x.cwd === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    /** A session was archived: its conversation goes to the top of the list. */
    add({ id, cwd, conversationId, title, tool, profile }) {
      if (!conversationId) return; // nothing on disk to continue (closed before its first message)
      const list = [{ id, cwd, conversationId, title: title || null, tool, profile, at: Date.now() }, ...read().filter((x) => x.conversationId !== conversationId)].slice(0, ARCHIVED_MAX);
      try {
        fs.writeFileSync(file(), `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
      } catch {
        /* the state folder cannot be written: the list misses this one */
      }
    },
    /** Conversation `conversationId` was deleted: it leaves the list. */
    drop(conversationId) {
      const list = read();
      if (!list.some((x) => x.conversationId === conversationId)) return;
      try {
        fs.writeFileSync(file(), `${JSON.stringify(list.filter((x) => x.conversationId !== conversationId), null, 2)}\n`, { mode: 0o600 });
      } catch {
        /* the state folder cannot be written */
      }
    },
    list: () => read().filter((x) => !openChatOf(x.conversationId)).map((x) => ({ ...x, short: tilde(x.cwd) })),
  };
}
