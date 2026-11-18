// Where Hoprig acts in the workspace, it stays really inside. A repository (a group's, a project's parent, a code
// repository) is data from a git server: it may commit `code -> /somewhere/else`, `builds -> ..` or
// `.env.example -> ~/.ssh/id_ed25519`, and a clone, a fetch, a push, a copy or an install through such a path would
// act outside the folder the map names. So this module is the ONLY way any code of Hoprig gets a folder or a file of
// the workspace to act on:
//
//   leaves(root, p)   null when `p` really lies inside `root`: with every link resolved (the real path of the
//                     nearest part that exists, plus the rest) it is inside the real path of `root`, and `root`
//                     itself lies where the map says, with no link on the way from the workspace (or the projects
//                     folder) down to it. Else { path: the link met, what: LEAVES }.
//
// `root` is the entry's own folder: a project's, a group's, a member's, a code repository's, the brain's. No question
// to git and no difference between a link that came with a repository and one made by hand, with one exception the
// owner states himself on this computer (`hoprig workspace mylink add <path>`): a link he names as his own (a
// project folder kept on another disk) is followed, and a path that leaves only through such links is fine. The
// list is kept in Hoprig's own settings on this computer, never in the map, never synced.
//
// The acts below check at the moment of the act, so a caller cannot forget it: clone into (cloneInto), run git in
// (gitIn), start a program in (startIn), write a file (writeIn: never THROUGH a link, the target is a regular file or
// does not exist), read a file to act on it (readIn), copy a file (copyIn: the source is read the same way), make a
// folder (mkdirIn), rename (renameIn), remove (removeIn). What remains is the moment between the look and the
// system's own write: only a person or a program writing on this computer can turn a folder into a link then.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { withoutSecrets } from '../secretenv.mjs';
import { capture } from '../setup/system.mjs';
import { projectsIn, workspaceDir } from './layout.mjs';

export const LEAVES = 'leaves its folder through a link';
const NOT_IN = 'is not in the workspace';

// A file system that ignores letter case (macOS, Windows) has one folder for "Shop" and "shop".
const fold = process.platform === 'darwin' || process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
const within = (p, top) => {
  const a = fold(p);
  const b = fold(top);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};
const lst = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

const LINK_SEP = process.platform === 'win32' ? /[\\/]/ : /\//;

/**
 * The real path of `p`: every link resolved, a dangling one too (its target, plus the rest), the part that does not
 * exist yet added as written. null for a loop of links or a link that cannot be read. A ".." in a link's target is
 * the real parent of where the walk is, as the system resolves it (`a -> ..`, `l -> a/../../x` leads two folders up
 * from a), never the lexical one.
 */
export function realOf(p) {
  const abs = path.resolve(p);
  const { root } = path.parse(abs);
  const todo = abs.slice(root.length).split(path.sep).filter(Boolean).reverse(); // a stack: the next part last
  let cur = root;
  let hops = 0;
  while (todo.length) {
    const part = todo.pop();
    if (part === '.') continue;
    if (part === '..') {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, part);
    const st = lst(next);
    if (!st) return path.join(next, ...todo.reverse());
    if (!st.isSymbolicLink()) {
      cur = next;
      continue;
    }
    if (++hops > 40) return null;
    let to;
    try {
      to = fs.readlinkSync(next);
    } catch {
      return null;
    }
    const top = path.isAbsolute(to) ? path.parse(to).root : '';
    if (top) cur = top;
    todo.push(...to.slice(top.length).split(LINK_SEP).filter(Boolean).reverse());
  }
  return cur;
}

// ---- the owner's own links (this computer only) ----

// Each entry is { path, to }: the link and the real place it pointed to when the owner named it. A link a repository
// tracks can be pointed elsewhere by a pull; it is then no longer the link he named, and it is not followed until he
// names it again. (An entry without `to` says nothing about where it may point: it is never followed.)
const entryOf = (x) => (x && typeof x === 'object' && typeof x.path === 'string' && path.isAbsolute(x.path) && typeof x.to === 'string' && path.isAbsolute(x.to) ? { path: path.resolve(x.path), to: x.to } : null);

