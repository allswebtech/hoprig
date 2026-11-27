// The check of `hoprig drop` for ONE git working tree of a project: what in it exists only on this computer. Read only
// (git through gitread.mjs; the git server asked with `git ls-remote`, which writes nothing here).
//
// "On the git server" means: every commit reachable from a local branch, a tag or HEAD is reachable from what the
// server has now (its branches and tags, as `git ls-remote` lists them, the ones this computer has the commits of).
// Only `origin` counts as the server. What is not there is sorted into:
//   pushes    a branch that is not the default one, only ahead of its branch on the server (or never there): drop
//             pushes it by itself, never forcing (branchpush.mjs's rules: one whose server copy is gone is never put back);
//   def       commits only on the default branch: never pushed without the owner's yes (a push there can be a release);
//   work      changed tracked files and untracked files git does not ignore: the owner is offered a `wip/` branch;
//   ignored   ignored files that cannot be made again (dropfind.mjs): removed only after he confirmed the list;
//   refusals  everything else, each with the thing found and the command that resolves it.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_DIRS, excludes } from '../pcsetup/projects.mjs';
import { gitRead, readCommand } from '../gitread.mjs';
import { capture, showCommand } from '../setup/system.mjs';
import { gitIn, realOf } from './inside.mjs';
import { isLinkedWorktree } from './layout.mjs';
import { ignoredItems, kindOf } from './dropfind.mjs';
import { withoutAWord } from './dropsilent.mjs';

export const quietEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
// A git server's address in git's words may hold a user and a token: never shown.
export const lastLine = (r) => ((r.stderr || r.stdout || '').trim().split('\n').pop() || 'git failed').replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const commits = (n) => plural(n, 'commit');
const lstatOr = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const within = (p, top) => p === top || p.startsWith(top.endsWith(path.sep) ? top : top + path.sep);

/** `git status --porcelain -z` → [{ xy, path, from? }] (from: the old name of a rename or a copy). */
export function parseStatus(text) {
  const parts = String(text).split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const item = { xy: e.slice(0, 2), path: e.slice(3) };
    if (/[RC]/.test(item.xy)) item.from = parts[++i];
    out.push(item);
  }
  return out;
}

/**
 * What the git server of `dir` has now (`git ls-remote --symref origin`): { ok, head, heads: Map(name → sha), tags:
 * Map(name → sha), tips: [sha] } or { ok: false, why }.
 */
export async function askServer(at, dir, run = capture) {
  const r = await gitIn(at, dir, ['ls-remote', '--symref', '--', 'origin'], run, { env: quietEnv(), timeout: 60_000 });
  if (!r.ok) return { ok: false, why: lastLine(r) };
  const heads = new Map();
  const tags = new Map();
  const peeled = new Map();
  const others = []; // every other ref of the server (notes, a hosting site's own): it has their commits too
  let head = '';
  for (const l of r.stdout.split('\n')) {
    const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(l);
    if (sym) {
      head = sym[1];
      continue;
    }
    const [sha, ref] = l.split('\t');
    if (!ref) continue;
    if (ref.startsWith('refs/heads/')) heads.set(ref.slice(11), sha);
    else if (ref.startsWith('refs/tags/')) (ref.endsWith('^{}') ? peeled : tags).set(ref.slice(10).replace(/\^\{\}$/, ''), sha);
    else if (ref.startsWith('refs/')) others.push(sha);
  }
  return { ok: true, head, heads, tags, tips: [...heads.values(), ...[...tags.keys()].map((n) => peeled.get(n) || tags.get(n)), ...others] };
}

const read = async (dir, args, run) => {
  const r = await gitRead(dir, args, { run, timeout: 60_000 });
  return r.ok ? r.stdout : null;
};
const lines = (s) => (s || '').split('\n').filter(Boolean);

// A status never looks into a private folder (PRIVATE_DIRS): drop names such a folder by its name only (dropfind.mjs).
const NOT_INTO = ['--', '.', ...excludes(PRIVATE_DIRS)];

