// What Files (the desktop's app) does with the editor's files beyond the editor's own routes: a folder with dates and
// hidden files on request, a file sent as a download (or a picture shown), an upload, move and copy, and find by name.
// Every path is a full path checked by paths.mjs locate(): the same rules as the editor's (private folders, sign-in
// files, git's folders, symlinks that lead out, the dashboard's own folders), within how far the dashboard reaches.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isOwnFolder } from '../server/folders.mjs';
import { fsError } from './files.mjs';
import { checkName, fail, isGitName, isPrivateName, isSecret, locate, mayChangeFolder } from './paths.mjs';

export const LIST_MAX = 5000;
export const MANY_MAX = 500; // paths in one move, copy, trash or pack

/** A list of full paths from the page: 1…MANY_MAX strings, no two the same. */
export function pathList(v) {
  if (!Array.isArray(v) || !v.length || v.length > MANY_MAX || v.some((p) => typeof p !== 'string')) throw fail(400, `send 1 to ${MANY_MAX} paths`);
  return [...new Set(v)];
}

const shown = (name, hidden) => !isGitName(name) && !isPrivateName(name) && (hidden || !name.startsWith('.'));

/**
 * One folder: { path, parent, top, project, entries: [{ name, kind: dir | file, link?, size, mtime }], hidden,
 * truncated }. `parent` null at the top of the reach; `project` the nearest folder above (or this one) that holds a
 * .git, for "Open in Editor". Names that start with a dot only with `hidden`; git's folder and private ones never.
 */
export function listFolder(p, roots, { hidden = false } = {}) {
  const at = locate(p, roots);
  const list = (() => {
    try {
      if (!fs.statSync(at.abs).isDirectory()) throw fail(400, 'that is not a folder');
      return fs.readdirSync(at.abs, { withFileTypes: true });
    } catch (e) {
      throw fsError(e);
    }
  })();
  const entries = [];
  for (const e of list) {
    if (!shown(e.name, hidden)) continue;
    const full = path.join(at.abs, e.name);
    if (isSecret(full) || isOwnFolder(full)) continue;
    let st;
    let link = false;
    try {
      if (e.isSymbolicLink()) {
        // A link is shown only when it leads to something Files may open (the same check opening it makes).
        st = fs.statSync(locate(full, roots).abs);
        link = true;
      } else st = fs.lstatSync(full);
    } catch {
      continue; // a link out of the reach, to a private folder, broken, or gone meanwhile
    }
    if (!st.isDirectory() && !st.isFile()) continue; // sockets, devices, pipes: not files to open
    entries.push({ name: e.name, kind: st.isDirectory() ? 'dir' : 'file', ...(link ? { link } : {}), size: st.isFile() ? st.size : null, mtime: Math.round(st.mtimeMs) });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.kind === 'dir' ? -1 : 1));
  return {
    path: at.abs,
    parent: at.rel ? path.dirname(at.abs) : null,
    top: at.root,
    project: projectOf(at.abs, at.root),
    entries: entries.slice(0, LIST_MAX),
    truncated: entries.length > LIST_MAX,
  };
}

/** The nearest folder from `dir` up to `top` that holds a .git (the top of a repository), or null. */
function projectOf(dir, top) {
  for (let at = dir; ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, '.git'))) return at;
    if (at === top || path.dirname(at) === at) return null;
  }
}

// Pictures a browser shows by itself and that cannot run code: shown in place. Everything else is a download.
const PICTURES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** The Content-Disposition of a download named `name`: plain letters as they are, the rest as UTF-8. */
export function disposition(name, inline = false) {
  const plain = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Send the file at `p` into `res` as a download; a picture (png, jpeg, gif, webp) is shown in place unless
 * `download`. Never as a page of this site: a sandbox with nothing allowed, no type guessing, and never HTML or SVG
 * inline. Resolves when it is sent.
 */
export async function sendFile(p, roots, res, { download = true } = {}) {
  const at = locate(p, roots);
  let st;
  try {
    st = fs.statSync(at.abs);
  } catch (e) {
    throw fsError(e);
  }
  if (!st.isFile()) throw fail(400, 'that is not a file');
  const name = path.basename(at.abs);
  const picture = !download && PICTURES[path.extname(name).toLowerCase()];
  const stream = fs.createReadStream(at.abs);
  await new Promise((resolve, reject) => {
    stream.once('open', resolve);
    stream.once('error', (e) => reject(fsError(e)));
  });
  res.writeHead(200, {
    'Content-Type': picture || 'application/octet-stream',
    'Content-Length': String(st.size),
    'Content-Disposition': disposition(name, !!picture),
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  await new Promise((resolve) => {
    stream.on('error', () => res.destroy());
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
    stream.pipe(res);
  });
}

/** A name not taken in `dir`: "name", else "name (2).ext", "name (3).ext"… */
export function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 1000; i++) {
    const n = i === 1 ? name : `${stem} (${i})${ext === name ? '' : ext}`;
    try {
      fs.lstatSync(path.join(dir, n));
    } catch {
      return n;
    }
  }
  throw fail(409, 'too many files with that name are there already');
}

/**
 * Stream an upload (`req`, raw bytes) into folder `dir` as `name`: never over something there unless `replace` (then
 * only over a file). At most `maxBytes`. The bytes go to a temporary file in the same folder first.
 */
export async function receive(req, dir, name, roots, { replace = false, maxBytes }) {
  checkName(name);
  const folder = locate(dir, roots);
  if (!fs.statSync(folder.abs).isDirectory()) throw fail(400, 'that is not a folder');
  const target = path.join(folder.abs, name);
  let at;
  try {
    at = locate(target, roots, { mode: 'new' });
  } catch (e) {
    if (!(replace && e.details && e.details.code === 'exists')) throw e;
    at = locate(target, roots, { mode: 'entry' });
    if (!fs.lstatSync(at.abs).isFile()) throw fail(409, 'a folder or link with that name is there: it is not replaced', { code: 'exists' });
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw fail(413, `the file is larger than ${Math.round(maxBytes / 1048576)} MB`);
  const tmp = path.join(folder.abs, `.${name.slice(0, 200)}.${crypto.randomBytes(4).toString('hex')}.upload`);
  const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o644 });
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.unpipe(out);
          req.destroy();
          reject(fail(413, `the file is larger than ${Math.round(maxBytes / 1048576)} MB`));
        }
      });
      req.on('aborted', () => reject(fail(400, 'the upload stopped before its end')));
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
    if (replace && fs.existsSync(at.abs)) fs.renameSync(tmp, at.abs);
    else {
      fs.linkSync(tmp, at.abs); // fails when a file appeared meanwhile: never replaces one
      fs.rmSync(tmp);
    }
  } catch (e) {
    await new Promise((resolve) => {
      out.once('close', resolve);
      out.destroy();
    });
    fs.rmSync(tmp, { force: true });
    throw fsError(e);
  }
  return { path: at.abs, name, size };
}

