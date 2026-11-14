// Project workspaces: one private PARENT repository per project (rules, AI memory, docs, decisions) with each
// product in its OWN repository under code/, all synced through git:
//
//   <projects folder>/<project>/        the parent repo
//     AGENTS.md  CLAUDE.md …            the instructions for AI tools (CLAUDE.md etc. point to AGENTS.md)
//     ai_brain/claude-memory/           Claude Code's memory for the project, linked from ~/.claude/projects/<slug>/memory
//     project.json                      the manifest: { name, repos: [{ dir, url, branch? }], memories: { launch: memory } }
//     code/<project>-<stack>/           each one its own git repository (code/ itself tracks only its .gitignore)
//
// The manifest lists the child repositories and where each folder's Claude Code memory lives. A parent without
// project.json is understood from what is there: code/* repositories and ai_brain/claude-memory.json.
//
// Commands used (checked against `gh help` of gh 2.103 and https://cli.github.com/manual):
//   gh repo create <owner>/<name> --private --source <dir> --remote origin --push
//   gh repo list <owner> --json name,url,isPrivate --limit 1000
//   gh api user --jq .login,  gh api user/orgs --jq .[].login
// Claude Code's memory folder (https://code.claude.com/docs/en/memory, "Storage location"): ~/.claude/projects/<project>/memory,
// <project> derived from the git repository's folder; `autoMemoryDirectory` in any settings scope moves it.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir } from '../paths.mjs';
import { projectSlug } from '../sessions.mjs';
import { capture, stream } from '../setup/system.mjs';
import { PRIVATE_DIRS, READ_ONLY_GIT, cleanRemote, parseRepo, parseStatus, statusArgv } from './projects.mjs';

export { PRIVATE_DIRS };

export const MANIFEST = 'project.json';
export const MEMORY_FILE = 'ai_brain/claude-memory.json';
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REL_RE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._\/-]{1,200}$/;

/** A relative folder inside the project ("." allowed for memories' launch folder). */
export const relOk = (p, { dot = false } = {}) => typeof p === 'string' && ((dot && p === '.') || (REL_RE.test(p) && !p.split('/').some((s) => PRIVATE_DIRS.includes(s))));

/** Strict check of a manifest (it comes from a repository someone else may write). */
export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['project.json is not an object'] };
  for (const k of Object.keys(m)) if (!['name', 'repos', 'memories'].includes(k)) errors.push(`unknown key "${String(k).slice(0, 30)}"`);
  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) errors.push('"name" must be a plain project name');
  const repos = [];
  if (m.repos !== undefined && !Array.isArray(m.repos)) errors.push('"repos" must be a list');
  for (const r of m.repos || []) {
    if (!r || typeof r !== 'object' || Object.keys(r).some((k) => !['dir', 'url', 'branch'].includes(k))) {
      errors.push('each repo is { dir, url, branch? }');
      continue;
    }
    if (!relOk(r.dir) || r.dir === MANIFEST) errors.push(`"${String(r.dir).slice(0, 60)}" is not a folder inside the project`);
    else if (!parseRepo(r.url)) errors.push(`"${String(r.url).slice(0, 80)}" is not a Git address Hoprig accepts`);
    else if (r.branch !== undefined && (typeof r.branch !== 'string' || !/^[A-Za-z0-9._\/-]{1,100}$/.test(r.branch) || r.branch.startsWith('-'))) errors.push(`bad branch for ${r.dir}`);
    else repos.push({ dir: r.dir, url: r.url, ...(r.branch ? { branch: r.branch } : {}) });
  }
  const memories = {};
  if (m.memories !== undefined && (!m.memories || typeof m.memories !== 'object' || Array.isArray(m.memories))) errors.push('"memories" must be an object');
  for (const [k, v] of Object.entries(m.memories || {})) {
    if (!relOk(k, { dot: true }) || !relOk(v)) errors.push(`memory "${String(k).slice(0, 40)}" → "${String(v).slice(0, 40)}" must be folders inside the project`);
    else memories[k] = v;
  }
  return errors.length ? { ok: false, errors } : { ok: true, manifest: { name: m.name, repos, memories } };
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const isRepo = (d) => fs.existsSync(path.join(d, '.git'));

