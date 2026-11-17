// Source Control for the editor: the status of the repository the opened folder is in, the two sides of a file for the
// diff editor, stage, unstage, discard, commit, the log and the branches. git gets an argv array, "--" before paths,
// and --literal-pathspecs wherever a path from the page goes in, so a file named like an option or a pathspec (":x",
// "*") is only ever that file. Paths in and out are relative to the opened folder, as everywhere in the editor.
// Every read goes through the reader (gitread.mjs): the folder's own git settings never start a program for it. What
// the owner presses (stage, unstage, discard, commit) is git doing what he asked in his repository, as from his
// terminal: its hooks, filters and fsmonitor run as git has them.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readCommand } from '../gitread.mjs';
import { STATUS_EXCLUDES, excludes } from '../pcsetup/projects.mjs';
import { within } from '../server/folders.mjs';
import { MAX_BYTES, isBinary } from './files.mjs';
import { fail, isHiddenName, isPrivateName, isSecret, resolveIn, rootOf, segments } from './paths.mjs';

/** `base` without what would point git at another repository than the folder's, and without its locks or prompts. */
export const gitEnv = (base = process.env) => Object.fromEntries(Object.entries({ ...base, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' })
  .filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|PREFIX|COMMON_DIR)$/.test(k)));
export { excludes };
// The same folders Workspace's count leaves out: private folders and packages.
const PRIVATE_EXCLUDES = STATUS_EXCLUDES;
const PATHS_MAX = 500;

/** Run `argv` with `env`: { ok, code, out (Buffer), err (text), tooLarge }. */
function exec(argv, env, { cwd, timeout, max }) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd, env, timeout, maxBuffer: max, encoding: 'buffer', windowsHide: true }, (e, out, err) => {
      resolve({
        ok: !e,
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        out: out || Buffer.alloc(0),
        err: String(err || (e && typeof e.code === 'string' ? e.message : '') || ''),
        tooLarge: Boolean(e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'),
      });
    });
  });
}

/** A read of the repository at `cwd`, through the reader: { ok, code, out (Buffer), err (text), tooLarge }. */
export async function git(args, { cwd, timeout = 15_000, max = 16 << 20 } = {}) {
  const c = await readCommand(cwd, args);
  if (c.refused) return { ok: false, code: null, out: Buffer.alloc(0), err: c.refused, tooLarge: false, refused: true };
  return exec(c.argv, c.env, { cwd, timeout, max });
}

/** What the owner pressed (stage, unstage, discard, commit): git as from his terminal, without a prompt. */
const change = (args, { cwd, timeout = 60_000 } = {}) => exec(['git', ...args], gitEnv(), { cwd, timeout, max: 16 << 20 });

const lastWords = (r) => (r.err || r.out.toString('utf8')).trim().split('\n').filter(Boolean).slice(-6).join('\n').slice(0, 1000) || `git ended with ${r.code}`;

/**
 * The repository the opened folder is in: { root, top, prefix } (prefix: the folder inside the repository, "" or
 * "sub/"), or null when it is in none, or in one that starts outside the dashboard's roots (the home folder kept as
 * a repository must not make every folder under it one).
 */
export async function repoOf(rootArg, roots) {
  const root = rootOf(rootArg, roots);
  const r = await git(['rev-parse', '--show-toplevel', '--show-prefix'], { cwd: root });
  if (!r.ok) return { root, top: null, prefix: '' };
  const [topLine, prefix = ''] = r.out.toString('utf8').split('\n');
  let top;
  try {
    top = fs.realpathSync(topLine);
  } catch {
    return { root, top: null, prefix: '' };
  }
  if (!roots.some((x) => within(top, x))) return { root, top: null, prefix: '' };
  return { root, top, prefix };
}

async function needRepo(rootArg, roots) {
  const r = await repoOf(rootArg, roots);
  if (!r.top) throw fail(409, 'this folder is not in a git repository', { code: 'not-a-repo' });
  return r;
}

/** A path git printed (relative to the repository) as a path relative to the opened folder. */
const fromTop = (p, prefix) => (!prefix ? p : p.startsWith(prefix) ? p.slice(prefix.length) : path.posix.relative(prefix.replace(/\/$/, ''), p));

