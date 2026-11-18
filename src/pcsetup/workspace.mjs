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
import { gitRead } from '../gitread.mjs';
import { claudeDir } from '../paths.mjs';
import { withoutSecrets } from '../secretenv.mjs';
import { projectSlug } from '../sessions.mjs';
import { capture, showCommand, showCommands, stream } from '../setup/system.mjs';
import { PRIVATE_DIRS, STATUS_ARGS, cleanRemote, parseRepo, parseStatus } from './projects.mjs';
import { WORKTREE_LEFT, isLinkedWorktree } from '../workspace/layout.mjs';
import { inTheWay, inTheWayWords } from './intheway.mjs';
import { copyIn, gitIn, kindAt, leaves, leavesThrough, leavesWords, linkIn, mkdirIn, myLinkCommand, readIn, removeIn, startIn, writeIn } from '../workspace/inside.mjs';

export { PRIVATE_DIRS };

export const MANIFEST = 'project.json';
export const MEMORY_FILE = 'ai_brain/claude-memory.json';
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REL_RE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._\/-]{1,200}$/;

/** A relative folder inside the project ("." allowed for memories' launch folder). */
export const relOk = (p, { dot = false } = {}) => typeof p === 'string' && ((dot && p === '.') || (REL_RE.test(p) && !p.split('/').some((s) => PRIVATE_DIRS.includes(s))));

const KNOWN = ['name', 'repos', 'memories'];
const REPO_KNOWN = ['dir', 'url', 'branch'];
// A key name this reader does not know yet (a newer Hoprig may write one): kept as it is, whatever its spelling, never
// interpreted. Only the three names that would reach an object's prototype are never kept.
const keep = (k) => !['__proto__', 'constructor', 'prototype'].includes(k);
// A key's name as a warning shows it: short, and no control character reaches a terminal.
const shown = (k) => String(k).slice(0, 30).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

/**
 * Check of a manifest (it comes from a repository someone else may write). The keys it knows are checked strictly;
 * a key it does not know is kept and reported in `warnings`, never a refusal: a key written by a newer Hoprig must
 * not lock the project out of a computer with an older one. → { ok, manifest, warnings } | { ok: false, errors }
 */
export function validateManifest(m) {
  const errors = [];
  const warnings = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['project.json is not an object'] };
  const extra = (obj, known, where) => {
    const out = [];
    for (const k of Object.keys(obj)) {
      if (known.includes(k)) continue;
      if (keep(k)) out.push([k, obj[k]]);
      warnings.push(`${where}unknown key "${shown(k)}"${keep(k) ? ' (kept, not used by this Hoprig)' : ' (left out: a name Hoprig never keeps)'}`);
    }
    return out;
  };
  const top = extra(m, KNOWN, '');
  if (typeof m.name !== 'string' || !NAME_RE.test(m.name)) errors.push('"name" must be a plain project name');
  const repos = [];
  if (m.repos !== undefined && !Array.isArray(m.repos)) errors.push('"repos" must be a list');
  for (const r of Array.isArray(m.repos) ? m.repos : []) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push('each repo is { dir, url, branch? }');
      continue;
    }
    if (!relOk(r.dir) || r.dir === MANIFEST) errors.push(`"${String(r.dir).slice(0, 60)}" is not a folder inside the project`);
    else if (!parseRepo(r.url)) errors.push(`"${String(r.url).slice(0, 80)}" is not a Git address Hoprig accepts`);
    else if (r.branch !== undefined && (typeof r.branch !== 'string' || !/^[A-Za-z0-9._\/-]{1,100}$/.test(r.branch) || r.branch.startsWith('-'))) errors.push(`bad branch for ${r.dir}`);
    else repos.push({ dir: r.dir, url: r.url, ...(r.branch ? { branch: r.branch } : {}), ...Object.fromEntries(extra(r, REPO_KNOWN, `${r.dir}: `)) });
  }
  const memories = {};
  if (m.memories !== undefined && (!m.memories || typeof m.memories !== 'object' || Array.isArray(m.memories))) errors.push('"memories" must be an object');
  for (const [k, v] of Object.entries(m.memories || {})) {
    if (!relOk(k, { dot: true }) || !relOk(v)) errors.push(`memory "${String(k).slice(0, 40)}" → "${String(v).slice(0, 40)}" must be folders inside the project`);
    else memories[k] = v;
  }
  if (errors.length) return { ok: false, errors };
  // (Unknown top-level keys stay in the file: writeManifest puts them back from it.)
  return { ok: true, manifest: { name: m.name, repos, memories }, warnings, unknown: top.map(([k]) => k) };
}