/** The links the owner named as his own on this computer, with where each pointed then: [{ path, to }]. */
export function myLinkEntries() {
  try {
    const l = loadConfig().workspaceLinks;
    return Array.isArray(l) ? l.map(entryOf).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** The paths of the owner's own links (settings key "workspaceLinks"). */
export const myLinks = () => myLinkEntries().map((e) => e.path);

// `at.mylinks` (a test's or a caller's own list): entries { path, to }, or a path alone, which then counts with where it
// points at the moment it is read.
const ctxOf = (at = {}) => ({
  dir: path.resolve(at.dir || workspaceDir()),
  projects: path.resolve(at.projects || projectsIn()),
  mine: new Map((at.mylinks || myLinkEntries()).map((x) => (typeof x === 'string' ? { path: x, to: realOf(x) } : x)).filter((e) => e && e.to).map((e) => [fold(path.resolve(e.path)), e.to])),
});

/**
 * Add a link of the workspace to the owner's own list, with where it points now. It must be a link (lstat) inside the
 * workspace or the projects folder. Named again after it was pointed elsewhere, the new place is kept.
 * → { path, to, added: boolean, moved?: the place it pointed to before }. Throws { status } with why.
 */
export function addMyLink(p, at = {}) {
  const c = ctxOf(at);
  const abs = path.resolve(p);
  if (!within(abs, c.dir) && !within(abs, c.projects)) throw Object.assign(new Error(`${abs} ${NOT_IN}`), { status: 400 });
  const st = lst(abs);
  if (!st || !st.isSymbolicLink()) throw Object.assign(new Error(`${abs} is not a link`), { status: 400 });
  const to = realOf(abs);
  if (!to) throw Object.assign(new Error(`${abs} is a link that cannot be followed (a loop, or it cannot be read)`), { status: 400 });
  const cur = myLinkEntries();
  const was = cur.find((x) => fold(x.path) === fold(abs));
  if (was && was.to === to) return { path: abs, to, added: false };
  saveConfig({ workspaceLinks: [...cur.filter((x) => x !== was), { path: abs, to }] });
  return { path: abs, to, added: true, ...(was ? { moved: was.to } : {}) };
}

/** Take a link off the owner's list (it stays on the disk). → { path, removed } */
export function removeMyLink(p) {
  const abs = path.resolve(p);
  const cur = myLinkEntries();
  const next = cur.filter((x) => fold(x.path) !== fold(abs));
  if (next.length !== cur.length) saveConfig({ workspaceLinks: next });
  return { path: abs, removed: next.length !== cur.length };
}

/** The command a person runs to name a link as his own. */
export const myLinkCommand = (p) => `hoprig workspace mylink add ${/^[A-Za-z0-9._/:@+-]+$/.test(p) ? p : `'${String(p).replace(/'/g, "'\\''")}'`}`;

// ---- the one check ----

/**
 * Does `p` leave the folder `root`? → null (it is really inside) | { path, what } (the link met, or the path that is
 * not in the workspace). `at`: { dir, projects, mylinks } (default: this computer's). `below`: only from `root` down
 * (a read that is no act: the root may be the owner's link; what is under it must stay inside).
 */
export function leaves(root, p = root, at = {}, { below = false } = {}) {
  const c = ctxOf(at);
  const R = path.resolve(root);
  const P = path.resolve(p);
  if (!within(P, R)) return { path: P, what: 'is not inside its folder' };
  // The base the root is checked from: the workspace or the projects folder it lies in (the longer when both), also
  // when the root is spelled by their real paths (a workspace that is itself a link). A root in neither is a folder
  // the owner gave a command himself (--dir, a template): only what is below it is checked.
  const bases = below ? [] : [c.dir, c.projects, realOf(c.dir), realOf(c.projects)].filter((x) => x && within(R, x));
  const base = bases.sort((x, y) => y.length - x.length)[0] || R;
  let cur = realOf(base);
  if (!cur) return { path: base, what: LEAVES };
  let fence = cur;
  let lex = base;
  const rest = path.relative(base, P).split(path.sep).filter(Boolean);
  const rootDepth = path.relative(base, R).split(path.sep).filter(Boolean).length;
  for (let i = 0; i < rest.length; i++) {
    lex = path.join(lex, rest[i]);
    const next = path.join(cur, rest[i]);
    const st = lst(next);
    if (!st) break; // nothing there yet: what is made below it is made inside
    if (st.isSymbolicLink()) {
      const to = realOf(next);
      if (c.mine.has(fold(lex))) {
        if (!to) return { path: lex, what: LEAVES };
        // Pointed elsewhere since the owner named it (a pull of a repository that tracks it): not the link he named.
        if (fold(to) !== fold(c.mine.get(fold(lex)))) return { path: lex, what: LEAVES, now: to };
        cur = to;
        fence = to; // the owner's own link: what is below it stays inside where it points
      } else {
        // On the way to the root no link at all (the root is not where the map says); below it, one that stays inside.
        if (i < rootDepth || !to || !within(to, fence)) return { path: lex, what: LEAVES };
        cur = to;
      }
    } else cur = next;
    if (i === rootDepth - 1) fence = cur;
  }
  return null;
}