/** `git status --porcelain=v2 -z --branch` → { branch, upstream, ahead, behind, staged, changes, untracked, conflicts }. */
export function parseStatusV2(buf, prefix = '') {
  const t = buf.toString('utf8').split('\0');
  const out = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, staged: [], changes: [], untracked: [], conflicts: [] };
  const field = (s, n) => {
    // The first n space-separated fields, then the path (which may hold spaces).
    let at = 0;
    for (let i = 0; i < n; i++) at = s.indexOf(' ', at) + 1;
    return { parts: s.slice(0, at - 1).split(' '), rest: s.slice(at) };
  };
  for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (!s) continue;
    if (s.startsWith('# ')) {
      const [, key, ...v] = s.split(' ');
      if (key === 'branch.head') {
        out.detached = v[0] === '(detached)';
        out.branch = out.detached ? null : v.join(' ');
      } else if (key === 'branch.upstream') out.upstream = v.join(' ');
      else if (key === 'branch.ab') {
        out.ahead = Math.abs(Number(v[0]) || 0);
        out.behind = Math.abs(Number(v[1]) || 0);
      }
    } else if (s[0] === '1' || s[0] === '2') {
      const { parts, rest } = field(s, s[0] === '1' ? 8 : 9);
      const xy = parts[1];
      const e = { path: fromTop(rest, prefix), x: xy[0], y: xy[1] };
      if (s[0] === '2') e.from = fromTop(t[++i] || '', prefix);
      if (e.x !== '.') out.staged.push(e);
      if (e.y !== '.') out.changes.push(e);
    } else if (s[0] === 'u') {
      const { parts, rest } = field(s, 10);
      out.conflicts.push({ path: fromTop(rest, prefix), x: parts[1][0], y: parts[1][1] });
    } else if (s[0] === '?') out.untracked.push({ path: fromTop(s.slice(2), prefix), x: '?', y: '?' });
  }
  return out;
}