// A file of the project is read only as a regular file whose folder stays inside the project (inside.mjs): a
// project.json or claude-memory.json that is a link, or under a folder that leads out, is not read.
const readJson = (root, f) => {
  try {
    const b = readIn(root, f, { below: true });
    return b ? JSON.parse(b.toString('utf8')) : null;
  } catch {
    return null;
  }
};
const isRepo = (d) => fs.existsSync(path.join(d, '.git'));

/**
 * Child repositories found under code/ (one level), with their origin addresses. A linked worktree there is a
 * second checkout of another repository (often a session's temporary one), not a child repository; a submodule is.
 */
export async function discoverChildren(root, run = capture) {
  const code = path.join(root, 'code');
  // code/ (or a repository in it) that leads out of the project is never followed (inside.mjs).
  if (leaves(root, code, {}, { below: true })) return [];
  let names = [];
  try {
    names = fs.readdirSync(code, { withFileTypes: true }).filter((d) => d.isDirectory() && !PRIVATE_DIRS.includes(d.name) && isRepo(path.join(code, d.name)) && !isLinkedWorktree(path.join(code, d.name))).map((d) => d.name).sort();
    // A link in code/ is no directory entry here (withFileTypes does not follow it): never a code repository.
  } catch {
    return [];
  }
  return Promise.all(names.map(async (n) => {
    const r = await gitRead(path.join(code, n), ['config', '--get', 'remote.origin.url'], { run });
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
  if (kindAt(path.join(root, MANIFEST)) === 'link') return { manifest: null, source: MANIFEST, errors: ['project.json is a link: Hoprig reads it only as a regular file in the project'] };
  const j = readJson(root, path.join(root, MANIFEST));
  if (j) {
    const v = validateManifest(j);
    if (!v.ok) return { manifest: null, source: MANIFEST, errors: v.errors };
    const mem = readJson(root, path.join(root, MEMORY_FILE));
    if (!Object.keys(v.manifest.memories).length && mem && mem.memories) v.manifest.memories = validateManifest({ name: v.manifest.name, memories: mem.memories }).manifest?.memories || {};
    return { manifest: v.manifest, source: MANIFEST, ...(v.warnings.length ? { warnings: v.warnings } : {}) };
  }
  const name = path.basename(root);
  const kids = await discoverChildren(root, run);
  const mem = readJson(root, path.join(root, MEMORY_FILE));
  let memories = {};
  if (mem && mem.memories) memories = validateManifest({ name: NAME_RE.test(name) ? name : 'x', memories: mem.memories }).manifest?.memories || {};
  else if (fs.existsSync(path.join(root, 'ai_brain', 'claude-memory')) && !leaves(root, path.join(root, 'ai_brain', 'claude-memory'), {}, { below: true })) memories = { '.': 'ai_brain/claude-memory' };
  return { manifest: { name, repos: kids.filter((k) => k.url).map((k) => ({ dir: k.dir, url: k.url })), memories, localOnly: kids.filter((k) => !k.url).map((k) => k.dir) }, source: 'found' };
}

/**
 * Write project.json, and keep ai_brain/claude-memory.json's "memories" the same when that file exists. A key of the
 * file this Hoprig does not know (a newer one wrote it) is kept where it was. Never through a link (inside.mjs
 * writeIn): a project.json that is a link, or a project that leads out, throws and nothing is written.
 */
export function writeManifest(root, manifest, at = {}) {
  const { name, repos, memories } = manifest;
  const cur = readJson(root, path.join(root, MANIFEST));
  const kept = cur && typeof cur === 'object' && !Array.isArray(cur) ? Object.entries(cur).filter(([k]) => !KNOWN.includes(k) && keep(k)) : [];
  // The file's own order of keys stays (a diff shows only what changed); a new file is name, repos, memories.
  const order = cur && kept.length ? Object.keys(cur).filter((k) => KNOWN.includes(k) || kept.some(([x]) => x === k)) : [];
  for (const k of KNOWN) if (!order.includes(k)) order.push(k);
  const all = { ...Object.fromEntries(kept), name, repos, memories };
  writeIn({ ...at, root }, path.join(root, MANIFEST), JSON.stringify(Object.fromEntries(order.map((k) => [k, all[k]])), null, 2) + '\n');
  const memFile = path.join(root, MEMORY_FILE);
  const mem = readJson(root, memFile);
  if (mem && typeof mem === 'object' && JSON.stringify(mem.memories) !== JSON.stringify(memories)) {
    writeIn({ ...at, root }, memFile, JSON.stringify({ ...mem, memories }, null, 2) + '\n');
  }
}

// ---------- the template ----------

/** The built-in template: small and neutral; every "{{project}}" becomes the project's name. */
export const BUILTIN_TEMPLATE = {
  'AGENTS.md': `# {{Project}}

The one place for instructions to AI coding tools: OpenCode and most others read it, Claude Code through
CLAUDE.md. The other instruction files only point here. Keep it short and true; edit it as the project grows.

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
        // Each target lexically, and the link as the system follows it (through the template's other links).
        if (path.isAbsolute(target) || !(resolved === base || resolved.startsWith(base + path.sep)) || leavesThrough(base, full)) throw new Error(`the template's link ${r} points outside the template`);
        out.push({ rel: r, kind: 'link', target });
      } else if (d.isDirectory()) walk(r);
      else if (d.isFile()) out.push({ rel: r, kind: 'file', data: fs.readFileSync(full) });
    }
  };
  walk('');
  return out;
}

