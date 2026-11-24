// The commit of a run that may write but has no git of its own (a mission's session: it has the file tools only). When
// such a run has ended, the dashboard itself makes ONE commit of what the run changed in its worktree, on the run's
// own branch:
//   - the worktree's own git entry (its `.git` file) must be exactly as the dashboard made it: a run that could
//     replace it would point git at settings of its own;
//   - what changed is asked through the one reader (src/gitread.mjs: no hook, no file-system monitor, no filter or
//     diff program of the folder is started);
//   - the commit is made the way a drop makes its own (src/workspace/dropacts.mjs sealedCommit: a temporary index,
//     each file's bytes as they are, no filter), so the commit holds exactly the bytes in the folder;
//   - the branch moves, and the worktree's index follows, with the repository's hooks off: a hook is a program the
//     owner did not ask a run to start.
// Nothing is pushed. A path that is no file git can keep (a folder with a repository of its own, a pipe) is left
// out and named.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import { sealedCommit } from '../workspace/dropacts.mjs';
import { idOf, isGitId } from '../workspace/dropcheck.mjs';
import { gitWrite, lastLine } from './git.mjs';

const NO_HOOKS = ['-c', `core.hooksPath=${os.devNull}`];

/**
 * A path that tells a coding tool what to do or which tools it has: the next session in this folder would read it as
 * its own instructions. A branch that changes one gets no reviewer session and is never accepted by itself.
 */
export const steersTools = (rel) =>
  /(^|\/)(CLAUDE(\.local)?\.md|AGENTS\.md|GEMINI\.md|\.mcp\.json|\.cursorrules|copilot-instructions\.md)$/i.test(rel) || /(^|\/)\.(claude|cursor|codex|opencode|gemini)\//i.test(rel);

// The same files as steersTools, as git pathspecs (at any depth, any case): git picks them out itself, also where the
// project ignores them, without listing every file of an ignored folder.
const STEER_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md', '.mcp.json', '.cursorrules', 'copilot-instructions.md'];
const STEER_DIRS = ['.claude', '.cursor', '.codex', '.opencode', '.gemini'];
const STEER_SPECS = [...STEER_FILES.map((f) => `:(glob,icase)**/${f}`), ...STEER_DIRS.flatMap((d) => [`:(glob,icase)**/${d}`, `:(glob,icase)**/${d}/**`])];

/**
 * The files of the worktree `dir` that tell a coding tool what to do and are not as the branch holds them: untracked,
 * changed, or ignored by the project (what its tests or its session left there). → [path] | null (git could not say).
 */
export async function steersLeft(dir, run = capture) {
  const st = await gitRead(dir, ['status', '--porcelain', '--untracked-files=all', '--ignored', '--', ...STEER_SPECS], { run });
  if (!st.ok) return null;
  return [...new Set(st.stdout.split('\n').filter(Boolean).map((l) => l.slice(3)))];
}

/** The worktree's own git entry as it is now: the text of its `.git` file, or null when it is no plain file. */
export function gitEntryOf(dir) {
  try {
    const p = path.join(dir, '.git');
    return fs.lstatSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

/** The paths git lists as changed in `dir` (new, changed or gone), by its own names, or null when it could not say. */
async function changedPaths(dir, run) {
  const st = await gitRead(dir, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'], { run });
  if (!st.ok) return null;
  const out = new Set();
  for (const rec of st.stdout.split('\0')) {
    if (rec.length > 3) out.add(rec.slice(3));
  }
  return [...out];
}

/**
 * One commit of what changed in the worktree `dir` (its top folder), on the branch it stands on.
 * `gitEntry`: the worktree's `.git` text as it was when the run started (gitEntryOf); `message`: the commit's.
 * → { ok: true, sha: <the commit> | null (nothing changed), files, skipped, steers } | { ok: false, why }
 */
export async function commitRun(dir, { message, gitEntry = null, run: runner = capture } = {}) {
  // Every git call made for this commit, also the ones inside the shared commit path, gets the two settings on its
  // command line: the repository's own file cannot outrank them, so neither a hook nor the file-system monitor it
  // may name is started (a monitor is asked by plain index commands too).
  const run = (argv, opts) => runner(argv[0] === 'git' ? ['git', '-c', 'core.fsmonitor=false', ...NO_HOOKS, ...argv.slice(1)] : argv, opts);
  if (gitEntry !== null && gitEntryOf(dir) !== gitEntry) {
    return { ok: false, why: 'the worktree\'s own git entry is not as the dashboard made it: nothing was committed, look at the folder yourself' };
  }
  const head = await gitRead(dir, ['rev-parse', '--verify', '-q', 'HEAD'], { run });
  const sym = await gitRead(dir, ['symbolic-ref', '--quiet', 'HEAD'], { run });
  if (!head.ok || !sym.ok || !/^refs\/heads\//.test(sym.stdout.trim()) || !isGitId(head.stdout.trim())) return { ok: false, why: 'git could not say which branch the worktree stands on: nothing was committed' };
  const parent = head.stdout.trim();
  const ref = sym.stdout.trim();
  const algo = parent.length === 64 ? 'sha256' : 'sha1'; // the repository's object format, told by the length of its ids
  const paths = await changedPaths(dir, run);
  if (!paths) return { ok: false, why: 'git could not list what changed: nothing was committed' };
  if (!paths.length) return { ok: true, sha: null, files: [], skipped: [], steers: [] };
  const entries = [];
  const skipped = [];
  for (const rel of paths) {
    const id = await idOf(dir, rel.replace(/\/$/, ''), algo, run);
    if (id === 'none') entries.push({ path: rel, id: 'none' });
    else if (isGitId(id)) entries.push({ path: rel, id });
    else skipped.push(rel);
  }
  if (!entries.length) return { ok: true, sha: null, files: [], skipped, steers: [] };
  const c = await sealedCommit({ root: dir }, dir, { parent, entries, message: String(message || 'Work by a run of Hoprig').slice(0, 2000), algo, run });
  if (!c.ok) return { ok: false, why: c.changed ? `${c.changed} changed while it was being committed: nothing was committed` : `git did not make the commit (${String(c.why || '').slice(0, 200)})` };
  if (c.same) return { ok: true, sha: null, files: [], skipped, steers: [] };
  const mv = await gitWrite(dir, [...NO_HOOKS, 'update-ref', '-m', 'hoprig run', ref, c.sha, parent], { run });
  if (!mv.ok) return { ok: false, why: `the branch could not be moved to the commit (${lastLine(mv)})` };
  // The worktree's own index now says what the branch holds; the files are not touched (they are those bytes already).
  const ix = await gitWrite(dir, [...NO_HOOKS, 'read-tree', c.sha], { run });
  const files = entries.map((e) => e.path);
  return { ok: true, sha: c.sha, files, skipped, steers: files.filter(steersTools), ...(ix.ok ? {} : { index: lastLine(ix) }) };
}
