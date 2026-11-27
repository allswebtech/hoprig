// The map keeps itself between computers (the upkeep, with "commitMap" and "push" on). Two computers that add
// different projects in the same hour both commit the map, and the second push is refused: the brain here and on
// the git server have both moved. When the ONLY difference on this side is the map or this computer's own file,
// that is never the owner's problem: Hoprig resolves it by its own rule, in code, never by git's text merge. It is the
// one narrow exception to sync's rule "never merges, rebases, forces or stashes", in exactly these steps:
//
//   (1) fetch;
//   (2) only when EVERY commit that is here and not on the server is Hoprig's own save of the map (its message, at
//       least one file, nothing but workspace.json and computers/<this computer>.json) or of the brain's memory folder
//       (its message, at least one file, nothing outside claude-memory/; the server changed none of those files): no
//       merge commit, no commit of the owner's, also none that changes no file; the working tree has no uncommitted
//       change in the map's two files and nothing is staged (a move would unstage it): keep the commit the branch is
//       on under refs/hoprig/kept/, put the memory files on top of the server's commit in one commit of Hoprig's own
//       (made from objects only, git's temporary index), then move the local branch there keeping the working tree
//       (`git reset --keep`: a file the server changed that has a change here stops it, and nothing is changed; so
//       does a file it would bring that is here untracked or ignored);
//   (3) read the server's map and put into it, three-way, only what this side added since the common commit
//       (uniteMaps, against the map at the merge-base: an entry this side's map has and the merge-base's has too, but
//       the server's lacks, was removed or renamed there and stays out; with no map at the merge-base nothing of
//       this side's map is put in), then this disk by the union rule the map already has (map.mjs updateMap); an
//       entry of this side that does not fit the server's map is left out and named, checked before (2). When that
//       changes nothing (this side was only behind), nothing is written, committed or pushed; else both files are
//       written, committed and pushed;
//   (4) when the push is refused because the server moved again, again from (1), three times at most; then the
//       owner is told (the next round tries again). A push the server refuses by a rule or a hook is said at once.
//
// In every other case nothing is touched and the owner is told, as before. Nothing is forced. What step (3) is about
// to write is kept beside the brain's git folder (.git/hoprig-map-pending.json) from before step (2) until step (3)
// wrote it: a run killed in between is finished by the next one (finishPending), which writes it over the map as it
// is, never united with the map on disk again (that could bring back what the server removed).
// `forget` wins: a name in either side's skip list is out for good.
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { FAST_FORWARD, MEMORY_MESSAGE, repoInfo } from '../pcsetup/workspace.mjs';
import { capture, showCommand } from '../setup/system.mjs';
import { gitIn, kindAt, readIn, removeIn, writeIn } from './inside.mjs';
import { isDir, projectsIn, workspaceDir } from './layout.mjs';
import { COMMIT_MESSAGE, MAP_FILE, diffMap, leaveOutNew, normalizeMap, readMap, refOf, sameUrl, updateMap, validateMap, writeMap } from './map.mjs';
import { onePlace } from './mapcheck.mjs';
import { relFileOf, thisComputer, writeOwnFile } from './computer.mjs';

export const TRIES = 3;
const PENDING = 'hoprig-map-pending.json';
// Where the commit a move of the branch left is kept (keepOld), and how many such refs stay.
export const KEPT = 'refs/hoprig/kept/';
const KEEP = 20;
// The brain's memory folder (the upkeep's "memory" switch commits it, upkeep.mjs).
const MEMORY_DIR = 'claude-memory';
const clone = (x) => JSON.parse(JSON.stringify(x));
const quietEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
const last = (r) => (r.stderr || r.stdout || '').trim().split('\n').pop() || 'git failed';

/** `m` with no entries: what a map that is not there is, for uniteMaps. */
const emptied = (m) => {
  const e = clone(m);
  e.projects = [];
  e.others = [];
  if (e.groups) e.groups = [];
  delete e.skip;
  return e;
};

