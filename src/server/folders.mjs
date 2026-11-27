// The folder picker: which folders the browser may see and start sessions in. Every path from the browser is
// resolved with realpath (so "..", symlinks and doubled slashes are gone) and must then lie inside one of the
// configured roots (server.roots, default: the home directory).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDir, configDir, stateDir, tilde } from '../paths.mjs';
import { isSecret } from '../editor/paths.mjs';

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

/**
 * How far Files and the editor reach on this computer. `server.reach` 'everything': the whole disk this user can
 * open (a terminal can already); else the allowed folders `server.roots` (the home folder unless changed). Hoprig's
 * own folders and the files that hold a sign-in stay locked either way (src/editor/paths.mjs). New sessions, Tia,
 * automations, chats and skills keep to the allowed folders (resolveRoots): the setting is about files only.
 */
export function reachRoots(server = {}, platform = process.platform) {
  if (server && server.reach === 'everything') return diskRoots(platform);
  return resolveRoots(server && server.roots);
}

/** The tops of every disk: "/" , or on Windows each drive letter that is there. */
export function diskRoots(platform = process.platform) {
  if (platform !== 'win32') return ['/'];
  const out = [];
  for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    try {
      if (fs.statSync(`${l}:\\`).isDirectory()) out.push(`${l}:\\`);
    } catch {
      /* no such drive */
    }
  }
  return out.length ? out : resolveRoots(null);
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
export function realOr(p) {
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

/**
 * True when `p` is, or lies inside, a place that holds a sign-in or the owner's credentials (the credentials folder, the
 * providers' folder, Claude Code's own sign-in files: editor/paths.mjs secretPaths), by its real place; also the
 * dashboard's own state and config folders (they hold the tokens and the private keys of the move).
 */
export const isSecretFolder = (p) => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0') && (isSecret(realOr(p)) || isOwnFolder(p));

/** What the browse screen shows for `p` (null when it is not allowed). Nothing is listed inside a secret place. */
export function browse(p, roots, opts) {
  const dir = insideRoots(p, roots);
  if (!dir) return null;
  // the outermost root that holds it (roots may lie inside one another: the projects folder inside the home)
  const root = roots.filter((r) => within(dir, r)).sort((a, b) => a.length - b.length)[0];
  const parent = dir === root ? null : path.dirname(dir);
  return { path: dir, short: tilde(dir), parent, dirs: isSecretFolder(dir) ? [] : listDirs(dir, roots, opts) };
}

export const SECRET_START_MSG = 'that folder holds the owner\'s credentials or a sign-in: only the owner starts a session or a chat there, from his own page';

/**
 * A session or a chat is started in `dir` (an absolute path as the request gave it): inside a secret place only the
 * owner's own page may (this dashboard's, or a main computer's relaying its own page), never Tia's token, her door,
 * her relay, another dashboard's plain token or a request without the page's mark, whatever her level says. Throws 403.
 * `ctx` is the server's feature context, `req` the request.
 */
export async function refuseSecretStart(ctx, req, dir) {
  if (!isSecretFolder(dir)) return;
  const [{ ownerPageOnly }, { tokenIdOf }] = await Promise.all([import('../workspace/whomay.mjs'), import('../machines/index.mjs')]);
  try {
    await ownerPageOnly(req, ctx, 'A start in this folder', { tokenId: tokenIdOf });
  } catch {
    throw Object.assign(new Error(SECRET_START_MSG), { status: 403 });
  }
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

/** The tail of a path that is a chat's worktree: /.claude/worktrees/<name> and anything inside it. */
const WORKTREE_TAIL = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/;

/**
 * Recent folders for the picker: live sessions first, then Claude Code's own history; existing and inside roots.
 * `live`: the folders sessions run in, as paths or { cwd, session } (a terminal) or { cwd, chat } (a chat at work); a
 * live folder names its session or chat, so the picker opens it instead of starting a second one there.
 */
export function recentFolders(live, roots, limit = 12) {
  const seen = new Set();
  const out = [];
  const own = ownRoots();
  const add = (p, isLive, session = null, chat = null) => {
    // A chat's own worktree (<project>/.claude/worktrees/<name>) is never a project: its project's folder is offered, so a
    // new session there starts in the project, and a chat running in the worktree counts as running in its project.
    const real = insideRoots(typeof p === 'string' ? p.replace(WORKTREE_TAIL, '') : p, roots);
    if (!real || seen.has(real) || own.some((r) => within(real, r)) || isSecretFolder(real)) return;
    seen.add(real);
    out.push({ path: real, short: tilde(real), name: path.basename(real) || real, live: isLive, ...(session ? { session } : {}), ...(chat ? { chat } : {}) });
  };
  const str = (x) => (typeof x === 'string' ? x : null);
  for (const x of live) typeof x === 'string' ? add(x, true) : add(x && x.cwd, true, x && str(x.session), x && str(x.chat));
  for (const f of claudeFolders()) add(f.path, false);
  return out.slice(0, limit);
}
