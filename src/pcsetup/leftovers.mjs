// What `hoprig get` (getproject.mjs) leaves when a run does not finish, and how the next one deals with it: a run
// killed after its clone, a clone whose folder name was taken, two runs at once. A clone is made under a temporary
// dot-folder in the projects folder, one name per address, so a later run finds it: a complete one is finished, an
// unfinished one is moved aside under a dated name (never deleted), and `workspace status` lists what is left. One
// run at a time per address and place: a lock file that names the process of its run (procid.mjs). Locks live in
// Hoprig's own state folder (<state>/get-locks/<place>/<address>.lock, both hashed: the place by its real path), never
// in the place's folder: there a lock was an untracked file of a group's repository, and stayed one after a killed run.
// The temporary clone is the one thing of Hoprig's own in a place's folder (a group's ignore lines cover it).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { stateDir } from '../paths.mjs';
import { mkdirIn, removeIn, renameIn } from '../workspace/inside.mjs';
import { alive, freshAfter, sameProcess, startOf, system } from '../procid.mjs';
import { capture, showCommand, showFileCommand } from '../setup/system.mjs';
import { sameUrl, urlKey } from '../workspace/map.mjs';
import { isLinkedWorktree } from '../workspace/layout.mjs';
import { cleanRemote, parseRepo } from './projects.mjs';
import { stamp } from './workspace.mjs';

const TEMP_PREFIX = '.hoprig-clone-';
const ASIDE = '.aside-'; // a leftover moved aside: <temporary name>.aside-<time>

const addressHash = (url) => crypto.createHash('sha256').update(urlKey(url)).digest('hex').slice(0, 8);
/** The temporary folder of a clone: one name per address, so a run finds what an earlier one left. */
export const tempNameFor = (r) => `${TEMP_PREFIX}${r.repo.toLowerCase()}-${addressHash(r.url)}`;

// A lock names the process of its run, not only its pid: a pid is handed out again, and the lock outlives its run and
// a restart of the computer. Where the system cannot tell who has a pid now (procid.mjs says "not known"), a lock is
// trusted for this long after it was written and taken over after that. The lock is held for the whole get: the
// parent's clone, its code repositories' clones and the installs. Six hours is a few gigabytes over a slow home line
// (5 GB at 2 Mbit/s is about 5.5 hours) with room left; the "being fetched" message says how to remove it sooner.
export const LOCK_MAX_AGE = 6 * 60 * 60_000;
const LEGACY_RE = /^\.hoprig-clone-[0-9a-f]{8}\.lock$/; // where an older Hoprig kept its locks: in the place's folder
const LOCK_RE = /^[0-9a-f]{8}\.lock$/;
const hash = (text, n) => crypto.createHash('sha256').update(text).digest('hex').slice(0, n);

/** A folder's real path; for one that is not there yet, its nearest existing parent's real path and the rest. */
function realDir(dir) {
  const abs = path.resolve(dir);
  const rest = [];
  for (let d = abs; ; d = path.dirname(d)) {
    try {
      return path.join(fs.realpathSync(d), ...rest);
    } catch {
      if (path.dirname(d) === d) return abs;
      rest.unshift(path.basename(d));
    }
  }
}

/** The folder of the locks for one place (`dir`, by its real path) in the state folder. */
const locksOf = (dir) => path.join(stateDir(), 'get-locks', hash(realDir(dir), 16));
// A member that comes with its group's repository has no address: it is locked by its <place>/<name>.
const keyOf = (r) => (r.url ? addressHash(r.url) : hash(`member:${r.member}`, 8));
/** The lock of a get of `r` (an address, or { member }) into the place `dir`. */
export const lockPathFor = (dir, r) => path.join(locksOf(dir), `${keyOf(r)}.lock`);
const legacyLockFor = (dir, r) => (r.url ? path.join(dir, `${TEMP_PREFIX}${addressHash(r.url)}.lock`) : null);

