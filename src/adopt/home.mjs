// Look over the home folder ("Find the projects on this computer" on the Workspace page, POST /api/adopt/home): which
// folders of the home are projects, on the owner's press only and within a budget. It reads folder names and nothing
// else: a folder is a project when it holds a `.git` or a project's own sign (SIGNS, SIGN_ENDINGS of scan.mjs). It opens
// no file, runs no git and no program, and does not go into a project it found. It never enters a hidden folder (a name
// with a dot first: .config, .local, .cache, the coding tools' own folders), installed packages and build output
// (SKIP_DIRS), a private folder (PRIVATE_DIRS, counted, never named), the folders it is told to skip (the workspace,
// Hoprig's settings and state, the coding tool's folder) or the system's own places in a home (SYSTEM_PLACES). A link
// is named and never followed; a folder it cannot read is counted, not named.
//
// What it finds is then looked at by the same scan as a folder the owner names (scan.mjs scanPlaces), so each project
// gets the same facts and, on his press, the same plan and arrange.
import fs from 'node:fs';
import path from 'node:path';
import { PRIVATE_DIRS } from '../pcsetup/projects.mjs';
import { SIGNS, SIGN_ENDINGS, SKIP_DIRS, scanPlaces } from './scan.mjs';

/** How far a look over the home goes: levels below the home, folders read, time, projects found. */
export const BUDGET = { depth: 4, folders: 20_000, ms: 20_000, projects: 100 };

/**
 * The system's own places in a home, as paths below it: programs, media and package caches, never a project of the
 * owner's. Hidden folders (.local, .cache, .config, .Trash, …) are never entered anyway.
 */
export const SYSTEM_PLACES = {
  linux: ['snap', 'Music', 'Pictures', 'Videos', 'go/pkg', 'miniconda3', 'anaconda3'],
  darwin: ['Library', 'Applications', 'Movies', 'Music', 'Pictures', 'Public', 'go/pkg', 'miniconda3', 'anaconda3'],
  win32: ['AppData', 'Application Data', 'Local Settings', 'Music', 'Pictures', 'Videos', 'Saved Games', 'Searches', 'Favorites', 'Links', 'Contacts', 'go/pkg', 'miniconda3', 'anaconda3'],
};
export const systemPlaces = (platform = process.platform) => SYSTEM_PLACES[platform] || SYSTEM_PLACES.linux;

const isPrivate = (name) => PRIVATE_DIRS.includes(name) || PRIVATE_DIRS.includes(name.toLowerCase());
/** The real path of `p` (links resolved), or `p` itself when it cannot be had (a folder not made yet). */
const realOf = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const hasSign = (names) => names.some((n) => SIGNS.includes(n) || SIGN_ENDINGS.some((e) => n.endsWith(e)));

/**
 * Look over `home` level by level (the nearest projects first, so a budget that ends early has found those).
 * `skip`: absolute folders never entered. `projects`: the workspace's projects folder, whose folders are counted as
 * already arranged. `budget`: parts of BUDGET to change (tests). `clock`: the time (tests).
 * → { found: [{ dir, depth, repo }], folders, unreadable, privates, links: [path], inWorkspace, ended }: `ended` is
 * null when the whole home was looked at, else 'depth', 'folders', 'time' or 'projects'.
 */