/**
 * Move or copy `paths` into folder `to`: { done: [{ from, to }], failed: [{ path, error }] }. A move never goes
 * over something with the same name; a copy into the folder it comes from gets a free name ("x (2).txt"). Nothing
 * goes into itself, and a folder that holds a private folder or a sign-in file is neither moved nor copied.
 */
export async function transfer(paths, to, roots, { copy = false } = {}) {
  const list = pathList(paths);
  const dest = locate(to, roots);
  if (!fs.statSync(dest.abs).isDirectory()) throw fail(400, 'the place to put them is not a folder');
  const done = [];
  const failed = [];
  for (const p of list) {
    try {
      const src = locate(p, roots, { mode: 'entry' });
      mayChangeFolder(src.abs);
      if (dest.abs === src.abs || dest.abs.startsWith(src.abs + path.sep)) throw fail(400, 'a folder cannot go into itself');
      let name = path.basename(src.abs);
      if (copy && path.dirname(src.abs) === dest.abs) name = freeName(dest.abs, name);
      const target = locate(path.join(dest.abs, name), roots, { mode: 'new' });
      if (copy) await copyEntry(src.abs, target.abs);
      else await moveEntry(src.abs, target.abs);
      done.push({ from: src.abs, to: target.abs });
    } catch (e) {
      const err = fsError(e);
      failed.push({ path: p, error: err.message, ...(err.details && err.details.code ? { code: err.details.code } : {}) });
    }
  }
  return { done, failed };
}

/** A copy that keeps links as links and never writes over anything. */
export const copyEntry = (from, to) => fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });

/** A rename; across disks a copy and then the removal of the original. */
export async function moveEntry(from, to) {
  try {
    if (fs.existsSync(to)) throw fail(409, 'something with that name is already there', { code: 'exists' });
    await fs.promises.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await copyEntry(from, to);
    await fs.promises.rm(from, { recursive: true, force: true });
  }
}

export const FIND_MAX = 300;
/**
 * Files and folders under `p` whose name holds `q` (no regard to case): { matches: [{ path, kind }], truncated,
 * timedOut }. Never into git's folders, private ones, the dashboard's own, packages or (without `hidden`) dot-folders;
 * links are not followed. At most FIND_MAX matches and `ms` of looking.
 */
export async function findByName(p, q, roots, { hidden = false, ms = 5000 } = {}) {
  if (typeof q !== 'string' || !q.trim() || q.length > 200) throw fail(400, 'type part of a name to find');
  const at = locate(p, roots);
  const want = q.trim().toLowerCase();
  const end = Date.now() + ms;
  const matches = [];
  const stack = [at.abs];
  let timedOut = false;
  while (stack.length) {
    if (Date.now() > end) {
      timedOut = true;
      break;
    }
    const dir = stack.pop();
    let d;
    try {
      d = await fs.promises.opendir(dir);
    } catch {
      continue; // not readable
    }
    for await (const e of d) {
      if (!shown(e.name, hidden) || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (isSecret(full) || isOwnFolder(full)) continue;
      if (e.isDirectory()) stack.push(full);
      if (!e.isDirectory() && !e.isFile()) continue;
      if (e.name.toLowerCase().includes(want)) matches.push({ path: full, kind: e.isDirectory() ? 'dir' : 'file' });
      if (matches.length > FIND_MAX) break;
    }
    if (matches.length > FIND_MAX) break;
  }
  return { path: at.abs, matches: matches.slice(0, FIND_MAX), truncated: matches.length > FIND_MAX, timedOut };
}
