// The folder picker: which folders the browser may see and start sessions in. Every path from the browser is
// resolved with realpath (so "..", symlinks and doubled slashes are gone) and must then lie inside one of the
// configured roots (server.roots, default: the home directory).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDir, configDir, stateDir, tilde } from '../paths.mjs';

/** Real paths of the configured roots that exist. */
export function resolveRoots(roots) {
  const list = Array.isArray(roots) && roots.length ? roots : [os.homedir()];
  const out = [];
  for (const r of list) {
    if (typeof r !== 'string' || !path.isAbsolute(r)) continue;
    try {
      const real = fs.realpathSync(r);
      if (fs.statSync(real).isDirectory() && !out.includes(real)) out.push(real);
    } catch {
      /* a root that does not exist on this machine is skipped */
    }
  }
  return out;
}

export const within = (p, root) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** The real path of `p` when it is an existing directory inside a root, else null. */
export function insideRoots(p, roots) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) return null;
  let real;
  try {
    real = fs.realpathSync(p);
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  return roots.some((r) => within(real, r)) ? real : null;
}

/**
 * The product's own folders (its state and settings, with Tia's working folders): never offered as a place to
 * work, though Claude Code remembers them as folders it ran in. Real paths, so a symlinked home matches too.
 */
export const ownRoots = () => [stateDir(), configDir()].map(realOr);

/** True when `p` lies in one of the product's own folders. */
export const isOwnFolder = (p) => typeof p === 'string' && path.isAbsolute(p) && ownRoots().some((r) => within(realOr(p), r));

/** The real path of `p`; for a path not made yet, the real path of its nearest existing folder plus the rest. */
function realOr(p) {
  const rest = [];
  let at = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(at), ...rest);
    } catch {
      const up = path.dirname(at);
      if (up === at) return path.resolve(p);
      rest.unshift(path.basename(at));
      at = up;
    }
  }
}

/** Sub-directories of `dir` (already checked), sorted, hidden ones only on request, symlinks only into roots. */
export function listDirs(dir, roots, { hidden = false, max = 500 } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!hidden && e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push({ name: e.name, path: full });
    else if (e.isSymbolicLink() && insideRoots(full, roots)) out.push({ name: e.name, path: full });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out.slice(0, max);
}

/** What the browse screen shows for `p` (null when it is not allowed). */
export function browse(p, roots, opts) {
  const dir = insideRoots(p, roots);
  if (!dir) return null;
  const root = roots.find((r) => within(dir, r));
  const parent = dir === root ? null : path.dirname(dir);
  return { path: dir, short: tilde(dir), parent, dirs: listDirs(dir, roots, opts) };
}

// The cwd Claude Code wrote into a transcript: the first line that has one, within the first 64 KiB.
function cwdOfTranscript(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
        if (m) return JSON.parse(`"${m[1]}"`);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* unreadable */
  }
  return null;
}

/**
 * Folders Claude Code has sessions for, newest first: [{ path, at }]. The project folder names are lossy (every
 * non-alphanumeric becomes "-"), so the real path is read from the newest transcript in each.
 */
export function claudeFolders(limit = 30) {
  const base = path.join(claudeDir(), 'projects');
  let names;
  try {
    names = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const dir = path.join(base, d.name);
    let newest = null;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const st = fs.statSync(path.join(dir, f));
        if (!newest || st.mtimeMs > newest.at) newest = { file: path.join(dir, f), at: st.mtimeMs };
      }
    } catch {
      continue;
    }
    if (newest) found.push(newest);
  }
  found.sort((a, b) => b.at - a.at);
  const out = [];
  for (const f of found.slice(0, limit * 2)) {
    const cwd = cwdOfTranscript(f.file);
    if (cwd && !out.some((o) => o.path === cwd)) out.push({ path: cwd, at: f.at });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Recent folders for the picker: live sessions first, then Claude Code's own history; existing and inside roots.
 * `live`: the folders sessions run in, as paths or { cwd, session }; a live folder names its session, so the
 * picker opens it instead of starting a second one there.
 */
export function recentFolders(live, roots, limit = 12) {
  const seen = new Set();
  const out = [];
  const own = ownRoots();
  const add = (p, isLive, session = null) => {
    const real = insideRoots(p, roots);
    if (!real || seen.has(real) || own.some((r) => within(real, r))) return;
    seen.add(real);
    out.push({ path: real, short: tilde(real), name: path.basename(real) || real, live: isLive, ...(session ? { session } : {}) });
  };
  for (const x of live) typeof x === 'string' ? add(x, true) : add(x && x.cwd, true, x && typeof x.session === 'string' ? x.session : null);
  for (const f of claudeFolders()) add(f.path, false);
  return out.slice(0, limit);
}