/**
 * The server's map with what THIS side changed since the two parted (three-way). `base` is the map at the merge-base
 * of the two commits, `theirs` the server's, `mine` this side's. A union of two whole maps cannot tell "this side
 * added it" from "the other side removed or renamed it"; this can:
 *   - the server's map is taken as it is;
 *   - a project (by refOf), group, other repository or code repository of a project (by folder) that `mine` has and
 *     `base` lacks was added here: it goes in when the server's map lacks it;
 *   - one that `base` and `mine` have and the server's map lacks was removed or renamed there: it stays out;
 *   - on an entry both have, the server's values stay, and what it lacks is taken from this side (an address, memory
 *     links); the same for the brain's address and the keys a later Hoprig fills in;
 *   - a name in either side's skip list is out (a forget on one computer wins over a scan on another); the higher
 *     version of the two.
 * No map at the merge-base (or it could not be read): nothing of this side's map is put in (only its forgets still
 * win: they never bring anything back); the server's map is taken as it is, and the scan of this disk that follows
 * (updateMap) adds what is on this computer, as it always has. No map
 * on the server: nothing there was removed, so what this side added since the merge-base goes in (all of its map when
 * the merge-base has none either).
 */
export function uniteMaps(base, theirs, mine) {
  if (!mine) return theirs ? clone(theirs) : null;
  if (!theirs) {
    theirs = emptied(mine);
    base = base || emptied(mine);
  }
  const skip = new Set([...(theirs.skip || []), ...(mine.skip || [])]);
  // No map at the merge-base: nothing of this side's map goes in but its forgets (a forget only ever takes out).
  if (!base) return forgetting(clone(theirs), skip);
  const out = clone(theirs);
  out.version = Math.max(theirs.version || 1, mine.version || 1);
  if (!out.brain.url && mine.brain && mine.brain.url) out.brain.url = mine.brain.url;
  if (!out.config && mine.config) out.config = clone(mine.config);
  for (const k of ['credentials', 'storage']) if (out[k] === undefined && mine[k] !== undefined) out[k] = clone(mine[k]);
  // What `list` (this side's) has and `had` (the merge-base's) lacks, by folder: what this side added.
  const added = (list, had) => (list || []).filter((x) => !(had || []).some((y) => y.dir === x.dir));
  if (theirs.groups || mine.groups) {
    out.groups = clone(theirs.groups || []);
    for (const g of added(mine.groups, base.groups)) if (!out.groups.some((x) => x.dir === g.dir)) out.groups.push(clone(g));
  }
  for (const pm of mine.projects || []) {
    const pb = (base.projects || []).find((p) => refOf(p) === refOf(pm));
    const pt = out.projects.find((p) => refOf(p) === refOf(pm));
    if (!pt) {
      // Added here: it goes in. In the merge-base's map too: removed or renamed on the server, it stays out.
      if (!pb) out.projects.push(clone(pm));
      continue;
    }
    if (!pt.url && pm.url) pt.url = pm.url;
    if (!pt.memories && pm.memories) pt.memories = clone(pm.memories);
    for (const r of added(pm.repos, pb && pb.repos)) if (!pt.repos.some((x) => x.dir === r.dir)) pt.repos.push(clone(r));
  }
  for (const o of added(mine.others, base.others)) if (!out.others.some((x) => x.dir === o.dir)) out.others.push(clone(o));
  if (out.version === 2 && !out.groups) out.groups = [];
  return forgetting(out, skip);
}

/** `out` without every name in `skip`, which becomes its skip list (when there is one). */
function forgetting(out, skip) {
  out.projects = out.projects.filter((p) => !skip.has(refOf(p)));
  for (const p of out.projects) p.repos = p.repos.filter((r) => !skip.has(`${refOf(p)}/${r.dir}`));
  out.others = out.others.filter((o) => !skip.has(o.dir));
  if (skip.size) out.skip = [...skip].sort();
  return out;
}

/** One name whose folder here has another address than the map (diffMap's changed), as the upkeep says it every round. */
export const addressWords = (c) => `${c.label}: the folder here has another address (${c.to}) than the map (${c.from}); the map keeps its own: to give it this folder's address:  hoprig workspace map`;

/** An entry left out of the map (leaveOutNew), as the upkeep says it every round. */
export const leftWords = (l) => `${l.ref} is not put into the map: ${l.why}; rename or move one of the folders`;

