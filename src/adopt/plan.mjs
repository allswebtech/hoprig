// Suggest (hoprig adopt plan): one plan per project, a file in Hoprig's state folder (so
// a plan writes nothing in the scanned places or the workspace), shown before anything is done. What is mechanical
// is here: which repositories go to code/<name>, where each neighbour goes by its kind, what stays, the other tools'
// skills, rules files and hooks, which tracked files name the old folders (file and line, never rewritten). What
// needs reading (is this note the plan the project came from; is this file a log with secrets in it) is marked
// `read: true` for the skill adopt-projects, which the owner's own session follows: Hoprig never asks a model itself.
//
// A plan may be edited by the owner or the session; readPlan takes it strictly, and apply takes it only while its
// fingerprint (the whole tree's listing and every repository's git state) is still what the folder shows now.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { stateDir } from '../paths.mjs';
import { pathRules } from '../server/platform/common.mjs';
import { MANIFEST, NAME_RE, builtinFiles, relOk } from '../pcsetup/workspace.mjs';
import { AI_NAMES, SIGNS, SKIP_DIRS, besideRepos, commonDir, hasLayout, projectRepos, worktreesOf } from './scan.mjs';
import { STATUS_EXCLUDES } from '../pcsetup/projects.mjs';
import { askVisibility, githubOf, readAddress } from '../workspace/credrepo.mjs';
import { noSignIn } from './scan.mjs';
import { isRebuiltName, withoutAWord } from '../workspace/dropsilent.mjs';
import { isPrivate, nameOf, repoState, treeOf } from './proof.mjs';

export const PLAN_VERSION = 1;
export const plansDir = () => path.join(stateDir(), 'adopt');
export const planFile = (name) => path.join(plansDir(), `${name}.json`);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The words of the rule that names a project (NAME_RE, as project new says it), as an error with the code ENAME. */
export const NAME_WORDS = 'a project name is letters, digits, ".", "_" and "-"';
export const nameError = () => Object.assign(new Error(NAME_WORDS), { code: 'ENAME' });

/** The name of the plan made for the folder `dir` (the newest one), else the name made from the folder's name. */
export function planNameOf(dir) {
  let best = null;
  let names = [];
  try {
    names = fs.readdirSync(plansDir()).filter((f) => f.endsWith('.json') && !f.endsWith('.done.json'));
  } catch {
    /* no plan yet */
  }
  for (const f of names) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(plansDir(), f), 'utf8'));
      if (p && p.from === dir && NAME_RE.test(String(p.name)) && `${p.name}.json` === f && (!best || String(p.made) > String(best.made))) best = p;
    } catch {
      /* not a plan */
    }
  }
  return best ? best.name : projectName(path.basename(dir));
}

/** A project name made from a folder's name: letters, digits, ".", "_" and "-" (what `project new` takes). */
export function projectName(folder) {
  const n = String(folder).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+$/, '').slice(0, 100);
  return NAME_RE.test(n) ? n : 'project';
}

// Where a neighbour goes, by its kind (as the hand-arranged computers had it): AI material to
// ai_brain/, the project's own operating scripts to scripts/, copies of production data to test-data/ (never in git,
// never read by AI tools), notes to ai_brain/notes/ (to be read: a plan, or a log with secrets in it).
const SCRIPT = /\.(sh|bash|ps1|psm1|cmd|bat)$/i;
const DATA = /\.(sql|dump|bak|backup|sqlite3?|db|csv|tsv|xlsx?|gz|zip|7z|tar|tgz)$/i;
const NOTE = /\.(md|txt|rtf|docx?|pdf|org)$/i;
const DATA_DIRS = /^(backups?|dumps?|data|db|database|exports?|prod[-_]?data)$/i;
const SCRIPT_DIRS = /^(scripts?|ops|deploy|tools)$/i;

export function placeOf(name, isDir) {
  if (AI_NAMES.includes(name)) return { kind: 'ai', to: `ai_brain/${name}` };
  if (isDir && DATA_DIRS.test(name)) return { kind: 'data', to: `test-data/${name}` };
  if (isDir && SCRIPT_DIRS.test(name)) return { kind: 'scripts', to: `scripts/${name}` };
  if (!isDir && DATA.test(name)) return { kind: 'data', to: `test-data/${name}` };
  if (!isDir && SCRIPT.test(name)) return { kind: 'scripts', to: `scripts/${name}` };
  if (!isDir && NOTE.test(name)) return { kind: 'note', to: `ai_brain/notes/${name}`, read: true };
  return { kind: 'other', to: null };
}

