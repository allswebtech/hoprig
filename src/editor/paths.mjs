// Every path the editor gets from a browser, checked on the server. A request names a root (the project or repository
// folder the editor was opened on: an absolute folder inside the dashboard's roots) and paths inside it as relative
// POSIX paths. A path is refused when it
//   - holds a NUL, a backslash, an empty, "." or ".." segment, or a segment that starts with "-" (it could be read
//     as an option by a program; every program also gets "--" before paths);
//   - leads, after symlinks, out of the root or the dashboard's roots, or into the dashboard's own folders;
//   - passes through a private folder (the same list git status leaves out) or git's own folder (.git, or any folder
//     that is a git directory: a bare repository, a worktree's separate one), read or write;
//   - is one of the files that hold a sign-in (Claude Code's stored sign-in, the providers' files).
// On macOS and Windows a disk usually ignores the case of a name, so names are compared there without it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDir, profilesDir } from '../paths.mjs';
import { listProfiles } from '../profiles.mjs';
import { FOLD, PRIVATE_DIRS } from '../pcsetup/projects.mjs';
import { insideRoots, isOwnFolder, ownRoots, within } from '../server/folders.mjs';

/** Folders the Explorer and Search never show: git's own data and installed packages. Private folders never at all. */
export const HIDDEN = ['.git', 'node_modules'];
export { FOLD, PRIVATE_DIRS };

const norm = (s, fold) => (fold ? String(s).toLowerCase() : String(s));
/** A private folder's name, in any case where the disk ignores case. */
export const isPrivateName = (s, fold = FOLD) => PRIVATE_DIRS.includes(norm(s, fold));
export const isGitName = (s, fold = FOLD) => norm(s, fold) === '.git';
/** A name the Explorer, Search and quick open never show: git's folder, packages, private folders. */
export const isHiddenName = (s, fold = FOLD) => HIDDEN.includes(norm(s, fold)) || isPrivateName(s, fold);

export const fail = (status, message, details) => Object.assign(new Error(message), { status, ...(details ? { details } : {}) });

const BAD_NAME = /[\0-\x1f\x7f\\/]/;
const PRIVATE_MSG = 'that folder is private: the dashboard never opens it';
const GIT_MSG = 'git\'s own folder is not opened in the editor';
const SECRET_MSG = 'that file holds a sign-in: the dashboard never shows it';

/** One file or folder name typed in the page: a plain name, at most 255 bytes. Returns it or throws 400. */
export function checkName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || BAD_NAME.test(name) || name.startsWith('-') || Buffer.byteLength(name) > 255) {
    throw fail(400, 'that is not a usable file name');
  }
  return name;
}

/**
 * A relative path from the page as its segments ([] for the root itself). Lexical rules only (no disk): the ones
 * above plus a private folder or .git at any depth.
 */
export function segments(rel) {
  if (rel === undefined || rel === null || rel === '' || rel === '.') return [];
  if (typeof rel !== 'string' || rel.length > 4096 || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw fail(400, 'paths are relative to the opened folder');
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) throw fail(400, 'a path inside the opened folder cannot go up or have empty parts');
  for (const s of segs) checkName(s);
  if (segs.some((s) => isPrivateName(s))) throw fail(403, PRIVATE_MSG);
  if (segs.some((s) => isGitName(s))) throw fail(403, GIT_MSG);
  return segs;
}

// ---------- files that hold a sign-in ----------

const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
let secretCache = { at: 0, list: [] };
/**
 * The real paths the editor never shows, reads, lists or changes: the providers' folder (their keys), and in every
 * Claude Code folder (the default one and each provider's own) the stored sign-in and the account file. Read again
 * every few seconds: providers come and go.
 */
export function secretPaths() {
  if (Date.now() - secretCache.at < 5000) return secretCache.list;
  // ~/.claude as well as claudeDir(): with CLAUDE_CONFIG_DIR set, claudeDir() is that folder, yet Claude Code's
  // default sign-in in ~/.claude is still on the disk.
  const claude = new Set([claudeDir(), path.join(os.homedir(), '.claude')]);
  try {
    for (const p of listProfiles()) if (p.env && typeof p.env.CLAUDE_CONFIG_DIR === 'string' && path.isAbsolute(p.env.CLAUDE_CONFIG_DIR)) claude.add(p.env.CLAUDE_CONFIG_DIR);
  } catch {
    /* no providers' folder */
  }
  const list = [profilesDir(), path.join(os.homedir(), '.claude.json')];
  for (const c of claude) list.push(path.join(c, '.credentials.json'), path.join(c, '.claude.json'));
  const out = new Set();
  for (const p of list) {
    out.add(path.resolve(p));
    out.add(realOr(p));
  }
  secretCache = { at: Date.now(), list: [...out] };
  return secretCache.list;
}
/** True when `p` (a real path) is such a file, or inside the providers' folder. */
export const isSecret = (p, fold = FOLD) => secretPaths().some((s) => (fold ? within(p.toLowerCase(), s.toLowerCase()) : within(p, s)));
/** True when `p` (a real path) is a folder that holds such a file at any depth. */
export const holdsSecret = (p, fold = FOLD) => secretPaths().some((s) => (fold ? within(s.toLowerCase(), p.toLowerCase()) : within(s, p)));

// ---------- git's own folders ----------