const pendingFile = (brain) => path.join(brain, '.git', PENDING);

/** Two maps that write the same file (in their written order, after the write rules). */
const sameMap = (a, b) => {
  const n = (m) => {
    const v = validateMap(m);
    return JSON.stringify(normalizeMap(v.ok ? v.map : m));
  };
  return n(a) === n(b);
};

/**
 * A rule that was cut off around the move of the branch (step 2) and before it wrote the map (step 3) left what step
 * (3) was about to write beside the git folder (the three-way result): write it over the map on disk now, then remove
 * it. Never united with the map on disk: that may still be this side's old map (cut off before the move), and a union
 * would bring back what the server removed or renamed. An entry the map on disk has and the kept map lacks comes back
 * only when this disk's scan finds it. → { finished, left: [leaveOutNew's], why? }
 */
export async function finishPending({ dir = workspaceDir() } = {}) {
  const brain = path.join(dir, 'ai_brain');
  const file = pendingFile(brain);
  if (kindAt(file) !== 'file') return { finished: false };
  const at = { root: brain, dir };
  const buf = readIn(at, file);
  let saved = null;
  try {
    const v = validateMap(JSON.parse(buf.toString('utf8')));
    saved = v.ok ? v.map : null;
  } catch {
    saved = null;
  }
  const cur = readMap(dir);
  // The map on disk refused: the kept side stays beside the git folder (its commit may be reachable nowhere else)
  // until the map can be read again.
  if (saved && cur.errors) return { finished: false, left: [], why: `what an earlier round kept of the map waits beside the brain's git folder (.git/${PENDING}): the map here was refused (${cur.errors[0]}); fix the map, then the next round puts it back` };
  let left = [];
  if (saved && !cur.errors) {
    // One entry that does not fit the map on disk is left out and named; the rest is written. A map that still cannot
    // be written keeps the file for the next round, with the reason.
    const fit = leaveOutNew(cur.exists ? cur.map : null, saved);
    try {
      writeMap(fit.map, dir);
    } catch (e) {
      return { finished: false, why: `what an earlier round kept of the map waits beside the brain's git folder (.git/${PENDING}) and could not be written: ${e.message}` };
    }
    left = fit.left;
  }
  removeIn(at, file);
  return { finished: Boolean(saved), left, ...(saved ? {} : { why: 'what an earlier round kept of the map could not be read: it was left out' }) };
}

/**
 * The commits here that the git server lacks (@{u}..HEAD), each with its subject and the files it changes.
 * → { list: [{ sha, subject, files }] } | { merge: true } | { error }
 */
async function localCommits(brain, run) {
  const merges = await gitRead(brain, ['rev-list', '--merges', '@{u}..HEAD'], { run });
  if (!merges.ok) return { error: last(merges) };
  if (merges.stdout.trim()) return { merge: true };
  // -z: each file name as it is (without it git quotes a name that is not plain ASCII, "priv\303\251.md"). Each commit is
  // "\x01<sha>\t<subject>", then "\n" and its files ended by NUL and one more NUL, or a NUL alone when it has none.
  const r = await gitRead(brain, ['log', '-z', '--no-renames', '--name-only', '--format=format:%x01%H%x09%s', '@{u}..HEAD'], { run });
  if (!r.ok) return { error: last(r) };
  const list = [];
  let header = true;
  for (const t of r.stdout.split('\0')) {
    if (header) {
      if (!t.startsWith('\x01')) continue;
      const nl = t.indexOf('\n');
      const [sha, ...subject] = (nl < 0 ? t : t.slice(0, nl)).slice(1).split('\t');
      list.push({ sha, subject: subject.join('\t'), files: nl < 0 ? [] : [t.slice(nl + 1)] });
      header = nl < 0;
    } else if (t === '') header = true;
    else list[list.length - 1].files.push(t);
  }
  for (const c of list) c.files = [...new Set(c.files.filter(Boolean))];
  return { list };
}

/** A NUL-ended list of names from git's -z output. */
const names0 = (stdout) => stdout.split('\0').filter(Boolean);

