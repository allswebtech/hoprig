// What a copy is proved by, and what a plan's fingerprint is made of: a repository's git state (HEAD, every ref, the
// status and the diffs by hash, the stash count, the remotes, each linked worktree) and a whole-tree listing of a
// folder (path, kind, size, mode, mtime (sameTime below), content hash or link text). Read only: git is asked through the
// reader (gitread.mjs), files are stat'ed and read, nothing is written. A private folder (PRIVATE_DIRS) is never
// entered: the listing counts it and names nothing in it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import { PRIVATE_DIRS, STATUS_EXCLUDES } from '../pcsetup/projects.mjs';
import { commonDir, noSignIn, worktreesOf } from './scan.mjs';

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const isPrivate = (name) => PRIVATE_DIRS.includes(name) || PRIVATE_DIRS.includes(String(name).toLowerCase());

const out = async (dir, args) => {
  const r = await gitRead(dir, args, { timeout: 60_000 });
  return r.ok ? r.stdout : null;
};

/**
 * The git state of the checkout at `dir` (one worktree): what two copies must have equal. Never `git diff` against
 * the working tree: it writes a refreshed index even with optional locks off (seen on git 2.53), which would change an
 * original. What is staged is the index's own entries (ls-files --stage, which writes nothing); what is not staged is
 * proved by the file set's content hashes (treeOf).
 */
export async function checkoutState(dir) {
  const head = (await out(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])) || '';
  const status = await out(dir, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all', '--', '.', ...STATUS_EXCLUDES]);
  const staged = await out(dir, ['ls-files', '--stage', '-z']);
  return { head: head.trim() || null, status: status === null ? null : hash(status), staged: staged === null ? null : hash(staged) };
}

/** The whole git state of a repository: its checkout, every ref, stashes, remotes and its linked worktrees. */
export async function repoState(dir) {
  const common = commonDir(dir);
  const refs = await out(dir, ['for-each-ref', '--format=%(objectname) %(refname)']);
  const remotes = await out(dir, ['config', '--get-regexp', '^remote\\..*\\.url$']);
  let stash = 0;
  try {
    stash = fs.readFileSync(path.join(common, 'logs', 'refs', 'stash'), 'utf8').split('\n').filter(Boolean).length;
  } catch {
    /* no stash */
  }
  const worktrees = [];
  for (const w of common ? worktreesOf(common) : []) worktrees.push({ dir: w, ...(await checkoutState(w)) });
  return {
    ...(await checkoutState(dir)),
    refs: refs === null ? null : refs.split('\n').filter(Boolean).sort().join('\n'),
    stash,
    remotes: (remotes || '').split('\n').filter(Boolean).map((l) => {
      const i = l.indexOf(' ');
      return `${l.slice(0, i)} ${noSignIn(l.slice(i + 1))}`;
    }).sort(),
    worktrees,
  };
}

// The files a copy writes anew on purpose: a linked worktree's ".git" file and its admin folder's "gitdir" name the
// folders they link, which are elsewhere in the copy. They are compared by their text with the original's folders
// replaced by the copy's (`rewrite`), so a link the copy got wrong is still a difference.
const GITLINK = (rel, st) => (st.isFile() && /(^|\/)\.git$/.test(rel)) || /(^|\/)\.git\/worktrees\/[^/]+\/gitdir$/.test(rel);

// A repository may borrow objects from another one's store (clone --shared, git worktree of an alternate): the names
// in <git>/objects/info/alternates. A copy that still names the original's store works only while that store is there,
// so apply points it at the copy of that repository, and the proof fails for a store outside the new folder.
const ALTERNATES = /(^|\/)\.git\/objects\/info\/alternates$/;

/** The folder `p` moved by the first [from, to] of `map` it lies in (whole path parts only), else `p`. */
export function movedPath(p, map = []) {
  for (const [from, to] of [...map].sort((a, b) => b[0].length - a[0].length)) {
    if (p === from) return to;
    if (p.startsWith(from + path.sep)) return to + p.slice(from.length);
  }
  return p;
}

