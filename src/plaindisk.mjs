// What rm would really get for one target of a plain delete (asking.mjs plainDelete), read on disk: the paths the shell
// hands to rm, not the text before the first glob. Only node: imports: the hook loads this for an ask in bypass mode.
// Here a wrong answer is Hoprig's own "allow", so wherever something cannot be told, it is no plain delete.
import fs from 'node:fs';
import path from 'node:path';

// How much the look may read for one line: over any of it, the line is no plain delete.
export const LOOK = Object.freeze({ entries: 20000, folders: 2000, ms: 250 });

/** A budget for one line: shared by all its targets (and the mount table, read once per line). */
export const newBudget = () => ({ entries: LOOK.entries, folders: LOOK.folders, steps: LOOK_STEPS, until: Date.now() + LOOK.ms, mounts: undefined });
// The steps all glob matching of one line may take, and one match against one name (a pattern with several * against a
// long name): over either, no plain delete.
const LOOK_STEPS = 2_000_000;
const MATCH_STEPS = 4_000;
// The clock: looked at in every loop of the look, not only while a folder is read.
const late = (budget) => Date.now() > budget.until;

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

class NotPlain extends Error {}
const no = () => {
  throw new NotPlain();
};

/**
 * Is target `rest` (its part after `cwd`, as written, quotes taken off; asking.mjs has read it: a plain name first, no
 * . or .. part, no glob in a part that begins with a dot) plainly inside `cwd` on disk? It is expanded part by part, as
 * a superset of what bash could hand to rm under any of its options: * and ? (no other glob sign gets this far), a
 * leading dot matched too (dotglob) and case not counted (nocaseglob), with every folder read entry by entry under
 * `budget`, names as bytes. No when:
 *   - a glob could reach an entry named .git (any case);
 *   - a part on the way is a symbolic link and the path goes on after it (more parts, or a slash at the end: GNU rm
 *     then deletes what the link leads to). `rm -rf link` alone removes only the link and stays plain;
 *   - a path rm gets is, by its real place, not inside the real `cwd`;
 *   - a path rm gets, or a folder below it, is on another file system than `cwd`, or a mount point is at it, below it
 *     or on the way to it (on Linux the mount table is read once per line, so a bind of the same file system is seen
 *     too; elsewhere only the device);
 *   - a folder between `cwd` and a path rm gets, or that path's own parent, is a git folder (HEAD with objects or
 *     commondir, each of any kind): the inside of a bare repository, of a separate git folder or a worktree's own;
 *   - a path rm gets is a folder that is a repository (an entry .git in any letter case, or a git folder) or holds
 *     one anywhere below it, as far as the budget reaches;
 *   - a name the look reads is not valid UTF-8 (bash matches it, the look could not read it as text), or a pattern part
 *     with ? meets a folder that holds a name with a byte over 127 (? is one character for bash, or one byte);
 *   - the budget runs out.
 * A pattern that matches nothing is plain: there is nothing to delete.
 */
export function plainOnDisk(cwd, rest, budget) {
  try {
    return look(cwd, rest, budget);
  } catch (e) {
    if (e instanceof NotPlain) return false;
    throw e;
  }
}

function look(cwd, rest, budget) {
  const trailing = rest.endsWith('/');
  const parts = rest.split('/');
  if (trailing) parts.pop();
  if (parts.some((p) => p.includes('**'))) return false; // zsh, and bash with globstar, read ** at any depth
  let top;
  try {
    top = fs.statSync(cwd);
  } catch {
    return true; // no folder: nothing in it to delete
  }
  const realCwd = real(cwd);
  if (!realCwd) return false;
  budget.dev = top.dev;
  let level = [cwd];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const goesOn = !last || trailing;
    const next = [];
    for (const dir of level) {
      if (gitFolder(dir)) return false; // a folder on the way, or the path's own parent, is a git folder
      let names = [parts[i]];
      if (/[*?]/.test(parts[i])) {
        const entries = readFolder(dir, budget);
        if (parts[i].includes('?') && entries.some((e) => e.wide)) return false;
        // A superset of what any option of the shell could hand to rm (the shell a coding tool starts replays the
        // owner's own shopt lines): * and ? match a leading dot too (dotglob), and case does not count (nocaseglob).
        const pat = parts[i].toLowerCase();
        names = [];
        for (const e of entries) {
          if (late(budget)) no();
          if (globMatch(pat, e.name.toLowerCase(), budget)) names.push(e.name);
        }
      }
      for (const n of names) {
        if (late(budget)) no();
        if (n.toLowerCase() === '.git') return false; // a glob that could reach a repository's own history
        const p = path.join(dir, n);
        let st;
        try {
          st = fs.lstatSync(p);
        } catch {
          continue; // nothing there
        }
        if (st.isSymbolicLink()) {
          if (goesOn) return false;
          continue; // rm removes the link itself
        }
        if (st.dev !== top.dev) return false;
        if (!last) {
          if (st.isDirectory()) next.push(p);
          continue;
        }
        const r = real(p);
        if (!r || !r.startsWith(`${realCwd}/`)) return false;
        if (mountNear(r, realCwd, budget)) return false;
        if (st.isDirectory() && holdsRepository(p, budget)) return false;
      }
    }
    level = next;
  }
  return true;
}

