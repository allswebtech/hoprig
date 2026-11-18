// The chats closed by "Open in Terminal" (the last HANDED_MAX): chat id → { conversation, tool, title, named }. The
// title the coding tool gave (or the owner) comes back with the conversation on "Open in the App"; its transcript
// does not keep it. Kept in <stateDir>/chat-handed.json, so a restart of the dashboard while the conversation runs in
// its terminal (an update does one) does not lose it.
import fs from 'node:fs';
import path from 'node:path';

const HANDED_MAX = 50;

/** file(): where they are kept (null: in memory only, as some tests run it) → { get(id), has(id), set(id, rec), titleOf(conversation, tool) } */
export function handedChats(file) {
  let map = null;
  function load() {
    if (map) return map;
    map = new Map();
    if (!file) return map;
    try {
      const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
      for (const [id, x] of Array.isArray(raw) ? raw : []) {
        if (typeof id === 'string' && x && typeof x.conversation === 'string' && typeof x.tool === 'string') {
          map.set(id, { conversation: x.conversation, tool: x.tool, title: typeof x.title === 'string' ? x.title : null, named: x.named === true });
        }
      }
    } catch {
      /* none yet, or unreadable: start empty */
    }
    return map;
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
      const tmp = `${file()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...map]) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file());
    } catch {
      /* a full disk loses only the title after a restart */
    }
  }
  return {
    get: (id) => load().get(id),
    has: (id) => load().has(id),
    set(id, rec) {
      load().delete(id);
      map.set(id, rec);
      while (map.size > HANDED_MAX) map.delete(map.keys().next().value);
      save();
    },
    /** The title kept for `conversation` of `tool` (the newest), as a chat record's fields: { title, named? } or {}. */
    titleOf(conversation, tool) {
      const h = [...load().values()].reverse().find((x) => x.conversation === conversation && x.tool === tool && x.title);
      return h ? { title: h.title, ...(h.named ? { named: true } : {}) } : {};
    },
  };
}