const IN_PROGRESS = [
  ['MERGE_HEAD', 'a merge', ['merge', '--abort']],
  ['rebase-merge', 'a rebase', ['rebase', '--abort']],
  ['rebase-apply', 'a rebase', ['rebase', '--abort']],
  ['CHERRY_PICK_HEAD', 'a cherry-pick', ['cherry-pick', '--abort']],
  ['REVERT_HEAD', 'a revert', ['revert', '--abort']],
  ['BISECT_LOG', 'a bisect', ['bisect', 'reset']],
];

/**
 * The blob id git would give the file at `p` as it is on disk (`algo`: sha1 or sha256), read in pieces without holding
 * the event loop; null when it cannot be read. No filter of the repository runs: a file a filter changes counts as
 * changed, which only refuses. Only a regular file is opened: an open of a FIFO waits for a writer that may never come
 * (the whole dashboard with it), and a socket or a device has no content git keeps. Such a path gets a marker of its
 * kind and size instead, which is never a blob id, so it counts as changed.
 */
async function blobId(p, algo) {
  const h = crypto.createHash(algo);
  const st = await fs.promises.lstat(p);
  if (st.isSymbolicLink()) {
    const t = Buffer.from(await fs.promises.readlink(p));
    return h.update(`blob ${t.length}\0`).update(t).digest('hex');
  }
  const marker = (s) => `not a file: ${s.mode.toString(8)} ${s.size}`;
  if (!st.isFile()) return marker(st);
  // Not blocking, not through a link: a path swapped for a FIFO or a link after the lstat is not waited on or followed.
  const fh = await fs.promises.open(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    const now = await fh.stat();
    if (!now.isFile()) return marker(now);
    h.update(`blob ${now.size}\0`);
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = (await fh.read(buf, 0, buf.length, null)).bytesRead) > 0;) h.update(buf.subarray(0, n));
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

/**
 * A file of a check read once for the press's commit, the way blobId reads it: a link's own text (never what it points
 * to), a regular file through a descriptor opened without blocking and without following a link (a path swapped for a
 * FIFO or a link after the lstat is not waited on or followed), or the `marker` of any other kind. Throws when it is
 * gone. The commit hashes exactly these bytes and keeps them only when the id is the sealed one (dropacts.mjs).
 * → { data, link, exec } | { marker }
 */
export async function readSealed(p) {
  const st = await fs.promises.lstat(p);
  if (st.isSymbolicLink()) return { data: Buffer.from(await fs.promises.readlink(p)), link: true, exec: false };
  const marker = (s) => ({ marker: `not a file: ${s.mode.toString(8)} ${s.size}` });
  if (!st.isFile()) return marker(st);
  const fh = await fs.promises.open(p, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    const now = await fh.stat();
    if (!now.isFile()) return marker(now);
    const parts = [];
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = (await fh.read(buf, 0, buf.length, null)).bytesRead) > 0;) parts.push(Buffer.from(buf.subarray(0, n)));
    return { data: Buffer.concat(parts), link: false, exec: (now.mode & 0o111) !== 0 };
  } finally {
    await fh.close();
  }
}

/**
 * A read whose output is a list of NUL-ended entries that may be far longer than capture holds (every tracked file):
 * read as it comes, only the entries `keep` takes are held. → the kept entries, or null when the read failed.
 */
async function readKept(dir, args, keep, run) {
  const c = await readCommand(dir, args, { run });
  if (c.refused) return null;
  return new Promise((resolve) => {
    const kept = [];
    let rest = '';
    let done = false;
    const end = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(c.argv[0], c.argv.slice(1), { env: c.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill();
      end(null);
    }, 120_000);
    child.stdout.setEncoding('utf8'); // a name cut between two pieces is put together whole
    child.stdout.on('data', (s) => {
      const parts = (rest + s).split('\0');
      rest = parts.pop();
      for (const e of parts) if (keep(e)) kept.push(e);
    });
    child.on('error', () => end(null));
    child.on('close', (code) => end(code === 0 ? kept : null));
  });
}