/** Folders one or two levels down that are repositories of their own (a project's code/<repo>), relative paths. */
function nestedRepos(root) {
  const out = [];
  const look = (rel, depth) => {
    let list = [];
    try {
      list = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of list) {
      if (!d.isDirectory() || d.name.startsWith('.') || isHiddenName(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (fs.existsSync(path.join(root, r, '.git'))) out.push(r);
      else if (depth < 2) look(r, depth + 1);
    }
  };
  look('', 1);
  return out.sort().slice(0, 50);
}

/** The status of the opened folder's repository; { repo: false } when it is in none. */
export async function gitStatus(rootArg, roots) {
  const rp = await repoOf(rootArg, roots);
  const repos = nestedRepos(rp.root);
  if (!rp.top) return { repo: false, repos };
  const r = await git(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--', '.', ...PRIVATE_EXCLUDES], { cwd: rp.root, timeout: 30_000 });
  if (r.refused) throw fail(502, r.err, { code: 'git-settings' });
  if (r.tooLarge) throw fail(502, 'git lists too many changed or new files here (more than 16 MB of names): is a large folder missing from .gitignore?', { code: 'too-many' });
  if (!r.ok) throw fail(502, `git status failed: ${lastWords(r)}`);
  return { repo: true, top: rp.top, prefix: rp.prefix.replace(/\/$/, ''), repos, ...parseStatusV2(r.out, rp.prefix) };
}

/**
 * The checked paths of a request: 1 to 500 relative paths of files (a folder would take in what Source Control does
 * not show: its private folders, its packages), none private, inside .git or a file with a sign-in.
 */
function pathList(paths, root) {
  if (!Array.isArray(paths) || !paths.length || paths.length > PATHS_MAX) throw fail(400, `send 1 to ${PATHS_MAX} paths`);
  return paths.map((p) => {
    const s = segments(p);
    if (!s.length) throw fail(400, 'name the files, not the opened folder');
    const abs = path.join(root, ...s);
    if (isSecret(abs)) throw fail(403, 'that file holds a sign-in: the dashboard never changes it');
    let st = null;
    try {
      st = fs.lstatSync(abs);
    } catch {
      /* deleted on disk: still a file to git */
    }
    if (st && st.isDirectory()) throw fail(400, 'name the files, not a folder');
    return s.join('/');
  });
}

/** One side of a diff from git (`spec`: "HEAD:./x" or ":./x"): { text, exists, binary, tooLarge }. */
async function blob(root, spec) {
  const size = await git(['cat-file', '-s', spec], { cwd: root });
  if (!size.ok) return { text: '', exists: false };
  if (Number(size.out.toString('utf8').trim()) > MAX_BYTES) return { text: '', exists: true, tooLarge: true };
  const r = await git(['cat-file', 'blob', spec], { cwd: root, max: MAX_BYTES + 1 });
  if (!r.ok) return { text: '', exists: false };
  return isBinary(r.out) ? { text: '', exists: true, binary: true } : { text: r.out.toString('utf8'), exists: true };
}

/** The file as it is on disk (only inside the opened folder). */
function working(root, rel, roots) {
  let at;
  try {
    at = resolveIn(root, rel, roots);
  } catch (e) {
    if (e.status === 404) return { text: '', exists: false };
    throw e;
  }
  const st = fs.statSync(at.abs);
  if (!st.isFile()) return { text: '', exists: false };
  if (st.size > MAX_BYTES) return { text: '', exists: true, tooLarge: true };
  const buf = fs.readFileSync(at.abs);
  return isBinary(buf) ? { text: '', exists: true, binary: true } : { text: buf.toString('utf8'), exists: true };
}

/**
 * The two sides of a file for the diff editor. staged: the last commit against the staged file; else the staged file
 * (or the last commit, when nothing is staged) against the file on disk. A new file has an empty original.
 */
export async function diffSides(rootArg, rel, staged, roots) {
  const rp = await needRepo(rootArg, roots);
  const p = segments(rel).join('/');
  if (!p) throw fail(400, 'name a file');
  if (isSecret(path.join(rp.root, p))) throw fail(403, 'that file holds a sign-in: the dashboard never shows it');
  const head = () => blob(rp.root, `HEAD:./${p}`);
  const index = () => blob(rp.root, `:./${p}`);
  const [a, b] = staged ? [await head(), await index()] : [await index(), working(rp.root, p, roots)];
  return {
    path: p, staged: Boolean(staged),
    original: a.text, modified: b.text, originalExists: a.exists, modifiedExists: b.exists,
    binary: Boolean(a.binary || b.binary), tooLarge: Boolean(a.tooLarge || b.tooLarge),
  };
}

const hasHead = async (root) => (await git(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root })).ok;

async function must(r, what) {
  if (r.refused) throw fail(502, r.err, { code: 'git-settings' });
  if (!r.ok) throw fail(409, `${what} failed: ${lastWords(r)}`, { code: 'git-failed' });
  return r;
}

export async function stage(rootArg, paths, roots) {
  const rp = await needRepo(rootArg, roots);
  const list = pathList(paths, rp.root);
  await must(await change(['--literal-pathspecs', 'add', '-A', '--', ...list], { cwd: rp.root }), 'git add');
  return { staged: list };
}

export async function unstage(rootArg, paths, roots) {
  const rp = await needRepo(rootArg, roots);
  const list = pathList(paths, rp.root);
  // Before the first commit there is no HEAD to go back to: the files simply leave the index.
  const args = (await hasHead(rp.root)) ? ['restore', '--staged', '--', ...list] : ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...list];
  await must(await change(['--literal-pathspecs', ...args], { cwd: rp.root }), 'git restore --staged');
  return { unstaged: list };
}

/** Throw away the changes on disk: a tracked file goes back to its staged state, a new (untracked) file is deleted. */
export async function discard(rootArg, paths, confirm, roots) {
  if (confirm !== true) throw fail(400, 'confirm the discard: the changes cannot be brought back');
  const rp = await needRepo(rootArg, roots);
  const list = pathList(paths, rp.root);
  const u = await must(await git(['--literal-pathspecs', 'ls-files', '-z', '--others', '--exclude-standard', '--', ...list], { cwd: rp.root }), 'git ls-files');
  const untracked = new Set(u.out.toString('utf8').split('\0').filter(Boolean));
  const tracked = list.filter((p) => !untracked.has(p));
  if (tracked.length) await must(await change(['--literal-pathspecs', 'restore', '--worktree', '--', ...tracked], { cwd: rp.root }), 'git restore');
  const deleted = [];
  for (const p of list.filter((x) => untracked.has(x))) {
    const at = resolveIn(rp.root, p, roots, { mode: 'entry' });
    fs.rmSync(at.abs, { force: true });
    deleted.push(p);
  }
  return { restored: tracked, deleted };
}

/** Commit what is staged. The repository's hooks run; their output comes back when they refuse. */
export async function commit(rootArg, message, amend, roots) {
  if (typeof message !== 'string' || !message.trim()) throw fail(400, 'write a commit message');
  if (message.length > 20_000) throw fail(400, 'the commit message is too long');
  if (amend !== undefined && typeof amend !== 'boolean') throw fail(400, 'amend is true or false');
  const rp = await needRepo(rootArg, roots);
  // A commit takes the whole index. Source Control shows only what is staged in the opened folder, outside private
  // folders and packages: when the index holds more than that, nothing is committed (the owner would not see it).
  // --no-renames: a staged rename is its two sides, so a source outside the folder (or in a private one) counts too.
  const names = async (args) => new Set((await must(await git(['diff', '--cached', '--no-renames', '--name-only', '-z', ...args], { cwd: rp.root }), 'git diff')).out.toString('utf8').split('\0').filter(Boolean));
  const all = await names([]);
  const shown = await names(['--', '.', ...PRIVATE_EXCLUDES]);
  const hidden = [...all].filter((p) => !shown.has(p));
  if (hidden.length) {
    const priv = hidden.filter((p) => p.split('/').some((s) => isPrivateName(s))).length;
    const n = hidden.length;
    throw fail(409, priv
      ? `${priv} staged file${priv === 1 ? ' is' : 's are'} in a private folder, which the dashboard never commits. Unstage ${priv === 1 ? 'it' : 'them'} in a terminal first.`
      : `${n} staged file${n === 1 ? ' is' : 's are'} not shown here (outside this folder, or in a folder the editor hides). Open the repository's top folder to see ${n === 1 ? 'it' : 'them'}, or unstage ${n === 1 ? 'it' : 'them'} first.`,
    { code: 'staged-elsewhere', count: n });
  }
  if (!amend && !all.size) throw fail(409, 'nothing is staged to commit', { code: 'nothing-staged' });
  const r = await change(['commit', '-q', ...(amend ? ['--amend'] : []), '-m', message], { cwd: rp.root, timeout: 120_000 });
  if (!r.ok) throw fail(409, `the commit was not made: ${lastWords(r)}`, { code: 'commit-failed' });
  const h = await git(['log', '-1', '--format=%h%x00%s'], { cwd: rp.root });
  const [hash, subject] = h.out.toString('utf8').trim().split('\0');
  return { commit: hash, subject };
}

/** The newest commits (of one file with `rel`): [{ hash, short, author, at, subject }]. */
export async function gitLog(rootArg, n, rel, roots) {
  const rp = await needRepo(rootArg, roots);
  const count = n === null || n === undefined || n === '' ? 50 : Number(n);
  if (!Number.isInteger(count) || count < 1 || count > 200) throw fail(400, 'n is 1 to 200');
  const p = rel ? segments(rel).join('/') : '';
  if (!(await hasHead(rp.root))) return { commits: [] };
  const r = await must(await git(['--literal-pathspecs', 'log', '-z', '--format=%H%x00%h%x00%an%x00%at%x00%s', '-n', String(count), ...(p ? ['--', p] : [])], { cwd: rp.root }), 'git log');
  const t = r.out.toString('utf8').split('\0');
  const commits = [];
  for (let i = 0; i + 4 < t.length; i += 5) commits.push({ hash: t[i].replace(/^\n/, ''), short: t[i + 1], author: t[i + 2], at: Number(t[i + 3]) * 1000, subject: t[i + 4] });
  return { commits };
}

/** The local and remote branches and which one is checked out. */
export async function gitBranches(rootArg, roots) {
  const rp = await needRepo(rootArg, roots);
  const r = await must(await git(['for-each-ref', '--format=%(refname)%00%(objectname:short)%00%(upstream:short)%00%(HEAD)', 'refs/heads', 'refs/remotes'], { cwd: rp.root }), 'git for-each-ref');
  const local = [];
  const remote = [];
  let current = null;
  for (const line of r.out.toString('utf8').split('\n')) {
    const [ref, short, upstream, head] = line.split('\0');
    if (!ref) continue;
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice(11);
      if (head === '*') current = name;
      local.push({ name, commit: short, upstream: upstream || null, current: head === '*' });
    } else if (!ref.endsWith('/HEAD')) remote.push({ name: ref.slice(13), commit: short });
  }
  return { current, local, remote };
}
