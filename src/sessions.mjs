// Claude Code's session store. A session is one file, <claudeDir>/projects/<slug of the folder>/<id>.jsonl. It
// belongs to the folder, not to an account, which is why any profile can continue it.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir } from './paths.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isSessionId = (s) => typeof s === 'string' && UUID_RE.test(s);

/** Claude Code names a folder's session directory by replacing every non-alphanumeric character with "-". */
export const projectSlug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

export const projectDir = (cwd) => path.join(claudeDir(), 'projects', projectSlug(cwd));

/** Sessions of a folder, newest first: [{ id, file, mtimeMs, size }]. */
export function sessionsIn(cwd) {
  const dir = projectDir(cwd);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -6);
    if (!isSessionId(id)) continue;
    try {
      const st = fs.statSync(path.join(dir, f));
      out.push({ id, file: path.join(dir, f), mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* removed meanwhile */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join(' ');
  return '';
};

/** A short human title for a session: its summary when it has one, else the first thing the user typed. */
export function sessionTitle(file, max = 80) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
  let first = '';
  for (const line of head.split('\n')) {
    if (!line.startsWith('{')) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue; // the last line of the chunk may be cut
    }
    if (m.type === 'summary' && typeof m.summary === 'string' && m.summary) return clip(m.summary, max);
    if (!first && m.type === 'user' && !m.isMeta && !m.isSidechain && m.message) {
      const t = textOf(m.message.content).trim();
      // Skip machine-made turns (command wrappers, reminders, tool results).
      if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) first = t;
    }
  }
  return clip(first, max);
}

const clip = (s, max) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};