// A project already in the layout keeps every file of its own at its own place (AGENTS.md, ai_brain/, scripts/,
// docs/, project.json, ...): Hoprig adds only what its layout has and the old folder lacks (`adds`). A file of his is
// never moved aside, replaced or written into. A folder that Hoprig writes into (one holding a file it adds, the
// coding tool's memory, a skill's pointer) is copied entry by entry, so what Hoprig adds never lands in a copy of his.
/** What is said of the git history of a parent in the layout that is itself a repository (it stays where it is). */
export const OLD_HISTORY = 'the old folder\'s own git history (its .git) stays where it is';
/** Where the table of what was where goes when the project's AGENTS.md is its own (his file is never written into). */
export const MOVED_FILE = 'ai_brain/moved-here.md';
const SKIPPED = { kind: 'installed', to: null, why: 'installed packages or build output: made again from the project, not copied' };
const sized = (p) => {
  const s = sizeOf(p);
  return { bytes: s.bytes, files: s.files };
};
/** Everything Hoprig may add to a new project: its template's files, project.json, and MOVED_FILE. */
export const addable = () => [...builtinFiles().map((f) => f.rel), MANIFEST, MOVED_FILE];
// The places Hoprig writes into after the copy (the coding tool's memory; another tool's skill's pointer).
const WRITES_INTO = ['ai_brain/claude-memory/x', '.claude/skills/x'];

/**
 * What Hoprig adds to the project made from `src`: for a folder not in the layout, the whole template and project.json;
 * for one in the layout, each of these that the old folder has nothing at, nor a file or a link on the way to it (that
 * one stays his, and the template's file is not added). MOVED_FILE when the old folder's AGENTS.md is its own.
 */
export function addsFor(src, layout) {
  const all = [...builtinFiles().map((f) => f.rel), MANIFEST];
  if (!layout) return all;
  const taken = (rel) => {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const st = fs.lstatSync(path.join(src, ...parts.slice(0, i)), { throwIfNoEntry: false });
      if (!st) return false;
      if (i < parts.length && !st.isDirectory()) return true;
    }
    return true;
  };
  const out = all.filter((r) => !taken(r));
  if (!out.includes('AGENTS.md') && !taken(MOVED_FILE)) out.push(MOVED_FILE);
  return out;
}

/** Which of the two a plan found, and what Hoprig adds, in words (the command's plan and the page's). */
export function foundWords(plan) {
  const adds = addsOf(plan);
  if (!plan.layout) return 'It is not laid out as a Hoprig project yet: the new folder is made from Hoprig\'s template, and the project\'s own files go to the places below.';
  const layout = adds.filter((f) => f !== MOVED_FILE);
  return `It is already laid out as a Hoprig project: every file of its own keeps its place, and nothing of it is replaced. ${layout.length ? `Hoprig adds only what the layout lacks: ${layout.join(', ')}.` : 'The layout lacks nothing, so Hoprig adds none of its files.'}${adds.includes(MOVED_FILE) ? ` Its own AGENTS.md stays as it is: the table of what was where goes to ${MOVED_FILE}.` : ''}`;
}

/** The neighbours of a project in the layout: `beside` from besideRepos. Each keeps its own place. */
function layoutNeighbours(src, beside, copyInstalled) {
  const into = [...addable(), ...WRITES_INTO];
  const folderAt = (t) => t === 'code' || into.some((f) => f.startsWith(`${t}/`));
  const out = [];
  const place = (rel, name, isDir) => {
    if (isDir && isPrivate(name)) return void out.push({ from: rel, kind: 'private', to: rel, private: true });
    if (isDir && SKIP_DIRS.has(name) && !copyInstalled) return void out.push({ from: rel, ...SKIPPED, ...sized(path.join(src, rel)) });
    if (!isDir || !folderAt(rel)) return void out.push({ from: rel, kind: 'own', to: rel });
    for (const e of list(path.join(src, rel)).sort((a, b) => a.name.localeCompare(b.name))) place(`${rel}/${e.name}`, e.name, e.isDirectory());
  };
  for (const b of beside) if (b.name !== '.git') place(b.rel, b.name, b.isDir);
  return out;
}

const list = (d) => {
  try {
    return fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return [];
  }
};

// Installed packages and build output inside a repository (node_modules, .next, vendor, .venv, ...): the folders a
// package manager or a build makes again, decided where drop decides them (src/workspace/dropsilent.mjs: a folder of
// that list that git ignores as a whole). A plan leaves each out of the copy by default, names it with its size and the
// command that makes it again, and `copyInstalled` copies them all the same. One that holds a repository of its own is
// copied (its commits are not made again by an install).
const LEFT_MAX = 200;

/** A folder's size without following a link: { bytes, files, repo } (repo: a .git lies somewhere in it). */
export function sizeOf(dir) {
  const out = { bytes: 0, files: 0, repo: false };
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of list(d)) {
      const p = path.join(d, e.name);
      if (e.name === '.git') out.repo = true;
      if (e.isDirectory()) stack.push(p);
      else {
        try {
          out.bytes += fs.lstatSync(p).size;
          out.files++;
        } catch {
          /* gone meanwhile */
        }
      }
    }
  }
  return out;
}