/**
 * Tracked files git is told not to look at (`git update-index --skip-worktree` or `--assume-unchanged`): git status
 * never shows their edits, so each one is compared with the index here. → [{ path, flag }] of those changed on disk.
 * The list of every tracked file is read as it comes: a large repository's is over capture's limit.
 */
async function hiddenEdits(wt, run) {
  const flagged = await readKept(wt, ['ls-files', '-v', '-s', '-z', ...NOT_INTO], (e) => e[0] === 'S' || /[a-z]/.test(e[0] || ''), run);
  if (flagged === null) return null;
  const out = [];
  for (const e of flagged) {
    const m = /^(\S) (\d{6}) ([0-9a-f]+) \d\t([^]*)$/.exec(e);
    if (!m) continue;
    if (!['100644', '100755', '120000'].includes(m[2])) continue; // a submodule is checked on its own
    const p = path.join(wt, ...m[4].split('/'));
    if (!lstatOr(p)) continue; // not on disk (a sparse checkout): its content is the committed one
    let id = null;
    try {
      id = await blobId(p, m[3].length === 64 ? 'sha256' : 'sha1');
    } catch {
      /* unreadable: counted as changed */
    }
    if (id !== m[3]) out.push({ path: m[4], flag: m[1] === 'S' || m[1] === 's' ? '--no-skip-worktree' : '--no-assume-unchanged' });
  }
  return out;
}

/**
 * Check one working tree. `repos`: every working tree of the project (a nested one is checked on its own, never as
 * an untracked folder here). `memories`: the memory folders of this tree (relative), committed by drop, not work.
 * `server`: what askServer gave (null: not asked). `label`: how the tree is named in what the owner reads.
 * `credentials`: the workspace's credentials folder. `project`: { root, manifest, at } whose credential links count
 * (dropsilent.mjs). `memo`: one Map for a whole check.
 * `seenBefore`: the server's branches this repository knew of before drop fetched with prune (a branch without an
 * upstream whose server copy was removed is never pushed back, as branchpush.mjs).
 * → { dir, label, linked, refusals: [{ what, command }], pushes, def, work: [{ path, from? }], memoryChanged, memoryFiles,
 *     ignored: [items], rebuilt: [folders of build output that go with it], credLinks: [credential links that go with
 *     it, made again by get], notes: [text], current, tagsUnknown }
 */