/**
 * Whether the run that wrote a lock (its text, its mtime) still goes on. → { pid, running }. Running: its pid lives and
 * is shown to be the same process (procid.mjs identity); where that cannot be told, while the lock is younger than
 * LOCK_MAX_AGE. An empty lock is being written (for an instant, where hard links cannot be made); any other text that
 * is no lock of this Hoprig is of no run.
 */
export function lockOwner(text, mtimeMs, { ident = system, now = Date.now() } = {}) {
  if (!String(text).trim()) return { pid: null, running: now - mtimeMs < 10_000 };
  let rec = null;
  try {
    rec = JSON.parse(text);
  } catch {
    /* not a lock of this Hoprig */
  }
  const pid = rec && Number.isInteger(rec.pid) && rec.pid > 0 ? rec.pid : null;
  if (!pid || !alive(pid)) return { pid, running: false };
  const same = typeof rec.proc === 'string' ? sameProcess(rec.proc, ident.of([pid], { after: freshAfter(), born: startOf(rec.proc) }).get(pid)) : null; // a fresh identity (procid.mjs freshAfter)
  return { pid, running: same !== null ? same : now - mtimeMs < LOCK_MAX_AGE };
}

/**
 * A file at an older Hoprig's lock name in a place's folder (.hoprig-clone-<8 hex>.lock): { pid, running } when it
 * parses as such a lock ({ pid, proc?, id? }, or the bare process number of the first ones), else null: then it is no lock (in a held folder it may be a tracked file)
 * and is left where it is. Its run goes on only when its process is shown to be that run (the same process identity);
 * without an identity it is stale at once (a checkout resets a file's time, so its age proves nothing here).
 */
export function legacyOwner(text, { ident = system } = {}) {
  let rec = null;
  try {
    rec = JSON.parse(text);
  } catch {
    return null;
  }
  if (Number.isInteger(rec) && rec > 0) return { pid: rec, running: false }; // the first locks were the bare process number
  if (!rec || typeof rec !== 'object' || Array.isArray(rec) || Object.keys(rec).some((k) => !['pid', 'proc', 'id'].includes(k))) return null;
  if (!Number.isInteger(rec.pid) || rec.pid <= 0 || (rec.proc !== undefined && rec.proc !== null && typeof rec.proc !== 'string')) return null;
  const running = typeof rec.proc === 'string' && alive(rec.pid) && sameProcess(rec.proc, ident.of([rec.pid], { after: freshAfter(), born: startOf(rec.proc) }).get(rec.pid)) === true;
  return { pid: rec.pid, running };
}