/** The object stores named in an alternates file, absolute (git reads a relative one from the objects folder). */
export function alternatesIn(file) {
  let t;
  try {
    t = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => path.resolve(path.dirname(path.dirname(file)), l));
}

/** Every object store the repository at `dir` borrows from, also through the stores it borrows from (absolute). */
export function borrowedStores(dir) {
  const common = commonDir(dir);
  if (!common) return [];
  const out = [];
  const stack = [path.join(common, 'objects')];
  while (stack.length && out.length < 50) {
    for (const a of alternatesIn(path.join(stack.pop(), 'info', 'alternates'))) {
      if (out.includes(a)) continue;
      out.push(a);
      stack.push(a);
    }
  }
  return out;
}

/** `text` with each [from, to] of `rewrite` replaced, the longest `from` first. */
export function rewritten(text, rewrite = []) {
  let t = text;
  for (const [from, to] of [...rewrite].sort((a, b) => b[0].length - a[0].length)) t = t.split(from).join(to);
  return t;
}

/**
 * Every entry below `root`, never into a private folder: { entries: { rel: 'kind size mode mtimeMs hash' }, privates }.
 * Links are not followed (their text is the entry). A folder's own mtime is left out: a copy writes into it.
 * `rewrite`: [[original folder, copy's folder]] for the git link files (GITLINK). `skipDirs`: folder names not
 * entered (a fingerprint leaves out installed packages); `contents: false`: no hashes (a quick fingerprint). `leave`:
 * a Set of folders (absolute paths) that a plan left out of the copy: neither listed nor entered, but counted (`left`).
 */
export function treeOf(root, { rewrite = [], skipDirs = null, contents = true, leave = null } = {}) {
  const entries = {};
  let privates = 0;
  let left = 0;
  let hardLinked = 0; // files outside .git that share their content with another name (a copy makes them separate)
  const sep = Buffer.from(path.sep);
  // Names are read as bytes: a name that is not UTF-8 would otherwise come back changed, and an lstat of the changed
  // name fails (ENOENT), so the file would drop out of the listing without a word.
  const walk = (d, relDir) => {
    let list;
    try {
      list = fs.readdirSync(d, { withFileTypes: true, encoding: 'buffer' });
    } catch (e) {
      entries[relDir || '.'] = `unreadable ${e.code || ''}`;
      return;
    }
    for (const e of list) {
      const p = Buffer.concat([d, sep, e.name]);
      const name = nameOf(e.name);
      const rel = relDir ? `${relDir}/${name}` : name;
      let st;
      try {
        st = fs.lstatSync(p);
      } catch (x) {
        entries[rel] = `unreadable ${x.code || ''}`; // two listings compare it: never left out
        continue;
      }
      if (st.isDirectory() && isPrivate(name)) {
        privates++;
        entries[`${rel}/`] = 'private folder (not looked into)';
        continue;
      }
      const mode = (st.mode & 0o7777).toString(8);
      try {
        if (st.isSymbolicLink()) entries[rel] = `link ${nameOf(fs.readlinkSync(p, { encoding: 'buffer' }))}`;
        else if (st.isDirectory() && leave && leave.has(p.toString('utf8'))) left++;
        else if (st.isDirectory()) {
          entries[rel] = `dir ${mode}`;
          if (!(skipDirs && skipDirs.has(name))) walk(p, rel);
        } else if (st.isFile() && ALTERNATES.test(rel)) entries[rel] = `alternates ${hash(alternatesIn(p.toString()).map((a) => movedPath(a, rewrite)).join('\n'))}`;
        else if (st.isFile() && GITLINK(rel, st)) entries[rel] = `gitlink ${hash(rewritten(fs.readFileSync(p, 'utf8').trim(), rewrite))}`;
        else if (st.isFile()) {
          if (st.nlink > 1 && !rel.split('/').includes('.git')) hardLinked++;
          entries[rel] = `file ${st.size} ${mode} ${st.mtimeMs}${contents ? ` ${hash(fs.readFileSync(p))}` : ''}`;
        } else entries[rel] = `other ${mode}`;
      } catch (x) {
        entries[rel] = `unreadable ${x.code || ''}`;
      }
    }
  };
  walk(Buffer.from(root), '');
  return { entries, privates, hardLinked, left };
}

