// Projects: where they live, cloning repositories into that folder, what each one needs (its dependency install,
// its Node version, its .env), and the state of each repository (branch, changes, ahead/behind — counts only).
// A repository address is input from outside (a recipe, the page): parseRepo accepts only plain https and SSH
// Git addresses, so nothing can smuggle in an option, a local path or a command-running transport.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { capture, compareVersions, stream, which } from '../setup/system.mjs';
// (a cycle: layout.mjs takes PRIVATE_DIRS from here; neither uses the other while it loads)
import { defaultProjectsDir } from '../workspace/layout.mjs';

/**
 * The projects folder: remembered in config.json ("projectsDir"), else <workspace>/projects (a computer that
 * already keeps them in ~/projects, the earlier default, keeps them there: workspace/layout.mjs).
 */
export function projectsDir(cfg) {
  let c = cfg;
  try {
    c = c || loadConfig();
    if (typeof c.projectsDir === 'string' && path.isAbsolute(c.projectsDir)) return c.projectsDir;
  } catch {
    c = {}; // unreadable settings: the default
  }
  return defaultProjectsDir(c);
}

/** "~/x" → absolute; an absolute path stays; anything else (relative, NUL, "..") → null. */
export function expandDir(input, home = os.homedir()) {
  const s = String(input || '').trim();
  if (!s || s.includes('\0') || s.split(/[\\/]/).includes('..')) return null;
  if (s === '~') return home;
  if (s.startsWith('~/')) return path.join(home, s.slice(2));
  return path.isAbsolute(s) ? path.normalize(s) : null;
}

/**
 * Remember the projects folder and make it the first root of the dashboard's folder picker (the roots that were
 * there stay; with none set, the home folder stays reachable too).
 */
export function rememberDir(dir, { load = loadConfig, save = saveConfig, home = os.homedir() } = {}) {
  const cfg = load();
  const roots = Array.isArray(cfg.server && cfg.server.roots) && cfg.server.roots.length ? cfg.server.roots : [home];
  const next = [dir, ...roots.filter((r) => r !== dir)];
  save({ projectsDir: dir, server: { roots: next } });
  return next;
}

const SEG = /^[A-Za-z0-9._-]{1,100}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;

/**
 * A Git address from what a person typed: "owner/repo", "https://host/owner/repo(.git)", "git@host:owner/repo.git"
 * or "ssh://git@host/owner/repo.git". Returns { url, name } or null. Refused: anything starting with "-", user
 * names or passwords in https addresses (a token would end up in a file), file:// and other transports, local
 * paths, "..", spaces and control characters.
 */