const unique = () => `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;

/** A lock's text, never through a link (O_NOFOLLOW where the system has it; lstat decides before). Throws when it cannot. */
function readLock(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** `text` written to a new file of its own name beside `file`. → its path */
function writeBeside(file, text) {
  const tmp = `${file}.new-${unique()}`;
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  return tmp;
}

/**
 * `file` made with `text` only when nothing is there: a hard link to a file already written, so that no run reads it
 * half written; an exclusive create where the file system has no hard links. → true, or false when something is there.
 */
function createWith(file, text, platform = process.platform, tr = null) {
  // Windows: a name whose removal is not through yet (another program, a virus scan, still holds the file for a
  // moment) refuses a new file with EPERM: something is there, as EEXIST says. The link's EPERM alone cannot tell that
  // from a folder that refuses hard links, so there the exclusive create decides: EEXIST or EPERM when the name is
  // held, a new lock where only links are refused (never "busy" for a folder nobody holds).
  const taken = (e) => e.code === 'EEXIST' || (platform === 'win32' && e.code === 'EPERM');
  const tmp = writeBeside(file, text);
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    tr?.('link', e.code);
    if (e.code === 'EEXIST') return false;
    try {
      fs.writeFileSync(file, text, { flag: 'wx' });
      return true;
    } catch (e2) {
      tr?.('make', e2.code);
      if (taken(e2)) return false;
      throw e2;
    }
  } finally {
    // A removal refused (Windows: a file another process touches) must not turn a lock made into an error.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* a file of its own name left beside the lock */
    }
  }
}

/**
 * Replaces the stale lock whose text this run read (`seen`) with `mine`. Of the runs that read the same stale lock only
 * the one that makes the claim (a file named after that text, made exclusively) may replace it, and only while the
 * lock still holds that text: a run that comes later finds another text and does not touch it. → true when replaced.
 */
function replaceStale(file, seen, mine, tr = null, platform = process.platform) {
  return withClaim(file, seen, () => {
    if (readLock(file) !== seen) return tr?.('replace', 'changed'), false;
    // Windows refuses a rename over a file another process has open (measured: EPERM every time, and the other run
    // reads this very lock to judge it), so there the stale lock is removed and this run's made exclusively in its
    // place. Only the claim's holder removes it, and only after reading it as `seen` (stale) under the claim; another
    // run's fresh lock never has that text. A removal refused while the other run touches the file (EPERM, now and
    // then) is tried again, briefly.
    if (platform === 'win32') {
      for (const end = Date.now() + 1000; ;) {
        try {
          fs.rmSync(file, { force: true });
          break;
        } catch (e) {
          tr?.('remove', e.code);
          if (e.code !== 'EPERM' || Date.now() > end) return false;
          pause(5);
        }
      }
      return createWith(file, mine, platform, tr);
    }
    const tmp = writeBeside(file, mine);
    try {
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      tr?.('rename', e.code);
      fs.rmSync(tmp, { force: true });
      return false;
    }
  }, tr);
}

/**
 * Anything at the lock's name that is not a regular file (a folder, a link: the link itself, never what it points to)
 * is moved aside under a dated name, never deleted, under the same claim as a take-over (`seen`: what lstat showed).
 * → the name it was moved to, or null.
 */
function moveAsideOther(file, seen, st) {
  let aside = null;
  withClaim(file, seen, () => {
    const now = fs.lstatSync(file);
    if (now.isFile() || now.ino !== st.ino || now.dev !== st.dev) return false;
    aside = `${file}${ASIDE}${stamp()}`;
    for (let i = 2; fs.existsSync(aside) || isLink(aside); i++) aside = `${file}${ASIDE}${stamp()}-${i}`;
    fs.renameSync(file, aside);
    return true;
  });
  return aside;
}

const isLink = (p) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** `act()` while holding the claim for `seen` (a file named after it, made exclusively). → what act returned, or false. */
function withClaim(file, seen, act, tr = null) {
  const claim = `${file}.take-${crypto.createHash('sha256').update(seen).digest('hex').slice(0, 12)}`;
  try {
    fs.writeFileSync(claim, '', { flag: 'wx' });
  } catch (e) {
    tr?.('claim', e.code);
    try {
      if (Date.now() - fs.statSync(claim).mtimeMs > 60_000) fs.rmSync(claim, { force: true }); // left by a killed run
    } catch {
      /* gone */
    }
    return false;
  }
  try {
    return act();
  } catch (e) {
    tr?.('act', e.code);
    return false; // gone meanwhile
  } finally {
    try {
      fs.rmSync(claim, { force: true });
    } catch {
      /* left: removed by the next taker once it is a minute old (above), never this act's error */
    }
  }
}

/** A lock this run holds: released only while it is still this run's own (never one taken over from it). */
const held = (file, mine) => ({
  release: () => {
    try {
      if (readLock(file) === mine) fs.rmSync(file, { force: true });
    } catch {
      /* gone */
    }
    try {
      fs.rmdirSync(path.dirname(file)); // the place's folder of locks goes with its last lock (another run's keeps it)
    } catch {
      /* not empty, or gone */
    }
  },
});

/**
 * One run at a time per address in a projects folder: a lock file there that names this run's process, made only when
 * nothing is there. A lock whose run is not shown to go on is taken over (replaceStale), then read back: this run goes
 * on only when the lock holds its own text; else another run took it over first, and this one is busy.
 * `at`: the workspace and projects folders the place lies in (inside.mjs; this computer's by default): the place's folder
 * is checked again at each act here, from them down.
 * → { release } | { busy: { pid, file } }
 */
// Windows: how long the rounds of a take-over go on, at least, while a file of the lock is held a moment by another
// program (a virus scan: a removed claim or lock refuses a new one, a replace is refused): ten rounds of 20 ms are
// gone before such a file is let go, and two runs on one stale lock were both left busy.
const WINDOWS_ROUNDS_MS = 3000;

/**
 * What a take-over met, for a test's failure message: `trace(step, what)` when given, or, for a run in a process of
 * its own, a line per step appended to the file HOPRIG_LOCK_TRACE names (tests only). Nothing at all otherwise.
 */
function tracer(trace) {
  if (trace) return trace;
  const to = process.env.HOPRIG_LOCK_TRACE;
  if (!to) return null;
  const t0 = Date.now();
  return (step, what) => {
    try {
      fs.appendFileSync(to, `${process.pid} +${Date.now() - t0}ms ${step} ${what ?? ''}\n`);
    } catch {
      /* a trace never stops a get */
    }
  };
}

export function takeLock(dir, r, { ident = system, ui = null, at = {}, platform = process.platform, trace = null } = {}) {
  const tr = tracer(trace);
  const file = lockPathFor(dir, r);
  const mine = `${JSON.stringify({ pid: process.pid, proc: ident.self(), id: unique() })}\n`;
  const inPlace = { ...at, root: dir };
  try {
    mkdirIn(inPlace, dir);
  } catch {
    /* the clone says why */
  }
  // A lock an older Hoprig left in the place's folder: its run going on keeps this one waiting; one that ended is
  // removed (it is Hoprig's own file, and it would stay an untracked file there).
  const legacy = legacyLockFor(dir, r);
  const lst = legacy ? lstat(legacy) : null;
  if (lst && lst.isFile()) {
    let owner = { pid: null, running: false };
    try {
      owner = legacyOwner(readLock(legacy), { ident });
    } catch {
      /* gone meanwhile */
    }
    if (!owner) {
      if (ui) ui.line('warn', `${legacy} has the name of an older Hoprig's lock but is no lock: left where it is`);
    } else if (owner.running) return { busy: { pid: owner.pid, file: legacy } };
    else {
      try {
        removeIn(inPlace, legacy);
      } catch {
        /* a place that leads out: the clone refuses and says why */
      }
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return { release: () => {} }; // a state folder that cannot be written: one run at a time is not kept, the get goes on
  }
  const until = platform === 'win32' ? Date.now() + WINDOWS_ROUNDS_MS : 0;
  for (let i = 0; i < 10 || Date.now() < until; i++) {
    try {
      if (createWith(file, mine, platform, tr)) return tr?.('held', i), held(file, mine);
    } catch {
      return { release: () => {} }; // a folder that cannot be written: the clone says why
    }
    let seen;
    let st;
    try {
      st = fs.lstatSync(file);
      if (!st.isFile()) {
        const aside = moveAsideOther(file, `other:${st.dev}:${st.ino}`, st);
        if (aside && ui) ui.line('warn', `${file} was not a lock file (a folder or a link): it was moved aside, nothing deleted: ${aside}`);
        continue;
      }
      seen = readLock(file);
    } catch (e) {
      tr?.('read', e.code);
      pause(20); // gone meanwhile, or (Windows) its name still held a moment: looked at again in a moment
      continue;
    }
    const owner = lockOwner(seen, st.mtimeMs, { ident });
    tr?.('owner', `${owner.pid} running=${owner.running} age=${Math.round(Date.now() - st.mtimeMs)}ms`);
    if (owner.running) return { busy: { pid: owner.pid, file } };
    if (replaceStale(file, seen, mine, tr, platform)) {
      let back = null;
      try {
        back = readLock(file);
      } catch {
        /* gone */
      }
      if (back === mine) return tr?.('held', `${i} by replace`), held(file, mine);
      tr?.('replaced', 'but read back another');
    }
    pause(20); // another run is taking it over right now: its lock decides in the next round
  }
  tr?.('busy', 'rounds over');
  return { busy: { pid: null, file } };
}

