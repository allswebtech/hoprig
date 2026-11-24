// Put together (step 2 of docs/GO-LIVE.md): the finished task branches the owner picked are merged, one after the other
// in his order, into ONE branch `work/<name>-all` made from the default branch's head, in a worktree in Hoprig's state
// folder. His own checkout never moves (no checkout, no reset, no stash, no config write in it). Merges are --no-ff,
// without the repository's hooks, never with a strategy option that picks a side. A conflict is never forced: the merge
// stays in progress, the record says which two tasks meet in which files, and conflictBrief() is what a session in that
// worktree gets on the owner's press. "Go on" merges the next branch once that merge is committed and nothing is
// unmerged. Hoprig's own code never pushes, never merges into the default branch, never tags.
//
// The record of a put-together is this dashboard's own (state folder ship/together/<id>.json), never in the repository.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { stateDir } from '../paths.mjs';
import { capture } from '../setup/system.mjs';
import { gitWrite, lastLine } from '../work/git.mjs';
import { gitFolder, takeLock } from './lock.mjs';

// One put-together or Go on at a time per repository (a second press of Go on waits its turn and finds it done).
async function locked(top, run, fn) {
  const release = takeLock(await gitFolder(top, run), 'put together', { name: 'hoprig-ship-together.lock' });
  try {
    return await fn();
  } finally {
    release();
  }
}

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const BRANCHES_MAX = 20;
const NO_HOOKS = ['-c', `core.hooksPath=${os.devNull}`];
const fail = (status, message, code = 'together') => Object.assign(new Error(message), { status, details: { code } });
const folder = () => path.join(stateDir(), 'ship', 'together');
export const togetherId = (top, name) => crypto.createHash('sha256').update(`${top}\0${name}`).digest('hex').slice(0, 20);
const fileOf = (id) => path.join(folder(), `${id}.json`);
export const allBranch = (name) => `work/${name}-all`;
// A branch name as git takes it and as the page shows it: no option, no range, nothing a shell or a ref would read.
const BRANCH_OK = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;

