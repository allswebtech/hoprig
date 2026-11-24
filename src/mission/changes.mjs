// What a branch changed, for a reviewer session: such a session has no git (it has the file tools only), so the
// dashboard reads the branch's changes itself, through the one reader, and writes them into a file in a folder of its
// own state. The reviewer may read that folder besides its worktree (alone.mjs: an added folder), and has no tool that
// writes. The folder goes when the review's run has ended.
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { stateDir } from '../paths.mjs';
import { capture } from '../setup/system.mjs';

// The most of a branch's diff that is written out for its reviewer; a longer one is cut, and the file says so.
const DIFF_MAX = 400_000;
const reviewDir = (mid, tid) => path.join(stateDir(), 'mission-reviews', `${mid}-${tid}`);

/**
 * What the branch changed since its base, as git shows it, through the one reader (no program of the folder is
 * started for it). → { names: [paths], text: the list of files, then the diff } or null when git could not say.
 */
export async function changesOf(top, base, branch, run = capture) {
  const range = `${base}...refs/heads/${branch}`;
  const names = await gitRead(top, ['diff', '--name-only', range], { run });
  const stat = await gitRead(top, ['diff', '--stat', range], { run });
  const diff = await gitRead(top, ['diff', range], { run });
  if (!names.ok || !stat.ok || !diff.ok) return null;
  const more = diff.stdout.length - DIFF_MAX;
  const body = more > 0 ? `${diff.stdout.slice(0, DIFF_MAX)}\n\n(This file holds the first ${DIFF_MAX} characters of the diff; ${more} more are left out. Read the files themselves.)\n` : diff.stdout;
  return { names: names.stdout.split('\n').filter(Boolean), text: `Files changed on the branch ${branch} since ${base.slice(0, 12)}:\n\n${stat.stdout.trim()}\n\n${body}` };
}

/** The file a reviewer reads the branch's changes from: in a folder of the dashboard's own, never in the worktree. */
export function writeChanges(mid, tid, text) {
  const dir = reviewDir(mid, tid);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'changes.diff');
  fs.writeFileSync(file, text, { mode: 0o600 });
  return { dir, file };
}
/**
 * What the tests printed in the box (gate.mjs printedTail: the last lines, cleaned), as a file beside the changes, for
 * the reviewer to read as data. → the file's path, or null when nothing was printed.
 */
export function writePrinted(mid, tid, text) {
  if (typeof text !== 'string' || !text) return null;
  const dir = reviewDir(mid, tid);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'tests-printed.txt');
  fs.writeFileSync(file, `${text}\n`, { mode: 0o600 });
  return file;
}
export const dropChanges = (mid, tid) => {
  try {
    fs.rmSync(reviewDir(mid, tid), { recursive: true, force: true });
  } catch {
    /* written again at the next review */
  }
};