/**
 * The locks of gets into a place (`dir`), for `workspace status`: [{ path, pid, running }]. Those in the state folder,
 * then any an older Hoprig left in the place's folder itself.
 */
export function findLocks(dir, { ident = system } = {}) {
  const list = (d, re) => {
    try {
      return fs.readdirSync(d).filter((n) => re.test(n)).sort().map((n) => path.join(d, n));
    } catch {
      return [];
    }
  };
  const out = [];
  for (const p of list(locksOf(dir), LOCK_RE)) {
    try {
      out.push({ path: p, ...lockOwner(readLock(p), fs.lstatSync(p).mtimeMs, { ident }) });
    } catch {
      out.push({ path: p, pid: null, running: false });
    }
  }
  // An older Hoprig's lock in the place's folder: only a file that is one (anything else there is not Hoprig's).
  for (const p of list(dir, LEGACY_RE)) {
    let owner = null;
    try {
      owner = fs.lstatSync(p).isFile() ? legacyOwner(readLock(p), { ident }) : null;
    } catch {
      /* gone, or unreadable */
    }
    if (owner) out.push({ path: p, ...owner });
  }
  return out;
}

/** A clone that finished: its commit is there and nothing in it differs from that commit. */
async function completeClone(p, run) {
  if (isLinkedWorktree(p) || fs.existsSync(path.join(p, '.git', 'index.lock'))) return false;
  const head = await gitRead(p, ['rev-parse', '--verify', '--quiet', 'HEAD'], { run, timeout: 10_000 });
  if (!head.ok) return false;
  const st = await gitRead(p, ['status', '--porcelain'], { run, timeout: 30_000 });
  return st.ok && !st.stdout.trim();
}

