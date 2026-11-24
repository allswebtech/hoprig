// The box (docs/BOX.md): nothing written inside runs later outside by the product's own hand. A git
// repository's hooks and configuration start programs when git runs there afterwards, so the `.git` of a write folder
// is read-only inside. A worktree's `.git` is a file naming its git folder (and that one names the common folder in
// `commondir`): those are read-only too when they lie inside a named folder (outside one they are not there at all).
// A `.git` deeper inside a write folder is not covered (docs/BOX.md says so).
import fs from 'node:fs';
import path from 'node:path';

const within = (p, dirs) => dirs.some((d) => p === d || p.startsWith(d.endsWith('/') ? d : d + '/'));

function realOr(p, real) {
  try {
    return real(p);
  } catch {
    return null;
  }
}

/** The git folder a worktree's `.git` file names, resolved, or null. */
function namedGitDir(file, read, real) {
  let text;
  try {
    text = read(file, 'utf8');
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  return m ? realOr(path.resolve(path.dirname(file), m[1]), real) : null;
}

/**
 * The paths to bind read-only over the write folders: each `.git` of a write folder, and for a worktree the git folder
 * and the common folder it names when those are inside a named folder (`named`: every write and read folder).
 */
export function gitGuards(write, named, { lstat = fs.lstatSync, real = fs.realpathSync, read = fs.readFileSync } = {}) {
  const out = [];
  const add = (p) => p && within(p, named) && !out.includes(p) && out.push(p);
  for (const w of write) {
    const dotgit = path.join(w, '.git');
    let st;
    try {
      st = lstat(dotgit);
    } catch {
      continue; // no .git: nothing is added
    }
    if (st.isSymbolicLink()) {
      // A link leads nowhere inside unless its target is in a named folder: then that target is what git uses.
      add(realOr(dotgit, real));
      continue;
    }
    if (!out.includes(dotgit)) out.push(dotgit);
    if (!st.isFile()) continue;
    const gitdir = namedGitDir(dotgit, read, real);
    if (!gitdir) continue;
    add(gitdir);
    let common = null;
    try {
      common = realOr(path.resolve(gitdir, read(path.join(gitdir, 'commondir'), 'utf8').trim()), real);
    } catch {
      /* no common folder named */
    }
    add(common);
  }
  return out;
}
