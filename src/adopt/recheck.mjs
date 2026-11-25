// retire's own check, made right before anything of an original is removed: it trusts nothing that was said before
// (not the plan, not apply's proof, not the fingerprint). It finds the repositories in the original folder itself and
// compares the original with its copy again: HEAD, every branch, tag and other ref, each stash entry, every linked
// worktree, and every working file by its content. What is in the original and not in the copy stops retire, with one
// line that counts each kind, and nothing is removed. So a mistake in a plan or a copy can never become a loss.
//
// "In the copy" means: the copy holds the same thing, or (for a ref) a newer commit that has the original's as its
// ancestor (work done in the copy since loses nothing of the original). A working file must be in the copy with the
// same content: a file changed in the copy since is counted too (Hoprig cannot tell which version he wants to keep).
// Read only: git is asked through the reader, files are listed and read. A private folder is never entered: retire
// keeps it where it is anyway.
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { commonDir, worktreesOf } from './scan.mjs';
import { isPrivate, movedPath, nameOf, treeOf } from './proof.mjs';

const MAX_DIRS = 200_000;
const GIT_ONLY = new Set(['.git']); // a git folder is compared by its refs and stash, not file by file
const KINDS = [
  ['repos', 'repository whose history is not in the copy', 'repositories whose history is not in the copy'],
  ['head', 'checked-out commit', 'checked-out commits'],
  ['branches', 'branch', 'branches'],
  ['tags', 'tag', 'tags'],
  ['refs', 'other ref', 'other refs'],
  ['stash', 'stash entry', 'stash entries'],
  ['worktrees', 'worktree', 'worktrees'],
  ['files', 'working file', 'working files'],
  ['unreadable', 'thing Hoprig could not read', 'things Hoprig could not read'],
];