/** The words for a refusal: "<path> leaves its folder through a link" (and where the owner's own link points now). */
export const leavesWords = (b) => `${b.path} ${b.what}${b.now ? ` (your own link, but it points to ${b.now} now)` : ''}`;

const refusal = (b) => Object.assign(new Error(`${leavesWords(b)}: nothing was done there`), { status: 409, code: 'ELEAVES', leaves: b });

/** `p` when it is really inside `root`, else throws { status: 409, code: 'ELEAVES', leaves }. */
export function insideOr(root, p = root, at = {}) {
  const b = leaves(root, p, at);
  if (b) throw refusal(b);
  return path.resolve(p);
}

// `at`: a root folder, or { root, dir?, projects?, mylinks? } (dir and projects: the workspace a test or a caller uses).
const rootOf = (at) => (typeof at === 'string' ? { root: at } : at);
const failed = (b) => ({ ok: false, code: 1, stdout: '', stderr: `${leavesWords(b)}: nothing was done there`, output: '', leaves: b });

// ---- the acts ----

/** git in `dir` (inside `at`'s root): `git -C <dir> …`. → the runner's result, or ok false when it leaves. */
export async function gitIn(at, dir, args, run = capture, opts = {}) {
  const a = rootOf(at);
  const b = leaves(a.root, dir, a);
  if (b) return failed(b);
  return run(['git', '-C', path.resolve(dir), ...args], { timeout: 120_000, ...opts });
}

/** A program started in `dir` (an install): the runner gets `cwd`. → the runner's result, or ok false. */
export async function startIn(at, dir, argv, run, opts = {}) {
  const a = rootOf(at);
  const b = leaves(a.root, dir, a);
  if (b) return failed(b);
  return run(argv, { ...opts, cwd: path.resolve(dir) });
}

/**
 * Clone `url` into `dest` (inside `at`'s root; `dest` may be the root). Never into a folder that has something in it
 * (an empty one is cloned into). `scratch`: `dest` is in a temporary folder Hoprig just made, outside the workspace.
 * → { ok, dest, skipped?, output, leaves? }
 */