/**
 * A name's bytes as a string that keeps them apart: a UTF-8 name as it is; any other with each byte from 0x80 as the
 * lone surrogate U+DC00+byte (as Python's surrogateescape does), which no UTF-8 name can hold, so two names never meet.
 */
export function nameOf(buf) {
  const s = buf.toString('utf8');
  if (Buffer.from(s, 'utf8').equals(buf)) return s;
  return [...buf].map((b) => String.fromCharCode(b < 0x80 ? b : 0xdc00 + b)).join('');
}

// Two times of a file (in milliseconds) are the same when they lie in the same whole second, or differ by less than
// 2 ms. A copy can keep a time only to the precision Node gives it (to the millisecond on Node 22.11; utimes takes a
// floating-point number on every Node), so a time just below a full second can land in the next one after a correct
// copy. A file system that keeps whole seconds only is still covered by the first half.
export const sameTime = (a, b) => Math.floor(a / 1000) === Math.floor(b / 1000) || Math.abs(a - b) < 2;

const TIME_AT = 3; // 'file size mode mtimeMs [hash]': where a file entry holds its time
/** Whether two entries of a listing are the same: equal text, or two files that differ only by a time sameTime takes. */
function sameEntry(x, y) {
  if (x === y) return true;
  if (typeof x !== 'string' || typeof y !== 'string' || !x.startsWith('file ') || !y.startsWith('file ')) return false;
  const a = x.split(' ');
  const b = y.split(' ');
  return a.length === b.length && a.every((v, i) => (i === TIME_AT ? sameTime(Number(v), Number(b[i])) : v === b[i]));
}

/** What differs between two listings: [{ rel, was, now }] (was/now null when the entry is missing on that side). */
export function treeDiff(a, b) {
  const keys = new Set([...Object.keys(a.entries), ...Object.keys(b.entries)]);
  const out = [];
  for (const k of [...keys].sort()) if (!sameEntry(a.entries[k], b.entries[k])) out.push({ rel: k, was: a.entries[k] ?? null, now: b.entries[k] ?? null });
  return out;
}

