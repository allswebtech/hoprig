// Where a task's session works, and what it left there. A session starts in a folder of a project of the workspace:
// the project's own folder, or one of its code repositories (code/<name>). The browser and the command name the
// project and one of these choices, never a path: the folder is looked up here, its real path must stay inside the
// project (a link that leads out is no choice), and that real path never leaves the server.
//
// What a run records of the folder is read through the safe git reader (src/gitread.mjs): each repository's commit
// when the session starts, then the commits made since and the files changed and not committed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { PRIVATE_DIRS, STATUS_EXCLUDES } from '../pcsetup/projects.mjs';
import { capture } from '../setup/system.mjs';
import { listProjects } from '../workspace/layout.mjs';
import { relOk } from './runs.mjs';

const CODE = 'code';
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const COMMITS_MAX = 50;
const CHANGED_MAX = 200;

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const inside = (child, root) => child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const isRepo = (d) => fs.existsSync(path.join(d, '.git'));

/** The projects of the workspace by name: { name → its folder } (`projectsDir`: the projects folder in use). */
export function projectsByName(projectsDir) {
  return new Map(listProjects(projectsDir).map((p) => [p.name, p.dir]));
}

/**
 * The folders a session of project `dir` may work in: [{ value, label, git }]. "." is the project's own folder; a
 * code repository is "code/<name>". A folder whose real path leads out of the project is left out.
 */
export function folderChoices(dir) {
  const root = real(dir);
  if (!root) return [];
  const out = [{ value: '.', label: 'The project\'s own folder', git: isRepo(root) }];
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, CODE), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!NAME_RE.test(d.name) || d.name.startsWith('.') || PRIVATE_DIRS.includes(d.name)) continue;
    const r = real(path.join(root, CODE, d.name));
    if (!r || !inside(r, root) || !fs.statSync(r).isDirectory() || !isRepo(r)) continue;
    out.push({ value: `${CODE}/${d.name}`, label: `${CODE}/${d.name}`, git: true });
  }
  return out;
}

/** The real folder of choice `folder` in project `dir`, or a 400 when it is not one of folderChoices. */
export function folderOf(dir, folder) {
  const choice = folderChoices(dir).find((c) => c.value === folder);
  if (!choice) throw Object.assign(new Error('choose the project\'s own folder or one of its code repositories'), { status: 400 });
  const root = real(dir);
  return folder === '.' ? root : real(path.join(root, folder));
}

/**
 * The git repositories of a session's folder: [{ repo (its name in the run: "." or "code/web"), dir }]: the folder
 * itself when it is one, and in a project's own folder each code repository too.
 */
export function reposOf(dir, folder) {
  const base = folderOf(dir, folder);
  const out = isRepo(base) ? [{ repo: folder, dir: base }] : [];
  if (folder === '.') for (const c of folderChoices(dir).slice(1)) out.push({ repo: c.value, dir: real(path.join(base, c.value)) });
  return out;
}

/** Each repository's commit now: [{ repo, head }] (head null: no commit yet, or git could not say). */
export async function headsOf(repos, run = capture) {
  const out = [];
  for (const r of repos) {
    const h = await gitRead(r.dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], { run });
    out.push({ repo: r.repo, head: h.ok && /^[0-9a-f]{40,64}$/.test(h.stdout.trim()) ? h.stdout.trim() : null });
  }
  return out;
}

// What a file holds, to tell whether a session changed a file that was changed before it started. Read only up to
// SIG_READ_MAX a file and SIG_BUDGET in all, without holding up the dashboard (one file at a time, asynchronously):
// past that a file is told by its size and time.
const SIG_READ_MAX = 1024 * 1024;
const SIG_BUDGET = 64 * 1024 * 1024;
const BEFORE_MAX = 5000; // files changed before a session started, kept one by one; past it their time tells
const STATUS_MAX = 50_000; // the files of git status looked at, at most
const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const bigSig = (st) => `big:${st.size}:${Math.round(st.mtimeMs)}`;

/** What a file holds now: 16 hex digits, or its size and time ("big:…") for a large one or past `budget`; "none" when gone. */
async function sigOf(file, budget) {
  try {
    const st = await fs.promises.lstat(file);
    if (!st.isFile()) return `kind:${st.isDirectory() ? 'dir' : 'other'}`;
    if (st.size > SIG_READ_MAX || budget.left < st.size) return bigSig(st);
    budget.left -= st.size;
    return hashOf(await fs.promises.readFile(file));
  } catch {
    return 'none';
  }
}

/** True when `file` holds what `sig` (sigOf, made when the session started) says: told the same way as then. */
async function holdsSame(file, sig) {
  try {
    const st = await fs.promises.lstat(file);
    if (!st.isFile()) return sig === `kind:${st.isDirectory() ? 'dir' : 'other'}`;
    if (sig.startsWith('big:')) return sig === bigSig(st);
    if (st.size > SIG_READ_MAX) return false;
    return sig === hashOf(await fs.promises.readFile(file));
  } catch {
    return sig === 'none';
  }
}

