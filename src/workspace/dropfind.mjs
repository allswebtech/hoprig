// What `hoprig drop` finds on the disk of a project before it may take the project off this computer (drop.mjs):
// every git repository in the project's folder, the files git ignores that a build or an install cannot make again,
// Claude Code's memory folders for the project's folders, and what a drop that was cut off left. Read only: nothing
// here writes, and nothing follows a link inside the project.
//
// The owner's words for ignored files: only build output, libraries and packages that are made again may go without
// a word ("deleting those causes no issue"). ONE function decides what that is (dropsilent.mjs withoutAWord); every
// other file git ignores is listed with its size, and a drop removes it only after he confirmed that exact list.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir } from '../paths.mjs';
import { PRIVATE_DIRS } from '../pcsetup/projects.mjs';
import { projectSlug } from '../sessions.mjs';
import { realOf } from './inside.mjs';

const lst = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const names = (d) => {
  try {
    return fs.readdirSync(d).sort();
  } catch {
    return [];
  }
};
const within = (p, top) => p === top || p.startsWith(top.endsWith(path.sep) ? top : top + path.sep);

/**
 * Every folder in `root` that is a git working tree (a `.git` folder or file in it), `root` itself first when it is
 * one, and every private folder (PRIVATE_DIRS: Hoprig never looks into those, so it cannot tell what in them is on a
 * git server: they are named, by their name only). The walk never follows a link and never enters a `.git` folder.
 * It enters build output too: a repository there (a tool cloned into dist/, a submodule under vendor/) has commits of
 * its own and is checked like any other, and a private folder there is asked about like any other (drop.mjs; only one
 * inside a folder git ignores as a whole goes without a word, dropsilent.mjs).
 * → { repos: [absolute path], privates: [absolute path] }
 */
export function walkProject(root) {
  const out = [];
  const privates = [];
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (ents.some((e) => e.name === '.git')) out.push(d);
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name === '.git') continue;
      if (PRIVATE_DIRS.includes(e.name)) privates.push(path.join(d, e.name)); // never entered
      else walk(path.join(d, e.name));
    }
  };
  walk(root);
  return { repos: out, privates };
}

/** What an ignored file is, in words the owner knows (all are handled alike: listed with their size). */
export function kindOf(name, isDir = false) {
  if (isDir) return name === 'test-data' ? 'test data' : 'folder';
  if (/^\.env(\..+)?$/.test(name)) return '.env file';
  if (/^id_(rsa|dsa|ecdsa|ed25519)$|\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i.test(name)) return 'key file';
  if (/\.(sql|dump|bak|sqlite3?|db)(\.gz)?$/i.test(name)) return 'database dump';
  return 'file';
}

/**
 * The size and file count of a folder, every file and link at every depth (a private folder counts as one file, not
 * looked into). Nothing in a folder that is listed is left out of its count: test-data/build/customers.sql is test data.
 */
function sizeOf(dir) {
  let size = 0;
  let files = 0;
  const walk = (d) => {
    for (const n of names(d)) {
      const p = path.join(d, n);
      const st = lst(p);
      if (!st) continue;
      if (st.isDirectory()) {
        if (PRIVATE_DIRS.includes(n)) {
          files++;
          continue;
        }
        walk(p);
      } else {
        files++;
        size += st.size;
      }
    }
  };
  walk(dir);
  return { size, files };
}

/**
 * The number of files and links in a private folder at every depth, never a name from it kept or shown (the count the
 * owner reads on the typed list). An unreadable folder in it counts as one.
 */
export function filesIn(dir) {
  let n = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      n++;
      return;
    }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

/**
 * The ignored files of one working tree, from git's own list of what it ignores (`entries`: paths relative to `wt`, a
 * folder ending in "/"). A repository among them (`repos`: every working tree of the project) is checked on its own; a
 * folder that holds one is looked into, so nothing beside it hides. `silent(abs, { isDir, isLink })`: dropsilent.mjs
 * withoutAWord, the one judge of what goes without a word (`rebuilt` gets the folder's name and `links` the path of a
 * credential link, so the owner is told they go); everything else is listed. A link into the workspace's credentials folder (`credentials`) is listed under
 * words that say only the link goes, never with its target's name. → [{ path (relative to wt), kind, size, files?, to? }]
 */