/** Child repositories found under code/ (one level), with their origin addresses. */
export async function discoverChildren(root, run = capture) {
  const code = path.join(root, 'code');
  let names = [];
  try {
    names = fs.readdirSync(code, { withFileTypes: true }).filter((d) => d.isDirectory() && !PRIVATE_DIRS.includes(d.name) && isRepo(path.join(code, d.name))).map((d) => d.name).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async (n) => {
    const r = await run(['git', '-C', path.join(code, n), 'config', '--get', 'remote.origin.url']);
    const url = cleanRemote(r.stdout.trim());
    return { dir: `code/${n}`, url: r.ok && parseRepo(url) ? url : null };
  }));
}

/**
 * The project's manifest: project.json when it is there (validated), else what the folder shows (code/*
 * repositories, memories from ai_brain/claude-memory.json, or "." → ai_brain/claude-memory when that folder exists).
 * { manifest, source: 'project.json' | 'found', errors? }
 */
export async function readManifest(root, run = capture) {
  const j = readJson(path.join(root, MANIFEST));
  if (j) {
    const v = validateManifest(j);
    if (!v.ok) return { manifest: null, source: MANIFEST, errors: v.errors };
    const mem = readJson(path.join(root, MEMORY_FILE));
    if (!Object.keys(v.manifest.memories).length && mem && mem.memories) v.manifest.memories = validateManifest({ name: v.manifest.name, memories: mem.memories }).manifest?.memories || {};
    return { manifest: v.manifest, source: MANIFEST };
  }
  const name = path.basename(root);
  const kids = await discoverChildren(root, run);
  const mem = readJson(path.join(root, MEMORY_FILE));
  let memories = {};
  if (mem && mem.memories) memories = validateManifest({ name: NAME_RE.test(name) ? name : 'x', memories: mem.memories }).manifest?.memories || {};
  else if (fs.existsSync(path.join(root, 'ai_brain', 'claude-memory'))) memories = { '.': 'ai_brain/claude-memory' };
  return { manifest: { name, repos: kids.filter((k) => k.url).map((k) => ({ dir: k.dir, url: k.url })), memories, localOnly: kids.filter((k) => !k.url).map((k) => k.dir) }, source: 'found' };
}

/** Write project.json, and keep ai_brain/claude-memory.json's "memories" the same when that file exists. */
export function writeManifest(root, manifest) {
  const { name, repos, memories } = manifest;
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify({ name, repos, memories }, null, 2) + '\n');
  const memFile = path.join(root, MEMORY_FILE);
  const mem = readJson(memFile);
  if (mem && typeof mem === 'object' && JSON.stringify(mem.memories) !== JSON.stringify(memories)) {
    fs.writeFileSync(memFile, JSON.stringify({ ...mem, memories }, null, 2) + '\n');
  }
}

// ---------- the template ----------