/** Write template files into `dest` (which must not exist yet). Names and text get the project's name. */
export function writeTemplate(dest, files, name, at = {}) {
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists: choose another name`);
  const a = { ...at, root: dest };
  mkdirIn(a, dest);
  const root = path.resolve(dest);
  const links = [];
  for (const f of files) {
    const rel = fillName(f.rel, name);
    const full = path.resolve(root, rel);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !full.startsWith(root + path.sep)) throw new Error(`the template file ${rel} would land outside the project`);
    mkdirIn(a, path.dirname(full));
    if (f.kind === 'link') links.push(linkIn(a, full, f.target));
    else {
      const buf = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
      writeIn(a, full, buf.includes(0) ? buf : fillName(buf.toString('utf8'), name), { excl: true });
    }
  }
  // A link made early may lead out only through one made after it: every link is followed again once all are made.
  const out = links.filter((l) => leavesThrough(root, l));
  for (const l of out) removeIn(a, l);
  if (out.length) throw new Error(`the template's link ${path.relative(root, out[0])} leads outside the project through its other links: it was taken away`);
  return root;
}

export const builtinFiles = () => Object.entries(BUILTIN_TEMPLATE).map(([rel, data]) => ({ rel, kind: 'file', data }));

// ---------- memory links ----------

export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/**
 * Copy every file of `from` (Claude Code's own folder, outside the workspace) into `to` (inside `at`'s root), never
 * overwriting: a name that is taken gets ".from-<stamp>" added. Only regular files and folders: a link is not copied.
 */
export function mergeInto(from, to, tag, at = { root: to }) {
  let moved = 0;
  mkdirIn(at, to);
  for (const d of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, d.name);
    let dst = path.join(to, d.name);
    if (d.isDirectory()) {
      moved += mergeInto(src, dst, tag, at);
      continue;
    }
    if (!d.isFile()) continue;
    if (kindAt(dst) !== 'none') {
      if (kindAt(dst) === 'file' && fs.readFileSync(dst).equals(fs.readFileSync(src))) continue;
      const ext = path.extname(d.name);
      dst = path.join(to, `${path.basename(d.name, ext)}.from-${tag}${ext}`);
    }
    if (copyIn(at, src, dst, { from: null })) moved++;
  }
  return moved;
}

/**
 * Link Claude Code's memory for each launch folder to the folder in the repository. What is done per entry:
 * linked | already | moved+linked (a real folder's files were merged in; the folder is kept as a dated backup) |
 * setting (Windows without links: autoMemoryDirectory in <launch>/.claude/settings.local.json) | conflict (a link to
 * somewhere else is there: left alone, the command to change it is given).
 */
export function linkMemories(root, memories, opts = {}) {
  return planMemories(root, memories, opts).map((p) => linkMemory(p, opts));
}

/**
 * The same for folders given as absolute paths: [{ launch, memory, label? }] (a group's members share the group's
 * memory, groups.mjs). `fix` is the command that makes the link again. → [{ launch: label or launch, link, memory, done }]
 */
export function linkMemoryPairs(pairs, opts = {}) {
  return planMemoryPairs(pairs, opts).map((p) => linkMemory(p, opts));
}

/**
 * What linkMemories would do for each entry, read only (a dry run, and a project that was already here, say it from
 * this): [{ launch, launchAbs, link, memory, action: already | link | merge | conflict, detail?, fix? }]. merge: a
 * real folder is there, its files go into the repository's folder and it is kept as a dated backup. `ref`: how
 * commands name the project (<place>/<name> in a group), for the command that makes the link again.
 */
export function planMemories(root, memories, opts = {}) {
  // `opts.root`: the folder the memory must stay inside, when it is not the launch folder (the brain's memory).
  const pairs = Object.entries(memories).map(([launch, memDir]) => ({ launch: launch === '.' ? root : path.join(root, launch), memory: path.join(opts.root || root, memDir), label: launch, root: opts.root || root }));
  return planMemoryPairs(pairs, { ...opts, fix: `hoprig project link ${opts.ref || path.basename(root)}` });
}

