// The walks of `hoprig pc leave --check` (leave.mjs) through what is in no git: the size of a folder, and a folder of
// --also (or of the workspace that no map names) looked through for git repositories and for folders in no git.
//
// Every walk shares one budget of entries and of time (a home or an old layout can hold millions of files): what is not
// finished within it is said as "at least <size>, not measured further", never as safe. Inside the dashboard's server
// the walk gives the one thread back the way needswalk.mjs does (every PIECE entries or SLICE_MS). A walk never follows
// a link, never enters `.git`, never counts what a build or an install makes again (dropsilent.mjs decides which names
// those are), and never enters a private folder (PRIVATE_DIRS), in any case of its name on every disk: a folder named
// NO-AI on a disk that does not fold case is still the owner's private folder by intent, and looking costs more than
// naming it.
import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_DIRS } from '../pcsetup/projects.mjs';
import { PIECE } from './needswalk.mjs';
import { isRebuiltName, isSystemFile } from './dropsilent.mjs';

const SLICE_MS = 20; // as needswalk.mjs: the thread is given back at least this often
/** The budget of a whole check when none is given: entries and milliseconds. */
export const DEFAULT_BUDGET = { entries: 300_000, ms: 30_000 };

/** A private folder's name (no-ai, ignore, ai-ignore-dir), in any case. */
export const isPrivateName = (name) => PRIVATE_DIRS.includes(String(name).toLowerCase());

/** One budget for a whole check. `tick()` before each entry: true once the entries or the time are used up. */
export function makeBudget({ entries = DEFAULT_BUDGET.entries, ms = DEFAULT_BUDGET.ms } = {}, clock = () => performance.now()) {
  const start = clock();
  let last = start;
  let count = 0;
  let out = false;
  return {
    get out() {
      return out;
    },
    async tick() {
      if (out) return true;
      if (++count > entries) return (out = true);
      if (count % PIECE === 0 || clock() - last >= SLICE_MS) {
        await new Promise((r) => setImmediate(r));
        last = clock();
        if (last - start > ms) out = true;
      }
      return out;
    },
  };
}

const list = (d) => {
  try {
    return fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return null;
  }
};
const sizeOfFile = (p) => {
  try {
    return fs.lstatSync(p).size;
  } catch {
    return 0;
  }
};

/**
 * The bytes and the number of files in `dir`, within the budget. `skip`: folders left out (repositories inside it,
 * checked on their own). → { size, files, done } (done false: the budget ran out, the numbers are a lower bound)
 */
export async function sizeOf(dir, budget, { skip = [] } = {}) {
  let size = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of list(d) || []) {
      if (await budget.tick()) return { size, files, done: false };
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || isPrivateName(e.name) || isRebuiltName(e.name) || skip.includes(p)) continue;
        stack.push(p);
      } else if (e.isFile() && !isSystemFile(e.name)) {
        size += sizeOfFile(p);
        files++;
      }
    }
  }
  return { size, files, done: true };
}

const CUT = Symbol('the budget ran out');

/**
 * Look through `top` for git repositories and for what is in no git. A repository is not walked into (its own check
 * walks it once, with the repositories inside it); a folder that holds no repository is one folder in no git, with
 * its size; a folder that holds one is split: each of its folders in no git, and its loose files as one more. `top`
 * itself is always split (the workspace, an old layout: what the owner decides about are the folders in it).
 * `stop(p)`: a folder not entered here (the owner's word, the credentials folder, one looked at in another way).
 * → { repos: [dir], plain: [{ dir, size, files, loose? }], privates: [dir], unreadable: [dir], cut: null | { size } }
 */
export async function lookThrough(top, budget, { stop = () => false } = {}) {
  const out = { repos: [], plain: [], privates: [], unreadable: [], cut: null };
  let seen = 0;
  // → null when `dir` is a boundary (a repository, a private, marked or unreadable folder, or one that holds such a
  // folder: its parts are listed on their own), else { size, files } of all of it.
  const visit = async (dir) => {
    if (stop(dir)) return null;
    const ents = list(dir);
    if (!ents) {
      out.unreadable.push(dir);
      return null;
    }
    if (ents.some((e) => e.name === '.git')) {
      out.repos.push(dir);
      return null;
    }
    const own = { size: 0, files: 0 };
    const kids = [];
    let split = false;
    for (const e of ents) {
      if (await budget.tick()) throw CUT;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isPrivateName(e.name)) {
          out.privates.push(p); // named, never entered
          split = true;
          continue;
        }
        if (isRebuiltName(e.name)) continue;
        const k = await visit(p);
        if (k === null) split = true;
        else kids.push([p, k]);
      } else if (e.isFile() && !isSystemFile(e.name)) {
        const n = sizeOfFile(p);
        own.size += n;
        own.files++;
        seen += n;
      }
      // A link is never followed and holds nothing of its own.
    }
    if (!split && dir !== top) return kids.reduce((a, [, k]) => ({ size: a.size + k.size, files: a.files + k.files }), own);
    for (const [p, k] of kids) if (k.files) out.plain.push({ dir: p, ...k });
    if (own.files) out.plain.push({ dir, ...own, loose: true });
    return null;
  };
  try {
    await visit(top);
  } catch (e) {
    if (e !== CUT) throw e;
    out.cut = { size: seen };
  }
  return out;
}