/** The built-in template: small and neutral; every "{{project}}" becomes the project's name. */
export const BUILTIN_TEMPLATE = {
  'AGENTS.md': `# {{Project}}

The one place for instructions to AI coding tools (Claude Code, Codex, Gemini, Cursor, Copilot). The other
instruction files only point here. Keep it short and true; edit it as the project grows.

## What this repository is
The parent of the {{project}} project: rules, decisions, docs and the AI memory. The code lives in its own
repositories under \`code/\` (listed in \`project.json\`).

## Where things are
- \`code/<repo>/\`             each product, its own git repository
- \`docs/\`                    documentation; \`decisions.md\` for decisions and why
- \`ai_brain/\`                learnings, the current context, the AI memory (synced with git)
- \`test-data/\`               local test data; never committed, never read by AI tools

## How to verify a change
- (write the commands here: tests, lint, build)

## Working rules
- Prove the most important case first, then the rest side by side. Estimate before anything long.
- Done means proven: run the check before saying it works; report a skip as a skip.
- The fast model for running and recording, the strong one for writing and reviewing code, the strongest
  for an unknown cause or a design decision. Effort high only where thinking decides the result.
- Ask before anything hard to undo or that others see. Never print or commit a secret.

## Conventions
- Small commits with plain messages. Never commit a secret (.env stays out of git).
`,
  'CLAUDE.md': '@AGENTS.md\n\nAll rules for this project live in AGENTS.md.\n',
  'GEMINI.md': 'All rules for this project live in AGENTS.md. Read it first.\n',
  '.claudeignore': 'test-data/\n.env\n.env.*\n',
  '.aiignore': 'test-data/\n.env\n.env.*\n',
  '.cursorignore': 'test-data/\n.env\n.env.*\n',
  '.copilotignore': 'test-data/\n.env\n.env.*\n',
  '.geminiignore': 'test-data/\n.env\n.env.*\n',
  '.claude/settings.json': `${JSON.stringify({ permissions: { deny: ['Read(./test-data/**)', 'Read(./.env)', 'Read(./.env.*)'] } }, null, 2)}\n`,
  '.gitignore': '/code/*\n!/code/.gitignore\n/test-data/\n.env\n.env.*\n.claude/settings.local.json\n',
  'code/.gitignore': '*\n!.gitignore\n',
  'ai_brain/learnings.md': '# Learnings\n\nWhat we learned the hard way, one line each.\n',
  'ai_brain/active_context.md': '# Active context\n\nWhat is being worked on now.\n',
  'ai_brain/daily_logs/.gitkeep': '',
  'ai_brain/claude-memory/.gitkeep': '',
  'ai_brain/claude-memory.json': `${JSON.stringify({ memories: { '.': 'ai_brain/claude-memory' } }, null, 2)}\n`,
  'docs/README.md': '# {{Project}} docs\n',
  'decisions.md': '# Decisions\n\nOne entry per decision: the date, what was decided, and why.\n',
};

export const fillName = (text, name) => text.replace(/\{\{project\}\}/g, name).replace(/\{\{Project\}\}/g, name.charAt(0).toUpperCase() + name.slice(1));

/**
 * The files of a custom template folder: [{ rel, kind: 'file' | 'link', data | target }]. Refused: absolute or ".."
 * paths, symlinks that point outside the template, the owner's private folders. `.git` is skipped.
 */
export function readTemplate(dir) {
  const base = fs.realpathSync(dir);
  const out = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
      if (d.name === '.git' || PRIVATE_DIRS.includes(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      const full = path.join(base, r);
      if (d.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        const resolved = path.resolve(path.dirname(full), target);
        if (path.isAbsolute(target) || !(resolved === base || resolved.startsWith(base + path.sep))) throw new Error(`the template's link ${r} points outside the template`);
        out.push({ rel: r, kind: 'link', target });
      } else if (d.isDirectory()) walk(r);
      else if (d.isFile()) out.push({ rel: r, kind: 'file', data: fs.readFileSync(full) });
    }
  };
  walk('');
  return out;
}