// The temporary name a run for this address would use: only a leftover under exactly that name is ever finished.
const exactName = (name, url) => {
  const r = parseRepo(url);
  return Boolean(r) && name === tempNameFor({ url, repo: r.name.replace(/\.git$/, '') });
};

/**
 * The temporary clones left in a projects folder: [{ name, path, url, complete, aside, fix }]. `fix`: what to do
 * (a complete one under its address's own temporary name: get it again, which finishes it; anything else: look at
 * it, then remove it by hand). `place`: the group or held folder `dir` is (none for the projects folder): the get
 * says --in, else it would go into the projects folder and clone there again.
 */
export async function findLeftovers(dir, run = capture, { place = '' } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith(TEMP_PREFIX)).map((d) => d.name).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const p = path.join(dir, name);
    const aside = name.includes(ASIDE);
    const o = lstat(path.join(p, '.git'))?.isDirectory() ? await gitRead(p, ['config', '--get', 'remote.origin.url'], { run, timeout: 10_000 }) : { ok: false };
    const url = o.ok && o.stdout.trim() ? cleanRemote(o.stdout.trim()) : null;
    const exact = !aside && Boolean(url) && exactName(name, url);
    const complete = exact && (await completeClone(p, run));
    const getIt = showCommand(['hoprig', 'get', url, ...(place ? ['--in', place] : [])]); // the address comes from the clone's own settings
    const fix = complete ? getIt : exact ? `${getIt}   (it moves this one aside and clones again)` : `look at it, then remove it:  ${showFileCommand('rm -rf', [p])}`;
    out.push({ name, path: p, url, complete, aside, fix });
  }
  return out;
}

/**
 * Before a clone: only what is at exactly this run's temporary name (it holds the hash of the address) is this run's.
 * A complete clone there is used; anything else there is moved aside under a dated name. No other .hoprig-clone-*
 * folder is touched (another address's clone may be under way there; `workspace status` lists them). Nothing is
 * deleted. → the leftover used, or null.
 */