const has = (dir, ...names) => names.find((n) => fs.existsSync(path.join(dir, n))) || null;
/** The package manager of a folder by its lockfile, and the command that installs from that lockfile. */
function nodeManager(dir) {
  if (has(dir, 'pnpm-lock.yaml')) return { pm: 'pnpm', install: 'pnpm install --frozen-lockfile' };
  if (has(dir, 'yarn.lock')) return { pm: 'yarn', install: 'yarn install --frozen-lockfile' };
  if (has(dir, 'bun.lock', 'bun.lockb')) return { pm: 'bun', install: 'bun install --frozen-lockfile' };
  if (has(dir, 'package-lock.json', 'npm-shrinkwrap.json')) return { pm: 'npm', install: 'npm ci' };
  return { pm: 'npm', install: 'npm install' };
}

/** The command that makes the folder `name` in `dir` again, from what lies beside it (its lockfile first), or null. */
export function remakeOf(dir, name) {
  const node = has(dir, 'package.json') ? nodeManager(dir) : null;
  if (name === 'node_modules') return nodeManager(dir).install;
  if (name === 'vendor') return has(dir, 'composer.json') ? 'composer install' : has(dir, 'Gemfile') ? 'bundle install' : has(dir, 'go.mod') ? 'go mod vendor' : null;
  if (name === '.venv' || name === 'venv') return has(dir, 'uv.lock') ? 'uv sync' : has(dir, 'poetry.lock') ? 'poetry install' : has(dir, 'requirements.txt') ? `python3 -m venv ${name} && ${name}/bin/pip install -r requirements.txt` : null;
  if (name === 'Pods') return 'pod install';
  if (name === '.dart_tool') return has(dir, 'pubspec.yaml') ? 'flutter pub get' : null;
  if (name === '.gradle') return has(dir, 'gradlew') ? './gradlew build' : null;
  if (name === 'target') return has(dir, 'Cargo.toml') ? 'cargo build' : has(dir, 'pom.xml') ? 'mvn package' : null;
  if (['.next', '.nuxt', '.svelte-kit', '.turbo', 'dist', 'build'].includes(name) && node) return `${node.pm} run build`;
  if (name === 'build' && has(dir, 'gradlew')) return './gradlew build';
  return null;
}

/**
 * The folders of installed packages and build output in the checkouts `dirs` (a repository and its worktrees), each
 * one git ignores as a whole: [{ dir, bytes, files, remake }]. A private folder, a .git and another repository are not
 * entered; a folder of the list is not entered either (what is inside it goes, or comes, with it).
 */
export async function installedIn(dirs) {
  const out = [];
  const memo = new Map();
  const walk = async (d) => {
    for (const e of list(d).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name === '.git' || isPrivate(e.name) || out.length >= LEFT_MAX) continue;
      const p = path.join(d, e.name);
      if (isRebuiltName(e.name)) {
        if (!fs.existsSync(p) || !(await withoutAWord(p, { repos: dirs, isDir: true, memo }))) continue;
        const sz = sizeOf(p);
        if (!sz.repo) out.push({ dir: p, bytes: sz.bytes, files: sz.files, remake: remakeOf(d, e.name) });
        continue;
      }
      if (fs.existsSync(path.join(p, '.git')) && !dirs.includes(p)) continue; // another repository: copied as it is
      await walk(p);
    }
  };
  for (const d of dirs) await walk(d);
  return out;
}

/** The other tools' skills, rules files and hooks in `dir` (a project folder or a repository's top). */
export function toolFiles(dir, base = '') {
  const out = { skills: [], rules: [], hooks: [] };
  const rel = (...p) => [base, ...p].filter(Boolean).join('/');
  for (const tool of ['.kiro', '.cursor', '.codex', '.windsurf', '.opencode', '.claude']) {
    const t = path.join(dir, tool);
    for (const s of list(path.join(t, 'skills'))) if (s.isDirectory() && fs.existsSync(path.join(t, 'skills', s.name, 'SKILL.md'))) out.skills.push({ tool, name: s.name, file: rel(tool, 'skills', s.name, 'SKILL.md') });
    for (const sub of ['steering', 'rules']) for (const f of list(path.join(t, sub))) if (f.isFile()) out.rules.push({ tool, file: rel(tool, sub, f.name) });
    for (const f of list(path.join(t, 'hooks'))) if (f.isFile()) out.hooks.push({ tool, file: rel(tool, 'hooks', f.name) });
    if (tool === '.claude') {
      for (const n of ['settings.json', 'settings.local.json']) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(t, n), 'utf8'));
          if (j && j.hooks && typeof j.hooks === 'object') for (const ev of Object.keys(j.hooks)) out.hooks.push({ tool, file: rel(tool, n), event: ev.slice(0, 40) });
        } catch {
          /* none, or not JSON */
        }
      }
    }
  }
  for (const n of ['.cursorrules', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) if (fs.existsSync(path.join(dir, n))) out.rules.push({ tool: n, file: rel(n) });
  return out;
}