export function parseRepo(input) {
  const s = String(input || '').trim();
  if (!s || s.length > 300 || /[\s\0-\x1f\x7f]/.test(s) || s.startsWith('-')) return null;
  const okPath = (p) => {
    const parts = p.replace(/\.git$/, '').split('/');
    return parts.length >= 2 && parts.every((x) => SEG.test(x) && x !== '.' && x !== '..') ? parts : null;
  };
  const named = (parts, url) => ({ url, name: parts[parts.length - 1] });
  let m = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  if (m && !['.', '..'].includes(m[2])) {
    const repo = m[2].replace(/\.git$/, '');
    return { url: `https://github.com/${m[1]}/${repo}.git`, name: repo };
  }
  m = /^https:\/\/([^/@?#]+)\/([^?#]+?)\/?$/.exec(s);
  if (m && HOST.test(m[1])) {
    const parts = okPath(m[2]);
    return parts ? named(parts, s.replace(/\/$/, '')) : null;
  }
  m = /^([A-Za-z0-9_.-]{1,32})@([A-Za-z0-9.-]{1,253}):([^?#]+)$/.exec(s);
  if (m && !m[3].startsWith('/') && !m[3].startsWith('-')) {
    const parts = okPath(m[3]);
    return parts ? named(parts, s) : null;
  }
  m = /^ssh:\/\/([A-Za-z0-9_.-]{1,32}@)?([A-Za-z0-9.-]{1,253}(?::\d{1,5})?)\/([^?#]+)$/.exec(s);
  if (m) {
    const parts = okPath(m[3]);
    return parts ? named(parts, s) : null;
  }
  return null;
}

/** A remote address with any user name or password taken out (what a recipe may keep). */
export function cleanRemote(url) {
  const s = String(url || '').trim();
  const m = /^(https?:\/\/)[^/@]*@(.*)$/.exec(s);
  return m ? m[1] + m[2] : s;
}

/** What a cloned project needs: { installs: [{ label, argv, ready, why }], node: { wants, have, ok } | null, envExample }. */
export function projectNeeds(dir, { has = (c) => !!which(c), nodeVersion = process.versions.node, exists = (f) => fs.existsSync(path.join(dir, f)), read = (f) => fs.readFileSync(path.join(dir, f), 'utf8') } = {}) {
  const installs = [];
  const add = (label, argv, tool) => installs.push({ label, argv, ready: has(tool), why: has(tool) ? '' : `${tool} is not installed` });
  if (exists('package.json')) {
    if (exists('pnpm-lock.yaml')) add('pnpm install', ['pnpm', 'install', '--frozen-lockfile'], 'pnpm');
    else if (exists('yarn.lock')) add('yarn install', ['yarn', 'install'], 'yarn');
    else if (exists('bun.lock') || exists('bun.lockb')) add('bun install', ['bun', 'install'], 'bun');
    else if (exists('package-lock.json')) add('npm ci', ['npm', 'ci'], 'npm');
    else add('npm install', ['npm', 'install'], 'npm');
  }
  if (exists('uv.lock')) add('uv sync', ['uv', 'sync'], 'uv');
  else if (exists('poetry.lock')) add('poetry install', ['poetry', 'install'], 'poetry');
  else if (exists('requirements.txt')) add('a .venv with requirements.txt', ['sh', '-c', 'python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt'], 'python3');
  if (exists('Gemfile.lock')) add('bundle install', ['bundle', 'install'], 'bundle');
  if (exists('composer.lock')) add('composer install', ['composer', 'install'], 'composer');
  if (exists('go.mod')) add('go mod download', ['go', 'mod', 'download'], 'go');
  if (exists('Cargo.lock')) add('cargo fetch', ['cargo', 'fetch'], 'cargo');

  let wants = null;
  if (exists('.nvmrc')) wants = read('.nvmrc').trim().split(/\s/)[0] || null;
  else if (exists('.node-version')) wants = read('.node-version').trim() || null;
  else if (exists('package.json')) {
    try {
      const e = JSON.parse(read('package.json')).engines;
      if (e && typeof e.node === 'string') wants = e.node;
    } catch {
      /* not valid JSON: npm will say so */
    }
  }
  const node = wants ? { wants: wants.slice(0, 40), have: nodeVersion, ok: nodeSatisfies(nodeVersion, wants) } : null;
  return { installs, node, envExample: exists('.env.example') && !exists('.env') };
}

/** A rough check of "18", "v20.1", ">=18", "^20", "20.x", "lts/*": the common forms; anything else counts as fine. */
export function nodeSatisfies(have, wants) {
  const w = String(wants).trim().replace(/^v/, '');
  if (/^lts\//.test(w) || w === 'node' || w === '*') return true;
  let m = /^>=\s*v?(\d+(?:\.\d+){0,2})$/.exec(w);
  if (m) return compareVersions(have, m[1].split('.').length === 1 ? `${m[1]}.0.0` : m[1]) >= 0;
  m = /^[\^~]?v?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?$/.exec(w);
  if (m) return Number(have.split('.')[0]) === Number(m[1]);
  return true;
}

// Folders that hold a person's private notes (and that AI tools must never read): hoprig never looks inside
// them, not even to count changes.
export const PRIVATE_DIRS = ['no-ai', 'ignore', 'ai-ignore-dir'];
// A status must not change anything: no optional locks, so git does not rewrite the index while it looks.
export const READ_ONLY_GIT = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
/**
 * `git status` for counts only, never looking into a private folder at any depth. Every new file counts on its own
 * (not a new folder as one), as the code editor's Source Control lists them, so "N changes" is the same number there.
 */
export const statusArgv = (dir) => ['git', '-C', dir, 'status', '--porcelain=v1', '-b', '--untracked-files=all', '--', '.', ...PRIVATE_DIRS.map((d) => `:(exclude,glob)**/${d}/**`)];

/** "## main...origin/main [ahead 1, behind 2]" + porcelain lines → { branch, upstream, ahead, behind, changes }. */
export function parseStatus(text) {
  const lines = String(text || '').split('\n').filter(Boolean);
  const head = lines[0] && lines[0].startsWith('## ') ? lines.shift().slice(3) : '';
  let branch = head;
  let upstream = null;
  const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
  if (m) {
    branch = m[1];
    upstream = m[2] || null;
  }
  if (/^No commits yet on /.test(branch)) branch = branch.replace(/^No commits yet on /, '');
  if (/^HEAD \(no branch\)/.test(branch)) branch = '(detached)';
  const ahead = Number((/ahead (\d+)/.exec(head) || [])[1] || 0);
  const behind = Number((/behind (\d+)/.exec(head) || [])[1] || 0);
  return { branch, upstream, ahead, behind, changes: lines.length };
}

/** The state of one repository folder (counts only; no file names, no diffs). */
export async function repoState(dir, run = capture) {
  const r = await run(statusArgv(dir), { timeout: 15_000, env: READ_ONLY_GIT });
  if (!r.ok) return { dir, ok: false, error: (r.stderr || 'not a git repository').trim().split('\n')[0] };
  return { dir, ok: true, ...parseStatus(r.stdout) };
}

/** Folders in the projects folder that are git repositories (one level). */
export function listRepos(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !PRIVATE_DIRS.includes(d.name) && fs.existsSync(path.join(dir, d.name, '.git'))).map((d) => path.join(dir, d.name)).sort();
}

/**
 * Clone `url` into `<dir>/<name>`. Never into a folder that already exists. With `quiet`, git may not ask for a
 * password on the terminal (the dashboard has none). Resolves { ok, dest, skipped?, output }.
 */
export async function cloneRepo(repo, dir, { onLine = () => {}, quiet = false, run = stream, name, env: extra = {} } = {}) {
  const dest = path.join(dir, name || repo.name);
  if (fs.existsSync(dest)) {
    onLine(`${dest} is already there: left as it is.`);
    return { ok: true, dest, skipped: true };
  }
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, ...(quiet ? { GIT_TERMINAL_PROMPT: '0' } : {}), ...extra };
  const r = await run(['git', 'clone', '--', repo.url, dest], { env, onLine, interactive: false });
  return { ok: r.ok, dest, output: r.output };
}

/** After a clone: copy .env.example to .env when there is none. Says what it did. */
export function prepareEnv(dest, onLine = () => {}) {
  const ex = path.join(dest, '.env.example');
  const env = path.join(dest, '.env');
  if (fs.existsSync(ex) && !fs.existsSync(env)) {
    fs.copyFileSync(ex, env, fs.constants.COPYFILE_EXCL);
    onLine(`Copied .env.example to .env in ${path.basename(dest)}: fill in its values.`);
    return true;
  }
  return false;
}

/** The repository addresses of the projects (origin, cleaned), for a recipe. */
export async function projectRemotes(dir, run = capture) {
  const out = [];
  for (const repo of listRepos(dir)) {
    const r = await run(['git', '-C', repo, 'config', '--get', 'remote.origin.url']);
    const url = cleanRemote(r.stdout.trim());
    if (r.ok && parseRepo(url)) out.push(url);
  }
  return out;
}
