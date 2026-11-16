// The earlier conversations of a chat's folder, for the chat's history list: each with its title as Claude Code
// shows it (the name it was given, else its summary, else the first thing the owner typed) and when it last changed.
import fs from 'node:fs';
import { plainText } from './events.mjs';
import { sessionTitle, sessionsIn } from '../sessions.mjs';

const LIST_MAX = 50;
const TAIL_BYTES = 64 * 1024; // a rename is written at the end of the file: look there for the newest
const cache = new Map(); // file → { mtimeMs, title }

/** The newest name the conversation was given (a custom-title line near the end of its file), or ''. */
function givenName(file, size) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
  let name = '';
  for (const l of text.split('\n')) {
    if (!l.includes('"custom-title"')) continue;
    try {
      const m = JSON.parse(l);
      if (m.type === 'custom-title' && typeof m.customTitle === 'string' && m.customTitle.trim()) name = plainText(m.customTitle, 200);
    } catch {
      /* a line cut by the window */
    }
  }
  return name;
}

/** The folder's conversations, newest first: [{ id, at, title }]. */
export function folderHistory(cwd) {
  return sessionsIn(cwd).slice(0, LIST_MAX).map((s) => {
    let hit = cache.get(s.file);
    if (!hit || hit.mtimeMs !== s.mtimeMs) {
      hit = { mtimeMs: s.mtimeMs, title: givenName(s.file, s.size) || sessionTitle(s.file) || '' };
      cache.set(s.file, hit);
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    return { id: s.id, at: s.mtimeMs, title: hit.title };
  });
}
