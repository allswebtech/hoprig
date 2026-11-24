// The check of the move's copy (src/setup/movecopy.mjs): it compares root's side with the user's and counts what
// differs. Per repository of the workspace (linked work trees too): the same head, the same `git status --porcelain`,
// the same branches and stashes, the same count of working files. Per part: the same count of entries. Every entry of
// the copy belongs to the user (the owner is read through `ownerOf`, handed in by tests). Per project of Claude Code:
// the same conversation ids in its new place, and every file of its old folder (agents' files at any depth) the same
// by content in the new one. git reads go through src/gitread.mjs; the copy's are run as the user.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readCommand } from '../gitread.mjs';
import { claudeSlug } from './movecopy.mjs';
import { capture } from './system.mjs';
import { runAsUser } from './asuser.mjs';
import { measure } from './moveplan.mjs';
import { moved } from './movecopy.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const REPO_DEPTH = 8;

/** The repositories under `dir` (a folder with a `.git` folder or file), linked work trees among them. */
export function findRepos(dir) {
  const out = [];
  const walk = (d, depth) => {
    let names;
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (names.some((e) => e.name === '.git')) out.push(d);
    if (depth >= REPO_DEPTH) return;
    for (const e of names) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), depth + 1);
  };
  walk(dir, 0);
  return out.sort();
}

/** Working files of a repository (everything but `.git`), counted; a nested repository counts as its own. */
function workingCount(repo) {
  return (measure(repo, { lstat: fs.lstatSync, readdir: (d) => fs.readdirSync(d, { withFileTypes: true }) }, (rel) => !rel.split('/').includes('.git'))?.entries || 0) - 1;
}

/** A read of git, safely (gitread.mjs), whoever owns the folder: `run` is root's or the user's. */
async function git(dir, args, run) {
  // Root's own tree can hold entries of another owner (copied from elsewhere), and git refuses a repository of another
  // owner. That check is about programs a repository's settings start, which every read here already switches off
  // (gitread.mjs), so the listing of the settings and the read itself both get safe.directory on the command line.
  const any = (argv, o) => run([argv[0], '-c', 'safe.directory=*', ...argv.slice(1)], o);
  const c = await readCommand(dir, args, { run: any });
  if (c.refused) return null;
  const r = await any(c.argv, { env: c.env, timeout: 60_000 });
  return r.ok ? r.stdout : null;
}

function stashCount(repo) {
  try {
    return fs.readFileSync(path.join(repo, '.git', 'logs', 'refs', 'stash'), 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** One repository's facts: { head, status, branches, stashes, files }. */
export async function repoFacts(repo, run) {
  const [head, status, branches] = await Promise.all([
    git(repo, ['rev-parse', 'HEAD'], run),
    git(repo, ['status', '--porcelain'], run),
    git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], run),
  ]);
  return { head: head?.trim() ?? null, status, branches, stashes: stashCount(repo), files: workingCount(repo) };
}

const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Every file under `dir` (relative path → its content's hash), at any depth. */
function hashes(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.set(r, hash(path.join(d, e.name)));
    }
  };
  try {
    walk(dir, '');
  } catch {
    /* none */
  }
  return out;
}

/** Every entry under each folder of `roots` whose owner (`ownerOf`) is not `uid`: their count, and the first few. */
function otherOwners(roots, uid, ownerOf) {
  let n = 0;
  const first = [];
  const walk = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (ownerOf(p, st) !== uid) {
      n += 1;
      if (first.length < 5) first.push(p);
    }
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) walk(path.join(p, name));
  };
  for (const r of roots) walk(r);
  return { n, first };
}

/**
 * Check the copy of `plan` (movePlan) after `copied` (copyParts). → { ok, problems: [lines], repos, conversations,
 * owners, hashes: { same, total } }. `asUser(argv, opts)` runs a read as the user; `ownerOf(path, lstat)` reads an
 * entry's owner; `runRoot` runs root's own reads.
 */