/** The coding tools' session stores that name a folder: Claude Code's key, Kiro's workspacePaths. → [{ tool, count }] */
export function sessionStores(dirs, { home, claude, platform = process.platform } = {}) {
  const rules = pathRules(platform);
  const { projectSlug } = sessionsMod;
  const out = [];
  let n = 0;
  for (const d of [...new Set(dirs.map((x) => path.resolve(x)))]) n += list(path.join(claude, 'projects', projectSlug(d))).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).length;
  if (n) out.push({ tool: 'Claude Code', count: n, moves: true });
  let k = 0;
  for (const ws of list(path.join(home, '.kiro', 'sessions'))) {
    for (const s of list(path.join(home, '.kiro', 'sessions', ws.name))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(home, '.kiro', 'sessions', ws.name, s.name, 'session.json'), 'utf8'));
        if (Array.isArray(j.workspacePaths) && j.workspacePaths.some((p) => dirs.some((d) => rules.within(String(p), d)))) k++;
      } catch {
        /* not a session */
      }
    }
  }
  if (k) out.push({ tool: 'Kiro', count: k, moves: false });
  return out;
}
let sessionsMod = null;
export async function loadSessions() {
  sessionsMod ||= await import('../sessions.mjs');
  return sessionsMod;
}

/**
 * A listing for the fingerprint: every entry by its content (a file's hash, a link's text), its kind and mode, never
 * its time. A file edited to the same size within the same second is a change; a file only touched is none.
 */
const byContent = (dir) => Object.fromEntries(Object.entries(treeOf(dir, { skipDirs: SKIP_DIRS }).entries).map(([k, v]) => {
  const f = v.split(' ');
  return [k, f[0] === 'file' ? `file ${f[2]} ${f[4]}` : v];
}));

/**
 * The fingerprint of a project as it is now: every file's content (a hash) outside installed packages, and each
 * repository's git state. apply takes a plan only while it is the same; retire only while the original is as it was
 * when it was copied. Reading every file costs time on a large project (measured: see docs/WORKSPACE.md).
 */
export async function fingerprint(dir, repos) {
  const parts = [JSON.stringify(byContent(dir))];
  for (const r of repos) {
    const s = await repoState(r.from);
    parts.push(JSON.stringify([r.from, s.head, s.refs, s.status, s.staged, s.stash, s.worktrees]));
    for (const w of r.worktrees || []) if (!pathRules().within(w.from, dir)) parts.push(JSON.stringify(byContent(w.from)));
  }
  return sha(parts.join('\n'));
}

/** Old folders named in text files: [{ file, line }] (`forms`: every spelling of the old folders). */
export function namedIn(file, forms, label = file) {
  let text;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 2 << 20) return [];
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (text.includes('\0')) return [];
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (forms.some((f) => l.includes(f))) out.push({ file: label, line: i + 1 });
  });
  return out;
}

/** Tracked files of a repository that name an old folder (git grep through the reader): [{ file, line }]. */
export async function trackedNaming(repo, forms, prefix) {
  const args = ['grep', '--null', '--line-number', '--fixed-strings', '--text'];
  for (const f of forms) args.push('-e', f);
  const r = await gitRead(repo, [...args, '--', '.'], { timeout: 60_000 });
  if (!r.ok) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [file, line] = l.split('\0');
    return { file: `${prefix}${file}`, line: Number(line) };
  }).filter((h) => !h.file.split('/').some(isPrivate));
}

/**
 * Every folder at or below `dir` (down to `depth`, never into a private folder or SKIP_DIRS) that holds a .git or a
 * sign: the first such folder on each way down is one project, and what is below it is that project's. Names are read
 * as bytes (a name that is not UTF-8 would otherwise come back changed and could not be listed) and shown with nameOf.
 * → [rel], at most `room` of them.
 */
function projectsWithin(dir, rel, depth, room) {
  const out = [];
  const walk = (d, r, left) => {
    if (out.length >= room) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true, encoding: 'buffer' });
    } catch {
      return;
    }
    const names = entries.map((e) => nameOf(e.name));
    if (names.some((n) => n === '.git' || SIGNS.includes(n))) return void out.push(r);
    if (left <= 0) return;
    const sub = entries.map((e, i) => ({ e, n: names[i] })).filter(({ e, n }) => e.isDirectory() && !isPrivate(n) && !SKIP_DIRS.has(n)).sort((x, y) => (x.n < y.n ? -1 : x.n > y.n ? 1 : 0));
    for (const { e, n } of sub) walk(Buffer.concat([d, Buffer.from(path.sep), e.name]), `${r}/${n}`, left - 1);
  };
  walk(Buffer.from(dir), rel, depth);
  return out;
}

/**
 * Untracked folders inside a repository that look like another project (their own .git, or a project's sign, at their
 * top or up to three folders down, as reposIn looks): copied with the repository, but a first push could take them, so
 * they are named for the owner to decide. → [rel] (with the repository's `prefix`): the folder that holds the other
 * project. A private folder is left out and never entered.
 */
const NESTED_MAX = 100;
export async function nestedProjects(repo, prefix) {
  const r = await gitRead(repo, ['ls-files', '-z', '--others', '--exclude-standard', '--directory', '--', '.', ...STATUS_EXCLUDES], { timeout: 60_000 });
  if (!r.ok) return [];
  const out = [];
  for (const e of r.stdout.split('\0').filter((x) => x.endsWith('/'))) {
    const rel = e.slice(0, -1);
    if (rel.split('/').some(isPrivate)) continue;
    for (const hit of projectsWithin(path.join(repo, rel), rel, 3, NESTED_MAX - out.length)) out.push(`${prefix}${hit}`);
    if (out.length >= NESTED_MAX) break;
  }
  return out;
}