/** planMemories for pairs of absolute paths (linkMemoryPairs). */
export function planMemoryPairs(pairs, { base = claudeDir(), fix = 'hoprig project link <name>', at = {} } = {}) {
  return pairs.map(({ launch: launchAbs, memory: repoMem, label, root }) => {
    const launch = label || launchAbs;
    const link = path.join(base, 'projects', projectSlug(launchAbs), 'memory');
    const p = { launch, launchAbs, link, memory: repoMem, root };
    // What would be made must stay inside its root: the memory folder, and a launch folder in the same root (inside.mjs).
    const make = (action) => {
      const out = memoryLeaves(p, at);
      return out ? { ...p, action: 'conflict', detail: leavesWords(out), fix: out.what === 'leaves its folder through a link' ? `if that link is yours:  ${myLinkCommand(out.path)}` : 'nothing to do: it is never linked there' } : { ...p, action };
    };
    let st = null;
    try {
      st = fs.lstatSync(link);
    } catch {
      return make('link');
    }
    if (st.isSymbolicLink()) {
      const to = path.resolve(path.dirname(link), fs.readlinkSync(link));
      if (to === repoMem || safeReal(to) === safeReal(repoMem)) return { ...p, action: 'already' };
      return { ...p, action: 'conflict', detail: `it points to ${to}`, fix: `${showCommand(['rm', link])} && ${fix}` };
    }
    if (st.isDirectory()) return make('merge');
    return { ...p, action: 'conflict', detail: 'a file is there', fix: `look at it, move it aside, then  ${fix}` };
  });
}

/**
 * Where a planned memory link would lead out (inside.mjs): its memory folder outside its root, or its launch folder
 * when that is in the same root. A plan without a root is never made (nothing to check it against). → null | leaves.
 */
function memoryLeaves(p, at = {}) {
  if (!p.root) return { path: p.memory, what: 'has no folder of its own to be checked against' };
  const a = { ...at, root: p.root };
  const inRoot = !path.relative(p.root, p.launchAbs).startsWith('..') && !path.isAbsolute(path.relative(p.root, p.launchAbs));
  return leaves(p.root, p.memory, a) || (inRoot ? leaves(p.root, p.launchAbs, a) : null);
}

/**
 * One planned entry made (planMemories). Checked again right before it is made (inside.mjs): a memory folder that
 * leads out of its root is never made or linked. → { launch, link, memory, done, detail?, fix? }
 */
export function linkMemory(p, { platform = process.platform, now = new Date(), at = {} } = {}) {
  const { launch, launchAbs, link, memory: repoMem } = p;
  if (p.action === 'already' || p.action === 'conflict') return { launch, link, memory: repoMem, done: p.action, ...(p.detail ? { detail: p.detail, fix: p.fix } : {}) };
  const out = memoryLeaves(p, at);
  if (out) return { launch, link, memory: repoMem, done: 'conflict', detail: leavesWords(out), fix: 'nothing to do: it is never linked there' };
  const a = { ...at, root: p.root };
  mkdirIn(a, repoMem);
  // The link itself lives in Claude Code's own folder, outside the workspace; what it points to was checked above.
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let what = 'linked';
  if (p.action === 'merge') {
    const backup = `${link}.backup-${stamp(now)}`;
    fs.renameSync(link, backup);
    const n = mergeInto(backup, repoMem, stamp(now), a);
    what = n ? `moved ${n} file${n > 1 ? 's' : ''} in, then linked (old folder kept: ${path.basename(backup)})` : 'linked (the old empty folder kept as a backup)';
  }
  try {
    fs.symlinkSync(repoMem, link, platform === 'win32' ? 'junction' : 'dir');
    return { launch, link, memory: repoMem, done: what };
  } catch (e) {
    if (platform !== 'win32') throw e;
    // No links without administrator rights here: tell Claude Code where the memory is instead.
    const file = path.join(launchAbs, '.claude', 'settings.local.json');
    // Inside the launch folder, never through a link (the launch folder is the root when it is not in p.root).
    const l = { ...a, root: launchAbs, ...(path.relative(p.root, launchAbs).startsWith('..') ? { dir: launchAbs, projects: launchAbs } : {}) };
    const cur = readJson(launchAbs, file) || {};
    mkdirIn(l, path.dirname(file));
    writeIn(l, file, JSON.stringify({ ...cur, autoMemoryDirectory: repoMem }, null, 2) + '\n');
    return { launch, link, memory: repoMem, done: `setting: autoMemoryDirectory in ${file}` };
  }
}

export const safeReal = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// ---------- git helpers ----------


/** Branch, changes, ahead/behind of one repository (counts only). */
export async function repoInfo(dir, run = capture, { exclude = [] } = {}) {
  if (!isRepo(dir)) return { dir, ok: false, error: 'not cloned' };
  // `exclude`: folders of a group's repository that are its members (repositories of their own): never its changes.
  const r = await gitRead(dir, [...STATUS_ARGS, ...exclude.map((x) => `:(exclude,glob)${x}/**`)], { run, timeout: 30_000 });
  return r.ok ? { dir, ok: true, ...parseStatus(r.stdout) } : { dir, ok: false, error: (r.stderr || 'git failed').trim().split('\n')[0] };
}