export async function checkCopy(plan, copied, { asUser, runRoot = capture, ownerOf = (p, st) => st.uid, onProgress } = {}) {
  const { user, oldHome } = plan;
  const newHome = user.home;
  const runUser = asUser || ((argv, o) => runAsUser(user, argv, o));
  const problems = [];
  const part = (id) => plan.parts.find((p) => p.id === id);

  // Repositories, linked work trees among them.
  const ws = part('workspace');
  const repos = ws ? findRepos(ws.from) : [];
  let i = 0;
  for (const repo of repos) {
    const a = await repoFacts(repo, runRoot);
    const b = await repoFacts(moved(repo, oldHome, newHome), runUser);
    const rel = path.relative(ws.from, repo) || '.';
    for (const k of ['head', 'status', 'branches', 'stashes', 'files']) if (a[k] !== b[k]) problems.push(`${rel}: its ${k === 'files' ? 'count of files' : k} differs in the copy${k === 'head' ? ` (${a.head || 'none'} → ${b.head || 'none'})` : ''}`);
    onProgress?.({ phase: 'check', repos: (i += 1), totalRepos: repos.length });
  }

  // Each part's count of entries (Claude Code's folder without the project folders placed under their new names).
  const placedNew = new Set((copied.placed || []).map((p) => `projects/${p.to}`));
  const fsIo = { lstat: fs.lstatSync, readdir: (d) => fs.readdirSync(d, { withFileTypes: true }) };
  for (const p of plan.parts) {
    if (p.id === 'ssh') continue;
    const keep = p.id === 'claude' ? (r) => !placedNew.has(r.split('/').slice(0, 2).join('/')) || fs.existsSync(path.join(p.from, r.split('/').slice(0, 2).join('/'))) : p.keep;
    const a = measure(p.from, fsIo, p.keep)?.entries ?? 0;
    const b = measure(p.to, fsIo, keep)?.entries ?? 0;
    if (a !== b) problems.push(`${p.what}: root's has ${a} entries, the copy ${b}`);
  }

  // Owners: every entry of the copy is the user's.
  const owners = otherOwners(copied.made.filter((m) => fs.existsSync(m)), user.uid, ownerOf);
  if (owners.n) problems.push(`${owners.n} entr${owners.n === 1 ? 'y' : 'ies'} of the copy do not belong to ${user.name} (${owners.first.join(', ')})`);

  // Conversations: the same ids per project in its new place, and every file the same by content.
  const claude = part('claude');
  const conversations = [];
  const same = { same: 0, total: 0, differ: [] };
  if (claude) {
    const oldSlug = claudeSlug(oldHome);
    const newSlug = claudeSlug(newHome);
    let names = [];
    try {
      names = fs.readdirSync(path.join(claude.from, 'projects')).filter((n) => n === oldSlug || n.startsWith(`${oldSlug}-`));
    } catch {
      /* none */
    }
    for (const name of names) {
      const to = newSlug + name.slice(oldSlug.length);
      const ids = (d) => {
        try {
          return fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort();
        } catch {
          return [];
        }
      };
      const before = ids(path.join(claude.from, 'projects', name));
      const after = ids(path.join(claude.to, 'projects', to));
      conversations.push({ project: to, ids: after.length });
      if (before.join() !== after.join()) problems.push(`the conversations of ${to} differ in their new place (${before.length} before, ${after.length} after)`);
      const a = hashes(path.join(claude.from, 'projects', name));
      const b = hashes(path.join(claude.to, 'projects', to));
      for (const [rel, h] of a) {
        same.total += 1;
        if (b.get(rel) === h) same.same += 1;
        else same.differ.push(`${to}/${rel}`);
      }
    }
    if (same.differ.length) problems.push(`${same.differ.length} conversation file${same.differ.length === 1 ? '' : 's'} differ by content in the new place (${same.differ.slice(0, 3).join(', ')})`);
  }
  return { ok: problems.length === 0, problems, repos: repos.length, conversations, owners: owners.n, hashes: same };
}
