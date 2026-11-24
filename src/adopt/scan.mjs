// Look (hoprig adopt scan): what a computer that already has projects holds, in the places its owner named. It changes
// nothing: folders are listed and stat'ed, git is asked only through the reader (gitread.mjs: no optional
// locks, so a status does not rewrite the index; none of the folder's own programs run), and a scan never fetches, so ahead and behind are as of
// the last fetch. A private folder (PRIVATE_DIRS) is never entered and nothing in it is named: it is counted.
//
// A project is a folder directly in a scanned place that is a repository, holds repositories, or has a project's own
// signs (package.json and the like); everything else in it is its neighbours (because that is how
// the hand-arranged computers looked, one folder per project with its repositories and its notes beside them).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { PRIVATE_DIRS, STATUS_ARGS, STATUS_EXCLUDES, parseStatus } from '../pcsetup/projects.mjs';
import { MANIFEST, validateManifest } from '../pcsetup/workspace.mjs';

/** Folders a scan never goes into: installed packages and build output (their size is not the project's). */
export const SKIP_DIRS = new Set(['node_modules', 'bower_components', 'vendor', '.venv', 'venv', '__pycache__', '.dart_tool', '.gradle', 'Pods', '.next', '.nuxt', '.turbo', '.cache', 'dist', 'build', 'target', 'out', 'obj', '.pub-cache', '.terraform']);
/** A project's own signs: a file of one of these names, or one with one of these endings. */
export const SIGNS = ['package.json', 'pubspec.yaml', 'composer.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'deno.json', 'Makefile', 'CMakeLists.txt'];
export const SIGN_ENDINGS = ['.sln', '.csproj', '.xcodeproj'];
/** The AI tools' own folders and files, found beside a project's repositories. */
export const AI_NAMES = ['.claude', '.kiro', '.cursor', '.codex', '.windsurf', '.opencode', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules'];
/** Files changed within this long make a copy unsafe now (someone may still be writing). */
export const RECENT_MS = 60 * 60 * 1000;

const isPrivate = (name) => PRIVATE_DIRS.includes(name) || PRIVATE_DIRS.includes(name.toLowerCase());
const hasSign = (names) => names.some((n) => SIGNS.includes(n) || SIGN_ENDINGS.some((e) => n.endsWith(e)));

/** A remote address without any sign-in part (a user name or token before "@" in a scheme://address). */
export function noSignIn(url) {
  const s = String(url || '').trim();
  const m = /^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@(.*)$/i.exec(s);
  return m ? m[1] + m[2] : s;
}

function list(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Walk `dir` without following links, never into SKIP_DIRS or a private folder. → { bytes, files, recent, privates,
 * newest }: the size without dependencies, files changed after `since`, private folders counted (not named).
 */
export function walk(dir, { since = 0 } = {}) {
  const out = { bytes: 0, files: 0, recent: 0, privates: 0, newest: 0 };
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of list(d)) {
      if (e.isDirectory()) {
        if (isPrivate(e.name)) out.privates++;
        else if (!SKIP_DIRS.has(e.name)) stack.push(path.join(d, e.name));
        continue;
      }
      let st;
      try {
        st = fs.lstatSync(path.join(d, e.name));
      } catch {
        continue;
      }
      out.files++;
      out.bytes += st.size;
      if (st.mtimeMs > out.newest) out.newest = st.mtimeMs;
      if (st.mtimeMs > since && !d.split(path.sep).includes('.git')) out.recent++;
    }
  }
  return out;
}

/** The repository's common git folder (the main one for a linked worktree), read from the files only. */
export function commonDir(repo) {
  const dot = path.join(repo, '.git');
  let st;
  try {
    st = fs.lstatSync(dot);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dot;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
    if (!m) return null;
    const gd = path.resolve(repo, m[1].trim());
    const cf = path.join(gd, 'commondir');
    return fs.existsSync(cf) ? path.resolve(gd, fs.readFileSync(cf, 'utf8').trim()) : gd;
  } catch {
    return null;
  }
}

const countLines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

/** The linked worktrees of a repository (their folders), from <common>/worktrees/<name>/gitdir. */
export function worktreesOf(common) {
  const out = [];
  for (const e of list(path.join(common, 'worktrees'))) {
    try {
      const gd = fs.readFileSync(path.join(common, 'worktrees', e.name, 'gitdir'), 'utf8').trim();
      out.push(path.dirname(path.resolve(path.join(common, 'worktrees', e.name), gd)));
    } catch {
      /* a broken entry: git worktree prune would remove it */
    }
  }
  return out.sort();
}

const EOL_FILES_MAX = 500;
const EOL_SIZE_MAX = 3 << 20;
/** git's id of a blob with `buf` as its content (sha1 or sha256, by the id's length). */
const blobId = (buf, len) => crypto.createHash(len === 64 ? 'sha256' : 'sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

/**
 * Of the files git status shows as changed in the working tree only, those whose content differs from the index only
 * in line endings (core.autocrlf: status lists them, a diff may be empty). Such a file is one that git add would store
 * as the index already has it: git turns CRLF into LF on add only for a file it converts (a text or eol attribute, or
 * core.autocrlf true or input without an attribute that says -text), and only for text (no NUL byte). So the working
 * file, with CRLF made LF where git would do that, is hashed here and compared with the index entry's id; any other
 * file counts as a real change. Nothing is written and no filter runs.
 */
export async function lineEndingsOnly(dir, opts = {}) {
  const st = await gitRead(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--', '.', ...STATUS_EXCLUDES], opts);
  if (!st.ok) return 0;
  const parts = st.stdout.split('\0');
  const changed = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    if (e[0] === 'R' || e[0] === 'C') i++; // its old name follows
    else if (e[0] === ' ' && e[1] === 'M') changed.push(e.slice(3));
  }
  if (!changed.length || changed.length > EOL_FILES_MAX) return 0;
  const ac = await gitRead(dir, ['config', '--get', 'core.autocrlf'], opts);
  const autocrlf = ac.ok && ['true', 'yes', 'on', '1', 'input'].includes(ac.stdout.trim().toLowerCase());
  const idx = await gitRead(dir, ['ls-files', '--stage', '--eol', '-z'], opts);
  if (!idx.ok) return 0;
  const ids = new Map();
  for (const l of idx.stdout.split('\0')) {
    // "<mode> <id> <stage>\ti/<eol> w/<eol> attr/<attributes>\t<name>"
    const m = /^\d+ ([0-9a-f]{40,64}) 0\ti\/(\S*)\s+w\/(\S*)\s+attr\/(.*?)\s*\t(.+)$/s.exec(l);
    if (m) ids.set(m[5], { id: m[1], i: m[2], w: m[3], attr: m[4] });
  }
  let n = 0;
  for (const f of changed) {
    const e = ids.get(f);
    if (!e) continue;
    const attr = e.attr.split(/\s+/).filter(Boolean);
    // Only `text` set on the file makes git convert it whatever it holds. Under text=auto, an eol attribute or
    // core.autocrlf alone, git converts only what it sees as text: a file with a lone CR or a NUL ("-text" in the index
    // or the working tree, as ls-files --eol says) is stored as it is, so its change is a real one.
    const forced = attr.includes('text');
    const auto = !attr.includes('-text') && (attr.some((a) => a.startsWith('text=') || a.startsWith('eol=')) || autocrlf);
    const converts = forced || (auto && e.w !== '-text' && e.i !== '-text');
    if (!converts) continue; // git add stores the bytes as they are: a file status lists differs in its content
    let buf;
    try {
      const fst = fs.lstatSync(path.join(dir, f));
      if (!fst.isFile() || fst.size > EOL_SIZE_MAX) continue;
      buf = fs.readFileSync(path.join(dir, f));
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // not text: git converts nothing
    const lf = Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    if (blobId(lf, e.id.length) === e.id) n++;
  }
  return n;
}

/** The counts and states of one repository (no file names, no contents). `run`: capture's shape, for tests. */
export async function repoFacts(dir, { run, now = Date.now() } = {}) {
  const opts = run ? { run } : {};
  const facts = { dir, ok: true };
  const st = await gitRead(dir, STATUS_ARGS, opts);
  if (!st.ok) return { dir, ok: false, error: (st.stderr || 'not a git repository').trim().split('\n')[0] };
  const s = parseStatus(st.stdout);
  // What really differs is counted; files that differ in line endings only are counted apart (never "fixed").
  const eolOnly = s.changes ? await lineEndingsOnly(dir, opts) : 0;
  Object.assign(facts, { branch: s.branch, upstream: s.upstream, ahead: s.ahead, behind: s.behind, uncommitted: s.changes - eolOnly, eolOnly });
  const url = await gitRead(dir, ['config', '--get', 'remote.origin.url'], opts);
  facts.remote = url.ok && url.stdout.trim() ? noSignIn(url.stdout) : null;
  const heads = await gitRead(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads'], opts);
  const branches = heads.ok ? heads.stdout.split('\n').filter(Boolean).length : 0;
  facts.otherBranches = Math.max(0, branches - (s.branch && s.branch !== '(detached)' ? 1 : 0));
  const common = commonDir(dir);
  facts.stashes = common ? countLines(path.join(common, 'logs', 'refs', 'stash')) : 0;
  facts.worktrees = common ? worktreesOf(common).length : 0;
  facts.linked = !!common && path.resolve(common) !== path.resolve(dir, '.git');
  const w = walk(dir, { since: now - RECENT_MS });
  Object.assign(facts, { bytes: w.bytes, files: w.files, recent: w.recent, privates: w.privates });
  return facts;
}

/** The repositories in a project folder: itself, or its sub-folders down to `depth` (never into skipped ones). */
export function reposIn(dir, depth = 3) {
  if (fs.existsSync(path.join(dir, '.git'))) return [dir];
  return reposBelow(dir, depth);
}

/** The repositories in the sub-folders of `dir` down to `depth`, whether or not `dir` is one itself. */
export function reposBelow(dir, depth = 3) {
  if (depth <= 0) return [];
  const out = [];
  for (const e of list(dir)) {
    if (!e.isDirectory() || isPrivate(e.name) || SKIP_DIRS.has(e.name) || e.name === '.git') continue;
    out.push(...reposIn(path.join(dir, e.name), depth - 1));
  }
  return out;
}

/**
 * What lies beside the repositories of the project folder `dir`, at every folder level between it and each repository
 * (a repository in apps/site leaves apps/notes.md and apps/assets beside it). `repoDirs`: every repository folder found
 * (a linked worktree too). → [{ rel, name, isDir }]: the entries that are neither a repository nor a folder on the way
 * to one; a private folder is one entry and is never entered.
 */
export function besideRepos(dir, repoDirs) {
  const rels = repoDirs.map((r) => path.relative(dir, r).split(path.sep).join('/')).filter(Boolean);
  if (rels.length !== repoDirs.length) return []; // the folder is itself a repository: everything in it is the repository's
  const out = [];
  const walk = (relDir) => {
    for (const e of list(relDir ? path.join(dir, relDir) : dir).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (rels.includes(rel)) continue;
      if (e.isDirectory() && !isPrivate(e.name) && rels.some((r) => r.startsWith(`${rel}/`))) walk(rel);
      else out.push({ rel, name: e.name, isDir: e.isDirectory() });
    }
  };
  walk('');
  return out;
}

/** True when `d` holds a git folder of its own (a folder, not the ".git" file of a submodule or a linked worktree). */
const ownGit = (d) => {
  try {
    return fs.lstatSync(path.join(d, '.git')).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (f) => {
  try {
    const st = fs.lstatSync(f);
    return st.isFile() && st.size < 1 << 20;
  } catch {
    return false;
  }
};

/**
 * A parent that already has Hoprig's layout, known only by Hoprig's own marks: a repository in code/ with a git folder
 * of its own, AND either a project.json that the product's own reader takes with no key it does not know, or the
 * template's own pair (AGENTS.md and code/.gitignore). Anything else is planned as the repository or the folder it is:
 * a project.json of another tool (an Nx app) or an AGENTS.md beside a submodule in code/ is not the layout, and taking
 * it for one would leave the folder's own history behind.
 */
export function hasLayout(dir) {
  const code = path.join(dir, 'code');
  if (!list(code).some((e) => e.isDirectory() && !isPrivate(e.name) && ownGit(path.join(code, e.name)))) return false;
  if (isFile(path.join(dir, MANIFEST))) {
    try {
      const v = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')));
      if (v.ok && !v.warnings.length) return true;
    } catch {
      /* not JSON: not Hoprig's */
    }
  }
  return isFile(path.join(dir, 'AGENTS.md')) && isFile(path.join(code, '.gitignore'));
}

/**
 * The repositories of a project folder. A parent in the layout may be a repository itself (the layout Hoprig makes
 * is one): its repositories are those below it, in code/ and beside; its own history is not one of them (the new
 * project starts its own, and the old one stays where it is).
 */
export const projectRepos = (dir) => (hasLayout(dir) ? reposBelow(dir) : reposIn(dir));

/**
 * Scan the places `places` (folders the owner named or confirmed). → { places: [{ dir, ok, error? }], projects: [{
 * name, dir, layout, repos: [facts], ai: [names], neighbours: [names], privates }], privates }.
 */
export async function scanPlaces(places, { run, now = Date.now() } = {}) {
  const out = { places: [], projects: [], privates: 0 };
  for (const p of places) {
    const dir = path.resolve(p);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      out.places.push({ dir, ok: false, error: 'not there' });
      continue;
    }
    if (!st.isDirectory()) {
      out.places.push({ dir, ok: false, error: 'not a folder' });
      continue;
    }
    out.places.push({ dir, ok: true });
    for (const e of list(dir).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory()) continue;
      if (isPrivate(e.name)) {
        out.privates++;
        continue;
      }
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      const pdir = path.join(dir, e.name);
      const names = list(pdir).map((x) => x.name);
      const found = projectRepos(pdir);
      if (!found.length && !hasSign(names)) continue;
      // A linked worktree of a repository of this project is that repository's second checkout: counted under it
      // (its worktrees), never listed as a repository of its own.
      const own = new Set(found.filter((r) => fs.lstatSync(path.join(r, '.git')).isDirectory()).flatMap((r) => worktreesOf(path.join(r, '.git')).map((w) => path.resolve(w))));
      const repoDirs = found.filter((r) => !own.has(path.resolve(r)));
      const repos = [];
      for (const r of repoDirs) repos.push(await repoFacts(r, { run, now }));
      // What lies beside the repositories, at every level down to each; a project that IS its repository has none.
      const beside = besideRepos(pdir, found);
      out.projects.push({
        name: e.name,
        dir: pdir,
        layout: hasLayout(pdir),
        repos,
        ai: names.filter((n) => AI_NAMES.includes(n)).sort(),
        neighbours: beside.filter((b) => b.name !== '.git' && !isPrivate(b.name) && !(b.rel === b.name && AI_NAMES.includes(b.name))).map((b) => b.rel).sort(),
        privates: names.filter(isPrivate).length,
      });
    }
  }
  return out;
}