/**
 * What the commits here are: Hoprig's own saves of the map (its message, at least one file, every file the map or
 * this computer's file) and of the brain's memory folder (its message, at least one file, every file in that folder)
 * are carried over by the rule. Any other commit of the owner's, also one that changes no file or only the map, is
 * his: the rule never takes it off the branch. → { others: [what stops it, in words], memory: [files of the memory
 * commits] }
 */
export function sortCommits(list, ours) {
  const others = [];
  const memory = new Set();
  const inMemory = (f) => f.startsWith(`${MEMORY_DIR}/`);
  for (const c of list) {
    if (c.subject === MEMORY_MESSAGE && c.files.length && c.files.every(inMemory)) {
      for (const f of c.files) memory.add(f);
      continue;
    }
    const outside = c.files.filter((f) => !ours.has(f));
    if (outside.length) others.push(...outside);
    else if (!c.files.length) others.push(`your commit ${c.sha.slice(0, 7)} "${c.subject.slice(0, 60)}", which changes no file`);
    else if (c.subject !== COMMIT_MESSAGE) others.push(`your commit ${c.sha.slice(0, 7)} "${c.subject.slice(0, 60)}"`);
  }
  return { others: [...new Set(others)], memory: [...memory] };
}

/**
 * Will the map's rule settle this brain by itself (the upkeep's sync leaves the case to it, no notification)? Only
 * when it is ahead and behind and every commit here is one the rule carries over. Reads only, after a fetch.
 */
export async function ruleSettles({ dir = workspaceDir(), run = capture } = {}) {
  const brain = path.join(dir, 'ai_brain');
  const me = thisComputer();
  const s = await repoInfo(brain, run);
  if (!s.ok || !s.upstream || !s.ahead || !s.behind) return false;
  const t = await localCommits(brain, run);
  return !t.error && !t.merge && !sortCommits(t.list, new Set([MAP_FILE, ...(me.label ? [relFileOf(me.label)] : [])])).others.length;
}

/** a and b are one path, or one is a folder that holds the other. */
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * The server's commit `sha` with the memory files of the commits here on top, in one commit of Hoprig's own made
 * without touching the working tree or the index (a temporary index): each of `files` as the commit here (`old`) has
 * it, or gone where it has it no longer. The caller made sure the server changed none of them. → { sha } | { error }
 */
async function memoryOnTop(at, brain, sha, old, files, run) {
  const g = await gitRead(brain, ['rev-parse', '--absolute-git-dir'], { run });
  if (!g.ok) return { error: last(g) };
  const idx = path.join(g.stdout.trim(), 'hoprig-index.tmp');
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  try {
    for (const args of [['read-tree', sha], ['--literal-pathspecs', 'reset', '-q', old, '--', ...files]]) {
      const r = await gitIn(at, brain, args, run, { env });
      if (!r.ok) return { error: last(r) };
    }
    const t = await gitIn(at, brain, ['write-tree'], run, { env });
    if (!t.ok) return { error: last(t) };
    const c = await gitIn(at, brain, ['commit-tree', t.stdout.trim(), '-p', sha, '-m', MEMORY_MESSAGE], run);
    return c.ok ? { sha: c.stdout.trim() } : { error: last(c) };
  } finally {
    if (kindAt(idx) === 'file') removeIn(at, idx);
  }
}

/**
 * The files a move of the branch to `sha` would write that are here and not tracked (ignored ones too): git's
 * `reset --keep` writes over them. → { files } | { error }
 */
async function untrackedInTheWay(brain, sha, run) {
  const d = await gitRead(brain, ['diff', '-z', '--name-only', '--no-renames', 'HEAD', sha], { run });
  if (!d.ok) return { error: last(d) };
  const paths = names0(d.stdout);
  if (!paths.length) return { files: [] };
  const files = new Set();
  for (const extra of [[], ['--ignored']]) {
    const r = await gitRead(brain, ['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', ...extra, '--', ...paths], { run });
    if (!r.ok) return { error: last(r) };
    for (const f of names0(r.stdout)) files.add(f);
  }
  return { files: [...files] };
}

/**
 * Keep the commit the branch was on under a ref of Hoprig's own before the rule moves the branch, so that no commit
 * is ever reachable only through the reflog (whose entries expire). The newest KEEP of them stay; an older one held
 * only Hoprig's own saves of the map, whose content is on the git server since.
 */
