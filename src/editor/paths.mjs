// Every path the editor gets from a browser, checked on the server. A request names a root (the project or repository
// folder the editor was opened on: an absolute folder inside the dashboard's roots) and paths inside it as relative
// POSIX paths. A path is refused when it
//   - holds a NUL, a backslash, an empty, "." or ".." segment, or a segment that starts with "-" (it could be read
//     as an option by a program; every program also gets "--" before paths);
//   - leads, after symlinks, out of the root or the dashboard's roots, or into the dashboard's own folders;
//   - passes through a private folder (the same list git status leaves out), or writes into .git.
import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_DIRS } from '../pcsetup/projects.mjs';
import { insideRoots, isOwnFolder, within } from '../server/folders.mjs';

/** Folders the Explorer and Search never show: git's own data and installed packages. Private folders never at all. */
export const HIDDEN = ['.git', 'node_modules'];
export { PRIVATE_DIRS };

export const fail = (status, message, details) => Object.assign(new Error(message), { status, ...(details ? { details } : {}) });

const BAD_NAME = /[\0-\x1f\x7f\\/]/;

/** One file or folder name typed in the page: a plain name, at most 255 bytes. Returns it or throws 400. */
export function checkName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || BAD_NAME.test(name) || name.startsWith('-') || Buffer.byteLength(name) > 255) {
    throw fail(400, 'that is not a usable file name');
  }
  return name;
}

/**
 * A relative path from the page as its segments ([] for the root itself). Lexical rules only (no disk): the ones
 * above plus a private folder at any depth, and .git when `write`.
 */
export function segments(rel, { write = false } = {}) {
  if (rel === undefined || rel === null || rel === '' || rel === '.') return [];
  if (typeof rel !== 'string' || rel.length > 4096 || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw fail(400, 'paths are relative to the opened folder');
  const segs = rel.split('/');
  for (const s of segs) checkName(s);
  if (segs.some((s) => PRIVATE_DIRS.includes(s))) throw fail(403, 'that folder is private: the dashboard never opens it');
  if (write && segs.includes('.git')) throw fail(403, 'git\'s own folder is not changed from the editor');
  return segs;
}

/** The opened folder: its real path, when it is an existing folder inside the roots and not the dashboard's own. */
export function rootOf(root, roots) {
  if (typeof root !== 'string' || !root) throw fail(400, 'name the folder the editor is opened on');
  const real = insideRoots(root, roots);
  if (!real) throw fail(403, 'that folder is not one the dashboard may show');
  if (isOwnFolder(real)) throw fail(403, 'the dashboard\'s own folders are not opened in the editor');
  const rel = real.split(path.sep);
  if (rel.some((s) => PRIVATE_DIRS.includes(s))) throw fail(403, 'that folder is private: the dashboard never opens it');
  return real;
}

/** The real `p` must still be inside the opened folder, the roots, outside the own folders and the private ones. */
function guard(real, rootReal, roots, write) {
  if (!within(real, rootReal) || !roots.some((r) => within(real, r)) || isOwnFolder(real)) throw fail(403, 'that path leads out of the opened folder');
  const rest = path.relative(rootReal, real).split(path.sep).filter(Boolean);
  if (rest.some((s) => PRIVATE_DIRS.includes(s))) throw fail(403, 'that folder is private: the dashboard never opens it');
  if (write && rest.includes('.git')) throw fail(403, 'git\'s own folder is not changed from the editor');
  return real;
}

/**
 * Resolve `rel` inside the opened folder `root`. Modes:
 *   'existing'  (read, write) the path must exist; symlinks are followed and must stay inside
 *   'new'       (create, the target of a rename) the parent must exist (followed), the name itself must not
 *   'entry'     (delete, the source of a rename) the entry itself, a symlink not followed: its parent is checked
 * Returns { root (real), abs, rel (POSIX, relative to root) }.
 */
export function resolveIn(root, rel, roots, { mode = 'existing', write = false } = {}) {
  const rootReal = rootOf(root, roots);
  const segs = segments(rel, { write: write || mode !== 'existing' });
  const lexical = path.join(rootReal, ...segs);
  const out = (abs) => ({ root: rootReal, abs, rel: segs.join('/') });
  if (mode === 'existing') {
    let real;
    try {
      real = fs.realpathSync(lexical);
    } catch {
      throw fail(404, 'there is no such file or folder');
    }
    return out(guard(real, rootReal, roots, write));
  }
  if (!segs.length) throw fail(400, 'the opened folder itself cannot be changed here');
  let parent;
  try {
    parent = fs.realpathSync(path.dirname(lexical));
  } catch {
    throw fail(404, 'the folder it would go into does not exist');
  }
  guard(parent, rootReal, roots, true);
  const abs = path.join(parent, segs[segs.length - 1]);
  guard(abs, rootReal, roots, true);
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
