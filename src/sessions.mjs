// Claude Code's session store. A session is one file, <claudeDir>/projects/<slug of the folder>/<id>.jsonl. It
// belongs to the folder, not to an account, which is why any profile can continue it.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir } from './paths.mjs';
import { conversationTitle } from './titles.mjs';

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

/**
 * Whether conversation `id` has anything on disk to continue. Claude Code writes a conversation's file with its
 * first message: a session nobody has typed into yet has none, and `claude --resume <id>` then ends at once with
 * "No conversation found with session ID". Looked for in the folder's own session directory first, then in every
 * other one (a conversation that lives under another folder is still one to resume, as before).
 */
export function hasConversation(cwd, id) {
  if (!isSessionId(id)) return false;
  const name = `${id}.jsonl`;
  if (typeof cwd === 'string' && cwd && fs.existsSync(path.join(projectDir(cwd), name))) return true;
  const root = path.join(claudeDir(), 'projects');
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return false;
  }
  return dirs.some((d) => fs.existsSync(path.join(root, d, name)));
}

/**
 * A short human title for a session, as Claude Code's session picker names it: the name it was given, else its
 * generated title, else its summary, else the first thing the person typed (titles.mjs; the newest of each counts,
 * wherever it is in the file).
 */
export function sessionTitle(file, max = 80) {
  return clip(conversationTitle(file).title, max);
}

const clip = (s, max) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};

/**
 * Copy the conversations of folder `from` under the key of folder `to` (hoprig sessions move): every file of
 * <claudeDir>/projects/<slug of from> (a conversation, its own sub-folder, the memory folder is left out: it goes
 * into the project's own memory), never over a file that is there, each compared by its bytes after the copy. The
 * old ones stay. `dryRun`: only what would be copied. → { from, to, copied: [rel], same: [rel], differ: [rel] }
 */
export function copySessions(from, to, { dryRun = false } = {}) {
  const src = projectDir(from);
  const dst = projectDir(to);
  const out = { from: src, to: dst, copied: [], same: [], differ: [] };
  if (src === dst) return out;
  const walk = (rel) => {
    let list;
    try {
      list = fs.readdirSync(path.join(src, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (!rel && e.name === 'memory') continue;
      if (e.isDirectory()) walk(r);
      if (!e.isFile()) continue;
      const a = path.join(src, r);
      const b = path.join(dst, r);
      if (fs.existsSync(b)) {
        (fs.readFileSync(a).equals(fs.readFileSync(b)) ? out.same : out.differ).push(r);
        continue;
      }
      if (dryRun) {
        out.copied.push(r);
        continue;
      }
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
      const st = fs.statSync(a);
      fs.utimesSync(b, st.atime, st.mtime);
      (fs.readFileSync(a).equals(fs.readFileSync(b)) ? out.copied : out.differ).push(r);
    }
  };
  walk('');
  return out;
}