async function keepOld(at, brain, sha, run) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const k = await gitIn(at, brain, ['update-ref', `${KEPT}${stamp}`, sha], run);
  if (!k.ok) return last(k);
  const refs = await gitRead(brain, ['for-each-ref', '--format=%(refname)', '--sort=-refname', KEPT], { run });
  for (const ref of refs.ok ? refs.stdout.split('\n').filter(Boolean).slice(KEEP) : []) await gitIn(at, brain, ['update-ref', '-d', ref], run);
  return '';
}

/** The map in a commit of the brain, checked strictly (never a link). → { map } | { none: true } | { error } */
async function mapAt(brain, sha, run) {
  const t = await gitRead(brain, ['cat-file', '-p', `${sha}^{tree}`], { run });
  if (!t.ok) return { error: last(t) };
  const entry = t.stdout.split('\n').find((l) => l.endsWith(`\t${MAP_FILE}`));
  if (!entry) return { none: true };
  if (!/^100(644|755) blob /.test(entry)) return { error: `${MAP_FILE} on the git server is not a regular file` };
  const s = await gitRead(brain, ['show', `${sha}:${MAP_FILE}`], { run });
  if (!s.ok) return { error: last(s) };
  try {
    const v = validateMap(JSON.parse(s.stdout));
    return v.ok ? { map: v.map } : { error: `the map on the git server was refused: ${v.errors.join('; ')}` };
  } catch {
    return { error: `the map on the git server is not valid JSON` };
  }
}

/**
 * Why the brain cannot take a commit or a move of its branch now, or '': an operation of git under way in it (a rebase,
 * a merge, a cherry-pick, a revert: a commit made now would land inside the owner's work) or no branch checked out (a
 * commit on a detached HEAD is uploaded nowhere).
 */
