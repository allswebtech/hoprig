// A made-up computer that already has projects, in a temporary home, with local bare repositories as its "server",
// and a whole-tree snapshot to prove that a step changed nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeTree } from '../workspace/helpers.mjs';

// The real git, found before any trap is put on PATH (the fixture builds its tree with it). On Windows the `sh` of Git
// for Windows answers `command -v git` with a path of its own world (/ucrt64/bin/git) that Node cannot start, so there
// git.exe is looked for on PATH the way Windows finds it.
const onWindowsPath = () => (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'git.exe')).find((f) => fs.existsSync(f));
export const REAL_GIT = process.platform === 'win32' ? onWindowsPath() || 'git' : execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
// No maintenance in the background: a commit or a fetch of the fixture may start git's own upkeep as a detached
// process, and its lock file then comes and goes while a snapshot walks the tree (seen on macOS: ENOENT on
// .git/objects/maintenance.lock in the middle of a walk).
const QUIET = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
export const git = (cwd, ...args) => execFileSync(REAL_GIT, [...QUIET, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository at `dir` with one commit and a bare "server" beside it as origin. */
export function repo(dir, server, files = { 'README.md': '# x\n' }) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeTree(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'first');
  if (server) {
    fs.mkdirSync(path.dirname(server), { recursive: true });
    git(path.dirname(server), 'init', '-q', '--bare', path.basename(server));
    git(dir, 'remote', 'add', 'origin', server);
    git(dir, 'push', '-q', 'origin', 'main');
    git(dir, 'fetch', '-q', 'origin');
    git(dir, 'branch', '-q', '--set-upstream-to=origin/main');
  }
  return dir;
}

/** Every path below `root` with its kind, size, mode, mtime and content hash (links: their target). */
export function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      const rel = path.relative(root, p);
      const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
      const hash = kind === 'file' ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : kind === 'link' ? fs.readlinkSync(p) : '';
      out[rel] = `${kind} ${kind === 'dir' ? '' : st.size} ${st.mode.toString(8)} ${st.mtimeMs} ${hash}`;
      if (kind === 'dir') walk(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Traps first on PATH: npm, ssh, gh, sudo, systemctl, loginctl, apt-get and brew fail loudly and leave a line in
 * `<root>/traps.log`; git is a stand-in that logs every call and refuses push, fetch, pull, clone of a server and
 * ls-remote before handing the rest to the real git. → { bin, log, calls() }.
 */
export function traps(root) {
  const bin = path.join(root, 'traps');
  const log = path.join(root, 'traps.log');
  fs.mkdirSync(bin, { recursive: true });
  for (const n of ['npm', 'npx', 'ssh', 'gh', 'sudo', 'systemctl', 'loginctl', 'apt-get', 'brew']) {
    fs.writeFileSync(path.join(bin, n), `#!/bin/sh\necho "TRAP ${n} $*" >> '${log}'\necho "trap: ${n} must not run in this test" >&2\nexit 97\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "git $*" >> '${log}'\nfor a in "$@"; do case "$a" in push|fetch|pull|ls-remote) echo "TRAP git $a" >> '${log}'; echo "trap: git $a must not run in this test" >&2; exit 97;; esac; done\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { bin, log, calls, trapped: () => calls().filter((l) => l.startsWith('TRAP')) };
}

/**
 * A made-up computer that already has projects, shaped like a hand-arranged one: under `<root>/code` four projects
 *   shop   already in the layout (AGENTS.md, project.json, code/shop)
 *   blog   two repositories, a linked worktree outside the repository and a stash
 *   notes  one repository with uncommitted and untracked work, ignored .env files, a private folder
 *   tools  another tool's skill, rules file and hook, and sessions of the coding tool and of that other tool
 * and their "server" of bare repositories under `<root>/server`. → { place, server, dirs }
 */
export function madeUpComputer(t) {
  const place = path.join(t.root, 'code');
  const server = path.join(t.root, 'server');
  const shop = path.join(place, 'shop');
  writeTree(shop, { 'AGENTS.md': '# Shop\n', 'project.json': '{ "name": "shop", "repos": [] }\n' });
  repo(path.join(shop, 'code', 'shop'), path.join(server, 'shop.git'), { 'package.json': '{ "name": "shop" }\n' });
  const blog = path.join(place, 'blog');
  const web = repo(path.join(blog, 'web'), path.join(server, 'blog-web.git'), { 'package.json': '{ "name": "blog-web" }\n', 'src/a.js': 'a\n' });
  repo(path.join(blog, 'api'), path.join(server, 'blog-api.git'), { 'go.mod': 'module api\n' });
  git(web, 'worktree', 'add', '-q', '-b', 'feature', path.join(blog, 'web-feature'));
  writeTree(path.join(blog, 'web-feature'), { 'src/a.js': 'work in the worktree\n' });
  writeTree(web, { 'src/a.js': 'stashed\n' });
  git(web, 'stash', 'push', '-q', '-m', 'half done');
  writeTree(blog, { 'deploy.sh': `#!/bin/sh\ncd ${blog}/web && npm run build\n`, 'backups/db.sql': 'insert into t values (1);\n', 'plan.md': '# How the blog started\n' });
  const notes = path.join(place, 'notes');
  repo(notes, path.join(server, 'notes.git'), { '.gitignore': '.env\n.env.*\n', 'README.md': '# notes\n', 'app.py': 'print(1)\n', 'pyproject.toml': '[project]\nname = "notes"\n' });
  writeTree(notes, { 'app.py': 'print(2)\n', 'draft.txt': 'untracked\n', '.env': 'TOKEN=made-up\n', '.env.local': 'X=1\n', 'no-ai/private.txt': 'made-up private words\n' });
  const tools = path.join(place, 'tools');
  repo(tools, null, { 'package.json': '{ "name": "tools" }\n', '.kiro/skills/series/SKILL.md': '---\nname: series\ndescription: Makes a made-up series.\n---\n\nSteps.\n', '.kiro/steering/about.md': '---\ninclusion: always\n---\nThe owner likes short answers.\n', '.kiro/hooks/guard.json': '{ "when": "preToolUse", "then": "node guard.mjs" }\n' });
  git(tools, 'config', 'credential.helper', `!${tools}/.bin/helper`);
  const key = (d) => d.replace(/[^A-Za-z0-9]/g, '-');
  writeTree(path.join(t.claude, 'projects', key(tools)), { '11111111-2222-4333-8444-555555555555.jsonl': '{"type":"user","message":{"role":"user","content":"make the series"}}\n', 'memory/MEMORY.md': '- the series is weekly\n' });
  writeTree(path.join(t.home, '.kiro', 'sessions', 'abc', 'sess_1'), { 'session.json': JSON.stringify({ workspacePaths: [tools] }) });
  return { place, server, dirs: { shop, blog, notes, tools } };
}

/** The snapshot of every place a step must not change: the made-up computer's places, its server and the coding tool. */
export const allOf = (...roots) => Object.assign({}, ...roots.map((r) => Object.fromEntries(Object.entries(fs.existsSync(r) ? snapshot(r) : {}).map(([k, v]) => [`${r}/${k}`, v]))));