/**
 * The parent and every child of a project: [{ rel, dir, ...state }]. A code repository that leads out of the project
 * (inside.mjs) is not looked into: it is in `notFollowed` with why.
 */
export async function workspaceState(root, run = capture) {
  const { manifest, source, errors, warnings } = await readManifest(root, run);
  const dirs = [{ rel: '.', dir: root }];
  const notFollowedHere = [];
  const add = (d) => {
    const out = leaves(root, d.dir, {}, { below: true });
    if (out) notFollowedHere.push({ rel: d.rel, why: leavesWords(out) });
    else dirs.push(d);
  };
  if (manifest) {
    for (const r of manifest.repos) add({ rel: r.dir, dir: path.join(root, r.dir), url: r.url });
    for (const d of manifest.localOnly || []) add({ rel: d, dir: path.join(root, d), localOnly: true });
  }
  const states = await Promise.all(dirs.map(async (d) => ({ ...d, ...(await repoInfo(d.dir, run)) })));
  return { name: manifest ? manifest.name : path.basename(root), root, source, errors, ...(warnings ? { warnings } : {}), ...(notFollowedHere.length ? { notFollowed: notFollowedHere } : {}), memories: manifest ? manifest.memories : {}, repos: states };
}

/**
 * Projects in the projects folder: git repositories that look like a workspace (a code/ folder or a manifest).
 * `withGroup`: a held folder whose members come with the group's repository (groups.mjs): a member is a folder of
 * that shape, never a repository of its own.
 */
export function listWorkspaces(projectsDir, { withGroup = false } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !PRIVATE_DIRS.includes(d.name))
    .map((d) => path.join(projectsDir, d.name))
    .filter((p) => (withGroup ? !isRepo(p) : isRepo(p)) && (fs.existsSync(path.join(p, MANIFEST)) || fs.existsSync(path.join(p, 'code')) || fs.existsSync(path.join(p, MEMORY_FILE))))
    .sort();
}

/**
 * The fast-forward Hoprig runs (sync, sync --with): never over a file or folder git ignores. A group's repository
 * ignores its members and a parent its code/ folder; each is a repository of its own there, with work and commits of
 * its own. A commit that starts to track a path there (a link, a file) would make a plain fast-forward delete it.
 * With --no-overwrite-ignore git refuses and changes nothing ("would lose untracked files in them").
 */
export const FAST_FORWARD = (ref) => ['merge', '--ff-only', '--no-overwrite-ignore', '--quiet', ref];

/** ", and your N uncommitted changes stay where they are" (n = 0: ''): a refusal that leaves them, said so. */
export const stay = (n) => (n ? `, and your ${n} uncommitted change${n > 1 ? 's stay where they are' : ' stays where it is'}` : '');

/** The lines git lists under one of its headers (a tab-indented line each) in a refused merge's output. */
function listedUnder(r, header) {
  const out = [];
  let under = false;
  for (const l of `${r.stderr || ''}\n${r.stdout || ''}`.split('\n')) {
    if (!/^\t/.test(l)) under = header.test(l);
    else if (under && l.trim()) out.push(l.trim());
  }
  return out;
}

/**
 * The folders or files a refused fast-forward would have removed or overwritten that this repository does not track
 * (git's own list under its headers for untracked files), or ''. Never the tracked files git lists in the same refusal
 * as changed here (changedToo): those hold the owner's work and are not moved away.
 */
export function keptBack(r) {
  if (r.ok) return '';
  const header = /would lose untracked files in them|untracked working tree files would be (overwritten|removed)/i;
  if (!header.test(`${r.stderr || ''}\n${r.stdout || ''}`)) return '';
  const list = listedUnder(r, header);
  return list.length ? list.join(', ') : 'a folder';
}

/** The tracked files a refused fast-forward names as changed here and by the incoming commits ('README.md, …'), or ''. */
export function changedToo(r) {
  return r.ok ? '' : listedUnder(r, /Your local changes to the following files would be overwritten/i).join(', ');
}

/**
 * The words after "but the incoming commits" for a fast-forward kept back (keptBack): what is in the way and must be
 * moved away, and in a sentence of its own the tracked files changed on both sides (changedToo), which are committed
 * or put aside instead. `n`: the uncommitted changes, which stay.
 */
export function keptWords(kept, changed, n) {
  const many = changed.includes(', ');
  const also = changed ? `. They also change ${changed}, which this repository tracks and you have changed here: commit those changes or put them aside (git stash) first; ${many ? 'those files are' : 'that file is'} not to be moved away. Then` : ', then';
  return `put files where ${kept} is here, which this repository does not track (another repository, perhaps): nothing was changed${stay(n)}; move it away first${also}`;
}

