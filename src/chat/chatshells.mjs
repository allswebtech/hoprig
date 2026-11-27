// The terminal shells made for a chat (the pane under it: POST /api/shells with the chat's id). The page keeps its
// shells in its own tab only; this record is the server's, so archiving a chat ends them whoever pressed Archive and
// whatever the page knew. Kept in <stateDir>/chat-shells.json: { <chat id>: [shell names] }, the newest CHATS_MAX chats.
import fs from 'node:fs';

export const CHATS_MAX = 200;

/** o: { file() (where it is kept) } */
export function chatShells({ file }) {
  const read = () => {
    try {
      const m = JSON.parse(fs.readFileSync(file(), 'utf8'));
      return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    } catch {
      return {};
    }
  };
  const write = (m) => {
    try {
      fs.writeFileSync(file(), `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
    } catch {
      /* the state folder cannot be written: a shell of this chat is then ended by the page only */
    }
  };
  return {
    /** Shell `name` was made for chat `id`. */
    add(id, name) {
      const m = read();
      const list = Array.isArray(m[id]) ? m[id] : [];
      delete m[id];
      m[id] = [...list.filter((x) => x !== name), name]; // the newest chat last
      write(Object.fromEntries(Object.entries(m).slice(-CHATS_MAX)));
    },
    /** The shells made for chat `id`; they leave the record. */
    take(id) {
      const m = read();
      const list = Array.isArray(m[id]) ? m[id].filter((x) => typeof x === 'string') : [];
      if (id in m) {
        delete m[id];
        write(m);
      }
      return list;
    },
  };
}
