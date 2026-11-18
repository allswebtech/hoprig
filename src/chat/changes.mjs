// What changed in a session's folder, for the session rail's Changes card (+N −M, as the desktop app's): the files
// git sees changed against the last commit, staged or not, with their added and removed lines, and the new files it
// does not track yet, whose lines count as added. Only the session's own folder: in a subfolder of a repository both
// lists are of that folder and name its files from it (nothing beside it is counted or named). Every git read goes
// through gitread.mjs, so a repository's own settings never start a program for it; a new file's lines are counted
// here, from the file itself, never through a filter.
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';

const FILES_MAX = 20; // the card names a few files; the editor's Changes view has them all
const COUNT_MAX = 100; // the new files whose lines are counted (the first ones; the rest add none)
const COUNT_BYTES = 1024 * 1024; // a bigger new file adds no lines (a log or a dump, not an edit)
// All new files together: the card asks again after every tool, turn and return to the tab, so what one ask reads
// is bounded (an unignored build output of many big files would be read whole each time). Past it, no more counted.
const COUNT_TOTAL = 4 * 1024 * 1024;

/** "12\t3\tsrc/a.js" (a binary file says "-\t-") → { path, added, removed } or null. */
function numstatLine(l) {
  const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
  if (!m) return null;
  return { path: m[3], added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) };
}

/**
 * The lines of new file `p` in `dir`, as git would count them: 0 for a link, a binary or a very big file. `budget`:
 * { left } bytes still to read for this ask; a file that does not fit ends the counting (left 0).
 */
async function newLines(dir, p, budget) {
  try {
    const full = path.join(dir, p);
    const st = await fs.lstat(full); // a link is not followed: its target may be outside the folder
    if (!st.isFile() || st.size > COUNT_BYTES || !st.size) return 0;
    if (st.size > budget.left) {
      budget.left = 0;
      return 0;
    }
    budget.left -= st.size;
    const buf = await fs.readFile(full);
    if (buf.includes(0)) return 0; // binary, as git says it ("-")
    let n = 0;
    for (const b of buf) if (b === 0x0a) n++;
    return buf[buf.length - 1] === 0x0a ? n : n + 1;
  } catch {
    return 0; // gone meanwhile, or a name git wrote in quotes
  }
}

/**
 * The changes of folder `dir` → { git: false } outside a repository (or when git cannot read it), else { git: true,
 * files (changed and new), added, removed, untracked, list: [{ path, added, removed, new }] (the first FILES_MAX) }.
 * o.run: how git is run (tests).
 */
export async function folderChanges(dir, o = {}) {
  const read = (args) => gitRead(dir, args, o.run ? { run: o.run } : {});
  const inside = await read(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') return { git: false };
  // A repository without a commit yet compares with the index (what was added), and its files are new.
  const head = await read(['rev-parse', '--verify', '--quiet', 'HEAD']);
  // --relative: the folder's own changes, named from it (as ls-files names the new files).
  const [diff, others] = await Promise.all([
    read(['-c', 'core.quotepath=false', 'diff', '--numstat', '--relative', ...(head.ok ? ['HEAD'] : ['--cached'])]),
    read(['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']),
  ]);
  if (!diff.ok) return { git: false };
  const changed = diff.stdout.split('\n').map(numstatLine).filter(Boolean);
  const fresh = others.ok ? others.stdout.split('\n').filter(Boolean) : [];
  // One file at a time: at most one new file's bytes are in memory, and the budget is spent in the list's order.
  const counts = [];
  const budget = { left: COUNT_TOTAL };
  for (const p of fresh.slice(0, COUNT_MAX)) counts.push(budget.left ? await newLines(dir, p, budget) : 0);
  const born = fresh.map((p, i) => ({ path: p, added: counts[i] || 0, removed: 0, new: true }));
  const list = [...changed.map((x) => ({ ...x, new: false })), ...born];
  return {
    git: true, files: list.length, untracked: fresh.length,
    added: list.reduce((n, x) => n + x.added, 0), removed: changed.reduce((n, x) => n + x.removed, 0),
    list: list.slice(0, FILES_MAX),
  };
}
