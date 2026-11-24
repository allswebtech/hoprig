// The editor's files: one level of a folder, read (size limit, binary files told apart), write (only over the version
// the page read, atomically), create, rename, delete. Paths come checked from paths.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isOwnFolder } from '../server/folders.mjs';
import { fail, isHiddenName, isSecret, mayChangeFolder, resolveIn, rootOf } from './paths.mjs';

export const MAX_BYTES = 5 * 1024 * 1024; // a file larger than this is not opened as text
export const TREE_MAX = 2000;

/** The version of a file's bytes: what a save must name, so it never overwrites a change made meanwhile. */
export const versionOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
/** versionOf of a file on disk, read in pieces off the main thread: a search reads many such files and must not hold the server. */
export const versionOfFile = (abs) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(abs).on('error', reject).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex').slice(0, 16)));
});

/** Binary: a NUL in the first 8 KB, or bytes that are not UTF-8. */
export function isBinary(buf) {
  if (buf.subarray(0, 8192).includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

/** An error of the file system in the page's words, with a status. */
export function fsError(e) {
  if (e && Number.isInteger(e.status)) return e;
  const code = e && e.code;
  if (code === 'ENOENT') return fail(404, 'there is no such file or folder');
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return fail(409, 'something with that name is already there', { code: 'exists' });
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return fail(403, 'this computer does not allow that change');
  if (code === 'EISDIR' || code === 'ENOTDIR' || code === 'EINVAL' || code === 'EXDEV') return fail(400, 'that cannot be done with this file or folder');
  return e;
}
const wrap = (fn) => {
  try {
    return fn();
  } catch (e) {
    throw fsError(e);
  }
};

/** One level of `dir` (relative to `root`): [{ name, kind: dir | file, link?, size? }], folders first. */
export function tree(root, dir, roots) {
  const at = resolveIn(root, dir, roots);
  const entries = wrap(() => {
    if (!fs.statSync(at.abs).isDirectory()) throw fail(400, 'that is not a folder');
    return fs.readdirSync(at.abs, { withFileTypes: true });
  });
  const out = [];
  for (const e of entries) {
    if (isHiddenName(e.name)) continue;
    const full = path.join(at.abs, e.name);
    if (isSecret(full) || isOwnFolder(full)) continue;
    let item = null;
    if (e.isSymbolicLink()) {
      // Shown only when it leads to something inside the opened folder (the same check a read makes).
      try {
        const real = resolveIn(at.root, at.rel ? `${at.rel}/${e.name}` : e.name, roots).abs;
        const st = fs.statSync(real);
        item = { name: e.name, kind: st.isDirectory() ? 'dir' : 'file', link: true, ...(st.isFile() ? { size: st.size } : {}) };
      } catch {
        /* a link out of the folder, to a private one, or broken */
      }
    } else if (e.isDirectory()) item = { name: e.name, kind: 'dir' };
    else if (e.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* gone meanwhile */
      }
      item = { name: e.name, kind: 'file', size };
    }
    if (item) out.push(item);
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.kind === 'dir' ? -1 : 1));
  return { root: at.root, dir: at.rel, entries: out.slice(0, TREE_MAX), truncated: out.length > TREE_MAX };
}

/** A file to edit: { text, version, size, eol }, or { binary: true, version, size }; over the size limit a 413. */
export function readFile(root, rel, roots) {
  const at = resolveIn(root, rel, roots);
  const st = wrap(() => fs.statSync(at.abs));
  if (!st.isFile()) throw fail(400, 'that is not a file');
  if (st.size > MAX_BYTES) throw fail(413, `the file is larger than ${MAX_BYTES / 1024 / 1024} MB and is not opened in the editor`, { code: 'too-large', size: st.size });
  const buf = wrap(() => fs.readFileSync(at.abs));
  const version = versionOf(buf);
  if (isBinary(buf)) return { path: at.rel, binary: true, size: buf.length, version };
  const text = buf.toString('utf8');
  return { path: at.rel, text, version, size: buf.length, eol: eolOf(text) };
}

/** The line end most lines of `text` use (as Monaco picks it): '\r\n' or '\n'. */
export function eolOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  return crlf > (text.match(/\n/g) || []).length - crlf ? '\r\n' : '\n';
}