export async function brainBusy(brain, run = capture) {
  const g = await gitRead(brain, ['rev-parse', '--absolute-git-dir'], { run });
  if (!g.ok) return `the brain's git folder could not be read: ${last(g)}`;
  const gd = g.stdout.trim();
  const what = [['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase'], ['MERGE_HEAD', 'a merge'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert']].find(([f]) => kindAt(path.join(gd, f)) !== 'none');
  if (what) return `${what[1]} is under way in the brain, so the map was written but not committed: finish it or stop it (${showCommand(['git', '-C', brain, 'status'])}), then the next round saves it`;
  const h = await gitRead(brain, ['symbolic-ref', '--quiet', 'HEAD'], { run });
  if (!h.ok) return `the brain is on no branch (a detached HEAD), so the map was written but not committed: go back to its branch (${showCommand(['git', '-C', brain, 'switch', '-'])}), then the next round saves it`;
  return '';
}

/**
 * Commit the map and this computer's own file, and only them, when one of them changed. Never while the brain has
 * other staged changes (they would ride along), never while git is in the middle of something or on no branch
 * (brainBusy). → { done, nothing?, staged?, busy?, failed?, why? }
 */
export async function commitOwnFiles({ dir = workspaceDir(), run = capture, message = 'Update the workspace map', mapToo = true } = {}) {
  const brain = path.join(dir, 'ai_brain');
  const me = thisComputer();
  // mapToo false: only this computer's file (a drop changes no map, so an edit of the owner's there is not taken along).
  const files = [...(mapToo ? [MAP_FILE] : []), ...(me.label && kindAt(path.join(brain, relFileOf(me.label))) === 'file' ? [relFileOf(me.label)] : [])];
  if (!files.length) return { done: false, nothing: true, why: 'nothing changed' };
  const st = await gitRead(brain, ['status', '--porcelain', '--untracked-files=all', '--', ...files], { run });
  if (!st.ok) return { done: false, failed: true, why: last(st) };
  if (!st.stdout.trim()) return { done: false, nothing: true, why: 'nothing changed' };
  const busy = await brainBusy(brain, run);
  if (busy) return { done: false, busy: true, why: busy };
  const staged = await gitRead(brain, ['diff', '--cached', '--name-only'], { run });
  if (staged.ok && staged.stdout.split('\n').map((l) => l.trim()).filter(Boolean).some((f) => !files.includes(f))) return { done: false, staged: true, why: 'the brain has other staged changes: the map was written but not committed' };
  const at = { root: brain, dir };
  const a = await gitIn(at, brain, ['add', '--', ...files], run);
  if (!a.ok) return { done: false, failed: true, why: last(a) };
  const c = await gitIn(at, brain, ['commit', '--quiet', '-m', message, '--', ...files], run);
  return c.ok ? { done: true, files } : { done: false, failed: true, why: last(c) };
}

/**
 * Bring the brain's map up to the git server by the rule above. Called by the upkeep after its own commit, with the
 * brain's lock held. → { done, pushed?, resolved?: number of times the rule moved the branch, lines: [activity],
 * needs: [what needs the owner], stopped?: why }
 */
export async function keepMapInStep({ dir = workspaceDir(), projects = projectsIn(), run = capture, tries = TRIES, ownOnly = false } = {}) {
  const brain = path.join(dir, 'ai_brain');
  const at = { root: brain, dir };
  const me = thisComputer();
  const ours = new Set([MAP_FILE, ...(me.label ? [relFileOf(me.label)] : [])]);
  const out = { done: false, resolved: 0, lines: [], needs: [] };
  const stop = (why, need = why) => {
    out.stopped = why;
    if (need) out.needs.push(need);
    return out;
  };
  const busy = await brainBusy(brain, run);
  if (busy) return stop(busy);
  for (let i = 0; i < tries; i++) {
    // (1)
    const f = await gitIn(at, brain, ['fetch', '--quiet'], run, { env: quietEnv() });
    if (!f.ok) return stop(`the brain could not be fetched: ${last(f)}`);
    const s = await repoInfo(brain, run);
    if (!s.ok) return stop(s.error);
    if (!s.upstream) return stop('the brain has no upstream', '');
    if (!s.ahead && !s.behind) return { ...out, done: true };
    // ownOnly (the "push" switch is off): only Hoprig's own map commits may go up; one commit of the owner's own, or a
    // memory commit (the "memory" switch decides those), keeps everything here as it is, without a word.
    if (ownOnly && s.ahead) {
      const own = await localCommits(brain, run);
      if (own.error || own.merge) return stop(own.error ? `the brain's history could not be read: ${own.error}` : 'a merge commit', '');
      const sort = sortCommits(own.list, ours);
      if (sort.others.length || sort.memory.length) return stop('the brain holds commits that are not the map\'s', '');
    }
    if (s.behind) {
      // (2) only commits of the map and this computer's file, and nothing of them uncommitted
      const t = await localCommits(brain, run);
      if (t.error) return stop(`the brain's history could not be read: ${t.error}`);
      const sorted = t.merge ? { others: ['a merge commit'], memory: [] } : sortCommits(t.list, ours);
      const others = sorted.others;
      if (others.length) return stop(`the brain and its git server have both moved, and the commits here change more than the map (${others.slice(0, 3).join(', ')}): nothing was changed; bring it in step yourself:  git -C ${brain} pull --rebase`);
      const dirty = await gitRead(brain, ['status', '--porcelain', '--', ...ours], { run });
      if (!dirty.ok || dirty.stdout.trim()) return stop(`the brain's map has an uncommitted change and the git server moved: nothing was changed; commit or undo it, then the next round brings it in step`);
      // A staged change would come out of the move unstaged (its content stays, its staging would not): wait for it.
      const staged = await gitRead(brain, ['diff', '--cached', '--quiet'], { run });
      if (!staged.ok) return stop(`the brain has staged changes and the git server moved: nothing was changed; commit them or unstage them, then the next round brings the map in step`);
      const up = await gitRead(brain, ['rev-parse', '--verify', '-q', '@{u}^{commit}'], { run });
      if (!up.ok) return stop(`the brain's upstream could not be read: ${last(up)}`);
      const sha = up.stdout.trim();
      // The memory commits here: carried over on top of the server's commit when the server changed none of their files
      // (two computers each saving what they learned); one file changed on both sides is a text only the owner merges.
      let target = sha;
      if (sorted.memory.length) {
        const srv = await gitRead(brain, ['diff', '-z', '--name-only', '--no-renames', `HEAD...${sha}`], { run });
        if (!srv.ok) return stop(`the brain's history could not be read: ${last(srv)}`);
        const twice = sorted.memory.filter((f) => names0(srv.stdout).some((x) => overlaps(f, x)));
        if (twice.length) return stop(`the brain and its git server have both moved, and a memory file changed here and on the git server (${twice.slice(0, 3).join(', ')}): nothing was changed; bring it in step yourself:  git -C ${brain} pull --rebase`);
      }
      const theirs = await mapAt(brain, sha, run);
      if (theirs.error) return stop(`${theirs.error}: nothing was changed`);
      const mine = readMap(dir);
      if (mine.errors) return stop(`the map here was refused: ${mine.errors.join('; ')}`);
      const head = await gitRead(brain, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { run });
      if (!head.ok) return stop(`the brain's branch could not be read: ${last(head)}`);
      // The map where the two parted (at the merge-base), read once a round: what this side changed since then is all
      // it puts into the server's map. None there, or it cannot be read: nothing of this side's map is put in.
      const mb = await gitRead(brain, ['merge-base', head.stdout.trim(), sha], { run });
      const base = (mb.ok ? await mapAt(brain, mb.stdout.trim(), run) : {}).map || null;
      // The united map must pass the write rules before anything moves: an entry of this side that does not fit the
      // server's map (a name that differs from one there only in letter case, an address it has in another place) is
      // left out and named, and the rest goes on; a map that still does not pass stops the rule with nothing changed.
      const united = uniteMaps(base, theirs.map || null, mine.exists ? mine.map : null);
      const fit = united ? leaveOutNew(theirs.map || null, united) : { map: null, left: [] };
      const both = fit.map;
      if (both) {
        const v = validateMap(both, { write: true, known: theirs.map ? onePlace(theirs.map) : [] });
        if (!v.ok) return stop(`the map here and the one on the git server do not fit together (${v.errors[0]}): nothing was changed`);
      }
      // Does this side add anything to the server's map? Not when it was only behind: then the move brings that map as
      // it is, and nothing waits beside the git folder.
      const adds = Boolean(both) && !(theirs.map && sameMap(both, theirs.map));
      if (s.ahead) {
        if (sorted.memory.length) {
          const m = await memoryOnTop(at, brain, sha, head.stdout.trim(), sorted.memory, run);
          if (m.error) return stop(`the memory commits here could not be put on top of the git server's: ${m.error}: nothing was changed`);
          target = m.sha;
        }
        // `reset --keep` writes over a file git does not track (one it ignores, too): a file the move would bring that
        // is here already untracked is the owner's, and stops it.
        const inWay = await untrackedInTheWay(brain, target, run);
        if (inWay.error) return stop(`the brain's files could not be read: ${inWay.error}`);
        if (inWay.files.length) return stop(`the brain and its git server have both moved, and the git server has a file that is here already and that git does not track here (${inWay.files.slice(0, 3).join(', ')}): nothing was changed; move it away (or commit it), then the next round brings the map in step`);
        const kept = await keepOld(at, brain, head.stdout.trim(), run);
        if (kept) return stop(`the brain's commits here could not be kept before the move: ${kept}: nothing was changed`);
      }
      // Kept until step (3) wrote it: a run cut off after the move finishes from here (finishPending).
      if (adds && isDir(path.join(brain, '.git'))) writeIn(at, pendingFile(brain), JSON.stringify(both, null, 2) + '\n', { atomic: true });
      // Nothing here that the server lacks: a plain fast-forward (what git ignores is never overwritten by it).
      const moved = await gitIn(at, brain, s.ahead ? ['reset', '--keep', '-q', target] : FAST_FORWARD(sha), run);
      if (!moved.ok) {
        if (kindAt(pendingFile(brain)) === 'file') removeIn(at, pendingFile(brain));
        return stop(`the brain and its git server have both moved, and a file the server changed has an uncommitted change here: nothing was changed (${last(moved)})`);
      }
      out.resolved++;
      // (3) the server's map with what this side added (three-way), then this disk by the union rule; each written only
      // when it changes the map
      if (both) {
        const now = readMap(dir);
        if (!(now.map && sameMap(both, now.map))) writeMap(both, dir);
        const r = await updateMap({ dir, projects, run, manifests: false });
        for (const l of [...fit.left, ...r.left.filter((x) => !fit.left.some((y) => y.ref === x.ref))]) out.needs.push(leftWords(l));
        // One name with another address here than on the server: the server's stays, and the owner is told (else
        // two computers would change it back and forth every round). Unless this side's map took that address since
        // the two parted (the owner ran hoprig workspace map here) and the server's map did not change it: then it is
        // a change of this side's like any other, and it goes up.
        let clash = theirs.map ? diffMap(theirs.map, r.map).changed.filter((c) => c.from && c.to) : [];
        if (clash.length && mine.exists && base) {
          const server = new Set(diffMap(base, theirs.map).changed.map((c) => c.label));
          const here = diffMap(base, mine.map).changed;
          clash = clash.filter((c) => server.has(c.label) || !here.some((h) => h.label === c.label && sameUrl(h.to, c.to)));
        }
        if (clash.length) {
          writeMap(keepAddresses(r.map, theirs.map, clash), dir);
          for (const c of clash) out.needs.push(addressWords(c));
        }
      }
      if (kindAt(pendingFile(brain)) === 'file') removeIn(at, pendingFile(brain));
      // This computer's file as the server has it may be another computer's (both took one label): said this round.
      const own = await writeOwnFile({ dir, projects });
      if (own.why && own.file) out.needs.push(own.why);
      const c = await commitOwnFiles({ dir, run });
      if (!c.done && !c.nothing) return stop(`the map was brought in step but not committed: ${c.why}`);
      // An activity line only for a commit really made. None, and the branch is on the server's commit (a fast-forward,
      // or this side's map commits held nothing the server's map lacks): nothing to upload.
      if (c.done) out.lines.push('The map was brought in step with the one on the git server (both had changed)');
      else if (target === sha) return { ...out, done: true };
    }
    // (3) push, (4) again when the server moved in between
    const p = await gitIn(at, brain, ['push', '--quiet'], run, { env: quietEnv() });
    if (p.ok) return { ...out, done: true, pushed: true };
    // Only a push refused because the server moved is tried again; one the server itself refused (a protected branch, a
    // hook) is said at once, in git's own words.
    if (!movedOn(p)) return stop(`the updated map could not be uploaded: ${pushReason(p)}`);
  }
  return stop(`the git server's brain moved again while Hoprig brought the map in step (${tries} tries): the next round tries again`);
}

/** A push refused because the git server's branch moved on (not one the server refused by a rule or a hook). */
function movedOn(p) {
  const t = `${p.stderr || ''}\n${p.stdout || ''}`;
  return !/\[remote rejected\]|hook declined/i.test(t) && /non-fast-forward|fetch first|stale info/i.test(t);
}

/** Why a push failed, in git's words: what the server said (its "remote:" lines and the refused branch), or git's last line. */
export function pushReason(p) {
  const lines = `${p.stderr || ''}\n${p.stdout || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  const remote = lines.filter((l) => /^remote:/.test(l)).map((l) => l.replace(/^remote:\s*/, '')).filter(Boolean);
  const refused = lines.find((l) => /\[remote rejected\]/.test(l));
  return [...remote.slice(-2), ...(refused ? [refused.replace(/^!\s*/, '')] : [])].join('; ') || last(p);
}

/** `map` with the addresses of `clash` (diffMap's changed) put back to what `theirs` says (the upkeep uses it too). */
export function keepAddresses(map, theirs, clash) {
  const m = clone(map);
  const want = new Map(clash.map((c) => [c.label, c.from]));
  for (const g of m.groups || []) if (want.has(g.dir)) g.url = want.get(g.dir);
  for (const p of m.projects) {
    if (want.has(refOf(p))) p.url = want.get(refOf(p));
    for (const r of p.repos) if (want.has(`${refOf(p)}/${r.dir}`)) r.url = want.get(`${refOf(p)}/${r.dir}`);
  }
  for (const o of m.others) if (want.has(o.dir)) o.url = want.get(o.dir);
  if (want.has('ai_brain') && theirs.brain) m.brain.url = theirs.brain.url;
  return m;
}