export async function checkRepo(wt, { label, repos, memories = [], server = null, credentials = null, project = null, memo = new Map(), seenBefore = [], run = capture }) {
  const out = { dir: wt, label, linked: isLinkedWorktree(wt), refusals: [], pushes: [], def: null, work: [], memoryChanged: false, memoryFiles: [], ignored: [], rebuilt: [], credLinks: [], notes: [], current: '' };
  const g = (...a) => showCommand(['git', '-C', wt, ...a]);
  const refuse = (what, command = '') => out.refusals.push({ what, command });
  const gitDir = (await read(wt, ['rev-parse', '--absolute-git-dir'], run))?.trim();
  if (!gitDir) {
    refuse('its git folder could not be read, so it cannot be told what is only here', g('status'));
    return out;
  }
  const common = path.resolve(wt, (await read(wt, ['rev-parse', '--git-common-dir'], run))?.trim() || gitDir);
  for (const [file, what, stop] of IN_PROGRESS) {
    if (fs.existsSync(path.join(gitDir, file))) refuse(`${what} is under way: finish it and commit, or stop it`, g(...stop));
  }

  // The working files: what is changed or untracked (work), and what git ignores that cannot be made again.
  const others = repos.filter((r) => r !== wt);
  const isOther = (rel) => others.includes(path.join(wt, ...rel.replace(/\/$/, '').split('/')));
  const st = await read(wt, ['status', '--porcelain', '-z', '--untracked-files=all', ...NOT_INTO], run);
  if (st === null) refuse('its changes could not be read', g('status'));
  const secrets = [];
  for (const e of parseStatus(st || '')) {
    if (e.xy === '??' && e.path.endsWith('/') && isOther(e.path)) continue; // a repository inside it: checked on its own
    if (e.path.split('/').some((x) => PRIVATE_DIRS.includes(x))) continue; // a private folder: named by the walk, never looked into
    if (memories.some((m) => e.path === m || e.path.startsWith(`${m}/`))) {
      out.memoryChanged = true;
      out.memoryFiles.push(e.from ? { path: e.path, from: e.from } : { path: e.path }); // committed by drop: sealed too
      continue;
    }
    if (e.xy === '??' && isOther(e.path)) continue;
    // An untracked file that looks like a secret is never committed by Hoprig: it is listed like an ignored one.
    if (e.xy === '??' && kindOf(path.basename(e.path)) !== 'file') {
      secrets.push(e.path);
      continue;
    }
    out.work.push(e.from ? { path: e.path, from: e.from } : { path: e.path });
  }
  // An edit git was told not to see: lost with the folder unless the owner commits it (or undoes the flag and drops).
  const hidden = await hiddenEdits(wt, run);
  if (hidden === null) refuse('its tracked files could not be listed', g('ls-files', '-v'));
  for (const h of hidden || []) {
    refuse(`${h.path} has an edit only here that git does not show (it was told not to look at the file: ${h.flag.slice(5)}): let git see it again, then commit and push it, or undo it`, g('update-index', h.flag, '--', h.path));
  }
  const ig = await read(wt, ['status', '--porcelain', '-z', '--ignored', '--untracked-files=normal', ...NOT_INTO], run);
  const ignored = parseStatus(ig || '').filter((e) => e.xy === '!!' && !e.path.split('/').some((x) => PRIVATE_DIRS.includes(x))).map((e) => e.path);
  const silent = (abs, kind) => withoutAWord(abs, { repos, project, memo, run, ...kind });
  out.ignored = await ignoredItems(wt, [...ignored, ...secrets], repos, { silent, rebuilt: out.rebuilt, links: out.credLinks, credentials });
  for (const s of secrets) {
    const i = out.ignored.find((x) => x.path === s);
    if (i) i.untracked = true;
  }

  const head = (await read(wt, ['rev-parse', '--verify', '-q', 'HEAD'], run))?.trim() || '';
  out.current = (await read(wt, ['symbolic-ref', '--quiet', '--short', 'HEAD'], run))?.trim() || '';
  if (out.memoryChanged && !out.current) refuse('its memory folder changed while HEAD is detached (on no branch), so it cannot be committed where it is pushed: go back to a branch, then drop again', g('switch', '-'));
  if (out.linked) {
    // A second checkout of a repository: its branches are that repository's. Only its own files and HEAD are its.
    if (out.work.length) refuse(`a linked worktree with work in it (${plural(out.work.length, 'changed file')}): commit and push it there, or remove what is not needed`, g('status'));
  }

  const url = (await read(wt, ['config', '--get', 'remote.origin.url'], run))?.trim();
  if (!url) {
    if (!out.linked) refuse('it has no git server (no remote named origin), so all of it exists only here: give it one and push, then drop again', g('remote', 'add', 'origin', '<address>'));
    return out;
  }
  const known = server && server.ok;
  out.serverHeads = known ? [...server.heads.keys()] : [];
  if (server && !server.ok) out.notes.push(`its git server could not be asked (${server.why}): what is said here is as of the last fetch`);
  // The server's tips this computer has the commits of: only those can be compared here.
  const have = new Set(lines(await read(wt, ['for-each-ref', '--format=%(objectname)%0a%(*objectname)'], run)).map((l) => l.trim()).filter(Boolean));
  const tracking = lines(await read(wt, ['for-each-ref', '--format=%(objectname)', 'refs/remotes/origin'], run));
  let tips = known ? server.tips : tracking;
  // Commits the server has that were never fetched here cannot be compared: then what the last fetch saw counts too
  // (a check and a dry run fetch nothing; a drop fetches first, so this never decides a removal).
  if (known && server.tips.some((t) => !have.has(t))) {
    tips = [...tips, ...tracking];
    out.notes.push('its git server has commits this computer has not fetched yet: what is said here is as of the last fetch (a drop fetches first)');
  }
  tips = [...new Set(tips.filter((t) => have.has(t)))];
  const onlyHere = async (ref, also = []) => {
    const r = await read(wt, ['rev-list', '--count', ref, ...[...tips, ...also].map((t) => `^${t}`)], run);
    return r === null ? null : Number(r.trim());
  };
  if (head && !out.current) {
    // A detached HEAD: its commits that no local branch has either are lost with the folder.
    const branchTips = lines(await read(wt, ['for-each-ref', '--format=%(objectname)', 'refs/heads'], run));
    const n = await onlyHere('HEAD', branchTips);
    if (n) refuse(`HEAD is detached (on no branch) and has ${commits(n)} that ${n === 1 ? 'is' : 'are'} on no branch and not on the git server: give them a branch, then drop again (it pushes that branch)`, g('switch', '-c', '<new branch name>'));
  }
  if (out.linked) return out;

  // Worktrees of this repository outside the project's folder: a removal here would leave them broken.
  for (const n of (() => {
    try {
      return fs.readdirSync(path.join(common, 'worktrees')).sort();
    } catch {
      return [];
    }
  })()) {
    let to = '';
    try {
      to = path.dirname(path.resolve(path.join(common, 'worktrees', n), fs.readFileSync(path.join(common, 'worktrees', n, 'gitdir'), 'utf8').trim()));
    } catch {
      continue;
    }
    if (!fs.existsSync(to) || repos.some((r) => r === to || realOf(r) === realOf(to))) continue;
    const ws = await read(to, ['status', '--porcelain', '-z', '--untracked-files=all'], run);
    const busy = ws === null || parseStatus(ws).length > 0;
    if (busy) refuse(`a linked worktree of it at ${to}, outside the project, has work in it: commit and push it there, or remove what is not needed, then remove the worktree`, showCommand(['git', '-C', to, 'status']));
    else refuse(`a linked worktree of it is at ${to}, outside the project: removing the project would leave it broken, so remove it first`, g('worktree', 'remove', to));
  }

  // A stash: work set aside, in no branch.
  if (lines(await read(wt, ['for-each-ref', '--format=%(objectname)', 'refs/stash'], run)).length) {
    let n = 1;
    try {
      n = lines(fs.readFileSync(path.join(common, 'logs', 'refs', 'stash'), 'utf8')).length || 1;
    } catch {
      /* one at least */
    }
    refuse(`a stash with ${plural(n, 'entry', 'entries')} (work set aside, in no branch): see it with git stash list; take it back and commit it (git stash pop), or remove it when it is not needed (git stash drop)`, g('stash', 'list'));
  }

  // Tags: a tag is never pushed by drop (it can be a release); one the server does not have is named.
  out.tagsUnknown = !known;
  for (const l of lines(await read(wt, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/tags'], run))) {
    const [name, obj] = l.split('\t');
    if (!known) refuse(`tag ${name}: the git server could not be asked whether it has it`, g('ls-remote', '--tags', 'origin'));
    else if (!server.tags.has(name)) refuse(`tag ${name} is only on this computer (drop never pushes a tag: it can be a release)`, g('push', 'origin', `refs/tags/${name}`));
    else if (server.tags.get(name) !== obj) refuse(`tag ${name} here is not the same as the git server's tag ${name}: take the server's with the command below, or first keep this one under a new name (git tag <new name> ${name}, then push that tag) and then take the server's; a tag is never pushed over the server's`, g('fetch', 'origin', '--force', `refs/tags/${name}:refs/tags/${name}`));
  }

  // Every other ref (git notes, refs/original of a rewrite, a tool's own): what it reaches that the server does not
  // have is lost with the folder. Branches, tags and the stash are looked at above and below; the server's copies
  // (refs/remotes, refs/prefetch) are not this computer's own. Every ref is listed and sorted here: for-each-ref
  // --exclude is new in git 2.42, and an older git fails the read, which must refuse, never pass for "none".
  const allRefs = await read(wt, ['for-each-ref', '--format=%(refname)'], run);
  if (allRefs === null) refuse('its refs (git notes and the like) could not be listed, so it cannot be told whether they are on the git server', g('for-each-ref'));
  // refs/hoprig/kept/: the safety copies the map's rule (mapkeep.mjs) makes of what it replaced: Hoprig's own, never the owner's work.
  const OWN_ELSEWHERE = ['refs/heads/', 'refs/tags/', 'refs/remotes/', 'refs/prefetch/', 'refs/hoprig/kept/'];
  for (const l of lines(allRefs).filter((r) => r !== 'refs/stash' && !OWN_ELSEWHERE.some((p) => r.startsWith(p)))) {
    if (!known) {
      refuse(`${l}: the git server could not be asked whether it has it`, g('ls-remote', 'origin', l));
      continue;
    }
    const n = await onlyHere(l);
    if (n === 0) continue;
    refuse(`${l} is only on this computer${n ? ` (${commits(n)} not on the git server)` : ''}${l.startsWith('refs/notes/') ? ' (git notes)' : ''}: push it, or remove it here when it is not needed (git update-ref -d ${l})`, g('push', 'origin', l));
  }

  // Branches.
  const def = (known && server.head) || ((await read(wt, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], run)) || '').trim().replace(/^origin\//, '');
  const heads = known ? server.heads : new Map(lines(await read(wt, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/remotes/origin'], run)).map((l) => l.split('\t')).map(([n, s]) => [n.replace(/^origin\//, ''), s]).filter(([n]) => n !== 'HEAD'));
  const bs = lines(await read(wt, ['for-each-ref', '--format=%(refname:short)%09%(upstream:remotename)%09%(upstream:remoteref)', 'refs/heads'], run)).map((l) => {
    const [name, remote, merge] = l.split('\t');
    return { name, remote: remote || '', merge: (merge || '').replace(/^refs\/heads\//, '') };
  });
  const knewOf = new Set([...seenBefore, ...lines(await read(wt, ['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin'], run)).filter((n) => n !== 'HEAD')]);
  // A branch whose upstream config names a branch but no remote-tracking one any more (git: "gone").
  const cfgMerge = async (b) => ((await read(wt, ['config', '--get', `branch.${b}.merge`], run)) || '').trim().replace(/^refs\/heads\//, '');
  for (const b of bs) {
    const extra = b.name === out.current && out.memoryChanged ? 1 : 0; // the memory commit drop makes on it
    const only = await onlyHere(`refs/heads/${b.name}`);
    if (only === null) {
      refuse(`${b.name}: its commits could not be compared with the git server`, g('log', '--oneline', b.name));
      continue;
    }
    const n = only + extra;
    if (!n) continue;
    if (!def) {
      refuse(`${b.name} has ${commits(n)} not on the git server, and the server's default branch is not known here`, g('remote', 'set-head', 'origin', '--auto'));
      continue;
    }
    const merge = b.merge || (b.remote ? '' : await cfgMerge(b.name));
    const ownUp = (b.remote === 'origin' || (!b.remote && merge)) && merge && merge !== def;
    if (b.name !== def && ownUp && !heads.has(merge)) {
      refuse(`${b.name} has ${commits(n)} only here, and its branch on the git server was removed, so drop does not put it back: push it back if you still need it, or delete it here if it is done (git branch -D ${b.name})`, g('push', 'origin', `${b.name}:${merge}`));
      continue;
    }
    if (b.name !== def && !b.remote && !merge && knewOf.has(b.name) && !heads.has(b.name)) {
      refuse(`${b.name} has ${commits(n)} only here, and its branch on the git server was removed, so drop does not put it back: push it back if you still need it, or delete it here if it is done (git branch -D ${b.name})`, g('push', '-u', 'origin', b.name));
      continue;
    }
    const to = b.name === def ? def : ownUp ? merge : b.name;
    const there = heads.get(to);
    if (there) {
      if (!have.has(there)) {
        out.notes.push(`${b.name}: its branch on the git server has commits this computer has not fetched yet (drop fetches first)`);
      } else if (!(await gitRead(wt, ['merge-base', '--is-ancestor', there, `refs/heads/${b.name}`], { run })).ok) {
        refuse(`${b.name} and its branch on the git server have both moved (${commits(n)} only here): bring them together with a merge (a conflict in it is yours to settle by hand), then drop again`, `${g('switch', b.name)} && ${g('pull', '--no-rebase', 'origin', to)}`);
        continue;
      }
    }
    const item = { branch: b.name, to, count: n, track: !b.remote && !merge, current: b.name === out.current };
    if (b.name === def) out.def = item;
    else out.pushes.push(item);
  }
  return out;
}

/** The object format of a repository: git's ids are sha1 unless the repository was made with sha256. */
export async function objectAlgo(dir, run = capture) {
  return /^sha256$/i.test(((await read(dir, ['config', '--get', 'extensions.objectFormat'], run)) || '').trim()) ? 'sha256' : 'sha1';
}

/**
 * A path's id as git would keep it in this repository: a file's or a link's blob id, `gitlink <commit>` for a
 * submodule (its HEAD), the marker of any other kind, or 'none' when it is gone or unreadable.
 */
export async function idOf(dir, rel, algo, run = capture) {
  const p = path.join(dir, ...rel.split('/'));
  try {
    const st = await fs.promises.lstat(p);
    if (st.isDirectory()) {
      const h = fs.existsSync(path.join(p, '.git')) ? ((await read(p, ['rev-parse', '--verify', '-q', 'HEAD'], run)) || '').trim() : '';
      return isGitId(h) ? `gitlink ${h}` : `not a file: ${st.mode.toString(8)}`;
    }
    return await blobId(p, algo);
  } catch {
    return 'none';
  }
}

/** An id of git's own (not 'none', not the marker of a FIFO or a folder). */
export const isGitId = (s) => /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(s);

/**
 * What a drop would push or commit, read once: HEAD, the tip of every local branch, what is staged (path, mode, id),
 * and every file of the work list (`c.work`) and of the memory folder that git lists as changed (`c.memoryFiles`: drop
 * commits them and pushes that commit), each with its blob id in the repository's own object format. The page's
 * sheet stands for exactly these (dropweb.mjs fingerprint), and the press commits exactly these bytes (dropacts.mjs):
 * a commit amended to another one of the same count, a file staged or changed again, makes another seal. Read only.
 * → { algo, heads, head, sym, staged: [[path, mode, id | 'none']] | null, files: [[kind, from, path, id]] }
 */
export async function sealParts(c, run = capture) {
  const algo = await objectAlgo(c.dir, run);
  const heads = await read(c.dir, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads'], run);
  const head = ((await read(c.dir, ['rev-parse', '--verify', '-q', 'HEAD'], run)) || '').trim();
  const sym = ((await read(c.dir, ['symbolic-ref', '--quiet', 'HEAD'], run)) || '').trim();
  const raw = await read(c.dir, ['diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '-z', ...NOT_INTO], run);
  let staged = null;
  if (raw !== null) {
    staged = [];
    const parts = raw.split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const m = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])/.exec(parts[i]);
      if (m) staged.push([parts[i + 1], m[1], m[3] === 'D' ? 'none' : m[2]]);
    }
  }
  const files = [];
  for (const w of [...c.work, ...(c.memoryFiles || []).map((m) => ({ ...m, memory: true }))]) {
    files.push([w.memory ? 'memory' : 'work', w.from || '', w.path, await idOf(c.dir, w.path, algo, run)]);
    // The place a renamed file came from: committed as it is now (gone, as a rename leaves it), so sealed too.
    if (w.from) files.push([w.memory ? 'memory' : 'work', 'from', w.from, await idOf(c.dir, w.from, algo, run)]);
  }
  return { algo, heads, head, sym, staged, files };
}

/** The seal as one hash (what the sheet's fingerprint holds). */
export const sealHash = (s) => crypto.createHash('sha256').update(JSON.stringify([s.heads, s.head, s.sym, s.staged, s.files])).digest('hex');
export const sealOf = async (c, run = capture) => sealHash(await sealParts(c, run));

/** Everything a check found that exists only here, without the files git ignores. */
export const somethingOnlyHere = (c) => c.refusals.length || c.pushes.length || c.def || c.work.length || c.memoryChanged;
export const inside = within;