export const VERSIONS_MAX = 100;
/**
 * The versions of open files, to tell which changed on disk: { versions: { path: version | null } } (null: the file is
 * gone). Paths the editor may not open are left out.
 */
export function versions(root, list, roots) {
  rootOf(root, roots);
  if (!Array.isArray(list) || list.length > VERSIONS_MAX) throw fail(400, `send up to ${VERSIONS_MAX} paths`);
  const out = {};
  for (const rel of new Set(list)) {
    try {
      const at = resolveIn(root, rel, roots);
      const st = fs.statSync(at.abs);
      out[rel] = st.isFile() && st.size <= MAX_BYTES ? versionOf(fs.readFileSync(at.abs)) : null;
    } catch (e) {
      if (e.status === 404 || e.code === 'ENOENT') out[rel] = null;
    }
  }
  return { versions: out };
}

/**
 * Save `text` to the file. `version`: the version the page read (a save over a newer file is refused with 409
 * { code: 'changed', version: <on disk> }, so nothing is lost), or null to make a new file only. The new bytes go
 * to a temporary file in the same folder that then replaces the old one, keeping its mode.
 */
export function writeFile(root, rel, text, version, roots) {
  if (typeof text !== 'string') throw fail(400, 'send the text of the file');
  const buf = Buffer.from(text, 'utf8');
  if (buf.length > MAX_BYTES) throw fail(413, `the file would be larger than ${MAX_BYTES / 1024 / 1024} MB`, { code: 'too-large', size: buf.length });
  if (version !== null && (typeof version !== 'string' || !/^[0-9a-f]{16}$/.test(version))) throw fail(400, 'send the version the file was read at');
  let at;
  let mode = 0o644;
  if (version === null) {
    at = resolveIn(root, rel, roots, { mode: 'new' });
  } else {
    at = resolveIn(root, rel, roots);
    const st = wrap(() => fs.statSync(at.abs));
    if (!st.isFile()) throw fail(400, 'that is not a file');
    const now = versionOf(wrap(() => fs.readFileSync(at.abs)));
    if (now !== version) throw fail(409, 'the file was changed on disk after you opened it', { code: 'changed', version: now });
    mode = st.mode & 0o7777;
  }
  const tmp = path.join(path.dirname(at.abs), `.${path.basename(at.abs)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'wx', mode);
    try {
      fs.writeSync(fd, buf);
      fs.fchmodSync(fd, mode); // the umask may have taken bits away
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (version === null) {
      fs.linkSync(tmp, at.abs); // fails when a file appeared meanwhile: never replaces one
      fs.rmSync(tmp);
    } else fs.renameSync(tmp, at.abs);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw fsError(e);
  }
  return { path: at.rel, version: versionOf(buf), size: buf.length };
}

/** A new empty file or one new folder. Never replaces anything. */
export function create(root, rel, kind, roots) {
  if (kind !== 'file' && kind !== 'dir') throw fail(400, 'kind is "file" or "dir"');
  const at = resolveIn(root, rel, roots, { mode: 'new' });
  wrap(() => (kind === 'dir' ? fs.mkdirSync(at.abs) : fs.closeSync(fs.openSync(at.abs, 'wx', 0o644))));
  return kind === 'dir' ? { path: at.rel, kind } : { path: at.rel, kind, version: versionOf(Buffer.alloc(0)) };
}

/** Rename or move inside the opened folder. Never over something that exists. */
export function rename(root, from, to, roots) {
  const a = resolveIn(root, from, roots, { mode: 'entry' });
  const b = resolveIn(root, to, roots, { mode: 'new' });
  mayChangeFolder(a.abs);
  if (b.abs === a.abs || b.abs.startsWith(a.abs + path.sep)) throw fail(400, 'a folder cannot be moved into itself');
  wrap(() => fs.renameSync(a.abs, b.abs));
  return { from: a.rel, to: b.rel };
}

/** Delete a file, a link (not what it points to) or a folder with everything in it. `confirm` must be true. */
export function remove(root, rel, confirm, roots) {
  if (confirm !== true) throw fail(400, 'confirm the delete');
  const at = resolveIn(root, rel, roots, { mode: 'entry' });
  // The Explorer never shows a private folder or a file with a sign-in, so a folder holding one is not deleted blind.
  mayChangeFolder(at.abs);
  wrap(() => fs.rmSync(at.abs, { recursive: true }));
  return { path: at.rel, deleted: true };
}