export async function cloneInto(at, destGiven, url, { run, env = {}, onLine = () => {}, quiet = false, scratch = false } = {}) {
  const a = rootOf(at);
  const dest = path.resolve(destGiven); // what is checked is what is acted on (a "<link>/.." is resolved first)
  if (!scratch) {
    const b = leaves(a.root, dest, a);
    if (b) {
      onLine(`${leavesWords(b)}: nothing was cloned`);
      return { ...failed(b), dest };
    }
  }
  const st = lst(dest);
  if (st && !(st.isDirectory() && fs.readdirSync(dest).length === 0)) {
    onLine(`${dest} is already there: left as it is.`);
    return { ok: true, dest, skipped: true };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // A clone needs no provider key; it keeps GitHub's token, which a private repository may need.
  const e = { ...withoutSecrets(process.env), ...(quiet ? { GIT_TERMINAL_PROMPT: '0' } : {}), ...env };
  const r = await run(['git', 'clone', '--', url, dest], { env: e, onLine, interactive: false });
  return { ok: r.ok, dest, output: r.output };
}

/**
 * Make a folder (and those above it) inside `at`'s root. `mode`: the folder's exact mode (mkdir's own is narrowed by
 * the umask), set only on a real folder, never through a link. Throws when it leaves.
 */
export function mkdirIn(at, dirGiven, opts = {}) {
  const a = rootOf(at);
  const dir = insideOr(a.root, dirGiven, a);
  fs.mkdirSync(dir, { recursive: true, ...opts });
  if (opts.mode !== undefined) {
    const st = lst(dir);
    if (!st || !st.isDirectory()) throw Object.assign(new Error(`${dir} is not a folder: its mode was not set`), { status: 409, code: 'ENOTDIR' });
    fs.chmodSync(dir, opts.mode);
  }
  return dir;
}

/** Remove an EMPTY real folder inside `at`'s root (a link there is someone's and stays). → true when it went. */
export function rmdirIn(at, dirGiven) {
  const a = rootOf(at);
  const dir = path.resolve(dirGiven);
  const st = lst(dir);
  if (!st || !st.isDirectory()) return false;
  insideOr(a.root, dir, a);
  fs.rmdirSync(dir);
  return true;
}

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

/** What is at `file`: 'none' | 'file' | 'link' | 'other'. */
export function kindAt(file) {
  const st = lst(file);
  return !st ? 'none' : st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other';
}

/**
 * Write `data` to `file` inside `at`'s root, never through a link: the target is a regular file or does not exist.
 * `excl`: only a new file. `atomic`: written to a temporary file beside it and renamed over it (a rename replaces
 * the name, never what a link there points to). Throws when it leaves or something else is there.
 */
export function writeIn(at, fileGiven, data, { mode, excl = false, atomic: atomicGiven = false } = {}) {
  const a = rootOf(at);
  const file = path.resolve(fileGiven);
  insideOr(a.root, path.dirname(file), a);
  const k = kindAt(file);
  if (k === 'link' || k === 'other' || (excl && k !== 'none')) throw Object.assign(new Error(`${file} is ${k === 'none' || k === 'file' ? 'there already' : k === 'link' ? 'a link' : 'not a regular file'}: Hoprig never writes through one`), { status: 409, code: k === 'link' ? 'ELINK' : 'EEXIST' });
  // A file with more than one name (a hard link, perhaps to a file outside) is replaced, never written in place: a
  // write in place would change the file outside too.
  const st = k === 'file' ? lst(file) : null;
  const atomic = atomicGiven || (st && st.nlink > 1);
  if (st && st.nlink > 1 && mode === undefined) mode = st.mode & 0o777;
  if (atomic) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, data, { flag: 'wx', ...(mode ? { mode } : {}) });
    fs.renameSync(tmp, file);
    return file;
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | NOFOLLOW | (excl ? fs.constants.O_EXCL : fs.constants.O_TRUNC);
  const fd = fs.openSync(file, flags, mode || 0o644);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

/**
 * Read a file to act on it (a template, an .env.example, a rules file, a manifest): only a regular file inside
 * `at`'s root (`below`: the root may be the owner's link), never through a link. → Buffer | null (not there, a link,
 * or it leaves: not read).
 */
export function readIn(at, fileGiven, { below = false } = {}) {
  const a = rootOf(at);
  const file = path.resolve(fileGiven);
  if (leaves(a.root, path.dirname(file), a, { below }) || kindAt(file) !== 'file') return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    return fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Copy `src` to `dest` (a new file) inside `at`'s root. The source is read as readIn reads (inside `from`, which is
 * `at` unless given; `from: null` for a file outside the workspace that is the owner's own, still never through a
 * link). → true, or false with nothing done when the source is no regular file inside. Throws when `dest` leaves.
 */
export function copyIn(at, src, dest, { from } = {}) {
  let buf;
  if (from === null) {
    buf = kindAt(src) === 'file' ? fs.readFileSync(src) : null;
  } else buf = readIn(from || at, src);
  if (!buf) return false;
  writeIn(at, dest, buf, { excl: true });
  return true;
}

/**
 * Make the link `link` → `target` inside `at`'s root (a template's own link): where it points must be inside the
 * root too, and nothing may be at `link` yet. Throws when either leaves.
 */
export function linkIn(at, linkGiven, target, type) {
  const a = rootOf(at);
  const link = path.resolve(linkGiven);
  insideOr(a.root, path.dirname(link), a);
  insideOr(a.root, path.resolve(path.dirname(link), target), a);
  fs.symlinkSync(target, link, type);
  // Each target may look inside on its own and still lead out through another link (`a -> ..`, `l -> a/../../x`): the
  // link made is followed as the system follows it, and taken away again when it leads out.
  if (leavesThrough(a.root, link)) {
    fs.unlinkSync(link);
    throw refusal({ path: link, what: LEAVES });
  }
  return link;
}

/** Does the link `link` (made in `root`) lead out of the real `root` when followed as the system follows it? */
export const leavesThrough = (root, link) => {
  const to = realOf(link);
  const top = realOf(root);
  return !to || !top || !within(to, top);
};

/** Rename inside `at`'s root (both names): the name is moved, never what a link there points to. */
export function renameIn(at, fromGiven, toGiven) {
  const a = rootOf(at);
  const from = path.resolve(fromGiven);
  const to = path.resolve(toGiven);
  insideOr(a.root, path.dirname(from), a);
  insideOr(a.root, path.dirname(to), a);
  fs.renameSync(from, to);
  return to;
}

/** Remove inside `at`'s root (a link is removed itself, never what it points to). */
export function removeIn(at, pGiven, { recursive = false } = {}) {
  const a = rootOf(at);
  const p = path.resolve(pGiven);
  insideOr(a.root, path.dirname(p), a);
  fs.rmSync(p, { recursive, force: true });
}