export function readTogether(id) {
  try {
    const r = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
    return r && r.id === id ? r : null;
  } catch {
    return null;
  }
}
function writeTogether(r) {
  fs.mkdirSync(folder(), { recursive: true, mode: 0o700 });
  const tmp = `${fileOf(r.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, fileOf(r.id));
  return r;
}
/** Every put-together of the repository at `top`, newest first. */
export function togethersOf(top) {
  let names = [];
  try {
    names = fs.readdirSync(folder()).filter((n) => /^[0-9a-f]{20}\.json$/.test(n));
  } catch {
    return [];
  }
  return names.map((n) => readTogether(n.slice(0, 20))).filter((r) => r && r.top === top).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

const read = async (dir, args, run) => {
  const r = await gitRead(dir, args, { run });
  return r.ok ? r.stdout.trim() : null;
};

/** The default branch: the server's HEAD (origin/HEAD), else main or master, else the branch the checkout stands on. */
export async function defaultBranch(top, run = capture) {
  const o = await read(top, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], run);
  if (o && o.startsWith('origin/')) {
    const b = o.slice(7);
    if (await read(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], run)) return b;
  }
  for (const b of ['main', 'master']) if (await read(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], run)) return b;
  return read(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'], run);
}

/**
 * The branches the owner can pick: local branches with commits the default branch does not have, `work/...` first,
 * each with the task's title where `titles` (branch → title, from Work's runs) names one. → { base, branches: [{ name,
 * title, commits, subject }] }.
 */
export async function candidates(top, { titles = {}, run = capture } = {}) {
  const base = await defaultBranch(top, run);
  if (!base) throw fail(409, 'this repository has no default branch to put tasks together on');
  const out = await read(top, ['for-each-ref', '--format=%(refname:short)%00%(subject)', '--no-merged', `refs/heads/${base}`, 'refs/heads'], run);
  const list = [];
  for (const line of (out || '').split('\n').filter(Boolean)) {
    const [name, subject] = line.split('\0');
    if (!BRANCH_OK.test(name) || /^work\/[a-z0-9-]+-all$/.test(name)) continue; // a put-together is not a task
    const n = await read(top, ['rev-list', '--count', `refs/heads/${base}..refs/heads/${name}`], run);
    list.push({ name, title: typeof titles[name] === 'string' ? titles[name].slice(0, 200) : null, commits: Number(n) || 0, subject: String(subject || '').slice(0, 200) });
  }
  list.sort((a, b) => Number(!a.name.startsWith('work/')) - Number(!b.name.startsWith('work/')) || a.name.localeCompare(b.name));
  return { base, branches: list };
}

/** What git says is unmerged in the worktree `dir`, and whether a merge is in progress there. */
async function mergeState(dir, run) {
  const u = await read(dir, ['diff', '--name-only', '--diff-filter=U'], run);
  const head = await read(dir, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], run);
  return { unmerged: (u || '').split('\n').filter(Boolean), merging: !!head };
}

/** The files `branch` changed since it left `base` (for "which two tasks meet in which files"). */
async function changedBy(top, base, branch, run) {
  const out = await read(top, ['diff', '--name-only', '--no-renames', `${base}...refs/heads/${branch}`], run);
  return new Set((out || '').split('\n').filter(Boolean));
}

/** Merge the branches of `r` from r.done.length on, until one meets a conflict. Writes the record after each. */
async function mergeOn(r, run) {
  while (r.done.length < r.branches.length) {
    const b = r.branches[r.done.length];
    const tip = await read(r.top, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], run);
    if (!tip) {
      r.problem = `the branch ${b} is not there any more`;
      return writeTogether(r);
    }
    // branch.<name>.mergeOptions in the repository's settings could add "-X ours": blanked for this call, so no
    // setting picks a side.
    const m = await gitWrite(r.dir, [...NO_HOOKS, '-c', `branch.${r.branch}.mergeOptions=`, 'merge', '--no-ff', '--no-edit', '-m', `Put together: ${b}`, tip], { run });
    const st = await mergeState(r.dir, run);
    if (m.ok && !st.merging && !st.unmerged.length) {
      r.done.push({ branch: b, commit: tip });
      r.conflict = null;
      r.problem = null;
      writeTogether(r);
      continue;
    }
    if (!st.merging) {
      r.problem = `git could not merge ${b} (${lastLine(m).replace(/\/[^\s'"]+/g, '…')})`;
      return writeTogether(r);
    }
    // Which earlier task meets this one: the ones that changed the files that are now unmerged.
    const files = st.unmerged.slice(0, 50);
    const meets = [];
    for (const d of r.done) {
      const ch = await changedBy(r.top, r.baseCommit, d.branch, run);
      const shared = files.filter((f) => ch.has(f));
      if (shared.length) meets.push({ branch: d.branch, files: shared });
    }
    r.conflict = { branch: b, commit: tip, files, meets, more: Math.max(0, st.unmerged.length - files.length), session: null };
    return writeTogether(r);
  }
  r.finished = true;
  r.head = await read(r.dir, ['rev-parse', 'HEAD'], run);
  return writeTogether(r);
}

/**
 * Start a put-together named `name` of `branches` (in that order) in the repository at `top` (the owner's checkout,
 * a real path). A name in use is refused unless it is that same open put-together (then it goes on as "Go on").
 */
export async function putTogether(top, args, { run = capture } = {}) {
  return locked(top, run, () => putTogetherNow(top, args, run));
}
async function putTogetherNow(top, { name, branches, titles = {} }, run) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw fail(400, 'the name is a short word of small letters, digits and "-", such as "tuesday"');
  if (!Array.isArray(branches) || !branches.length || branches.length > BRANCHES_MAX) throw fail(400, `pick 1 to ${BRANCHES_MAX} branches`);
  if (new Set(branches).size !== branches.length) throw fail(400, 'a branch is picked twice');
  const { base, branches: offered } = await candidates(top, { titles, run });
  for (const b of branches) if (typeof b !== 'string' || !offered.some((o) => o.name === b)) throw fail(400, `${String(b).slice(0, 80)} is not a finished task branch of this repository`);
  const id = togetherId(top, name);
  const branch = allBranch(name);
  const kept = readTogether(id);
  if (kept && !kept.closed && kept.dir && fs.existsSync(kept.dir)) {
    if (JSON.stringify(kept.branches) !== JSON.stringify(branches)) throw fail(409, `"${name}" is already put together with other branches: choose another name`, 'name-used');
    return goOnNow(kept, run);
  }
  if (await read(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], run)) throw fail(409, `the branch ${branch} is already there: choose another name`, 'name-used');
  const baseCommit = await read(top, ['rev-parse', '--verify', `refs/heads/${base}`], run);
  const trees = path.join(stateDir(), 'ship', 'trees');
  fs.mkdirSync(trees, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(trees, `${name}-`));
  fs.rmdirSync(dir); // git makes it
  const w = await gitWrite(top, [...NO_HOOKS, 'worktree', 'add', '--quiet', '-b', branch, dir, baseCommit], { run });
  if (!w.ok) throw fail(409, `a worktree for ${branch} could not be made (${lastLine(w).replace(/\/[^\s'"]+/g, '…')})`);
  const r = { v: 1, id, top, name, branch, dir: fs.realpathSync(dir), base, baseCommit, branches: [...branches], titles: Object.fromEntries(branches.map((b) => [b, offered.find((o) => o.name === b).title])), done: [], conflict: null, problem: null, finished: false, head: null, at: new Date().toISOString() };
  writeTogether(r);
  return mergeOn(r, run);
}

