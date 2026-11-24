// Work's git: what a save asks of the repository that holds the Work file. Every read goes through src/gitread.mjs
// (a repository's own settings start nothing for it); every write (add, commit, fetch, the fast-forward, the send)
// is the owner's own press and runs as git runs it, with his hooks, but never with the file-system monitor a
// repository may name: that is a program the owner did not ask a save to start.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import { RUN_FILE_RE } from './runs.mjs';
import { NOTE_FILE_RE, PLAN_FILE_RE } from './plans.mjs';

// A mission's file (src/mission/file.mjs: missions/<id>.json). Named here, not imported, so work/ keeps no
// dependency on mission/ (which imports work/).
export const MISSION_FILE_RE = /^m-\d{8}-[0-9a-f]{6}\.json$/;

// The most commits not yet sent that a save looks at one by one; more than this are never sent by a save.
export const UNSENT_MAX = 50;

const env = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

/** One git write in `top`, the file-system monitor off for this call. Capture's shape: { ok, code, stdout, stderr }. */
export function gitWrite(top, args, { run = capture, timeout = 120_000 } = {}) {
  return run(['git', '-c', 'core.fsmonitor=false', '-C', top, ...args], { timeout, env: env() });
}

/** git's last line, for the server's log and the command line (never for the page). */
export const lastLine = (r) => String((r && (r.stderr || r.stdout)) || '').trim().split('\n').pop().slice(0, 300);

/** The repository of `dir`: { top, name, branch, remote, merge } (remote and merge null without a server branch), or null. */
export async function repoInfo(dir, run = capture) {
  const top = await gitRead(dir, ['rev-parse', '--show-toplevel'], { run });
  if (!top.ok) return null;
  const root = top.stdout.trim();
  const br = await gitRead(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { run });
  const branch = br.ok ? br.stdout.trim() : null;
  let remote = null;
  let merge = null;
  if (branch) {
    const r = await gitRead(root, ['config', '--get', `branch.${branch}.remote`], { run });
    const m = await gitRead(root, ['config', '--get', `branch.${branch}.merge`], { run });
    if (r.ok && m.ok && r.stdout.trim() && r.stdout.trim() !== '.') {
      remote = r.stdout.trim();
      merge = m.stdout.trim();
    }
  }
  return { top: root, name: path.basename(root), branch, remote, merge };
}

/**
 * The commits on this branch that its server branch does not have, newest first: [{ sha, short, subject, parents,
 * files }] (files: what the commit changes, asked of git per commit). null when git could not say, or when there are
 * more than UNSENT_MAX (a save then sends none of them). `range`: another pair of commits, by id (what a save judged).
 */
export async function unsentCommits(top, run = capture, range = '@{u}..HEAD') {
  const l = await gitRead(top, ['log', `--max-count=${UNSENT_MAX + 1}`, '--format=%H%x00%h%x00%P%x00%s', range], { run });
  if (!l.ok) return null;
  const rows = l.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, short, parents, subject] = line.split('\0');
    return { sha, short, subject, parents: parents ? parents.split(' ') : [] };
  });
  if (rows.length > UNSENT_MAX) return null;
  for (const c of rows) {
    const d = await gitRead(top, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', '--root', c.sha], { run });
    c.files = d.ok ? d.stdout.split('\0').filter(Boolean) : null;
  }
  return rows;
}

/**
 * Whether `f` (a path in the repository) is one of Work's files: the list `rel`, a run file right in `runsRel`, or a
 * plan's file or note right in `plansRel` (a commit's file of such a name that is not Work's there is marked first:
 * plans.mjs checkPlanCommits).
 */
export const isWorkFile = (f, { rel, runsRel = null, plansRel = null, missionsRel = null }) => f === rel || (runsRel !== null && f.startsWith(`${runsRel}/`) && RUN_FILE_RE.test(f.slice(runsRel.length + 1)))
  || (plansRel !== null && f.startsWith(`${plansRel}/`) && (PLAN_FILE_RE.test(f.slice(plansRel.length + 1)) || NOTE_FILE_RE.test(f.slice(plansRel.length + 1))))
  || (missionsRel !== null && f.startsWith(`${missionsRel}/`) && MISSION_FILE_RE.test(f.slice(missionsRel.length + 1)));

/**
 * Which unsent commits a save may send: those that change nothing but Work's files (the list `rel` and the run files
 * in `runsRel`), or, in the AI brain, nothing but the workspace map Hoprig keeps there (`mapRel`). A merge commit, a
 * commit whose files git could not list, or one that changes anything else is the owner's own: it is never sent by a
 * save, and neither is anything while one of those waits. The subject plays no part (a hook may rewrite it; the
 * owner may write the same words). → { ours: [commit], theirs: [commit] } (theirs: the owner's own, not sent by a save).
 */