/**
 * Sync one repository without ever deciding for the user: fetch; fast-forward when only behind (uncommitted work
 * stays, and stops it only where the incoming commits touch the same files); push
 * when only ahead and there is an upstream (unless `push` is false: then it is reported). Anything else is
 * reported with the exact command. One engine for `project sync` and `workspace sync`.
 * Resolves { rel, did: [..], todo: [{ why, command }] }.
 */
export async function syncRepo(dir, rel, run = capture, { push = true, dryRun = false, exclude = [], root = dir, at = {} } = {}) {
  const did = [];
  const todo = [];
  // `root`: the entry's own folder (the project's, the group's): nothing is fetched, merged or pushed in a repository
  // that leads out of it (inside.mjs), and the git calls below check it again at the moment they run.
  const out = leaves(root, dir, at);
  if (out) return notFollowed(rel, out);
  const g = (args, opts) => gitIn({ ...at, root }, dir, args, run, opts);
  if (!isRepo(dir)) return { rel, did, todo: [{ why: 'not cloned', command: `hoprig project clone …` }] };
  if (rel !== '.' && isLinkedWorktree(dir)) return { rel, did: [WORKTREE_LEFT], todo: [] }; // a second checkout, not this repository
  let s;
  let theirs = '@{u}'; // what a merge would take: in a dry run the server's commit when it is here already
  if (dryRun) {
    // A dry run fetches nothing (a fetch writes the remote-tracking refs, FETCH_HEAD and objects): the server's
    // branch is looked up instead, and counted against when its commit is here already.
    s = await repoInfo(dir, run, { exclude });
    if (!s.ok) return { rel, did, todo: [{ why: s.error, command: '' }] };
    const p = s.upstream ? await peekServer(dir, s.branch, run) : {};
    if (p.error) todo.push({ why: `the server could not be asked: ${p.error}`, command: showCommand(['git', '-C', dir, 'fetch']) });
    else if (p.unknown) {
      did.push(`would fetch the server's new commits on ${s.branch} first (a dry run does not fetch, so they are not counted), then fast-forward if ${s.branch} is only behind`);
      if (s.changes) todo.push({ why: `${s.changes} uncommitted change${s.changes > 1 ? 's' : ''}`, command: showCommand(['git', '-C', dir, 'status']) });
      return { rel, did, todo, state: s };
    } else if (p.counts) {
      s = { ...s, ...p.counts };
      theirs = p.sha;
    }
  } else {
    const f = await g(['fetch', '--prune', '--quiet'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (!f.ok) todo.push({ why: `fetch failed: ${(f.stderr || '').trim().split('\n').pop()}`, command: showCommand(['git', '-C', dir, 'fetch']) });
    s = await repoInfo(dir, run, { exclude });
    if (!s.ok) return { rel, did, todo: [...todo, { why: s.error, command: '' }] };
  }
  if (!s.upstream) {
    if (s.ahead === 0 && s.behind === 0) todo.push({ why: `${s.branch} has no upstream`, command: showCommand(['git', '-C', dir, 'push', '-u', 'origin', s.branch]) });
    return { rel, did, todo, state: s };
  }
  if (s.ahead && s.behind) {
    // A merge or a rebase replaces what git ignores without a word (inTheWay): when the server's commits put files
    // there, that is said first, and the folder is moved away before either.
    const hit = await inTheWay(dir, theirs, run);
    const both = `${s.branch} and its upstream have both moved (${s.ahead} ahead, ${s.behind} behind)`;
    todo.push({ why: `${both}${inTheWayWords(hit, "the server's commits")}`, command: `${showCommand(['git', '-C', dir, 'pull', '--rebase'])}   (or: ${showCommand(['git', '-C', dir, 'merge', s.upstream])})` });
  }
  else if (s.behind) {
    // Uncommitted work does not stop a fast-forward: git refuses, changing nothing, only when the incoming commits
    // touch a changed (or untracked) file. Then it is the user's to decide, with the exact command.
    const dirty = s.changes ? ` (your ${s.changes} uncommitted change${s.changes > 1 ? 's' : ''} stay${s.changes > 1 ? '' : 's'})` : '';
    if (dryRun) did.push(`would pull ${s.behind}${s.changes ? `, unless they touch your ${s.changes} uncommitted change${s.changes > 1 ? 's' : ''}` : ''}`);
    else {
      const p = await g(FAST_FORWARD('@{u}'));
      const kept = keptBack(p);
      if (p.ok) did.push(`pulled ${s.behind}${dirty}`);
      // What git ignores is in the way: said before the uncommitted changes, which may lie elsewhere (a stash would
      // only hide them, the fast-forward is refused all the same).
      else if (kept) todo.push({ why: `${s.behind} to pull, but the incoming commits ${keptWords(kept, changedToo(p), s.changes)}`, command: showCommand(['git', '-C', dir, ...FAST_FORWARD('@{u}')]) });
      else if (s.changes) todo.push({ why: `${s.behind} to pull, but there are ${s.changes} uncommitted changes in the same files`, command: showCommands([['git', '-C', dir, 'stash'], ['git', '-C', dir, ...FAST_FORWARD('@{u}')], ['git', '-C', dir, 'stash', 'pop']]) });
      else todo.push({ why: 'fast-forward failed', command: showCommand(['git', '-C', dir, ...FAST_FORWARD('@{u}')]) });
    }
  } else if (s.ahead && !push) {
    todo.push({ why: `${s.ahead} commit${s.ahead > 1 ? 's' : ''} to push`, command: showCommand(['git', '-C', dir, 'push']) });
  } else if (s.ahead && dryRun) {
    did.push(`would push ${s.ahead}`);
  } else if (s.ahead) {
    const p = await g(['push', '--quiet'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (p.ok) did.push(`pushed ${s.ahead}`);
    else todo.push({ why: `push failed: ${(p.stderr || '').trim().split('\n').pop()}`, command: showCommand(['git', '-C', dir, 'push']) });
  }
  if (s.changes) todo.push({ why: `${s.changes} uncommitted change${s.changes > 1 ? 's' : ''}`, command: showCommand(['git', '-C', dir, 'status']) });
  return { rel, did, todo, state: dryRun ? s : await repoInfo(dir, run, { exclude }) };
}

/**
 * The commit a branch has on a server, without a fetch: `git ls-remote <url> <ref>`, run outside any repository so that
 * none of a repository's own settings start a program (only git's own transport and the owner's global settings).
 * `url` may be a path relative to `from`. → { sha } (null: no such branch there) | { error }
 */
export async function lsRemote(url, ref, { from, run = capture, env = {} } = {}) {
  const local = !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) && !/^[^/:]+@[^/:]+:/.test(url);
  const where = local && from && !path.isAbsolute(url) ? path.resolve(from, url) : url;
  const r = await run(['git', '-c', 'protocol.ext.allow=never', 'ls-remote', '--', where, ref], { cwd: path.parse(process.cwd()).root, timeout: 60_000, env: { ...withoutSecrets(process.env), GIT_TERMINAL_PROMPT: '0', ...env } });
  if (!r.ok) return { error: (r.stderr || r.stdout || 'git failed').trim().split('\n').pop() };
  const line = String(r.stdout).split('\n').find((l) => l.endsWith(`\t${ref}`));
  return { sha: line ? line.split('\t')[0] : null };
}

/**
 * Dry run of a sync: ahead and behind of `branch` against its upstream branch on the server as it is now (lsRemote).
 * → { counts: { ahead, behind } } | { unknown: true } (the server has commits that are not here: not countable without
 * a fetch) | { error } | {} (an upstream that is a branch of this repository: the counts are exact already).
 */
export async function peekServer(dir, branch, run = capture) {
  const get = async (k) => {
    const r = await gitRead(dir, ['config', '--get', k], { run });
    return r.ok ? r.stdout.trim() : '';
  };
  const remote = await get(`branch.${branch}.remote`);
  const merge = await get(`branch.${branch}.merge`);
  const url = remote && remote !== '.' ? await get(`remote.${remote}.url`) : '';
  if (!url || !merge) return {};
  const there = await lsRemote(url, merge, { from: dir, run });
  if (there.error) return { error: there.error };
  if (!there.sha) return { error: `the server has no branch ${merge.replace(/^refs\/heads\//, '')}` };
  const c = await gitRead(dir, ['rev-list', '--left-right', '--count', `HEAD...${there.sha}`], { run });
  if (!c.ok) return { unknown: true };
  const [ahead, behind] = c.stdout.trim().split(/\s+/).map(Number);
  return { counts: { ahead, behind }, sha: there.sha };
}

/** A repository that is not acted on: it leads out of its folder (inside.mjs). Said with the command to name the link as the owner's own. */
export const notFollowed = (rel, b) => ({ rel, did: [], todo: [{ why: `not followed: ${leavesWords(b)}`, command: b.what === 'leaves its folder through a link' ? myLinkCommand(b.path) : '', kind: 'link' }] });

/** Commit the memory folders of the parent when they changed (only those paths, each inside the parent). */
export async function commitMemory(root, memories, run = capture, at = {}) {
  const paths = [...new Set(Object.values(memories))].filter((p) => fs.existsSync(path.join(root, p)) && !leaves(root, path.join(root, p), at));
  if (!paths.length) return { committed: false, why: 'no memory folder' };
  const a = await gitIn({ ...at, root }, root, ['add', '--', ...paths], run);
  if (a.leaves) return { committed: false, why: a.stderr };
  const d = await gitRead(root, ['diff', '--cached', '--quiet', '--', ...paths], { run });
  if (d.ok) return { committed: false, why: 'the memory did not change' };
  const c = await gitIn({ ...at, root }, root, ['commit', '--quiet', '-m', 'Update AI memory', '--', ...paths], run);
  return c.ok ? { committed: true } : { committed: false, why: (c.stderr || c.stdout).trim().split('\n').pop() };
}

/**
 * Sync the parent (after committing the memory, when asked) and every child. A project that leads out of its place,
 * or a code repository that leads out of the project (project.json may name code/x where code is a link to
 * elsewhere), is said, never fetched or pushed (inside.mjs). `at`: { dir, projects } of the workspace.
 */
export async function syncWorkspace(root, { memory = false, run = capture, push = true, dryRun = false, skip = [], parent = true, at = {} } = {}) {
  const out = { memory: null, repos: [] };
  const away = leaves(root, root, at);
  if (away) {
    out.repos.push(notFollowed('.', away));
    return out;
  }
  const { manifest } = await readManifest(root, run);
  // parent false: a member that comes with its group's repository (its folder and memory are the group's to sync).
  if (memory && manifest && parent) out.memory = dryRun ? { committed: false, why: 'dry run: would commit the memory folders when they changed' } : await commitMemory(root, manifest.memories, run, at);
  if (parent) out.repos.push(await syncRepo(root, '.', run, { push, dryRun, root, at }));
  for (const r of (manifest && manifest.repos) || []) {
    if (skip.includes(r.dir)) continue;
    out.repos.push(await syncRepo(path.join(root, r.dir), r.dir, run, { push, dryRun, root, at }));
  }
  return out;
}

// ---------- creating and cloning ----------

/** Set core.hooksPath to .githooks when the repository has that folder and no hooks path is set. */
export async function useHooks(dir, run = capture, root = dir, at = {}) {
  if (!(await hooksToUse(dir, run))) return false;
  return (await gitIn({ ...at, root }, dir, ['config', 'core.hooksPath', '.githooks'], run)).ok;
}

/** Whether useHooks would set the hooks path (read only). */
export async function hooksToUse(dir, run = capture) {
  if (!fs.existsSync(path.join(dir, '.githooks'))) return false;
  const cur = await gitRead(dir, ['config', '--get', 'core.hooksPath'], { run });
  return !cur.stdout.trim();
}

/** git init -b main + first commit. Needs a commit name and e-mail. */
export async function initRepo(dir, message, run = capture, at = { root: dir }) {
  const i = await gitIn(at, dir, ['init', '-q', '-b', 'main'], run);
  if (!i.ok) return { ok: false, error: i.stderr.trim() };
  await gitIn(at, dir, ['add', '-A'], run);
  const c = await gitIn(at, dir, ['commit', '-q', '-m', message], run);
  return c.ok ? { ok: true } : { ok: false, error: (c.stderr || c.stdout).trim().split('\n').pop() };
}

/** The GitHub accounts the signed-in user may create repositories in: [login, ...orgs]. */
export async function githubOwners(run = capture) {
  const me = await run(['gh', 'api', 'user', '--jq', '.login'], { timeout: 20_000 });
  if (!me.ok) return [];
  const orgs = await run(['gh', 'api', 'user/orgs', '--jq', '.[].login'], { timeout: 20_000 });
  // A login never starts with "-": one that did would reach gh as an option.
  return [me.stdout.trim(), ...(orgs.ok ? orgs.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [])].filter((s) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(s));
}

/** Create a private GitHub repository from a local one and push it. */
export async function createGithubRepo(dir, owner, name, { onLine = () => {}, run = stream, at = {} } = {}) {
  // gh runs git in `dir` (its remote, the push): only in a folder that is really where it should be, started there
  // through inside.mjs like every other program in a folder of the workspace.
  return startIn({ ...at, root: dir }, dir, ['gh', 'repo', 'create', `${owner}/${name}`, '--private', '--source', path.resolve(dir), '--remote', 'origin', '--push'], run, { onLine });
}

/**
 * The owner's code repositories of a project: names that start with "<project>-", and "<project>" itself. Never the
 * project's parent repository `parent` (a parent called "<project>-workspace" fits the pattern). [{ name, url }]
 */
export async function childCandidates(owner, project, run = capture, { parent = project } = {}) {
  const r = await run(['gh', 'repo', 'list', owner, '--json', 'name,url', '--limit', '1000'], { timeout: 60_000 });
  if (!r.ok) return [];
  let list = [];
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  const fits = (n) => (n.startsWith(`${project}-`) || n === project) && n !== parent;
  return list.filter((x) => x && typeof x.name === 'string' && NAME_RE.test(x.name) && fits(x.name)).map((x) => ({ name: x.name, url: `https://github.com/${owner}/${x.name}.git` }));
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
