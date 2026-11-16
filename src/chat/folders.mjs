// What a chat in each folder ran with last: the provider, the permission mode, the model, the effort and ultracode.
// One tap on a project opens a chat with these (feature.mjs, POST /api/chats without a choice), so the owner sets
// them once per project, from the chips of a chat, and never again before the first message. Kept in
// <stateDir>/chat-folders.json; the newest FOLDERS_MAX folders.
import fs from 'node:fs';
import path from 'node:path';

const FOLDERS_MAX = 200;
const KEYS = ['engine', 'profile', 'permissionMode', 'model', 'effort', 'ultracode'];

export function folderMemory(file) {
  let map = null;
  function load() {
    if (map) return map;
    map = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
      for (const [dir, x] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
        if (path.isAbsolute(dir) && x && typeof x === 'object' && typeof x.profile === 'string') map.set(dir, x);
      }
    } catch {
      /* none yet, or unreadable: start empty */
    }
    return map;
  }
  function save() {
    const out = Object.fromEntries([...map].sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, FOLDERS_MAX));
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
      const tmp = `${file()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, file());
    } catch {
      /* a full disk loses only this convenience */
    }
  }
  return {
    /** The settings a chat in `dir` ran with last, or null. */
    last(dir) {
      const x = load().get(dir);
      return x ? Object.fromEntries(KEYS.filter((k) => k in x).map((k) => [k, x[k]])) : null;
    },
    /** A chat's settings (its record) are now the last ones of its folder. */
    remember(rec) {
      if (!rec || !path.isAbsolute(String(rec.cwd || '')) || typeof rec.profile !== 'string') return;
      const next = { ...Object.fromEntries(KEYS.map((k) => [k, rec[k] ?? null])), ultracode: rec.ultracode === true, at: Date.now() };
      const old = load().get(rec.cwd);
      if (old && KEYS.every((k) => old[k] === next[k])) return;
      map.set(rec.cwd, next);
      save();
    },
  };
}