// git's integrity check of the copy. Not a read the reader offers, so it gets the reader's fixed settings by hand:
// none of the copy's own programs (fsmonitor, hooks) run, and nothing is fetched.
const SAFE = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`, '-c', 'protocol.allow=never'];
export async function fsck(dir, run = capture) {
  const r = await run(['git', ...SAFE, '-C', dir, 'fsck', '--no-progress', '--no-dangling'], { timeout: 300_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.ok, text: (r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' ') };
}
export { SAFE as GIT_SAFE };

/** The proof's words for folders a plan left out: counted as left out, never as missing. */
const leftWords = (n) => (n ? `; ${n} folder${n === 1 ? '' : 's'} of installed packages or build output left out, as the plan says: not missing, made again by their command` : '');

/**
 * Compare a repository's copy with its original. `wtMap`: original worktree folder → its copy's folder. `map`: every
 * [original, copy] of the plan (a store borrowed from another copied repository). `root`: the new project folder (a
 * borrowed store must lie in it). → [{ what, ok, words }], one line per proof, in the order the brief names them.
 */
export async function proveRepo(from, to, { wtMap = new Map(), map = [], root = null, leave = null } = {}) {
  wtMap = new Map(wtMap);
  const [a, b] = [await repoState(from), await repoState(to)];
  const lines = [];
  const say = (what, ok, words, warn = false) => lines.push(warn ? { what, ok, words, warn: true } : { what, ok, words });
  say('HEAD', a.head === b.head, a.head === b.head ? `HEAD ${a.head ? a.head.slice(0, 12) : '(no commit yet)'} is the same` : `HEAD differs: ${a.head} here, ${b.head} in the copy`);
  say('refs', a.refs !== null && a.refs === b.refs, a.refs === b.refs ? `every ref is the same (${a.refs ? a.refs.split('\n').length : 0})` : 'the refs differ');
  say('status', a.status !== null && a.status === b.status, a.status === b.status ? 'the status is the same (by hash)' : 'the status differs');
  say('diff', a.staged !== null && a.staged === b.staged, a.staged === b.staged ? 'what is staged is the same (the index by hash; what is not staged: the file set below)' : 'what is staged differs');
  say('stash', a.stash === b.stash, a.stash === b.stash ? `the stash count is the same (${a.stash})` : `stashes: ${a.stash} here, ${b.stash} in the copy`);
  say('remote', JSON.stringify(a.remotes) === JSON.stringify(b.remotes), JSON.stringify(a.remotes) === JSON.stringify(b.remotes) ? `the remote is the same (${a.remotes.length ? a.remotes.map((r) => r.split(' ')[1]).join(', ') : 'none'})` : 'the remotes differ');
  const okWt = a.worktrees.length === b.worktrees.length && a.worktrees.every((w) => {
    const c = b.worktrees.find((x) => path.resolve(x.dir) === path.resolve(wtMap.get(w.dir) || ''));
    return c && c.head === w.head && c.status === w.status && c.staged === w.staged;
  });
  say('worktrees', okWt, okWt ? `each worktree is the same (${a.worktrees.length})` : 'a worktree differs or was not copied');
  const rewrite = [...map, [from, to], ...wtMap];
  const ta = treeOf(from, { rewrite, leave });
  const tb = treeOf(to);
  const d = treeDiff(ta, tb);
  say('files', !d.length, d.length ? `${d.length} file${d.length === 1 ? '' : 's'} differ, first: ${d[0].rel}` : `the file set is the same (${Object.keys(ta.entries).length} entries${ta.privates ? `, ${ta.privates} private folder${ta.privates === 1 ? '' : 's'} copied but not looked into: ${ta.privates === 1 ? 'its' : 'their'} contents are not checked` : ''}${leftWords(ta.left)})`);
  if (ta.hardLinked) say('links', true, `${ta.hardLinked} hard-linked file${ta.hardLinked === 1 ? ' was' : 's were'} copied as separate files: the same contents, but a change to one no longer changes the other`, true);
  for (const w of a.worktrees) {
    const c = wtMap.get(w.dir);
    if (!c) continue;
    const tw = treeOf(w.dir, { rewrite, leave });
    const dw = treeDiff(tw, treeOf(c));
    say('worktree files', !dw.length, dw.length ? `the worktree ${path.basename(w.dir)}: ${dw.length} files differ, first: ${dw[0].rel}` : `the worktree ${path.basename(w.dir)}: the file set is the same${tw.left ? ` (${leftWords(tw.left).slice(2)})` : ''}`);
  }
  const borrowed = borrowedStores(to);
  const outside = borrowed.filter((b) => !root || !(b === root || b.startsWith(root + path.sep)));
  if (borrowed.length) say('objects', !outside.length, outside.length ? `it borrows objects from ${outside[0]}, outside the new folder: the copy's history would break when that goes (a clone made with --shared). Hoprig never changes the original; in it, git repack -a -d and then removing .git/objects/info/alternates make it stand alone` : `it borrows objects from ${borrowed.map((b) => path.relative(root, b)).join(', ')}, a copy in the new folder`);
  const f = await fsck(to);
  say('fsck', f.ok, f.ok ? 'git fsck of the copy found nothing wrong' : `git fsck of the copy: ${f.text}`);
  return lines;
}
