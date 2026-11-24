// The worktree of a run that ends by itself (alone.mjs): such a run never works in the owner's own checkout and never
// on its default branch. It works in a linked worktree of the project's repository, on a branch of its own
// (`work/<item or schedule id>`), in Hoprig's state folder. Nothing is pushed, merged or published here.
//
// The worktree is kept until the owner accepts the result (then it is removed when it is clean; the branch stays) or
// another run of the same id continues in it (after Send back, or the next slot of a schedule). Which worktree
// belongs to which branch, and which branches this dashboard made, is its own record (`work-alone/trees.json`),
// never in the repository.
//
// The two writes (worktree add, worktree remove) are this dashboard's own and run without the repository's hooks
// (a checkout hook is a program the owner did not ask a run to start); every read goes through src/gitread.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { clearLink } from '../mission/boxed.mjs';
import { stateDir } from '../paths.mjs';
import { capture } from '../setup/system.mjs';
import { gitWrite, lastLine } from './git.mjs';

const treesFile = () => path.join(stateDir(), 'work-alone', 'trees.json');
const fail = (message, code) => Object.assign(new Error(message), { status: 409, details: { code } });
const NO_HOOKS = ['-c', `core.hooksPath=${os.devNull}`];

/**
 * The git config a run's own git commands take through the environment: the repository's hooks off. A hook is a
 * program the owner did not ask a run to start, yet an allowed `git commit` runs one (a repository's own
 * `core.hooksPath`, e.g. husky's `.husky`, resolves inside the run's worktree), with the run's whole environment.
 * Set with GIT_CONFIG_* so the repository's own file cannot outrank it, merged with any GIT_CONFIG_* already in the
 * environment so none is lost. The session cannot undo it: it may not pass a `-c` of its own, and an env of its own
 * is a different command line than the one its role allows.
 */
export function noHooksEnv(base = {}) {
  const n = Number.parseInt(base.GIT_CONFIG_COUNT, 10);
  const i = Number.isInteger(n) && n >= 0 ? n : 0;
  return { GIT_CONFIG_COUNT: String(i + 1), [`GIT_CONFIG_KEY_${i}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${i}`]: os.devNull };
}