export async function useLeftover(dir, r, tempName, { ui, run, at = {} }) {
  const there = lstat(path.join(dir, tempName));
  if (!there) return null;
  // The temporary name must be a real folder made by a clone: a link there (the link is moved, never what it points
  // to) or a file is moved aside, and the clone is made new.
  const l = there.isDirectory() ? (await findLeftovers(dir, run)).find((x) => x.name === tempName) : { name: tempName, path: path.join(dir, tempName), complete: false };
  if (!l) return null;
  // Used only when it is a clone of this very address (its remote may have been changed by hand to another's).
  if (l.complete && sameUrl(l.url, r.url)) {
    ui.line('ok', 'a complete clone an earlier run left here is used: it is finished now, not cloned again');
    return l;
  }
  let aside = `${l.name}${ASIDE}${stamp()}`;
  for (let i = 2; fs.existsSync(path.join(dir, aside)); i++) aside = `${l.name}${ASIDE}${stamp()}-${i}`;
  renameIn({ ...at, root: dir }, l.path, path.join(dir, aside)); // the name is moved, never what a link there points to
  ui.line('warn', there.isDirectory() ? `a clone an earlier run left unfinished was moved aside (nothing deleted): ${path.join(dir, aside)}` : `a ${there.isSymbolicLink() ? 'link' : 'file'} at the clone's temporary name was moved aside (nothing deleted): ${path.join(dir, aside)}`);
  return null;
}

/**
 * Dry run: what takeLock would find, said and nothing taken. → a message when another run goes on (a real run would
 * stop there), else null.
 */
export function sayLock(dir, r, { ui, ident = system } = {}) {
  const legacy = legacyLockFor(dir, r);
  const lst = legacy ? lstat(legacy) : null;
  // An older Hoprig's lock is looked at first, as takeLock does; a file there that is no lock is left and named.
  let old = null;
  try {
    old = lst && lst.isFile() ? legacyOwner(readLock(legacy), { ident }) : null;
  } catch {
    /* gone meanwhile */
  }
  if (lst && lst.isFile() && !old) ui.note(`(dry run) ${legacy} has the name of an older Hoprig's lock but is no lock: a real run leaves it where it is`);
  if (old) {
    if (!old.running) {
      ui.note(`(dry run) the lock an older Hoprig left (${legacy}) would be removed; its run has ended`);
    } else {
      const message = `another run of Hoprig is fetching it right now (process ${old.pid}): a real run would stop here and wait for it`;
      ui.line('warn', `(dry run) ${message}`);
      return message;
    }
  }
  const file = lockPathFor(dir, r);
  const st = lstat(file);
  if (!st) return null;
  if (!st.isFile()) {
    ui.note(`(dry run) ${file} is not a lock file (a folder or a link): a real run would move it aside, nothing deleted`);
    return null;
  }
  let owner = { pid: null, running: false };
  try {
    owner = lockOwner(readLock(file), st.mtimeMs, { ident });
  } catch {
    /* gone meanwhile, or unreadable: a real run takes it over */
  }
  if (!owner.running) {
    ui.note(`(dry run) the lock an earlier run of hoprig get left (${file}) would be taken over; its run has ended`);
    return null;
  }
  const message = `another run of Hoprig is fetching it right now${owner.pid ? ` (process ${owner.pid})` : ''}: a real run would stop here and wait for it`;
  ui.line('warn', `(dry run) ${message}`);
  return message;
}

/** Dry run: what useLeftover would do with what is at this run's temporary name, said and nothing moved or used. */
export async function sayLeftover(dir, r, tempName, { ui, run = capture }) {
  const p = path.join(dir, tempName);
  const there = lstat(p);
  if (!there) return;
  const l = there.isDirectory() ? (await findLeftovers(dir, run)).find((x) => x.name === tempName) : null;
  if (l && l.complete && sameUrl(l.url, r.url)) ui.note(`(dry run) the complete clone an earlier run left in ${p} would be used, not cloned again`);
  else if (there.isDirectory()) ui.note(`(dry run) the unfinished clone an earlier run left in ${p} would be moved aside (nothing deleted), and a new clone made`);
  else ui.note(`(dry run) the ${there.isSymbolicLink() ? 'link' : 'file'} at the clone's temporary name ${p} would be moved aside (nothing deleted)`);
}

const lstat = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
