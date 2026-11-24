// What changed in a session's folder, for the session rail's Changes card (+N −M, as the desktop app's): the files
// git sees changed against the last commit, staged or not, with their added and removed lines, and the new files it
// does not track yet, whose lines count as added. Only the session's own folder: in a subfolder of a repository both
// lists are of that folder and name its files from it (nothing beside it is counted or named). Every git read goes
// through gitread.mjs, so a repository's own settings never start a program for it; a new file's lines are counted
// here, from the file itself, never through a filter.
import fs from 'node:fs/promises';
import path from 'node:path';
import { isGitName, isPrivateName } from '../editor/paths.mjs';
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
    // --no-renames: a moved file is its old name removed and its new name added, each a real path the pane can open
    // (with rename detection git names it "old.js => new.js", which is no file).
    read(['-c', 'core.quotepath=false', 'diff', '--numstat', '--no-renames', '--relative', ...(head.ok ? ['HEAD'] : ['--cached'])]),
    read(['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']),
  ]);
  if (!diff.ok) return { git: false };
  // A private folder (and git's own) is never shown, as in the editor: it is left out of the list and its lines.
  const changed = diff.stdout.split('\n').map(numstatLine).filter((x) => x && shownPath(x.path));
  const fresh = others.ok ? others.stdout.split('\n').filter((p) => p && shownPath(p)) : [];
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

const DIFF_LINES = 5000; // lines of one file's diff the pane gets; past it, the editor's Changes view has the rest

/** Not in a private folder or git's own at any depth: the editor never opens those (editor/paths.mjs segments). */
const shownPath = (p) => !p.split('/').some((x) => isPrivateName(x) || isGitName(x));

/**
 * A file name from the page, as git names it from the folder: relative, no "..", no control character, not in a
 * private folder or .git; else null.
 */
export function changedPath(p) {
  if (typeof p !== 'string' || !p || p.length > 1000 || /[\x00-\x1f\x7f]/.test(p) || p.includes('\\')) return null;
  if (path.posix.isAbsolute(p) || p.split('/').some((x) => x === '..' || x === '.' || x === '')) return null;
  return shownPath(p) ? p : null;
}

/** Hunks of git's unified diff text: [{ oldStart, newStart, lines: [" a", "-b", "+c"] }]; `cut` past `max` lines. */
export function parseUnified(text, max = DIFF_LINES) {
  const hunks = [];
  let cur = null;
  let n = 0;
  let cut = false;
  for (const l of String(text).split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) {
      cur = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] };
      hunks.push(cur);
    } else if (cur && (l[0] === ' ' || l[0] === '-' || l[0] === '+')) {
      if (n >= max) {
        cut = true;
        break;
      }
      cur.lines.push(l);
      n++;
    }
  }
  return { hunks, cut };
}

/**
 * One changed file's diff in folder `dir`, for the App's diff pane: { path, new, binary, hunks, cut } (a new file
 * that git does not track yet: all its lines added), or null when the file has no change (or is not the folder's).
 * Through gitread.mjs as every read of the folder; a new file is read here, without following a link out of it.
 */
export async function fileDiff(dir, p, o = {}) {
  const rel = changedPath(p);
  if (!rel) return null;
  const read = (args) => gitRead(dir, args, o.run ? { run: o.run } : {});
  const head = await read(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const d = await read(['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--no-color', '--no-renames', '--unified=3', '--relative', ...(head.ok ? ['HEAD'] : ['--cached']), '--', rel]);
  if (!d.ok) return null;
  if (d.stdout.trim()) {
    if (/^Binary files /m.test(d.stdout) && !/^@@/m.test(d.stdout)) return { path: rel, new: false, binary: true, hunks: [], cut: false };
    return { path: rel, new: false, binary: false, ...parseUnified(d.stdout) };
  }
  const others = await read(['--literal-pathspecs', '-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard', '--', rel]);
  if (!others.ok || !others.stdout.split('\n').includes(rel)) return null;
  try {
    const full = path.join(dir, rel);
    const st = await fs.lstat(full);
    if (!st.isFile() || st.size > COUNT_BYTES) return { path: rel, new: true, binary: true, hunks: [], cut: false };
    const buf = await fs.readFile(full);
    if (buf.includes(0)) return { path: rel, new: true, binary: true, hunks: [], cut: false };
    const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
    const shown = lines.slice(0, DIFF_LINES);
    return { path: rel, new: true, binary: false, hunks: buf.length ? [{ oldStart: 0, newStart: 1, lines: shown.map((l) => `+${l}`) }] : [], cut: lines.length > shown.length };
  } catch {
    return null;
  }
}