export async function lookHome({ home, skip = [], projects = null, platform = process.platform, budget = {}, clock = Date.now } = {}) {
  const b = { ...BUDGET, ...budget };
  const root = path.resolve(home);
  const fold = platform === 'darwin' || platform === 'win32';
  const key = (p) => (fold ? p.toLowerCase() : p);
  // A home or a skipped folder may be spelled through a link (a linked home folder, /var and /private/var on a Mac):
  // each folder to skip is kept as given and by its real path, and each folder of the home is checked by both its
  // spelling and its real path. The look never follows a link, so a folder's real path is the home's real path and
  // the same steps below it.
  const realRoot = realOf(root);
  const given = [...skip.filter(Boolean).map((p) => path.resolve(p)), ...systemPlaces(platform).map((r) => path.join(root, r))];
  const never = new Set([...given, ...given.map(realOf)].map(key));
  const skipped = (p) => never.has(key(p)) || never.has(key(path.join(realRoot, path.relative(root, p))));
  const out = { found: [], folders: 0, unreadable: 0, privates: 0, links: [], inWorkspace: 0, ended: null };
  const start = clock();
  let deeper = 0;
  let level = [root];
  for (let depth = 0; level.length && !out.ended; depth++) {
    const next = [];
    for (const dir of level) {
      if (out.folders + out.unreadable >= b.folders) out.ended = 'folders';
      else if (clock() - start >= b.ms) out.ended = 'time';
      if (out.ended) break;
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        out.unreadable++;
        continue;
      }
      out.folders++;
      entries.sort((x, y) => x.name.localeCompare(y.name));
      const names = entries.map((e) => e.name);
      if (depth > 0 && (names.includes('.git') || hasSign(names))) {
        out.found.push({ dir, depth, repo: names.includes('.git') });
        if (out.found.length >= b.projects) out.ended = 'projects';
        continue; // a project is not gone into
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) out.links.push(p);
        else if (!e.isDirectory() || SKIP_DIRS.has(e.name) || skipped(p)) continue;
        else if (isPrivate(e.name)) out.privates++;
        else if (depth + 1 > b.depth) deeper++;
        else next.push(p);
      }
    }
    level = next;
  }
  if (!out.ended && deeper) out.ended = 'depth';
  if (projects) {
    try {
      out.inWorkspace = (await fs.promises.readdir(projects, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).length;
    } catch {
      /* no projects folder yet */
    }
  }
  return out;
}

/**
 * Which places the scan looks in, and which of their folders it takes (scanPlaces' `only`). A repository found below
 * a usual place's folder (~/code/blog/web) belongs to the project folder directly in that place (~/code/blog), as a
 * look in ~/code would show it; anything else found is a project of its own in its parent folder. A folder inside
 * another one taken is not taken again. → [{ dir, only: [dir] }]
 */
export function placesOf(found, usual = []) {
  const ups = usual.map((u) => path.resolve(u));
  const chosen = found.map((f) => {
    const u = f.repo && ups.find((x) => f.dir.startsWith(x + path.sep) && path.relative(x, f.dir).split(path.sep).length > 1);
    return u ? path.join(u, path.relative(u, f.dir).split(path.sep)[0]) : f.dir;
  });
  const uniq = [...new Set(chosen)];
  const kept = uniq.filter((d) => !uniq.some((o) => o !== d && d.startsWith(o + path.sep)));
  const groups = new Map();
  for (const d of kept) groups.set(path.dirname(d), [...(groups.get(path.dirname(d)) || []), d]);
  return [...groups].map(([dir, only]) => ({ dir, only: only.sort() })).sort((x, y) => x.dir.localeCompare(y.dir));
}

const n = (x) => x.toLocaleString('en-US');
/** What ended the look, in the page's words (`ended` of lookHome; `b`: the budget it had). */
export function endedWords(ended, b = BUDGET) {
  const byHand = 'A project it did not reach is found when you name its folder in "Look in other folders".';
  if (ended === 'depth') return `It looked ${b.depth} levels down from your home folder and no deeper. ${byHand}`;
  if (ended === 'folders') return `It stopped after ${n(b.folders)} folders, before the end of your home folder. ${byHand}`;
  if (ended === 'time') return `It stopped after ${Math.round(b.ms / 1000)} seconds, before the end of your home folder. ${byHand}`;
  if (ended === 'projects') return `It stopped at ${b.projects} projects. ${byHand}`;
  return 'It looked through your whole home folder.';
}

/**
 * The look over the home, then the same scan as for a folder the owner names, of what it found. `usual`: the usual
 * places (cli.mjs usualPlaces). → { places, projects, privates } as scanPlaces answers, and `home`: what the look did.
 */
export async function findHome({ home, skip = [], projects = null, usual = [], platform = process.platform, budget = {}, clock = Date.now, run } = {}) {
  const b = { ...BUDGET, ...budget };
  const look = await lookHome({ home, skip, projects, platform, budget: b, clock });
  // The privates are the look's count: the scan lists the same folders again and would count them twice.
  const out = { places: [], projects: [], privates: look.privates };
  for (const p of placesOf(look.found, usual)) {
    const r = await scanPlaces([p.dir], { run, only: new Set(p.only) });
    out.places.push(...r.places);
    out.projects.push(...r.projects);
  }
  out.projects.sort((x, y) => x.name.localeCompare(y.name) || x.dir.localeCompare(y.dir)); // one list, by name
  const { ended, folders, unreadable, links, inWorkspace } = look;
  return { ...out, home: { ended, words: endedWords(ended, b), folders, unreadable, privates: look.privates, links, inWorkspace } };
}