/**
 * The repositories inside the working tree of `repo` (not `repo` itself) and its private folders, within the budget:
 * what checkRepo needs to tell a repository inside from work, and what is checked on its own. Build output is not
 * walked (a repository there shows as part of the outer one's files). → { repos: [dir], privates: [dir], cut }
 */
export async function reposInside(repo, budget) {
  const out = { repos: [], privates: [], cut: false };
  const stack = [repo];
  while (stack.length) {
    const d = stack.pop();
    for (const e of list(d) || []) {
      if (await budget.tick()) {
        out.cut = true;
        return out;
      }
      if (!e.isDirectory() || e.name === '.git' || isRebuiltName(e.name)) continue;
      const p = path.join(d, e.name);
      if (isPrivateName(e.name)) {
        out.privates.push(p);
        continue;
      }
      if (fs.existsSync(path.join(p, '.git'))) out.repos.push(p);
      stack.push(p);
    }
  }
  out.repos.sort();
  return out;
}

// The home part's walker (leavehome.mjs): one walk of a folder's sizes within the look's budget, with a hook per
// file and per folder (the keys it hashes, the newest change of a database's data).
export { sizeWords } from './dropfind.mjs';
export const BUDGET = DEFAULT_BUDGET;

/**
 * A walker over one look's budget: { entries, ms } (BUDGET by default), `now` for the time. walk(top, { skip, onFile,
 * madeAgain }) → { size, files, done, unreadable, privates, opened }: `done` false when the budget ran out inside it,
 * `unreadable` the folders inside that could not be read, `opened` false when `top` itself could not be.
 * `skip`: a Set of absolute paths never entered; `onFile(abs, stat)`: each plain file; `onDir(abs, stat)`: each folder
 * entered; `madeAgain` (default true): leave
 * out build output and installs.
 */
export function makeWalker({ budget = {}, now = () => Date.now() } = {}) {
  const maxEntries = Number.isFinite(budget.entries) ? budget.entries : BUDGET.entries;
  const maxMs = Number.isFinite(budget.ms) ? budget.ms : BUDGET.ms;
  const start = now();
  let entries = 0;
  let spent = false;
  let last = performance.now();
  const over = () => spent || (spent = entries >= maxEntries || now() - start > maxMs);
  // A turn given back to the server's thread now and then.
  const turn = async () => {
    if (entries % PIECE !== 0 && performance.now() - last < SLICE_MS) return;
    await new Promise((r) => setImmediate(r));
    last = performance.now();
  };

  async function walk(top, { skip = new Set(), onFile = null, onDir = null, madeAgain = true } = {}) {
    const r = { size: 0, files: 0, done: true, unreadable: 0, privates: 0, opened: true };
    const stack = [top];
    while (stack.length) {
      const d = stack.pop();
      let dir;
      try {
        dir = fs.opendirSync(d, { bufferSize: 256 });
      } catch {
        if (d === top) r.opened = false;
        else r.unreadable++;
        continue;
      }
      try {
        for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
          if (over()) {
            r.done = false;
            return r;
          }
          entries++;
          await turn();
          const p = path.join(d, e.name);
          if (isPrivateName(e.name)) {
            r.privates++; // never entered, never looked through: as a folder or as a link
            continue;
          }
          if (skip.has(p)) continue;
          if (e.isSymbolicLink()) {
            r.files++;
            continue;
          }
          if (e.isDirectory()) {
            if (madeAgain && isRebuiltName(e.name)) continue;
            if (e.name === '.git') {
              r.size += statSize(p);
              continue;
            }
            if (onDir) {
              try {
                onDir(p, fs.lstatSync(p));
              } catch {
                /* gone since it was listed */
              }
            }
            stack.push(p);
            continue;
          }
          let st;
          try {
            st = fs.lstatSync(p);
          } catch {
            continue;
          }
          if (!st.isFile()) continue;
          r.files++;
          r.size += st.size;
          if (onFile) onFile(p, st);
        }
      } finally {
        dir.closeSync();
      }
    }
    return r;
  }
  return { walk, spent: () => over() };
}

const statSize = (p) => {
  try {
    return fs.lstatSync(p).size;
  } catch {
    return 0;
  }
};