export async function ignoredItems(wt, entries, repos, { silent, rebuilt = [], links = [], credentials = null }) {
  const items = [];
  const repoSet = new Set(repos);
  const creds = credentials ? realOf(credentials) : null;
  const kind = (st) => ({ isDir: st.isDirectory(), isLink: st.isSymbolicLink(), isFile: st.isFile() });
  const note = (s, rel) => {
    if (s.why === 'rebuilt' && !rebuilt.includes(s.folder)) rebuilt.push(s.folder);
    if (s.why === 'credential link') links.push(rel);
  };
  // A folder git lists as ignored because all there is in it is ignored (src/ for src/build/, web/ for a system file
  // alone in it) goes without a word only when every thing in it does, each asked of `silent`; else it is listed whole.
  const allSilent = async (abs, rel, found) => {
    for (const n of names(abs)) {
      const p = path.join(abs, n);
      const st = lst(p);
      if (!st) continue;
      if (repoSet.has(p)) return false;
      const s = await silent(p, kind(st));
      if (s) {
        found.push([s, `${rel}/${n}`]);
        continue;
      }
      if (!st.isDirectory() || PRIVATE_DIRS.includes(n) || !(await allSilent(p, `${rel}/${n}`, found))) return false;
    }
    return true;
  };
  const visit = async (abs, rel) => {
    const st = lst(abs);
    if (!st) return;
    if (repoSet.has(abs)) return;
    const name = path.basename(abs);
    const s = await silent(abs, kind(st));
    if (s) {
      note(s, rel);
      return;
    }
    if (st.isSymbolicLink()) {
      const to = realOf(abs);
      if (to && creds && within(to, creds)) {
        items.push({ path: rel, kind: 'link (only the link goes: the file it points to stays where it is)', size: 0 });
        return;
      }
      let text = '';
      try {
        text = fs.readlinkSync(abs);
      } catch {
        /* unreadable: still listed */
      }
      items.push({ path: rel, kind: 'link', size: 0, to: text });
      return;
    }
    if (st.isDirectory()) {
      if (repos.some((r) => within(r, abs + path.sep))) {
        for (const n of names(abs)) await visit(path.join(abs, n), `${rel}/${n}`);
        return;
      }
      if (PRIVATE_DIRS.includes(name)) {
        items.push({ path: `${rel}/`, kind: 'private folder', size: null });
        return;
      }
      const found = [];
      if (await allSilent(abs, rel, found)) {
        for (const [f, r] of found) note(f, r);
        return;
      }
      const size = sizeOf(abs);
      items.push({ path: `${rel}/`, kind: kindOf(name, true), size: size.size, files: size.files });
      return;
    }
    items.push({ path: rel, kind: kindOf(name), size: st.size });
  };
  for (const e of entries) {
    const rel = e.replace(/\/$/, '');
    if (rel) await visit(path.join(wt, ...rel.split('/')), rel);
  }
  return items;
}

/** A size in plain words: "512 B", "12.4 KB", "3.1 GB". */
export function sizeWords(n) {
  if (n === null || n === undefined) return 'size not looked at';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i ? `${v.toFixed(1)} ${units[i]}` : `${v} B`;
}

// ---- Claude Code's memory folders ----

const projectsOfClaude = () => path.join(claudeDir(), 'projects');

/**
 * Claude Code's memory for each folder a session may start in (`launches`), as it is here: [{ launch, link, state }].
 * state: 'real' (a real folder with files in it: in no git), 'into' (a link into `root`), 'elsewhere' (a link to
 * another place: left alone). A launch folder with no memory, or an empty real one, is left out.
 */
export function memoriesOf(launches, root) {
  const tops = [path.resolve(root), realOf(root)].filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const launch of launches) {
    for (const spelled of new Set([launch, realOf(launch) || launch])) {
      const link = path.join(projectsOfClaude(), projectSlug(spelled), 'memory');
      if (seen.has(link)) continue;
      seen.add(link);
      const st = lst(link);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        let to = '';
        try {
          to = path.resolve(path.dirname(link), fs.readlinkSync(link));
        } catch {
          continue;
        }
        out.push({ launch, link, state: tops.some((t) => within(to, t)) ? 'into' : 'elsewhere' });
      } else if (st.isDirectory()) {
        const n = sizeOf(link).files;
        if (n) out.push({ launch, link, state: 'real', files: n });
      }
    }
  }
  return out;
}

/**
 * Every memory link of Claude Code that points into `root` (by its spelling, also when nothing is there any more: a
 * drop cut off after the rename): [link path]. Only links, never a real folder.
 */
export function linksInto(root, { spelled = false } = {}) {
  const tops = spelled ? [path.resolve(root)] : [path.resolve(root), realOf(root)].filter(Boolean);
  const out = [];
  for (const n of names(projectsOfClaude())) {
    const link = path.join(projectsOfClaude(), n, 'memory');
    const st = lst(link);
    if (!st || !st.isSymbolicLink()) continue;
    try {
      const to = path.resolve(path.dirname(link), fs.readlinkSync(link));
      if (tops.some((t) => within(to, t))) out.push(link);
    } catch {
      /* unreadable: not ours to judge */
    }
  }
  return out;
}

// ---- what a cut-off drop leaves ----

/** The name a folder has between the rename and the delete of a drop. */
export const droppingName = (name, time) => `.${name}.dropping-${time}`;
export const DROPPING_RE = /^\.(.+)\.dropping-(\d{8}-\d{6})(-\d+)?$/;

/** The folders a cut-off drop left in `dir`: [{ name: the project's (or repository's) name, path }]. `only`: that name. */
export function droppingIn(dir, only = null) {
  const out = [];
  for (const n of names(dir)) {
    const m = DROPPING_RE.exec(n);
    const st = m ? lst(path.join(dir, n)) : null;
    if (st && (st.isDirectory() || st.isSymbolicLink()) && (!only || m[1] === only)) out.push({ name: m[1], path: path.join(dir, n) });
  }
  return out;
}