function readTrees() {
  try {
    const d = JSON.parse(fs.readFileSync(treesFile(), 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}
function writeTrees(d) {
  fs.mkdirSync(path.dirname(treesFile()), { recursive: true, mode: 0o700 });
  const tmp = `${treesFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, treesFile());
}
const keyOf = (top, branch) => `${top}\0${branch}`;

/** The top folder of the git repository at `dir` (a real path), or null when it is none. */
export async function repoTop(dir, run = capture) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const r = await gitRead(dir, ['rev-parse', '--show-toplevel'], { run });
  return r.ok ? fs.realpathSync(r.stdout.trim()) : null;
}

/** The branch the repository at `top` stands on now (its own checkout), or null. */
export async function currentBranch(top, run = capture) {
  const r = await gitRead(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { run });
  return r.ok ? r.stdout.trim() : null;
}

/**
 * The record of the run branch asked for as `branch` in `top`: [key, entry], or null. Only by its own key (top + the
 * name asked for): the name a run got (`work/<id>-2`) may be another id's name (an item "fix-2"), so a record is never
 * found by the branch it got.
 */
function entryOf(trees, top, branch) {
  const k = keyOf(top, branch);
  return trees[k] ? [k, trees[k]] : null;
}
const hasBranch = async (top, b, run) => (await gitRead(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { run })).ok;

/**
 * The worktree of the run branch `branch` in the repository at `top`: kept from an earlier run (→ { dir, made: false,
 * branch }) or made now (→ { dir, made: true, branch }). A branch is this dashboard's only when its record says it made
 * it: a branch of that name it did not make is the owner's own and is never taken; the run gets a free name then
 * (`work/<id>-2`). A kept worktree that is no longer on its branch (a run switched it) is refused: a run there would
 * commit on whatever branch it stands on.
 */
export async function treeFor(top, branch, { run = capture } = {}) {
  const trees = readTrees();
  const found = entryOf(trees, top, branch);
  const kept = found ? found[1] : null;
  const key = found ? found[0] : keyOf(top, branch);
  if (kept && kept.dir && fs.existsSync(path.join(kept.dir, '.git'))) {
    const head = await gitRead(kept.dir, ['symbolic-ref', '--quiet', 'HEAD'], { run });
    if (!head.ok || head.stdout.trim() !== `refs/heads/${kept.branch}`) throw fail(`the kept worktree of ${kept.branch} is not on that branch any more (an earlier run switched it): nothing runs there until it is back on ${kept.branch}`, 'worktree-moved');
    return { dir: kept.dir, made: false, branch: kept.branch };
  }
  let name = kept ? kept.branch : branch;
  if (!kept) {
    // Free: no branch of that name in git, and no record of this repository got it (its branch may be gone meanwhile).
    const got = new Set(Object.entries(trees).filter(([k, t]) => k.startsWith(`${top}\0`) && t && typeof t.branch === 'string').map(([, t]) => t.branch));
    for (let i = 2; got.has(name) || (await hasBranch(top, name, run)); i++) {
      if (i > 50) throw fail(`the branches ${branch} to ${branch}-50 are all taken: a run that ends by itself needs a branch of its own`, 'worktree');
      name = `${branch}-${i}`;
    }
  }
  const has = kept ? await hasBranch(top, name, run) : false;
  const base = path.join(stateDir(), 'work-trees');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(base, `${name.replace(/[^a-z0-9-]/g, '-')}-`));
  fs.rmdirSync(dir); // git makes the folder itself
  const r = await gitWrite(top, [...NO_HOOKS, 'worktree', 'add', '--quiet', ...(has ? [dir, name] : ['-b', name, dir, 'HEAD'])], { run });
  if (!r.ok) throw fail(`a worktree on the branch ${name} could not be made (${lastLine(r).replace(/\/[^\s'"]+/g, '…')})`, 'worktree');
  trees[key] = { dir: fs.realpathSync(dir), branch: name };
  writeTrees(trees);
  return { dir: trees[key].dir, made: true, branch: name };
}

/** The kept worktree of the run branch asked for as `branch` in `top`, or null. */
export function keptTree(top, branch) {
  const e = entryOf(readTrees(), top, branch);
  return e && e[1].dir && fs.existsSync(path.join(e[1].dir, '.git')) ? e[1].dir : null;
}

/** Every branch and tag of the repository at `top`: Map ref → commit (a run's start and end are compared). */
export async function refsOf(top, run = capture) {
  const r = await gitRead(top, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads', 'refs/tags'], { run });
  if (!r.ok) return null;
  return new Map(r.stdout.split('\n').filter(Boolean).map((l) => l.split('\0')));
}

/** A commit as the owner recognises it: `abc1234 ("its subject")`, or its short id alone when git cannot read it. */
export async function commitWords(top, sha, run = capture) {
  const r = await gitRead(top, ['log', '-1', '--format=%h%x00%s', sha, '--'], { run });
  if (!r.ok) return String(sha).slice(0, 7);
  const [short, subject] = r.stdout.trim().split('\0');
  return subject ? `${short} ("${subject.replace(/\s+/g, ' ').slice(0, 80)}")` : short;
}

/**
 * Accept: the worktree of the run branch asked for as `branch` (its record's key, as treeFor) goes when nothing in it is left uncommitted (the branch stays, with its commits).
 * → { removed: true } | { removed: false, why } (nothing there, or files changed and not committed).
 */
export async function releaseTree(top, branch, { run = capture } = {}) {
  const trees = readTrees();
  const found = entryOf(trees, top, branch);
  const t = found ? found[1] : null;
  // The record stays without its folder: the branch is still this dashboard's (treeFor), for the next run of the id.
  if (!t || !t.dir || !fs.existsSync(t.dir)) {
    if (found) trees[found[0]] = { branch: t.branch };
    writeTrees(trees);
    return { removed: false, why: 'there is no worktree of it any more' };
  }
  // The link to the project's dependencies that a run in the box made and a dashboard that died did not take away
  // (mission/boxed.mjs): the product's own, never the session's, so it does not keep the worktree. A link is no folder
  // to git, so a project's "node_modules/" line does not ignore it.
  try {
    clearLink(t.dir);
  } catch {
    /* no record could be read: nothing of ours to take away */
  }
  const st = await gitRead(t.dir, ['status', '--porcelain', '--untracked-files=all'], { run });
  if (!st.ok || st.stdout.trim()) return { removed: false, why: `its worktree has files changed and not committed, so it is kept (branch ${t.branch})` };
  const r = await gitWrite(top, [...NO_HOOKS, 'worktree', 'remove', t.dir], { run });
  if (!r.ok) return { removed: false, why: 'git did not remove the worktree' };
  trees[found[0]] = { branch: t.branch };
  writeTrees(trees);
  return { removed: true };
}

/**
 * A look's end (src/operator/look.mjs): its worktree AND its branch go, the record with them. The branch goes only when
 * it has no commit of its own (none that another branch of the repository does not hold) and its worktree has nothing
 * changed; else both stay and the answer says why. → { removed: true } | { removed: false, why }.
 */
export async function dropRunBranch(top, branch, { run = capture } = {}) {
  const trees = readTrees();
  const found = entryOf(trees, top, branch);
  if (!found) return { removed: false, why: 'the dashboard has no record of its branch' };
  const t = found[1];
  if (t.dir && fs.existsSync(t.dir)) {
    const st = await gitRead(t.dir, ['status', '--porcelain', '--untracked-files=all'], { run });
    if (!st.ok || st.stdout.trim()) return { removed: false, why: `its worktree has files changed, so it is kept (branch ${t.branch})` };
  }
  const own = `refs/heads/${t.branch}`;
  const refs = await refsOf(top, run);
  if (!refs) return { removed: false, why: 'git could not list the branches' };
  if (refs.has(own)) {
    const others = [...refs].filter(([k]) => k !== own && k.startsWith('refs/heads/')).map(([, sha]) => `^${sha}`);
    const n = await gitRead(top, ['rev-list', '--count', own, ...others], { run });
    if (!n.ok) return { removed: false, why: 'git could not count its commits' };
    const count = Number(n.stdout.trim());
    if (count > 0) return { removed: false, why: `its branch ${t.branch} has ${count} commit${count === 1 ? '' : 's'} of its own, so it is kept` };
  }
  if (t.dir && fs.existsSync(t.dir)) {
    const r = await gitWrite(top, [...NO_HOOKS, 'worktree', 'remove', t.dir], { run });
    if (!r.ok) return { removed: false, why: 'git did not remove the worktree' };
  }
  if (refs.has(own)) {
    const b = await gitWrite(top, [...NO_HOOKS, 'branch', '-D', t.branch], { run });
    if (!b.ok) return { removed: false, why: `git did not remove the branch ${t.branch}` };
  }
  delete trees[found[0]];
  writeTrees(trees);
  return { removed: true };
}