/** Where a copy still names the old folders where it bites: its git settings and hooks, launch and tool files. */
export function bitingIn(repo, forms, prefix) {
  const out = [];
  const common = commonDir(repo);
  if (common) {
    out.push(...namedIn(path.join(common, 'config'), forms, `${prefix}.git/config`));
    for (const h of list(path.join(common, 'hooks'))) if (h.isFile() && !h.name.endsWith('.sample')) out.push(...namedIn(path.join(common, 'hooks', h.name), forms, `${prefix}.git/hooks/${h.name}`));
  }
  for (const f of ['.vscode/launch.json', '.vscode/settings.json', '.vscode/tasks.json', '.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'package.json']) out.push(...namedIn(path.join(repo, f), forms, `${prefix}${f}`));
  for (const tool of ['.kiro', '.cursor']) {
    const walk = (d, rel, depth) => {
      if (depth > 3) return;
      for (const e of list(d)) {
        if (e.isDirectory() && !isPrivate(e.name)) walk(path.join(d, e.name), `${rel}${e.name}/`, depth + 1);
        else if (e.isFile()) out.push(...namedIn(path.join(d, e.name), forms, `${prefix}${rel}${e.name}`));
      }
    };
    walk(path.join(repo, tool), `${tool}/`, 0);
  }
  return out;
}

/**
 * Whether a repository's hosting server holds it as public or private, AS THAT SERVER SAYS: asked only with `run`
 * (the owner made the plan himself, with the sign-in this computer has: gh for GitHub), never guessed from the
 * address. `url`: origin's address without any sign-in part. → null (no remote) |
 * { state: 'public' | 'private' | 'not private' | 'unknown' | 'local', words }.
 */
export async function visibilityOf(url, run = null) {
  if (!url) return null;
  if (readAddress(url).kind === 'local') return { state: 'local', words: 'Its remote is a folder on this computer, not a server: there is nothing to ask and nothing to publish' };
  if (!run) return { state: 'unknown', words: 'not known: not asked (the server is asked only when you make the plan yourself)' };
  const g = await githubOf(url, run);
  if (g.why) return { state: 'unknown', words: `not known: ${g.why}` };
  if (!g.full) return { state: 'unknown', words: 'not known: Hoprig asks only GitHub, and this is another server' };
  const v = await askVisibility(g.full, run);
  if (v.private) return { state: 'private', words: 'private on GitHub, as GitHub said when this plan was made' };
  if (v.why === 'it is public on GitHub') return { state: 'public', words: 'PUBLIC on GitHub, as GitHub said when this plan was made: anyone can read what a push takes there' };
  if (/could not be asked/.test(v.why)) return { state: 'unknown', words: `not known: ${v.why.replace(/^its visibility /, 'it ')}` };
  return { state: 'not private', words: `${v.why}, as GitHub said when this plan was made` };
}

/**
 * The plan of the project folder `dir` (one that scan found). `projects`: the workspace's projects folder.
 * `home`, `claude`: where the coding tools keep their sessions. → the plan object (not written).
 */
export async function makePlan(dir, { projects, home, claude, now = new Date(), ask = null, copyInstalled = false, name: given = null } = {}) {
  if (given !== null && given !== undefined && !NAME_RE.test(String(given))) throw nameError();
  await loadSessions();
  const src = path.resolve(dir);
  const name = given ?? projectName(path.basename(src));
  const layout = hasLayout(src);
  const repoDirs = projectRepos(src);
  const repos = [];
  const taken = new Set();
  const notes = [];
  const elsewhere = [];
  const ownWorktrees = new Set(repoDirs.filter((r) => fs.lstatSync(path.join(r, '.git')).isDirectory()).flatMap((r) => worktreesOf(commonDir(r)).map((w) => path.resolve(w))));
  for (const r of repoDirs) {
    const rel = path.relative(src, r).split(path.sep).join('/');
    const dot = path.join(r, '.git');
    const common = commonDir(r);
    if (!fs.lstatSync(dot).isDirectory()) {
      // A linked worktree of a repository of this project comes with that repository; any other folder whose git
      // folder is elsewhere stays where it is (its history is not in it).
      if (!ownWorktrees.has(path.resolve(r))) elsewhere.push(rel || '.');
      continue;
    }
    let base = layout ? rel : projectName(path.basename(r) === path.basename(src) && r === src ? name : path.basename(r));
    if (!layout) {
      let b = base;
      for (let i = 2; taken.has(b.toLowerCase()); i++) b = `${base}-${i}`;
      base = b;
      taken.add(base.toLowerCase());
    }
    const to = layout ? (rel || '.') : `code/${base}`;
    const worktrees = worktreesOf(common).map((w) => {
      const inside = pathRules().within(w, r);
      const wrel = path.relative(r, w).split(path.sep).join('/');
      // A worktree from outside goes beside its repository's copy: code/<repo>.<worktree> (for a project in the layout
      // too, whose repository is already at code/<repo>).
      return { from: w, to: inside ? `${to === '.' ? '' : `${to}/`}${wrel}` : `${to === '.' ? `code/${name}` : to}.${projectName(path.basename(w))}`, inside };
    });
    const url = await gitRead(r, ['config', '--get', 'remote.origin.url']);
    const remote = url.ok && url.stdout.trim() ? noSignIn(url.stdout.trim()) : null;
    repos.push({ from: r, rel: rel || '.', to, worktrees, remote, visibility: await visibilityOf(remote, ask) });
  }
  // The parent's own history (a parent in the layout that is a repository): not copied, named, and it stays.
  if (layout && fs.existsSync(path.join(src, '.git'))) notes.push(`${OLD_HISTORY}: the new project starts a history of its own; its files are copied as the rest are`);
  const neighbours = [];
  let privates = 0;
  for (const e of elsewhere) {
    if (e === '.') notes.push(`${e}: its git folder is elsewhere (a linked worktree of another repository, or a separate git folder): it stays where it is`);
    else neighbours.push({ from: e, kind: 'other', to: null, why: 'its git folder is elsewhere (a linked worktree of another repository, or a separate git folder): it stays where it is' });
  }
  // What lies beside the repositories, at every folder level down to each one (apps/notes.md beside apps/site too):
  // each goes to its kind's place, keeping the folders it was in below that place.
  if (layout) neighbours.push(...layoutNeighbours(src, besideRepos(src, repoDirs), copyInstalled));
  else {
    for (const b of besideRepos(src, repoDirs)) {
      if (b.name === '.git') continue;
      if (b.isDir && isPrivate(b.name)) {
        privates++;
        neighbours.push({ from: b.rel, kind: 'private', to: b.rel, private: true });
        continue;
      }
      if (b.isDir && SKIP_DIRS.has(b.name) && !copyInstalled) {
        neighbours.push({ from: b.rel, ...SKIPPED, ...sized(path.join(src, b.rel)) });
        continue;
      }
      const at = placeOf(b.name, b.isDir);
      neighbours.push({ from: b.rel, ...at, to: at.to && `${at.to.slice(0, at.to.length - b.name.length)}${b.rel}` });
    }
  }
  const rules = pathRules();
  const old = [src, ...repos.map((r) => r.from), ...repos.flatMap((r) => r.worktrees.map((w) => w.from))];
  const forms = [...new Set(old.flatMap((o) => rules.forms(o)))];
  const breaks = [];
  const nested = [];
  for (const r of repos) {
    const prefix = r.rel === '.' ? '' : `${r.rel}/`;
    nested.push(...(await nestedProjects(r.from, prefix)));
    breaks.push(...(await trackedNaming(r.from, forms, prefix)).map((b) => ({ ...b, tracked: true })));
    breaks.push(...bitingIn(r.from, forms, prefix));
  }
  for (const n of neighbours) if (['scripts', 'ai', 'note', 'own'].includes(n.kind)) {
    const p = path.join(src, n.from);
    if (fs.statSync(p).isFile()) breaks.push(...namedIn(p, forms, n.from));
  }
  for (const [rel, v] of Object.entries(treeOf(src, { contents: false, skipDirs: SKIP_DIRS }).entries)) {
    if (!v.startsWith('link ')) continue;
    const t = path.resolve(path.dirname(path.join(src, rel)), v.slice(5));
    if (old.some((o) => rules.within(t, o)) && path.isAbsolute(v.slice(5))) breaks.push({ file: rel, line: 0, link: true });
  }
  // Installed packages and build output in each repository and its worktrees: left out unless copyInstalled.
  const leftOut = [];
  if (!copyInstalled) for (const r of repos) leftOut.push(...(await installedIn([r.from, ...r.worktrees.map((w) => w.from)])));
  const seen = new Set();
  const tools = { skills: [], rules: [], hooks: [] };
  const addTools = (t) => {
    for (const k of Object.keys(tools)) tools[k].push(...t[k]);
  };
  addTools(toolFiles(src));
  for (const r of repos) addTools(toolFiles(r.from, r.rel === '.' ? '' : r.rel));
  for (const k of Object.keys(tools)) tools[k] = tools[k].filter((x) => !seen.has(`${k} ${x.file} ${x.event || ''}`) && seen.add(`${k} ${x.file} ${x.event || ''}`));
  return {
    version: PLAN_VERSION,
    name,
    made: now.toISOString(),
    from: src,
    to: path.join(projects, name),
    layout,
    adds: addsFor(src, layout),
    exists: fs.existsSync(path.join(projects, name)),
    repos,
    neighbours,
    leftOut,
    copyInstalled,
    privates,
    tools,
    sessions: sessionStores(old, { home, claude }),
    breaks: breaks.filter((b) => !seen.has(`b ${b.file}:${b.line}`) && seen.add(`b ${b.file}:${b.line}`)),
    notes,
    nested,
    fingerprint: await fingerprint(src, repos),
  };
}

/** Write a plan into Hoprig's state folder (the only file `plan` writes). → the file. */
export function writePlan(plan) {
  fs.mkdirSync(plansDir(), { recursive: true, mode: 0o700 });
  const f = planFile(plan.name);
  // A project arranged from another folder keeps its plan: verify and retire read it.
  let was = null;
  try {
    was = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    /* none yet */
  }
  if (was && was.from !== plan.from && fs.existsSync(path.join(plansDir(), `${plan.name}.done.json`))) throw Object.assign(new Error(`${plan.name} is the name of a project arranged from ${was.from}: give this one another name`), { code: 'ENAME' });
  fs.writeFileSync(f, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  return f;
}

const KEYS = ['version', 'name', 'made', 'from', 'to', 'layout', 'adds', 'exists', 'repos', 'neighbours', 'leftOut', 'copyInstalled', 'privates', 'tools', 'sessions', 'breaks', 'notes', 'nested', 'fingerprint'];
const bad = (m) => Object.assign(new Error(`the plan is not one apply takes: ${m}`), { code: 'EPLAN' });

/** What a plan adds: its own `adds`, or (a plan made before plans named them) the whole template and project.json. */
export const addsOf = (plan) => (Array.isArray(plan.adds) ? plan.adds : [...builtinFiles().map((f) => f.rel), MANIFEST]);

/**
 * The places of what Hoprig adds to a new project folder (`adds`), before or after anything is copied into it: its
 * files and the folders they lie in (AGENTS.md, docs, ai_brain/daily_logs, ...). Nothing is copied onto one of them:
 * a copy never merges into a folder that is there, nor writes over a file.
 */
export function templatePlaces(adds = addsOf({})) {
  const out = new Map();
  for (const rel of adds) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) out.set(parts.slice(0, i).join('/'), true);
    out.set(rel, false);
  }
  return out; // rel -> whether it is a folder
}

/** The words a person gets for a copy that would land on a place of the template (the plan's check and apply's). */
export const takenWords = (to, from, isDir) => `${to} is ${isDir ? 'a folder' : 'a file'} of the template: the plan must put ${path.basename(from)} elsewhere`;
/** A neighbour's path in the scanned folder: plain parts, no "..", no .git; a private folder only as its last part. */
const fromOk = (f, priv) => {
  if (typeof f !== 'string' || !f || f.length > 400 || f.includes('\\') || f.includes('\0')) return false;
  const parts = f.split('/');
  if (parts.some((x) => !x || x === '.' || x === '..' || x === '.git')) return false;
  return parts.slice(0, -1).every((x) => !isPrivate(x)) && isPrivate(parts[parts.length - 1]) === priv;
};
const relTo = (p) => typeof p === 'string' && relOk(p) && !p.split('/').some((s) => s === '.git');

/**
 * A plan as apply takes it: read strictly (an edited plan too). Every place it names is inside the project's new
 * folder (no "..", no absolute path, no private folder, no .git), every source inside the scanned folder, the new
 * folder is <projects>/<name>. Throws EPLAN with what is wrong.
 */
export function readPlan(name, { projects }) {
  if (!NAME_RE.test(String(name))) throw bad('a project name is letters, digits, ".", "_" and "-"');
  let p;
  try {
    p = JSON.parse(fs.readFileSync(planFile(name), 'utf8'));
  } catch (e) {
    throw Object.assign(new Error(e.code === 'ENOENT' ? `there is no plan for ${name}: make one with hoprig adopt plan <folder>` : `the plan of ${name} is not JSON (${e.message})`), { code: 'EPLAN' });
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw bad('not an object');
  for (const k of Object.keys(p)) if (!KEYS.includes(k)) throw bad(`unknown key "${String(k).slice(0, 40)}"`);
  if (p.version !== PLAN_VERSION) throw bad(`version ${PLAN_VERSION} is needed`);
  if (!NAME_RE.test(String(p.name)) || p.name !== name) throw bad('its "name" must be the file\'s name (rename the file with it)');
  if (typeof p.from !== 'string' || !path.isAbsolute(p.from)) throw bad('"from" is the scanned folder');
  const rules = pathRules();
  if (path.resolve(p.to || '') !== path.join(path.resolve(projects), p.name)) throw bad(`"to" must be ${path.join(projects, p.name)}`);
  if (rules.within(p.to, p.from) || rules.within(p.from, p.to)) throw bad('the new folder and the old one may not lie in each other');
  if (typeof p.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(p.fingerprint)) throw bad('"fingerprint" is missing');
  if (!Array.isArray(p.repos) || !Array.isArray(p.neighbours)) throw bad('"repos" and "neighbours" are lists');
  if (p.nested !== undefined && (!Array.isArray(p.nested) || p.nested.some((x) => typeof x !== 'string' || x.length > 400))) throw bad('"nested" is a list of folders');
  const tos = new Set();
  const claim = (to) => {
    const k = rules.fold ? to.toLowerCase() : to;
    if (tos.has(k)) throw bad(`two things go to ${to}`);
    tos.add(k);
  };
  for (const r of p.repos) {
    if (!r || typeof r.from !== 'string' || !rules.within(r.from, p.from)) throw bad('a repository\'s "from" must be inside the scanned folder');
    if (!(p.layout ? r.to === '.' || relTo(r.to) : relTo(r.to) && r.to.startsWith('code/'))) throw bad(`a repository goes to code/<name> (not ${String(r.to).slice(0, 60)})`);
    claim(r.to);
    // A worktree's source is one the repository itself names (an edited plan may not name any other folder: apply
    // would copy it and retire would remove it).
    const real = new Set(fs.existsSync(path.join(r.from, '.git')) ? worktreesOf(commonDir(r.from)).map((x) => path.resolve(x)) : []);
    for (const w of r.worktrees || []) {
      if (!w || typeof w.from !== 'string' || !real.has(path.resolve(w.from))) throw bad('a worktree must be one of its repository\'s own linked worktrees');
      if (!relTo(w.to) || !!w.inside !== rules.within(w.from, r.from)) throw bad('a worktree\'s place is a folder inside the project');
      if (!w.inside) claim(w.to);
    }
  }
  if (p.adds !== undefined) {
    const may = addable();
    if (!Array.isArray(p.adds) || p.adds.some((x) => !may.includes(x)) || new Set(p.adds).size !== p.adds.length) throw bad('"adds" lists files of Hoprig\'s template, each once');
  }
  if (p.copyInstalled !== undefined && typeof p.copyInstalled !== 'boolean') throw bad('"copyInstalled" is true or false');
  if (p.leftOut !== undefined) {
    // Only a folder of installed packages or build output inside a repository or a worktree of the plan (apply asks git
    // again whether it ignores it as a whole): an edited plan cannot leave out anything else.
    const checkouts = p.repos.flatMap((r) => [r.from, ...(r.worktrees || []).map((w) => w.from)]).filter((x) => typeof x === 'string');
    const seenLeft = new Set();
    if (!Array.isArray(p.leftOut) || p.leftOut.length > LEFT_MAX) throw bad('"leftOut" is a list of folders');
    for (const l of p.leftOut) {
      const d = l && l.dir;
      if (typeof d !== 'string' || !path.isAbsolute(d) || path.resolve(d) !== d || !isRebuiltName(path.basename(d)) || seenLeft.has(d)) throw bad('a folder left out is one of installed packages or build output, named once');
      const top = checkouts.find((c) => rules.within(d, c) && path.resolve(d) !== path.resolve(c));
      if (!top || path.relative(top, d).split(path.sep).some((x) => x === '.git' || isPrivate(x))) throw bad(`${d.slice(0, 80)} is not inside a repository of the plan`);
      if (!Number.isFinite(l.bytes) || !Number.isFinite(l.files) || (l.remake !== null && typeof l.remake !== 'string')) throw bad('a folder left out has its size and the command that makes it again');
      seenLeft.add(d);
    }
  }
  const template = templatePlaces(addsOf(p));
  const fold = (x) => (rules.fold ? x.toLowerCase() : x);
  const under = (x, d) => fold(x) === fold(d) || fold(x).startsWith(`${fold(d)}/`);
  const copied = p.repos.flatMap((r) => [r.to, ...(r.worktrees || []).filter((w) => !w.inside).map((w) => w.to)]).filter((x) => typeof x === 'string');
  for (const n of p.neighbours) {
    if (!n || !fromOk(n.from, !!n.private)) throw bad('a neighbour is a path in the scanned folder');
    // Each folder on its way is a real folder, never a link: a copy and a retire must not reach through one.
    const parts = n.from.split('/');
    for (let i = 1; i < parts.length; i++) {
      let st = null;
      try {
        st = fs.lstatSync(path.join(p.from, ...parts.slice(0, i)));
      } catch {
        /* not there: refused below */
      }
      if (!st || !st.isDirectory()) throw bad(`${parts.slice(0, i).join('/')} is not a folder of the scanned folder`);
    }
    if (n.private ? n.to !== n.from || !isPrivate(n.from) : n.to !== null && !relTo(n.to)) throw bad(`a neighbour's place must be a folder inside the project (not ${String(n.to).slice(0, 60)})`);
    // A project in the layout keeps its own files in code/ (its code/.gitignore) at their own place; nothing else goes there.
    if (n.to && (n.to === 'code' || (n.to.startsWith('code/') && !(p.layout && n.to === n.from)))) throw bad(`a neighbour cannot go to ${n.to}`);
    if (n.to) {
      const hit = [...template].find(([rel]) => fold(rel) === fold(n.to));
      if (hit) throw bad(takenWords(n.to, n.from, hit[1]));
      const file = [...template].find(([rel, dir]) => !dir && under(n.to, rel));
      if (file) throw bad(takenWords(file[0], n.from, false));
      const repo = copied.find((c) => c === '.' || under(n.to, c) || under(c, n.to));
      if (repo) throw bad(`${n.to} lies in or around the copy of a repository (${repo}): the plan must put ${path.basename(n.from)} elsewhere`);
      claim(n.to);
    }
  }
  return p;
}