/** Write template files into `dest` (which must not exist yet). Names and text get the project's name. */
export function writeTemplate(dest, files, name) {
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists: choose another name`);
  fs.mkdirSync(dest, { recursive: true });
  const root = fs.realpathSync(dest);
  for (const f of files) {
    const rel = fillName(f.rel, name);
    const full = path.resolve(root, rel);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !full.startsWith(root + path.sep)) throw new Error(`the template file ${rel} would land outside the project`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (f.kind === 'link') fs.symlinkSync(f.target, full);
    else {
      const buf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
      fs.writeFileSync(full, buf.includes(0) ? buf : fillName(buf.toString('utf8'), name));
    }
  }
  return root;
}

export const builtinFiles = () => Object.entries(BUILTIN_TEMPLATE).map(([rel, data]) => ({ rel, kind: 'file', data }));

// ---------- memory links ----------

export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/** Copy every file of `from` into `to`, never overwriting: a name that is taken gets ".from-<stamp>" added. */
export function mergeInto(from, to, tag) {
  let moved = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const d of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, d.name);
    let dst = path.join(to, d.name);
    if (d.isDirectory()) {
      moved += mergeInto(src, dst, tag);
      continue;
    }
    if (fs.existsSync(dst)) {
      if (fs.readFileSync(dst).equals(fs.readFileSync(src))) continue;
      const ext = path.extname(d.name);
      dst = path.join(to, `${path.basename(d.name, ext)}.from-${tag}${ext}`);
    }
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    moved++;
  }
  return moved;
}

/**
 * Link Claude Code's memory for each launch folder to the folder in the repository. What is done per entry:
 * linked | already | moved+linked (a real folder's files were merged in; the folder is kept as a dated backup) |
 * setting (Windows without links: autoMemoryDirectory in <launch>/.claude/settings.local.json) | conflict (a link to
 * somewhere else is there: left alone, the command to change it is given).
 */
export function linkMemories(root, memories, { base = claudeDir(), platform = process.platform, now = new Date() } = {}) {
  const out = [];
  for (const [launch, memDir] of Object.entries(memories)) {
    const launchAbs = launch === '.' ? root : path.join(root, launch);
    const repoMem = path.join(root, memDir);
    const link = path.join(base, 'projects', projectSlug(launchAbs), 'memory');
    fs.mkdirSync(repoMem, { recursive: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    let st = null;
    try {
      st = fs.lstatSync(link);
    } catch {
      /* nothing there */
    }
    let what = 'linked';
    if (st && st.isSymbolicLink()) {
      const to = path.resolve(path.dirname(link), fs.readlinkSync(link));
      if (to === repoMem || safeReal(to) === safeReal(repoMem)) {
        out.push({ launch, link, memory: repoMem, done: 'already' });
        continue;
      }
      out.push({ launch, link, memory: repoMem, done: 'conflict', detail: `it points to ${to}`, fix: `rm "${link}" && hoprig project link ${path.basename(root)}` });
      continue;
    }
    if (st && st.isDirectory()) {
      const backup = `${link}.backup-${stamp(now)}`;
      fs.renameSync(link, backup);
      const n = mergeInto(backup, repoMem, stamp(now));
      what = n ? `moved ${n} file${n > 1 ? 's' : ''} in, then linked (old folder kept: ${path.basename(backup)})` : 'linked (the old empty folder kept as a backup)';
    }
    try {
      fs.symlinkSync(repoMem, link, platform === 'win32' ? 'junction' : 'dir');
      out.push({ launch, link, memory: repoMem, done: what });
    } catch (e) {
      if (platform !== 'win32') throw e;
      // No links without administrator rights here: tell Claude Code where the memory is instead.
      const file = path.join(launchAbs, '.claude', 'settings.local.json');
      const cur = readJson(file) || {};
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...cur, autoMemoryDirectory: repoMem }, null, 2) + '\n');
      out.push({ launch, link, memory: repoMem, done: `setting: autoMemoryDirectory in ${file}` });
    }
  }
  return out;
}

export const safeReal = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// ---------- git helpers ----------

export async function git(dir, args, run = capture, opts = {}) {
  return run(['git', '-C', dir, ...args], { timeout: 120_000, ...opts });
}

/** Branch, changes, ahead/behind of one repository (counts only). */
export async function repoInfo(dir, run = capture) {
  if (!isRepo(dir)) return { dir, ok: false, error: 'not cloned' };
  const r = await run(statusArgv(dir), { timeout: 30_000, env: READ_ONLY_GIT });
  return r.ok ? { dir, ok: true, ...parseStatus(r.stdout) } : { dir, ok: false, error: (r.stderr || 'git failed').trim().split('\n')[0] };
}

/** The parent and every child of a project: [{ rel, dir, ...state }]. */
export async function workspaceState(root, run = capture) {
  const { manifest, source, errors } = await readManifest(root, run);
  const dirs = [{ rel: '.', dir: root }];
  if (manifest) {
    for (const r of manifest.repos) dirs.push({ rel: r.dir, dir: path.join(root, r.dir), url: r.url });
    for (const d of manifest.localOnly || []) dirs.push({ rel: d, dir: path.join(root, d), localOnly: true });
  }
  const states = await Promise.all(dirs.map(async (d) => ({ ...d, ...(await repoInfo(d.dir, run)) })));
  return { name: manifest ? manifest.name : path.basename(root), root, source, errors, memories: manifest ? manifest.memories : {}, repos: states };
}

/** Projects in the projects folder: git repositories that look like a workspace (a code/ folder or a manifest). */
export function listWorkspaces(projectsDir) {
  let names = [];
  try {
    names = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !PRIVATE_DIRS.includes(d.name))
    .map((d) => path.join(projectsDir, d.name))
    .filter((p) => isRepo(p) && (fs.existsSync(path.join(p, MANIFEST)) || fs.existsSync(path.join(p, 'code')) || fs.existsSync(path.join(p, MEMORY_FILE))))
    .sort();
}

/**
 * Sync one repository without ever deciding for the user: fetch; fast-forward when clean and only behind; push
 * when only ahead and there is an upstream (unless `push` is false: then it is reported). Anything else is
 * reported with the exact command. One engine for `project sync` and `workspace sync`.
 * Resolves { rel, did: [..], todo: [{ why, command }] }.
 */
export async function syncRepo(dir, rel, run = capture, { push = true, dryRun = false } = {}) {
  const did = [];
  const todo = [];
  if (!isRepo(dir)) return { rel, did, todo: [{ why: 'not cloned', command: `hoprig project clone …` }] };
  const f = await git(dir, ['fetch', '--prune', '--quiet'], run, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (!f.ok) todo.push({ why: `fetch failed: ${(f.stderr || '').trim().split('\n').pop()}`, command: `git -C "${dir}" fetch` });
  const s = await repoInfo(dir, run);
  if (!s.ok) return { rel, did, todo: [...todo, { why: s.error, command: '' }] };
  if (!s.upstream) {
    if (s.ahead === 0 && s.behind === 0) todo.push({ why: `${s.branch} has no upstream`, command: `git -C "${dir}" push -u origin ${s.branch}` });
    return { rel, did, todo, state: s };
  }
  if (s.ahead && s.behind) todo.push({ why: `${s.branch} and its upstream have both moved (${s.ahead} ahead, ${s.behind} behind)`, command: `git -C "${dir}" pull --rebase   (or: git -C "${dir}" merge ${s.upstream})` });
  else if (s.behind) {
    if (s.changes) todo.push({ why: `${s.behind} to pull, but there are ${s.changes} uncommitted changes`, command: `git -C "${dir}" stash && git -C "${dir}" pull --ff-only && git -C "${dir}" stash pop` });
    else if (dryRun) did.push(`would pull ${s.behind}`);
    else {
      const p = await git(dir, ['merge', '--ff-only', '--quiet', '@{u}'], run);
      if (p.ok) did.push(`pulled ${s.behind}`);
      else todo.push({ why: 'fast-forward failed', command: `git -C "${dir}" pull --ff-only` });
    }
  } else if (s.ahead && !push) {
    todo.push({ why: `${s.ahead} commit${s.ahead > 1 ? 's' : ''} to push`, command: `git -C "${dir}" push` });
  } else if (s.ahead && dryRun) {
    did.push(`would push ${s.ahead}`);
  } else if (s.ahead) {
    const p = await git(dir, ['push', '--quiet'], run, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (p.ok) did.push(`pushed ${s.ahead}`);
    else todo.push({ why: `push failed: ${(p.stderr || '').trim().split('\n').pop()}`, command: `git -C "${dir}" push` });
  }
  if (s.changes) todo.push({ why: `${s.changes} uncommitted change${s.changes > 1 ? 's' : ''}`, command: `git -C "${dir}" status` });
  return { rel, did, todo, state: await repoInfo(dir, run) };
}

/** Commit the memory folders of the parent when they changed (only those paths). */
export async function commitMemory(root, memories, run = capture) {
  const paths = [...new Set(Object.values(memories))].filter((p) => fs.existsSync(path.join(root, p)));
  if (!paths.length) return { committed: false, why: 'no memory folder' };
  await git(root, ['add', '--', ...paths], run);
  const d = await git(root, ['diff', '--cached', '--quiet', '--', ...paths], run);
  if (d.ok) return { committed: false, why: 'the memory did not change' };
  const c = await git(root, ['commit', '--quiet', '-m', 'Update AI memory', '--', ...paths], run);
  return c.ok ? { committed: true } : { committed: false, why: (c.stderr || c.stdout).trim().split('\n').pop() };
}

/** Sync the parent (after committing the memory, when asked) and every child. */
export async function syncWorkspace(root, { memory = false, run = capture, push = true, dryRun = false } = {}) {
  const { manifest } = await readManifest(root, run);
  const out = { memory: null, repos: [] };
  if (memory && manifest) out.memory = dryRun ? { committed: false, why: 'dry run: would commit the memory folders when they changed' } : await commitMemory(root, manifest.memories, run);
  out.repos.push(await syncRepo(root, '.', run, { push, dryRun }));
  for (const r of (manifest && manifest.repos) || []) out.repos.push(await syncRepo(path.join(root, r.dir), r.dir, run, { push, dryRun }));
  return out;
}

// ---------- creating and cloning ----------

/** Set core.hooksPath to .githooks when the repository has that folder and no hooks path is set. */
export async function useHooks(dir, run = capture) {
  if (!fs.existsSync(path.join(dir, '.githooks'))) return false;
  const cur = await git(dir, ['config', '--get', 'core.hooksPath'], run);
  if (cur.stdout.trim()) return false;
  return (await git(dir, ['config', 'core.hooksPath', '.githooks'], run)).ok;
}

/** git init -b main + first commit. Needs a commit name and e-mail. */
export async function initRepo(dir, message, run = capture) {
  const i = await git(dir, ['init', '-q', '-b', 'main'], run);
  if (!i.ok) return { ok: false, error: i.stderr.trim() };
  await git(dir, ['add', '-A'], run);
  const c = await git(dir, ['commit', '-q', '-m', message], run);
  return c.ok ? { ok: true } : { ok: false, error: (c.stderr || c.stdout).trim().split('\n').pop() };
}

/** The GitHub accounts the signed-in user may create repositories in: [login, ...orgs]. */
export async function githubOwners(run = capture) {
  const me = await run(['gh', 'api', 'user', '--jq', '.login'], { timeout: 20_000 });
  if (!me.ok) return [];
  const orgs = await run(['gh', 'api', 'user/orgs', '--jq', '.[].login'], { timeout: 20_000 });
  return [me.stdout.trim(), ...(orgs.ok ? orgs.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [])].filter((s) => /^[A-Za-z0-9-]{1,39}$/.test(s));
}

/** Create a private GitHub repository from a local one and push it. */
export function createGithubRepo(dir, owner, name, { onLine = () => {}, run = stream } = {}) {
  return run(['gh', 'repo', 'create', `${owner}/${name}`, '--private', '--source', dir, '--remote', 'origin', '--push'], { onLine });
}

/** The owner's repositories whose names start with "<project>-": [{ name, url }]. */
export async function childCandidates(owner, project, run = capture) {
  const r = await run(['gh', 'repo', 'list', owner, '--json', 'name,url', '--limit', '1000'], { timeout: 60_000 });
  if (!r.ok) return [];
  let list = [];
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  return list.filter((x) => x && typeof x.name === 'string' && x.name.startsWith(`${project}-`) && NAME_RE.test(x.name)).map((x) => ({ name: x.name, url: `https://github.com/${owner}/${x.name}.git` }));
}

/** "name", "owner/name" or a Git address → { url?, owner?, name } (a bare name needs an owner chosen). */
export function parseProjectSpec(spec) {
  const s = String(spec || '').trim();
  if (NAME_RE.test(s) && !s.includes('/')) return { name: s.replace(/\.git$/, '') };
  const r = parseRepo(s);
  if (!r) return null;
  const owner = (/github\.com[/:]([A-Za-z0-9-]+)\//.exec(r.url) || [])[1] || null;
  return { url: r.url, owner, name: r.name.replace(/\.git$/, '') };
}