/** True when `dir` is a git directory (HEAD, objects/ and refs/ in it): a .git folder, a bare repository. */
export function isGitDir(dir) {
  try {
    return fs.statSync(path.join(dir, 'HEAD')).isFile() && fs.statSync(path.join(dir, 'objects')).isDirectory() && fs.statSync(path.join(dir, 'refs')).isDirectory();
  } catch {
    return false;
  }
}
/** The folders from `top` (excluded) down to `p` (included, when a folder): is any of them a git directory? */
function inGitDir(p, top) {
  let at = p;
  try {
    if (!fs.statSync(at).isDirectory()) at = path.dirname(at);
  } catch {
    at = path.dirname(at);
  }
  while (at !== top && within(at, top)) {
    if (isGitDir(at)) return true;
    at = path.dirname(at);
  }
  return false;
}

/** The opened folder: its real path, when it is an existing folder inside the roots and not the dashboard's own. */
export function rootOf(root, roots) {
  if (typeof root !== 'string' || !root) throw fail(400, 'name the folder the editor is opened on');
  const real = insideRoots(root, roots);
  if (!real) {
    // Inside the roots but not there (moved or deleted): said as such. Outside them nothing is told about the disk.
    if (path.isAbsolute(root) && !root.includes('\0') && roots.some((r) => within(path.resolve(root), r)) && !fs.existsSync(root)) throw fail(404, 'there is no such folder');
    throw fail(403, 'that folder is not one the dashboard may show');
  }
  if (isOwnFolder(real)) throw fail(403, 'the dashboard\'s own folders are not opened in the editor');
  const parts = real.split(path.sep);
  if (parts.some((s) => isPrivateName(s))) throw fail(403, PRIVATE_MSG);
  if (parts.some((s) => isGitName(s)) || inGitDir(real, path.parse(real).root)) throw fail(403, GIT_MSG);
  if (isSecret(real)) throw fail(403, SECRET_MSG);
  return real;
}

/** The real `p` must still be inside the opened folder, the roots, outside the own folders, the private ones and git's. */
function guard(real, rootReal, roots) {
  if (!within(real, rootReal) || !roots.some((r) => within(real, r)) || isOwnFolder(real)) throw fail(403, 'that path leads out of the opened folder');
  const rest = path.relative(rootReal, real).split(path.sep).filter(Boolean);
  if (rest.some((s) => isPrivateName(s))) throw fail(403, PRIVATE_MSG);
  if (rest.some((s) => isGitName(s)) || inGitDir(real, rootReal)) throw fail(403, GIT_MSG);
  if (isSecret(real)) throw fail(403, SECRET_MSG);
  return real;
}

/**
 * A path a program printed (relative to the opened folder `rootReal`) that may be shown: no hidden or private part,
 * not a file with a sign-in, not inside a git directory or the dashboard's own folders. `cache` (a Map) keeps the answer per folder for one listing.
 */
export function showable(rootReal, rel, cache = new Map()) {
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return false;
  const segs = rel.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..' || isHiddenName(s))) return false;
  const abs = path.join(rootReal, ...segs);
  if (isSecret(abs)) return false;
  const dir = path.dirname(abs);
  if (!cache.has(dir)) cache.set(dir, !inGitDir(dir, rootReal) && !isOwnFolder(dir));
  return cache.get(dir);
}

/**
 * Resolve `rel` inside the opened folder `root`. Modes:
 *   'existing'  (read, write) the path must exist; symlinks are followed and must stay inside
 *   'new'       (create, the target of a rename) the parent must exist (followed), the name itself must not
 *   'entry'     (delete, the source of a rename) the entry itself, a symlink not followed: its parent is checked
 * Returns { root (real), abs, rel (POSIX, relative to root) }.
 */
export function resolveIn(root, rel, roots, { mode = 'existing' } = {}) {
  const rootReal = rootOf(root, roots);
  const segs = segments(rel);
  const lexical = path.join(rootReal, ...segs);
  const out = (abs) => ({ root: rootReal, abs, rel: segs.join('/') });
  if (mode === 'existing') {
    let real;
    try {
      real = fs.realpathSync(lexical);
    } catch {
      throw fail(404, 'there is no such file or folder');
    }
    return out(guard(real, rootReal, roots));
  }
  if (!segs.length) throw fail(400, 'the opened folder itself cannot be changed here');
  let parent;
  try {
    parent = fs.realpathSync(path.dirname(lexical));
  } catch {
    throw fail(404, 'the folder it would go into does not exist');
  }
  guard(parent, rootReal, roots);
  const abs = path.join(parent, segs[segs.length - 1]);
  guard(abs, rootReal, roots);
  let exists = true;
  try {
    fs.lstatSync(abs);
  } catch {
    exists = false;
  }
  if (mode === 'new' && exists) throw fail(409, 'something with that name is already there', { code: 'exists' });
  if (mode === 'entry' && !exists) throw fail(404, 'there is no such file or folder');
  return out(abs);
}

/**
 * A folder that is about to be deleted or moved must not hold a private folder or a file with a sign-in at any depth
 * (the Explorer never shows them, so the owner could not know they would go too). Symlinks are not followed.
 */
export function mayChangeFolder(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  if (holdsSecret(abs) || ownRoots().some((r) => within(r, abs))) throw fail(403, 'that folder holds the dashboard\'s own files or a file with a sign-in, which are never changed from here', { code: 'holds-protected' });
  const stack = [abs];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      throw fail(403, 'a folder inside it cannot be read, so it is not changed from here', { code: 'holds-protected' });
    }
    for (const d of list) {
      if (++seen > 200_000) throw fail(409, 'that folder holds too many files to check here: change it in a terminal', { code: 'too-many' });
      if (!d.isDirectory()) continue;
      if (isPrivateName(d.name)) throw fail(403, 'that folder holds a private folder, which the dashboard never changes: change it in a terminal', { code: 'holds-protected' });
      stack.push(path.join(dir, d.name));
    }
  }
}