export function sortUnsent(commits, { rel, mapRel = null, runsRel = null, plansRel = null, missionsRel = null }) {
  const ours = [];
  const theirs = [];
  for (const c of commits) {
    const all = (test) => Array.isArray(c.files) && c.files.length > 0 && c.files.every(test);
    const fits = c.parents.length <= 1 && (all((f) => isWorkFile(f, { rel, runsRel, plansRel, missionsRel })) || (mapRel !== null && all((f) => f === mapRel)));
    (fits ? ours : theirs).push(c);
  }
  return { ours, theirs };
}

/** "a1b2c3d Fix the readme", "a1b2c3d … and 2 more" for a message. */
export function nameCommits(list, max = 3) {
  const shown = list.slice(0, max).map((c) => `${c.short} "${String(c.subject).slice(0, 60)}"`);
  return `${shown.join(', ')}${list.length > max ? ` and ${list.length - max} more` : ''}`;
}

/** git's id of a file with these bytes (a text: as UTF-8), in the repository's kind of id (40 or 64 hex digits). */
export function blobId(content, hexLength = 40) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return crypto.createHash(hexLength === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** git's id of the file on disk now (null when it is not there), in the repository's kind of id. */
export function blobOnDisk(file, hexLength = 40) {
  try {
    return blobId(fs.readFileSync(file), hexLength);
  } catch {
    return null;
  }
}

/**
 * The file at a commit: { text, id, exact } or null when the commit has no such file. `exact`: the text is the file's
 * very bytes (false when some were not UTF-8: a write of the text would change them). Throws when git cannot show it.
 */
export async function fileAt(top, rev, rel, run = capture) {
  const there = await gitRead(top, ['rev-parse', '--verify', '--quiet', `${rev}:${rel}`], { run });
  if (!there.ok) return null;
  const r = await gitRead(top, ['show', `${rev}:${rel}`], { run });
  if (!r.ok) throw Object.assign(new Error(`git could not show the Work file of a commit in ${path.basename(top)}`), { detail: lastLine(r) });
  const id = there.stdout.trim();
  return { text: r.stdout, id, exact: blobId(r.stdout, id.length) === id };
}

/** The index's entry of `rel`: { mode, sha } (stage 0), null when it has none. Throws when git cannot say. */
export async function indexEntry(top, rel, run = capture) {
  const r = await gitRead(top, ['ls-files', '--stage', '-z', '--', rel], { run });
  if (!r.ok) throw Object.assign(new Error(`git could not read the index of ${path.basename(top)}`), { detail: lastLine(r) });
  const m = /^(\d{6}) ([0-9a-f]{40,64}) 0\t/.exec(r.stdout);
  return m ? { mode: m[1], sha: m[2] } : null;
}

/** Put the index's entry of `rel` back to `entry` (null: none), and nothing else of the index. */
export function setIndexEntry(top, rel, entry, run = capture) {
  return gitWrite(top, entry ? ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.sha},${rel}`] : ['update-index', '--force-remove', '--', rel], { run });
}

/** Where the repository stands now: { branch (null: a detached HEAD), head (null: git could not say) }. */
export async function standing(top, run = capture) {
  const br = await gitRead(top, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { run });
  const hd = await gitRead(top, ['rev-parse', '--verify', '--quiet', 'HEAD'], { run });
  return { branch: br.ok ? br.stdout.trim() : null, head: hd.ok ? hd.stdout.trim() : null };
}

/** The local branches whose history has commit `sha`: [name] (empty also when git could not say). */
export async function branchesWith(top, sha, run = capture) {
  const r = await gitRead(top, ['for-each-ref', `--contains=${sha}`, '--format=%(refname:short)', 'refs/heads/'], { run });
  return r.ok ? r.stdout.split('\n').filter(Boolean) : [];
}

/** Whether commit `a` is in the history of `b`: true, false, or null when git could not say. */
export async function isAncestor(top, a, b, run = capture) {
  const r = await gitRead(top, ['merge-base', '--is-ancestor', a, b], { run });
  return r.ok ? true : r.code === 1 ? false : null;
}

/**
 * The send: exactly one commit to exactly one branch of the server. Never the owner's tags (push.followTags), never
 * a submodule's commits (push.recurseSubmodules), never another branch (push.default does not apply to a refspec).
 */
export const sendArgs = (remote, sha, mergeRef) => ['push', '--quiet', '--no-follow-tags', '--recurse-submodules=no', remote, `${sha}:${mergeRef}`];

/** Why a send failed, in a few plain words, from git's own. */
export function sendFailure(r) {
  const t = `${r.stderr || ''}\n${r.stdout || ''}`;
  if (/\[rejected\]|non-fast-forward|fetch first|stale info|\(fetch first\)/i.test(t)) return 'the server moved again meanwhile';
  if (/could not read from remote|unable to access|could not resolve|does not appear to be a git repository|connection|timed out|no such file or directory/i.test(t) || r.error === 'ETIMEDOUT') return 'the server did not answer';
  return 'the server refused it';
}