/**
 * "Go on": after a conflict, the next branch is merged once the merge in progress was committed and nothing is left
 * unmerged; else it says what is still open, and nothing moves.
 */
export async function goOn(id, { run = capture } = {}) {
  const r0 = readTogether(id);
  if (!r0) throw fail(404, 'there is no such put-together');
  return locked(r0.top, run, () => goOnNow(readTogether(id), run));
}
async function goOnNow(r, run) {
  if (r.finished) return r;
  if (r.conflict) {
    const st = await mergeState(r.dir, run);
    if (st.merging || st.unmerged.length) throw fail(409, `the merge of ${r.conflict.branch} is not finished yet: ${st.unmerged.length ? `${st.unmerged.length} file(s) still in conflict` : 'it is not committed'}`, 'still-conflict');
    // The merge must be the branch's: its tip is one of HEAD's parents, and no conflict marker is left in its files.
    const parents = (await read(r.dir, ['rev-list', '--parents', '-n', '1', 'HEAD'], run) || '').split(' ').slice(1);
    if (!parents.includes(r.conflict.commit)) throw fail(409, `the last commit is not the merge of ${r.conflict.branch}`, 'still-conflict');
    const marked = await read(r.dir, ['grep', '-l', '-e', '^<<<<<<< ', '-e', '^>>>>>>> ', 'HEAD', '--', ...r.conflict.files], run);
    if (marked) throw fail(409, `conflict markers are still in ${marked.split('\n').map((l) => l.replace(/^HEAD:/, '')).join(', ')}`, 'still-conflict');
    r.done.push({ branch: r.conflict.branch, commit: r.conflict.commit, resolved: true });
    r.conflict = null;
    writeTogether(r);
  }
  return mergeOn(r, run);
}

/** Note the session a conflict was handed to (its chat id), so the page can show it and not hand it twice. */
export function noteSession(id, session) {
  const r = readTogether(id);
  if (!r || !r.conflict) throw fail(409, 'there is no conflict to hand on');
  if (r.conflict.session) throw fail(409, 'this conflict is already with a session', 'handed');
  r.conflict.session = String(session).slice(0, 80);
  return writeTogether(r);
}

// The developer's words: the seam for a role file later; one constant here.
export const DEVELOPER_ROLE = 'You are the developer who puts finished tasks together. Two tasks changed the same lines: keep what each task meant to do, so both work together. Do not drop either side to make the conflict go away. Do not push, do not tag, and do not change any other branch.';

/** The brief for the session that resolves the conflict of `r`, made from both tasks (their titles and commits). */
export function conflictBrief(r) {
  if (!r || !r.conflict) return null;
  const c = r.conflict;
  const task = (b) => (r.titles && r.titles[b] ? `${b} ("${r.titles[b]}")` : b);
  const meets = c.meets.length ? c.meets.map((m) => `- ${task(m.branch)} also changed: ${m.files.join(', ')}`).join('\n') : '- (git names no earlier task: the conflict is with the default branch)';
  return [
    DEVELOPER_ROLE,
    '',
    `This folder is a worktree on the branch ${r.branch}, made from ${r.base}. A merge of ${task(c.branch)} is in progress and stopped at a conflict in: ${c.files.join(', ')}${c.more ? ` and ${c.more} more` : ''}.`,
    'The tasks that meet there:',
    meets,
    '',
    `Resolve every conflicted file, run the project's own tests if it has them, then finish the merge with "git add" and "git commit --no-edit" in this folder. When "git status" shows no merge in progress and no unmerged path, you are done: say in two lines what you kept from each task.`,
  ].join('\n');
}

/** Close a put-together (the record stays, marked; its worktree and branch stay for the owner). */
export function closeTogether(id) {
  const r = readTogether(id);
  if (!r) throw fail(404, 'there is no such put-together');
  r.closed = true;
  return writeTogether(r);
}