const read = async (dir, args) => {
  const r = await gitRead(dir, args, { timeout: 60_000 });
  return r.ok ? r.stdout : null;
};
const has = async (dir, id) => Boolean(id) && (await read(dir, ['rev-parse', '--verify', '--quiet', `${id}^{commit}`])) !== null;
/** The commits of a repository's stash entries, from its stash log (read as a file: nothing is run). */
function stashIds(common) {
  if (!common) return [];
  try {
    return fs.readFileSync(path.join(common, 'logs', 'refs', 'stash'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')[1]);
  } catch {
    return [];
  }
}
const within = (p, d) => p === d || p.startsWith(d + path.sep);

/**
 * Every folder at or below `root` that holds a ".git" (a folder or a file), never into a private folder or a git
 * folder. Names are read as bytes: one that is not UTF-8 cannot be given to git, so such a repository is counted as
 * unreadable instead. → { repos: [path], unreadable: n }
 */
export function gitFoldersIn(root) {
  const repos = [];
  let unreadable = 0;
  let seen = 0;
  const walk = (d) => {
    if (++seen > MAX_DIRS) return void unreadable++;
    let list;
    try {
      list = fs.readdirSync(d, { withFileTypes: true, encoding: 'buffer' });
    } catch {
      return void unreadable++;
    }
    for (const e of list) {
      const name = nameOf(e.name);
      if (name === '.git') {
        const s = d.toString('utf8');
        if (Buffer.from(s, 'utf8').equals(d)) repos.push(s);
        else unreadable++;
        continue;
      }
      if (e.isDirectory() && !isPrivate(name)) walk(Buffer.concat([d, Buffer.from(path.sep), e.name]));
    }
  };
  try {
    if (fs.lstatSync(root).isDirectory()) walk(Buffer.from(root));
  } catch {
    /* not there */
  }
  return { repos, unreadable };
}

/** The working entries of one listing that must be in the other: files by content, links by their text. */
function working(listing) {
  const out = new Map();
  for (const [rel, v] of Object.entries(listing.entries)) {
    if (rel.split('/').includes('.git') || v.startsWith('private folder') || v.startsWith('dir ') || v.startsWith('other ')) continue;
    out.set(rel, v.startsWith('file ') ? `file ${v.split(' ').pop()}` : v);
  }
  return out;
}

/**
 * How many working entries of the original `from` are not in `to` as they are (missing, or another content). `leave`:
 * the folders apply left out (installed packages, build output) that retire found again just now as made again: not
 * listed, so what is in them is not counted.
 */
function filesMissing(from, to, leave = null) {
  let st;
  try {
    st = fs.lstatSync(from);
  } catch {
    return { missing: 0, unreadable: 0 };
  }
  if (!st.isDirectory()) {
    try {
      return { missing: fs.readFileSync(from).equals(fs.readFileSync(to)) ? 0 : 1, unreadable: 0 };
    } catch {
      return { missing: 1, unreadable: 0 };
    }
  }
  const a = working(treeOf(from, { skipDirs: GIT_ONLY, leave }));
  const b = working(treeOf(to, { skipDirs: GIT_ONLY }));
  let missing = 0;
  let unreadable = 0;
  for (const [rel, v] of a) {
    if (v.startsWith('unreadable')) unreadable++;
    else if (b.get(rel) !== v) missing++;
  }
  return { missing, unreadable };
}

/**
 * Compare the originals that retire would remove (`go`) with their copies. `pairs`: [original, copy] of every copy
 * apply recorded. `root`: the old project folder (its repositories are found in it again). → { ok, counts, words }
 */
export async function recheck({ root, go, pairs, leave = null }) {
  const counts = Object.fromEntries(KINDS.map(([k]) => [k, 0]));
  const map = pairs.filter(([f, t]) => f && t);
  const copyOf = (p) => {
    const c = movedPath(p, map);
    return c === p ? null : c;
  };
  // Every path that goes must be one apply copied.
  for (const g of go) if (!copyOf(g)) counts.repos++;
  // The working files of each path that goes, by their content.
  for (const g of go) {
    const c = copyOf(g);
    if (!c) continue;
    const f = filesMissing(g, c, leave);
    counts.files += f.missing;
    counts.unreadable += f.unreadable;
  }
  // The repositories in the original, found again: each one that a path that goes touches.
  const found = gitFoldersIn(root);
  counts.unreadable += found.unreadable;
  // A repository whose folder goes (its .git with it). One that holds what goes and stays itself (a parent's own
  // history) loses nothing of its history; the files that go out of it are compared above.
  const touched = (r) => go.some((g) => within(r, g));
  for (const r of found.repos.filter(touched)) {
    const c = copyOf(r);
    let ownGit = false;
    try {
      ownGit = fs.lstatSync(path.join(r, '.git')).isDirectory();
    } catch {
      /* gone */
    }
    if (!c || !fs.existsSync(path.join(c, '.git'))) {
      counts.repos++;
      continue;
    }
    const head = ((await read(r, ['rev-parse', '--verify', '--quiet', 'HEAD'])) || '').trim();
    if (head && !(await has(c, head))) counts.head++;
    if (!ownGit) continue; // a linked worktree or a submodule: its refs are its repository's, checked there
    const refs = await read(r, ['for-each-ref', '--format=%(objectname) %(refname)']);
    if (refs === null) {
      counts.unreadable++;
      continue;
    }
    for (const line of refs.split('\n').filter(Boolean)) {
      const i = line.indexOf(' ');
      const id = line.slice(0, i);
      const name = line.slice(i + 1);
      if (name === 'refs/stash') continue; // each entry of the stash is checked below
      const kind = name.startsWith('refs/heads/') ? 'branches' : name.startsWith('refs/tags/') ? 'tags' : 'refs';
      const now = ((await read(c, ['rev-parse', '--verify', '--quiet', name])) || '').trim();
      if (now === id) continue;
      if (now && (await has(c, id)) && (await gitRead(c, ['merge-base', '--is-ancestor', id, now], { timeout: 60_000 })).ok) continue;
      counts[kind]++;
    }
    const common = commonDir(r);
    // A stash entry is in the copy only as an entry of the copy's own stash: a dropped one leaves its commit behind as
    // a loose object, so "the copy has this commit" would still say yes.
    const theirs = new Set(stashIds(commonDir(c)));
    for (const id of stashIds(common)) if (!theirs.has(id)) counts.stash++;
    for (const w of worktreesOf(common)) {
      const cw = copyOf(w);
      if (!cw || !fs.existsSync(cw)) {
        counts.worktrees++;
        continue;
      }
      const wh = ((await read(w, ['rev-parse', '--verify', '--quiet', 'HEAD'])) || '').trim();
      if (wh && !(await has(cw, wh))) counts.head++;
    }
  }
  const parts = KINDS.filter(([k]) => counts[k]).map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`);
  const ok = !parts.length;
  return {
    ok,
    counts,
    words: ok
      ? 'checked again just now: everything in the originals is in their copies (every commit, branch, tag, stash entry, worktree and working file)'
      : `the originals hold what their copies do not: ${parts.join(', ')}. Nothing is removed. Look with hoprig adopt verify, and keep the old folders until the copy holds everything`,
  };
}