// A git folder: an entry HEAD of any kind (a link too) with an entry objects of any kind (a link to a store elsewhere
// too: git follows it), or with commondir (a worktree's own git folder, which keeps no objects).
const isEntry = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
export function gitFolder(dir) {
  return isEntry(path.join(dir, 'HEAD')) && (isEntry(path.join(dir, 'objects')) || isEntry(path.join(dir, 'commondir')));
}

// Folder `dir`'s entries, read one by one under the budget, names as bytes: [{ name, dir, wide }] (wide: a byte over
// 127). Over the budget, unreadable, or a name that is not valid UTF-8: no plain delete.
function readFolder(dir, budget) {
  if (--budget.folders < 0 || Date.now() > budget.until) no();
  let d;
  try {
    d = fs.opendirSync(dir, { encoding: 'buffer' });
  } catch {
    no();
  }
  const out = [];
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if (--budget.entries < 0 || ((budget.entries & 255) === 0 && Date.now() > budget.until)) no();
      const name = e.name.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(e.name)) no();
      out.push({ name, isDir: e.isDirectory(), wide: e.name.some((b) => b > 127) });
    }
  } catch (err) {
    if (err instanceof NotPlain) throw err;
    no();
  } finally {
    try {
      d.closeSync();
    } catch {
      /* closed */
    }
  }
  return out;
}

// Is `dir` a repository, or does it hold one anywhere below it, within the budget? Links are not followed (rm removes a
// link, not what it leads to); a folder on another device is no plain delete either.
function holdsRepository(dir, budget) {
  let level = [dir];
  while (level.length) {
    const next = [];
    for (const d of level) {
      let st;
      try {
        st = fs.lstatSync(d);
      } catch {
        return true;
      }
      if (st.dev !== budget.dev) return true;
      const entries = readFolder(d, budget);
      // An entry .git in any letter case (a disk may not tell .GIT from .git), or a git folder's HEAD with objects or
      // commondir, each of any kind (gitFolder).
      if (late(budget)) return true;
      if (entries.some((e) => e.name.toLowerCase() === '.git')) return true;
      if (entries.some((e) => e.name === 'HEAD') && entries.some((e) => e.name === 'objects' || e.name === 'commondir')) return true;
      for (const e of entries) if (e.isDir) next.push(path.join(d, e.name));
    }
    level = next;
  }
  return false;
}

// Is a mount point below `realCwd` at `realPath`, below it, or between the two (a path inside a mount: a bind of the
// same file system leads elsewhere)? The mounts `realCwd` itself is on do not count. Linux: the mount table, read once
// per line; elsewhere there is none to read and the device checks stand alone.
function mountNear(realPath, realCwd, budget) {
  if (budget.mounts === undefined) budget.mounts = readMounts();
  if (budget.mounts === null) return false;
  return budget.mounts.some((m) => m.startsWith(`${realCwd}/`) && (m === realPath || m.startsWith(`${realPath}/`) || realPath.startsWith(`${m}/`)));
}

function readMounts() {
  if (process.platform !== 'linux') return null;
  let text;
  try {
    text = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return [];
  }
  // The fifth field is the mount point, with space, tab, newline and backslash written as \040, \011, \012, \134.
  return text.split('\n').filter(Boolean).map((l) => l.split(' ')[4]).filter(Boolean).map((m) => m.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))));
}

// Does `name` match `pat` (only * and ? are special)? One pass with the last star to go back to: no backtracking
// beyond it, so the time is at most the product of the two lengths, and with a budget at most MATCH_STEPS steps (over
// them, and over the line's steps, no plain delete).
export function globMatch(pat, name, budget = null) {
  let p = 0;
  let n = 0;
  let star = -1;
  let mark = 0;
  let steps = 0;
  while (n < name.length) {
    if (budget && (++steps > MATCH_STEPS || --budget.steps < 0)) no();
    if (p < pat.length && pat[p] === '*') {
      star = p++;
      mark = n;
    } else if (p < pat.length && (pat[p] === '?' || pat[p] === name[n])) {
      p++;
      n++;
    } else if (star >= 0) {
      p = star + 1;
      n = ++mark;
    } else return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}