/** True when `file` was last changed before `since` (ms): it was so before the session started. */
async function olderThan(file, since) {
  try {
    return (await fs.promises.lstat(file)).mtimeMs < since;
  } catch {
    return false;
  }
}

const KIND_OF = (code) => (code === '??' ? 'new' : code.includes('D') ? 'deleted' : code.includes('R') ? 'renamed' : code.includes('A') ? 'added' : 'changed');

/**
 * The files changed and not committed in the repositories now, each with what it holds (sigOf): { before: [{ repo,
 * path, sig }], beforeCut } (cut: more than BEFORE_MAX, the rest are told by their time). Kept when a session starts,
 * so that what it leaves is told from what was there before it.
 */
export async function dirtyOf(repos, { run = capture, skip = [] } = {}) {
  const { files } = await uncommitted(repos, { run, skip }); // odd names too: they stay on this computer
  const budget = { left: SIG_BUDGET };
  const before = [];
  for (const f of files.slice(0, BEFORE_MAX)) before.push({ repo: f.repo, path: f.path, sig: await sigOf(f.abs, budget) });
  return { before, beforeCut: files.length > BEFORE_MAX };
}

/**
 * What a session left in the repositories since `start` ([{ repo, head }]): { commits: [{ repo, short, subject }],
 * changed: [{ repo, path, kind }], more } (the files changed and not committed, relative to their repository, but not
 * one that was so before it and holds the same now: `before`, `beforeCut` from dirtyOf, `since`: when it started, in
 * ms; `more`: files changed and not listed, past CHANGED_MAX or of a name a run does not hold). `skip`: real folders
 * whose files are left out (Work's own folder, when it is in one of them).
 */
export async function leftIn(repos, start, { run = capture, skip = [], before = [], beforeCut = false, since = null } = {}) {
  const commits = [];
  for (const r of repos) {
    const from = (start.find((s) => s.repo === r.repo) || {}).head || null;
    const log = await gitRead(r.dir, ['log', `--max-count=${COMMITS_MAX}`, '--format=%h%x00%s', from ? `${from}..HEAD` : 'HEAD'], { run });
    if (log.ok) {
      for (const line of log.stdout.split('\n').filter(Boolean)) {
        const [short, subject = ''] = line.split('\0');
        if (commits.length < COMMITS_MAX && /^[0-9a-f]{4,64}$/.test(short)) commits.push({ repo: r.repo, short, subject: subject.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) });
      }
    }
  }
  // Every file is weighed against what was there before, and only then is the list cut: a folder with many changed
  // files before the session still shows what the session changed.
  const was = new Map(before.map((b) => [`${b.repo}\0${b.path}`, b.sig]));
  const { files, over } = await uncommitted(repos, { run, skip });
  const changed = [];
  let more = over;
  for (const f of files) {
    const sig = was.get(`${f.repo}\0${f.path}`);
    if (sig !== undefined ? await holdsSame(f.abs, sig) : beforeCut && since !== null && await olderThan(f.abs, since)) continue;
    if (!f.odd && changed.length < CHANGED_MAX) changed.push({ repo: f.repo, path: f.path, kind: f.kind });
    else more += 1;
  }
  return { commits, changed, more };
}

/**
 * The files changed and not committed in each repository: { files: [{ repo, path, kind, abs, odd }], over } (odd: a
 * name a run does not hold, runs.mjs relOk: a control character, a folder named ~, the home folder in it, more than 500 characters: weighed
 * like the rest, then counted, never listed; over: past STATUS_MAX, only counted).
 */
async function uncommitted(repos, { run, skip }) {
  const files = [];
  let over = 0;
  for (const r of repos) {
    const top = await gitRead(r.dir, ['rev-parse', '--show-toplevel'], { run });
    const topDir = top.ok ? real(top.stdout.trim()) : null;
    // Left out: Work's own folder, and the other repositories of the list inside this one (a code repository in its
    // project's folder is a repository of its own, listed with its own files).
    const others = repos.filter((o) => o !== r).map((o) => o.dir);
    const skipRel = topDir ? [...skip, ...others].map((s) => (s && s !== topDir && inside(s, topDir) ? path.relative(topDir, s).split(path.sep).join('/') : null)).filter((x) => x !== null) : [];
    const st = await gitRead(r.dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.', ...STATUS_EXCLUDES], { run });
    if (!st.ok) continue;
    for (const e of st.stdout.split('\0').filter(Boolean)) {
      const code = e.slice(0, 2);
      const p = e.slice(3);
      if (!p || skipRel.some((s) => p === s || p === `${s}/` || p.startsWith(`${s}/`))) continue;
      const odd = !relOk(p);
      const abs = topDir && !p.split('/').includes('..') ? path.join(topDir, ...p.split('/')) : null;
      if (files.length >= STATUS_MAX) over += 1;
      else files.push({ repo: r.repo, path: p, kind: KIND_OF(code), abs, odd });
    }
  }
  return { files, over };
}
