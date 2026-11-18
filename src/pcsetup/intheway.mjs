// What a merge or a rebase would delete, or refuse over. A group's repository ignores its members and a project's parent its code/
// folder; each is a repository of its own there. When the other side's commits start to track a path over one of them,
// a plain merge or rebase replaces it (its work and commits gone) without a word: git's --no-overwrite-ignore guards
// only a fast-forward (FAST_FORWARD in workspace.mjs), a real merge and a rebase ignore it. So before Hoprig suggests
// either for a branch that has moved on both sides, it asks git what the other side would put here. Only what git
// ignores is deleted: over an untracked path it does not ignore, git refuses the merge or the rebase instead.
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';

const exists = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/**
 * The paths the other side (`ref`) changed since the two parted that this repository's HEAD does not track and that are
 * on disk here (or a file here that sits where the other side needs a folder), as { deleted, refused }: those git
 * ignores (a merge or a rebase deletes them) and the others (git refuses over them until they are moved), each
 * 'builds/acme, …' or ''. Both '' when nothing is in the way or git could not be asked. Read-only, through gitRead.
 */
export async function inTheWay(dir, ref, run = capture) {
  const none = { deleted: '', refused: '' };
  const split = (r) => (r.ok ? r.stdout.split('\0').filter(Boolean) : null);
  const theirs = split(await gitRead(dir, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=d', '--merge-base', 'HEAD', ref], { run }));
  const status = split(await gitRead(dir, ['diff', '--name-status', '-z', '--no-renames', 'HEAD', ref], { run }));
  if (!theirs || !status) return none;
  const added = new Set(); // in their commit, not in HEAD
  const gone = new Set(); // in HEAD, not in their commit (a file of HEAD where they have a folder)
  for (let i = 0; i + 1 < status.length; i += 2) {
    if (status[i] === 'A') added.add(status[i + 1]);
    else if (status[i] === 'D') gone.add(status[i + 1]);
  }
  const hits = new Set();
  for (const rel of theirs.filter((p) => added.has(p))) {
    if (exists(path.join(dir, rel))) {
      hits.add(rel);
      continue;
    }
    const parts = rel.split('/');
    for (let k = 1; k < parts.length; k++) {
      const up = parts.slice(0, k).join('/');
      const st = exists(path.join(dir, up));
      if (!st) break;
      if (!st.isDirectory() && !gone.has(up)) {
        hits.add(up);
        break;
      }
    }
  }
  const all = [...hits].sort();
  if (!all.length) return none;
  // Which of them git ignores (a folder comes back with a slash). Not known: all counted as deleted, the safe words.
  const ig = split(await gitRead(dir, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--', ...all.map((p) => `:(literal)${p}`)], { run }));
  const ignored = new Set((ig || all).map((p) => p.replace(/\/$/, '')));
  const list = (xs) => (xs.length > 5 ? `${xs.slice(0, 5).join(', ')} and ${xs.length - 5} more` : xs.join(', '));
  return { deleted: list(all.filter((p) => ignored.has(p))), refused: list(all.filter((p) => !ignored.has(p))) };
}

/**
 * The words that follow "have both moved (…)" when something is in the way (inTheWay), or '' when nothing is.
 * `whose`: "the server's commits" or "those commits".
 */
export function inTheWayWords(hit, whose) {
  const it = (l) => (l.includes(', ') || / more$/.test(l) ? 'them' : 'it');
  const they = (l) => (it(l) === 'it' ? 'it is' : 'they are');
  const { deleted: d, refused: r } = hit;
  if (!d && !r) return '';
  const lost = d ? `put files where ${d} is here, which this repository does not track (another repository, perhaps): a merge or a rebase would delete ${it(d)}` : '';
  const stuck = `${d ? 'and where' : 'put files where'} ${r} is here, which this repository does not track: ${they(r)} in the way, and git refuses a merge or a rebase until ${they(r)} moved away`;
  return `, and ${whose} ${d && r ? `${lost}; ${stuck}; move both away first` : d ? `${lost}; move ${it(d)} away first` : `${stuck}; move ${it(r)} away first`}, then`;
}
