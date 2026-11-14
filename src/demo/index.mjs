// `hoprig demo`: the dashboard with believable sample data and working sessions, needing no Claude Code and
// no account — to try it in ten seconds and to take the README's screenshots.
//
// Everything lives in a fresh folder under the OS temp folder (settings, accounts, state, a home folder for the
// sessions) and is removed when the demo stops; the real settings, accounts and Claude folders are never read or
// written. The server listens on 127.0.0.1 only, on a free port, and the browser is signed in with a one-time
// link. What it sets up:
//   five sessions in different states (working with output flowing, waiting for you, needs your OK, limit
//   reached, waiting with a queue), three accounts with usage, Auto mode on, a second computer ("Laptop", a
//   second demo server in its own temp folder), a schedule, a Tia conversation with a confirm card and a finished
//   job, the TRouteAI add-on (pretend: "installing" it prints lines and installs nothing).
// The sessions are src/demo/session.mjs (looks like Claude Code, talks to no model); Tia's engine is
// src/demo/tia.mjs; the sign-in on the Providers page is src/demo/signin.mjs.
//
//   hoprig demo [--port N] [--no-open]
// Internal (the second computer, and tests): --secondary, --ready-file <file> (writes { url, link, root, … }).
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.join(HERE, 'session.mjs');
const TIA = path.join(HERE, 'tia.mjs');
const SIGNIN = path.join(HERE, 'signin.mjs');
const SELF = fileURLToPath(import.meta.url);

const MAIN_FOLDERS = ['shop-frontend', 'api-server', 'mobile-app', 'docs-site', 'data-pipeline', 'landing-page'];
const LAPTOP_FOLDERS = ['blog', 'scripts'];

function parseArgs(args) {
  const o = { port: 0, open: true, secondary: false, readyFile: null, quiet: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') o.port = Number(args[++i]);
    else if (a === '--no-open') o.open = false;
    else if (a === '--secondary') o.secondary = true;
    else if (a === '--ready-file') o.readyFile = args[++i];
    else if (a === '--quiet') o.quiet = true;
    else throw new Error(`unknown option ${a} (use: demo [--port N] [--no-open])`);
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error('--port must be a number from 1 to 65535');
  return o;
}

/**
 * Point every place hoprig and Claude Code look at into `root`. Called before anything reads a path (paths.mjs
 * reads the environment on every call). Credentials from the environment are dropped, so nothing real is used.
 */
/** A folder holding only a link to the Node that runs the demo, for its PATH. */
function nodeOnly(root) {
  const dir = path.join(root, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'node'))) fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  return dir;
}

export function isolate(root, env = process.env) {
  const home = path.join(root, 'home');
  for (const d of ['config', 'state', 'profiles', home, path.join(home, '.claude'), path.join(home, 'Workspace', 'projects')]) fs.mkdirSync(path.isAbsolute(d) ? d : path.join(root, d), { recursive: true, mode: 0o700 });
  Object.assign(env, {
    HOPRIG_CONFIG_DIR: path.join(root, 'config'),
    HOPRIG_STATE_DIR: path.join(root, 'state'),
    HOPRIG_PROFILES_DIR: path.join(root, 'profiles'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    // Folders show as ~/projects/…, and the sessions' shell starts clean (no personal shell setup, no prompt with
    // a real name in it).
    HOME: home,
    HOPRIG_HOSTNAME: 'workstation', // a made-up host name for the Computers page (the Laptop says its own)
    SHELL: '/bin/sh',
    PS1: '$ ',
    // Only the system's own programs and this Node (the demo's stand-ins for Claude Code are Node scripts): the
    // demo must not find (and show) the tools installed on this computer.
    ...(process.platform === 'win32' ? {} : { PATH: `${nodeOnly(root)}:/usr/bin:/bin:/usr/sbin:/sbin` }),
  });
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|HOPRIG_PROFILE$|HOPRIG_TERM_ID$|TMUX$|TMUX_PANE$)/.test(k)) delete env[k];
  return home;
}

// A pretend TRouteAI add-on: "install" prints believable lines and installs nothing.
function demoAddon() {
  const st = { installed: false, running: false };
  const url = 'http://localhost:20017';
  const lines = async (onLine, list) => {
    for (const l of list) {
      onLine(l);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  return {
    id: 'trouteai',
    title: 'TRouteAI',
    summary: 'A self-hosted AI gateway. Add any provider in its dashboard (OpenAI, Gemini, OpenRouter, local models…) and Claude Code can use them all as one more provider.',
    homepage: 'https://github.com/allswebtech/trouteai',
    status: async () => ({ installed: st.installed, version: st.installed ? '1.0.8' : null, running: st.running, url }),
    install: async ({ onLine = () => {} } = {}) => {
      await lines(onLine, ['(demo) npm install -g trouteai', 'added 41 packages in 3s', '(demo) nothing was installed: this is the demo']);
      st.installed = true;
      return { ok: true };
    },
    update: async ({ onLine = () => {} } = {}) => {
      await lines(onLine, ['(demo) already the newest version']);
      return { ok: true };
    },
    start: async () => {
      st.running = st.installed;
      return st.installed ? { ok: true, url } : { ok: false, url, error: 'TRouteAI is not installed' };
    },
    stop: async () => {
      st.running = false;
      return { ok: true };
    },
    profile: () => ({ name: 'api', label: 'API via TRouteAI', env: { ANTHROPIC_BASE_URL: url }, prerun: '', tokenVar: 'ANTHROPIC_AUTH_TOKEN', tokenHint: 'demo' }),
  };
}

// Home → Get started and Computer → Setup in the demo: made-up facts instead of this computer's own (which could
// show its user name, its tools, its projects).
const DEMO_FACTS = {
  claude: async () => ({ installed: '2.1.330', loggedIn: true }),
  tools: async () => ({ missing: [] }),
  rules: async () => ({ installed: true, edited: false }),
  projects: async () => ['shop-frontend', 'api-server', 'data-pipeline'],
  skills: async () => [],
  machines: async () => [],
  sessions: async () => 1,
};
const C = (group, id, label, status, detail, extra = {}) => ({ group, id, label, status, detail, fix: '', ...extra });
const DEMO_CHECKS = [
  C('system', 'os', 'macOS 15.4', 'ok', 'up to date'),
  C('system', 'disk', 'Free disk space', 'ok', '182 GB free'),
  C('system', 'memory', 'Memory', 'ok', '16 GB'),
  C('kit:basics', 'basics.git', 'git', 'ok', '2.47.1'),
  C('kit:basics', 'basics.ripgrep', 'ripgrep', 'ok', '14.1.1'),
  C('kit:node', 'node.node', 'Node.js', 'ok', '22.12.0'),
  C('kit:node', 'node.pnpm', 'pnpm', 'fail', 'missing', { fixKit: 'node' }),
  C('kit:python', 'python.python', 'Python', 'ok', '3.13.1'),
  C('kit:python', 'python.uv', 'uv', 'warn', '0.4.2 is old; 0.6.1 is out', { fixKit: 'python' }),
  C('kit:github', 'github.gh', 'GitHub CLI', 'ok', '2.63.0'),
  C('kit:github', 'github.signin', 'Signed in to GitHub', 'info', 'not signed in (optional)'),
  C('claude', 'claude.code', 'Claude Code', 'ok', '2.1.330'),
  C('claude', 'claude.rules', 'Working rules', 'ok', 'added'),
];

/** The Computer tab in the demo: sample numbers and processes, never the real computer's; stopping is refused. */
export function demoSystem(secondary) {
  const GB = 1024 ** 3;
  const proc = (pid, name, args, cpu, rss, mine = true) => ({ pid, uid: 501, cpu, rss: rss * 1024 ** 2, age: 3600 + pid, name, args, mine });
  const procs = secondary
    ? [proc(4120, 'node', 'node scripts/backup.mjs', 3.1, 90), proc(4188, 'claude', 'claude', 1.2, 240)]
    : [
      proc(2311, 'node', 'node node_modules/.bin/next dev', 42.5, 610),
      proc(2402, 'claude', 'claude --resume', 12.8, 380),
      proc(2455, 'postgres', 'postgres -D /usr/local/var/postgresql', 6.4, 210, false),
      proc(2518, 'claude', 'claude', 4.9, 300),
      proc(2601, 'python3', 'python3 -m pipeline.run --dry-run', 3.3, 150),
      proc(2690, 'node', 'node src/server.js', 1.7, 120),
    ];
  const refused = async () => ({ ok: false, error: 'not in the demo: nothing on this computer is stopped' });
  return {
    snapshot: async () => ({
      host: secondary ? 'laptop' : 'workstation',
      platform: process.platform,
      uptime: 3 * 86400 + 5 * 3600 + 12 * 60,
      load: [1.8, 1.5, 1.2],
      cpus: 10,
      mem: { total: 16 * GB, available: 6.5 * GB, swapTotal: 2 * GB, swapFree: 1.7 * GB },
      disks: [{ mount: '/', size: 494 * GB, used: 312 * GB, avail: 182 * GB, fs: 'apfs' }],
      topCpu: [...procs].sort((a, b) => b.cpu - a.cpu),
      topMem: [...procs].sort((a, b) => b.rss - a.rss),
      ports: secondary ? [] : [
        { addr: '127.0.0.1', port: 3000, process: 'node', pid: 2311 },
        { addr: '127.0.0.1', port: 5432, process: 'postgres', pid: 2455 },
        { addr: '127.0.0.1', port: 8080, process: 'node', pid: 2690 },
      ],
      errors: [],
    }),
    killProcess: refused,
    power: refused,
  };
}

const CLAUDE_INFO = { installed: '2.1.330', path: '~/.local/bin/claude', latest: '2.1.330', method: 'native', updateAvailable: false };

// git for the demo's own sample repositories: never the owner's git settings, a made-up author.
const gitEnv = () => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const git = (dir, ...args) => execFileSync('git', ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', ...args], { cwd: dir, stdio: 'ignore', timeout: 10_000, env: gitEnv() });

/** A real (tiny) git repository in `dir`, when git is there; the demo works without one. */
function gitInit(dir) {
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'Start of the demo project');
    return true;
  } catch {
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    return false;
  }
}

/**
 * The Workspace page's git stories, each with an "online copy" (a bare repository in the demo's own folder):
 * up to date, one saved change to upload, one change not saved to git, two new changes to download. The other
 * folders have no online copy ("not on GitHub yet").
 */
function gitStories(projects, remotes) {
  const online = (f) => {
    const bare = path.join(remotes, `${f}.git`);
    fs.mkdirSync(bare, { recursive: true });
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(path.join(projects, f), 'remote', 'add', 'origin', bare);
    git(path.join(projects, f), 'push', '-q', '-u', 'origin', 'main');
    return bare;
  };
  try {
    online('shop-frontend');
    online('api-server');
    fs.writeFileSync(path.join(projects, 'api-server', 'CHANGELOG.md'), '# Changes\n\n- Rate limiting on the login route\n');
    git(path.join(projects, 'api-server'), 'add', '-A');
    git(path.join(projects, 'api-server'), 'commit', '-q', '-m', 'Add a changelog');
    online('docs-site');
    fs.writeFileSync(path.join(projects, 'docs-site', 'README.md'), '# Docs\n\nWork in progress.\n');
    const bare = online('data-pipeline');
    const other = path.join(remotes, 'data-pipeline-elsewhere'); // someone else's computer, two commits ahead
    execFileSync('git', ['clone', '-q', bare, other], { stdio: 'ignore', timeout: 10_000, env: gitEnv() });
    for (const n of [1, 2]) {
      fs.writeFileSync(path.join(other, `step${n}.py`), `# step ${n}\n`);
      git(other, 'add', '-A');
      git(other, 'commit', '-q', '-m', `Add step ${n}`);
    }
    git(other, 'push', '-q');
    git(path.join(projects, 'data-pipeline'), 'fetch', '-q');
  } catch {
    /* the demo works without them */
  }
}

/** A project with its code repositories under code/ (docs/PC-SETUP.md), on the main computer. */
function workspace(projects) {
  const root = path.join(projects, 'bookshop');
  for (const d of ['code', 'docs', 'ai_brain/claude-memory']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Bookshop\n\nRules for AI tools. The code lives in code/.\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '/code/*\n!/code/.gitignore\n');
  fs.writeFileSync(path.join(root, 'code', '.gitignore'), '*\n!.gitignore\n');
  fs.writeFileSync(path.join(root, 'ai_brain', 'claude-memory', '.gitkeep'), '');
  if (!gitInit(root)) return;
  for (const [name, file, text] of [['bookshop-web', 'package.json', JSON.stringify({ name: 'bookshop-web', private: true, dependencies: { next: '15.1.0', react: '19.0.0' } }, null, 2)], ['bookshop-api', 'pyproject.toml', '[project]\nname = "bookshop-api"\n']]) {
    const dir = path.join(root, 'code', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    gitInit(dir);
  }
}

/**
 * The workspace's map, sync, restore and the Git and GitHub state, as sample data (the workspace feature's stand-ins,
 * src/workspace/feature.mjs). Made-up addresses on git.example.com; nothing reaches a network. The main computer
 * has a map with the brain, two projects here, one project that is not on this computer and one tool; the second
 * computer has no map and is not signed in to GitHub.
 */
function demoWorkspaceMore(home, secondary) {
  const ws = path.join(home, 'Workspace');
  const at = (p) => `https://git.example.com/demo/${p}.git`;
  if (!secondary) {
    const tool = path.join(ws, 'development', 'flutter');
    fs.mkdirSync(tool, { recursive: true });
    fs.writeFileSync(path.join(tool, 'README.md'), '# A toolchain checkout (sample)\n');
    gitInit(tool);
    const map = {
      version: 1,
      brain: { url: at('ai_brain') },
      projects: [
        { name: 'bookshop', url: at('bookshop'), repos: [{ dir: 'code/bookshop-api', url: at('bookshop-api') }, { dir: 'code/bookshop-web', url: at('bookshop-web') }] },
        { name: 'shop-frontend', url: at('shop-frontend'), repos: [] },
        { name: 'invoices', url: at('invoices'), repos: [{ dir: 'code/invoices-api', url: at('invoices-api') }] },
      ],
      others: [{ dir: 'development/flutter', url: 'https://git.example.com/tools/flutter.git', sync: false }],
    };
    fs.writeFileSync(path.join(ws, 'ai_brain', 'workspace.json'), `${JSON.stringify(map, null, 2)}\n`);
  }
  // Every sample repository gets a made-up https address, so the map, its notes and the pages show those and never
  // a folder of this computer. git reaches the address through `url.<local>.insteadOf`: a bare copy next to the
  // demo's home (made here when the repository has none yet), so a project's Sync still works without a network.
  const remotes = path.join(path.dirname(home), 'remotes');
  const own = (dir, url) => {
    if (!fs.existsSync(path.join(dir, '.git'))) return;
    let local = null;
    try {
      local = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: dir, encoding: 'utf8', env: gitEnv() }).trim();
    } catch {
      /* no remote yet */
    }
    try {
      if (!local) {
        local = path.join(remotes, `${path.basename(dir)}-${crypto.randomBytes(3).toString('hex')}.git`);
        fs.mkdirSync(remotes, { recursive: true });
        execFileSync('git', ['clone', '-q', '--bare', dir, local], { stdio: 'ignore', timeout: 10_000, env: gitEnv() });
        git(dir, 'remote', 'add', 'origin', url);
      } else git(dir, 'remote', 'set-url', 'origin', url);
      git(dir, 'config', `url.${local}.insteadOf`, url);
      git(dir, 'fetch', '-q', 'origin');
      git(dir, 'branch', '-q', '--set-upstream-to', 'origin/main');
    } catch {
      /* the demo works without it */
    }
  };
  const projectsDir = path.join(ws, 'projects');
  for (const f of fs.readdirSync(projectsDir)) {
    own(path.join(projectsDir, f), at(f));
    const code = path.join(projectsDir, f, 'code');
    if (fs.existsSync(code)) for (const c of fs.readdirSync(code)) if (!c.startsWith('.')) own(path.join(code, c), at(c));
  }
  own(path.join(ws, 'ai_brain'), at(secondary ? 'laptop-brain' : 'ai_brain'));
  if (!secondary) own(path.join(ws, 'development', 'flutter'), 'https://git.example.com/tools/flutter.git');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const P = (rel) => path.join(ws, 'projects', rel);
  return {
    gitState: async () => (secondary
      ? { git: true, identity: { name: '', email: '' }, gh: { installed: true, signedIn: false, account: null }, helper: false, brain: { exists: true, git: true, remote: null, branch: 'main', upstream: null, ahead: 0, behind: 0, changes: 0 } }
      : { git: true, identity: { name: 'Demo', email: 'demo@example.invalid' }, gh: { installed: true, signedIn: true, account: 'demo-user' }, helper: true, brain: { exists: true, git: true, remote: at('ai_brain'), branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0 } }),
    // One thing to decide (both sides changed), one to upload unless uploading was chosen, one not on this computer.
    sync: async ({ memory = false, push = false, onLine = () => {} } = {}) => {
      const repos = [
        { label: 'ai_brain', did: memory ? ['saved the memory'] : [], todo: [] },
        { label: 'bookshop', did: ['pulled 1'], todo: [] },
        { label: 'bookshop/code/bookshop-api', did: [], todo: [{ why: 'changed here and on the server', command: `git -C ${P('bookshop/code/bookshop-api')} pull --rebase`, kind: 'diverged' }] },
        { label: 'bookshop/code/bookshop-web', did: [], todo: [] },
        push ? { label: 'shop-frontend', did: ['pushed 1'], todo: [] } : { label: 'shop-frontend', did: [], todo: [{ why: '1 commit to push', command: `git -C ${P('shop-frontend')} push`, kind: 'to-push' }] },
        { label: 'invoices', did: [], todo: [{ why: 'not on this computer', command: 'hoprig workspace restore <brain address>', kind: 'missing' }] },
      ];
      for (const r of repos) {
        await wait(250);
        onLine(`${r.todo.length ? '!' : '✓'} ${r.label}${r.did.length ? `  ${r.did.join(', ')}` : r.todo.length ? '' : '  in step'}${r.todo.map((t) => `\n    ${t.why}  →  ${t.command}`).join('')}`);
      }
      return { fromMap: !secondary, memory: memory ? [{ label: 'ai_brain', committed: true }] : [], repos, tools: secondary ? [] : ['development/flutter'], done: repos.filter((r) => !r.todo.length).length, todo: repos.reduce((n, r) => n + r.todo.length, 0) };
    },
    syncWith: async (name, { onLine = () => {} } = {}) => {
      await wait(400);
      onLine('✓ blog  pulled 2');
      return { peer: name, repos: [{ label: 'blog', did: ['pulled 2'], todo: [], notes: [] }] };
    },
    // A fresh computer bringing its workspace: everything cloned but one repository that cannot be reached.
    restore: async (url, { ui, dryRun = false } = {}) => {
      const plan = [
        { kind: 'brain', label: 'ai_brain', url: at('ai_brain'), dest: path.join(ws, 'ai_brain'), action: 'clone' },
        { kind: 'project', label: 'bookshop', url: at('bookshop'), dest: P('bookshop'), action: 'clone' },
        { kind: 'repo', label: 'bookshop/code/bookshop-api', url: at('bookshop-api'), dest: P('bookshop/code/bookshop-api'), action: 'clone' },
        { kind: 'project', label: 'invoices', url: at('invoices'), dest: P('invoices'), action: 'clone' },
        { kind: 'repo', label: 'invoices/code/invoices-api', url: at('invoices-api'), dest: P('invoices/code/invoices-api'), action: 'clone' },
        { kind: 'other', label: 'development/flutter', url: 'https://git.example.com/tools/flutter.git', dest: path.join(ws, 'development', 'flutter'), action: 'clone' },
      ];
      if (dryRun) return { ok: true, dryRun, brain: String(url), plan, folders: ['credentials', 'backups'], notes: [], projectsDir: P('') };
      for (const e of plan) {
        await wait(300);
        ui.out(`  git clone ${e.url}`);
        e.result = e.label === 'invoices/code/invoices-api' ? 'failed: remote: Repository not found.' : 'cloned';
        ui.line(e.result === 'cloned' ? 'ok' : 'fail', `${e.label}: ${e.result}`);
      }
      return { ok: false, dryRun, brain: String(url), plan, folders: ['credentials', 'backups'], notes: [], projectsDir: P('').replace(/[\\/]$/, '') };
    },
  };
}

// Past Claude Code conversations, as Claude Code keeps them: a project's page lists them to continue.
const PAST = {
  'shop-frontend': ['Make the checkout page work on small phones', 'Add a test for the cart total'],
  'api-server': ['Why is the orders query slow?', 'Move the settings to environment variables'],
  'mobile-app': ['Fix the crash when the photo picker is closed'],
  'docs-site': ['Write the getting-started page'],
  'data-pipeline': ['Read the CSV files in parallel'],
  'landing-page': ['A new hero section with the product photo'],
  blog: ['Draft a post about the new release'],
  scripts: ['A backup script for the photos folder'],
  bookshop: ['Plan the first version of the shop'],
};
function pastTalks(home, dir, titles = []) {
  const talk = path.join(home, '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(talk, { recursive: true });
  titles.forEach((t, i) => {
    const file = path.join(talk, `${crypto.randomUUID()}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', cwd: dir, message: { role: 'user', content: t } })}\n`);
    const when = new Date(Date.now() - (i + 1) * 26 * 3600_000);
    fs.utimesSync(file, when, when);
  });
}

/** A skill added by hand (not through the dashboard), so Skills has one installed for you. */
function handSkill(home) {
  const dir = path.join(home, '.claude', 'skills', 'commit-messages');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: commit-messages\ndescription: Write short commit messages that say what changed and why, in plain words.\n---\n\n# Commit messages\n\nOne line that says what changed, then why.\n');
}

// One provider of each sign-in state on Providers (what routerstate.mjs providerFacts reads from files on a real
// computer): signed in with usage (max: its own figures), signed in on a plan that reports none, not signed in.
const DEMO_SIGNIN = {
  max: { signedIn: true, plan: 'max', usageReported: true },
  team: { signedIn: true, plan: 'team', usageReported: false },
  pro: { signedIn: false, plan: null, usageReported: null },
};
async function demoRouterState() {
  const rs = await import('../routerstate.mjs');
  return { ...rs, providerFacts: (p) => DEMO_SIGNIN[p.name] || rs.providerFacts(p) };
}

// A made-up certificate fingerprint in the shape of a real one: "sha256:" and 43 base64url characters.
const DEMO_PIN = 'sha256:DemoNotARealFingerprint00000000000000000000';

/** Settings, accounts and usage for a fresh demo. */
async function seed(home, { secondary, password }) {
  const { saveConfig } = await import('../config.mjs');
  const { writeProfile } = await import('../profiles.mjs');
  const { hashPassword } = await import('../server/auth.mjs');
  const { saveProfileUsage } = await import('../routerstate.mjs');
  // The recommended place: the projects of the workspace (docs/WORKSPACE.md), so every screen shows that tree.
  const projects = path.join(home, 'Workspace', 'projects');
  // New project on the Workspace page makes a first commit: git needs a name and an e-mail (made-up ones).
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Demo\n\temail = demo@example.invalid\n[init]\n\tdefaultBranch = main\n');
  for (const f of secondary ? LAPTOP_FOLDERS : MAIN_FOLDERS) {
    const dir = path.join(projects, f);
    fs.mkdirSync(dir, { recursive: true });
    // Look like real projects to the Projects block and the skill suggestions: a package file and a git folder.
    if (f === 'shop-frontend') fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: f, private: true, dependencies: { next: '15.1.0', react: '19.0.0' } }, null, 2));
    if (f === 'api-server') fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: f, private: true, dependencies: { express: '4.21.2', pg: '8.13.1' } }, null, 2));
    if (f === 'data-pipeline') fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "data-pipeline"\ndependencies = ["pandas"]\n');
    gitInit(dir);
    pastTalks(home, dir, PAST[f]);
  }
  if (!secondary) {
    gitStories(projects, path.join(path.dirname(home), 'remotes'));
    workspace(projects);
    pastTalks(home, path.join(projects, 'bookshop'), PAST.bookshop);
    handSkill(home);
  }
  saveConfig({
    claudeBin: SIGNIN, // only Providers → Add provider → Claude subscription runs it
    projectsDir: projects,
    launcher: [process.execPath, SESSION],
    // One subscription, then the API account: the order the README recommends. "Team plan" is an account of its
    // own, outside Auto mode (moving to it stays a manual choice).
    autoSwitch: { enabled: true, order: ['max', 'api'], returnToPreferred: true, prompt: 'Continue from where you stopped.' },
    assistant: { enabled: true, level: 'work', accounts: ['auto', 'max', 'team', 'api'] },
    server: {
      backend: 'pty', host: '127.0.0.1', roots: [projects],
      passwordHash: await hashPassword(password),
      machineLabel: secondary ? 'Laptop' : 'Workstation',
      publicUrl: 'https://203.0.113.10/', // a documentation address (RFC 5737): reaches nothing
      quickActions: [{ label: 'continue', text: 'continue' }, { label: 'run the tests', text: 'run the tests and fix what fails' }, { label: '/compact', text: '/compact' }, { label: '/model', text: '/model' }],
    },
  });
  // Made-up values that look like what each kind of account stores; none of them works anywhere.
  writeProfile('max', { label: 'Claude Max', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-demo-not-a-real-token-000000000000' } });
  writeProfile('team', { label: 'Team plan', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-demo-not-a-real-token-111111111111' } });
  writeProfile('api', { label: 'API (pay as you go)', env: { ANTHROPIC_API_KEY: 'demo-not-a-real-key-2222222222' } });
  // A provider whose sign-in is gone: no token in its file (a stored sign-in), "not signed in" in DEMO_SIGNIN.
  if (!secondary) writeProfile('pro', { label: 'Claude Pro', env: {} });
  const h = 3600_000;
  const now = Date.now();
  saveProfileUsage('max', { fiveHour: { pct: 96, resetsAt: now + 2.4 * h }, week: { pct: 58, resetsAt: now + 3.2 * 24 * h }, status: 'allowed_warning', at: now });
  // "Team plan" reports no usage (DEMO_SIGNIN): it has no figures, and the page says so.
  return projects;
}

/**
 * What the automations did "earlier today", for Automations → Activity: written to the log the server reads, oldest
 * first, as the automations themselves would have written it.
 */
async function demoActivity() {
  const { createActivityLog } = await import('../automation/store.mjs');
  const { stateDir } = await import('../paths.mjs');
  const t0 = Date.now();
  const m = 60_000;
  const entries = [
    [9 * 60, { automation: 'restore', session: 'api-server', did: 'reopened api-server after the restart, with its conversation', outcome: 'ok' }],
    [8 * 60, { automation: 'schedules', session: 'api-server', did: 'started "Morning dependency check"', outcome: 'ok' }],
    [5 * 60, { automation: 'updates', did: 'looked for a new Claude Code', outcome: 'nothing new' }],
    [95, { automation: 'retry', session: 'shop-frontend', did: 'sent "continue" to shop-frontend after Claude\'s servers were busy (try 1 of 3)', outcome: 'ok' }],
    [40, { automation: 'queue', session: 'data-pipeline', did: 'sent the next queued message to data-pipeline: "Add a progress bar to the import"', outcome: 'ok' }],
    [12, { automation: 'queue', session: 'data-pipeline', did: 'could not send the next queued message to data-pipeline', outcome: 'failed: the session was waiting for your OK' }],
  ];
  for (const [ago, e] of entries) createActivityLog(path.join(stateDir(), 'automation.log'), { now: () => t0 - ago * m }).add(e);
}

/** A logged-in caller of the demo's own API (the same routes the page uses). */
async function client(base, password) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password }) });
  if (!r.ok) throw new Error(`demo login failed (${r.status})`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (p, body) => {
    const res = await fetch(base + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${p}: ${data.error || res.status}`);
    return data;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  return null;
}

/**
 * A demo that was killed hard (power cut, kill -9) cannot remove its folder; the next demo does: every
 * hoprig-demo-* folder whose process is gone.
 */
export function sweepStale(tmp = os.tmpdir()) {
  let names = [];
  try {
    names = fs.readdirSync(tmp).filter((n) => n.startsWith('hoprig-demo-'));
  } catch {
    return;
  }
  for (const n of names) {
    const dir = path.join(tmp, n);
    let pid = null;
    try {
      pid = Number(fs.readFileSync(path.join(dir, 'demo.pid'), 'utf8'));
    } catch {
      continue; // not ours to judge (still starting, or made by something else)
    }
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      alive = e.code === 'EPERM';
    }
    if (!alive) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function openBrowser(url, env) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    // With the owner's own environment: a browser started with the demo's temp home folder would not work.
    spawn(cmd, args, { stdio: 'ignore', detached: true, env }).unref();
  } catch {
    /* no browser: the address is printed */
  }
}

/** Start the second demo computer (another demo server, its own temp folder) and wait until it is ready. */
async function startLaptop() {
  const ready = path.join(os.tmpdir(), `hoprig-demo-ready-${crypto.randomBytes(4).toString('hex')}.json`);
  // stdin is a pipe from us: when this process ends in any way, the pipe closes and the second computer stops too.
  const child = spawn(process.execPath, [SELF, '--secondary', '--no-open', '--quiet', '--ready-file', ready], { stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env } });
  const info = await until(() => fs.existsSync(ready) && JSON.parse(fs.readFileSync(ready, 'utf8')), 30_000);
  fs.rmSync(ready, { force: true });
  return { child, info };
}

/**
 * Run the demo. Returns null (keeps running) after printing the address; Ctrl+C stops it and removes everything.
 * `hooks.onReady(info)` is for tests.
 */
export async function main(args = [], hooks = {}) {
  let o;
  try {
    o = parseArgs(args);
  } catch (e) {
    console.error(`demo: ${e.message}`);
    return 2;
  }
  // The real path (macOS: /var is a link to /private/var), so folders show as ~/projects/… everywhere.
  const ownEnv = { ...process.env };
  sweepStale();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-demo-')));
  fs.writeFileSync(path.join(root, 'demo.pid'), String(process.pid));
  const home = isolate(root);
  if (o.secondary) process.env.HOPRIG_HOSTNAME = 'laptop';
  const password = crypto.randomBytes(18).toString('base64url'); // only this process knows it
  let app = null;
  let laptop = null;
  let stopped = false;
  let background = Promise.resolve();
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      if (laptop) laptop.child.kill('SIGTERM');
      if (app) await app.close();
      await Promise.race([background.catch(() => {}), sleep(3000)]);
      if (laptop) laptop.child.kill('SIGTERM'); // started meanwhile
    } catch {
      /* stopping anyway */
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const projects = await seed(home, { secondary: o.secondary, password });
    const { createServer } = await import('../server/server.mjs');
    const addon = demoAddon();
    app = createServer({
      demo: true,
      routerstate: await demoRouterState(),
      watchTickMs: 1000,
      claudecode: { claudeInfo: async () => CLAUDE_INFO, claudeUpdate: async ({ onLine }) => { onLine('(demo) Claude Code is up to date'); return { ok: true, version: CLAUDE_INFO.installed, output: '' }; } },
      addons: { addons: [addon] },
      onboarding: { facts: DEMO_FACTS },
      pcsetup: { status: async () => DEMO_CHECKS },
      // The workspace tree and the AI brain (sample files), then the map, sync, restore and git state samples.
      workspace: { ...demoWorkspace(home, o.secondary), ...demoWorkspaceMore(home, o.secondary) },
      system: demoSystem(o.secondary),
      // The list of computers: the sample version, not "not installed". The join line: what a hub with its own
      // certificate answers (the address in server.publicUrl below; a made-up fingerprint), so the page shows it whole.
      machines: { claudeVersion: async () => CLAUDE_INFO.installed, certOf: async () => ({ kind: 'own', pin: DEMO_PIN }) },
      accounts: { trouteai: addon },
      assistant: {
        claudecode: async () => ({ claudeInfo: async () => CLAUDE_INFO }),
        engine: { command: { command: process.execPath, args: [TIA] }, resolveEnv: async () => ({ ...process.env }) },
      },
    });
    const addr = await app.listen(o.port || 0, '127.0.0.1');
    const base = `http://127.0.0.1:${addr.port}`;
    const api = await client(base, password);

    // ---- sessions: each folder's story is in session.mjs ----
    const start = (folder, profile) => api('/api/sessions', { dir: path.join(projects, folder), profile, mode: 'new' });
    if (o.secondary) {
      await start('blog', 'team');
      await start('scripts', 'max');
    } else {
      await start('shop-frontend', 'auto');
      await start('api-server', 'max');
      await start('mobile-app', 'team');
      await start('docs-site', 'max');
      await start('data-pipeline', 'team');
      await until(async () => (await api('/api/state')).sessions.filter((s) => s.kind === 'claude').length >= 5);

      // ---- automations: a queue and a schedule ----
      await api('/api/automation/queue/data-pipeline', { op: 'pause', paused: true }).catch(() => {});
      for (const text of ['Now make the import run in parallel for each region', 'Then add a test with a 1 GB sample file']) {
        await api('/api/automation/queue/data-pipeline', { op: 'add', text }).catch(() => {});
      }
      await api('/api/automation/schedules', {
        op: 'add',
        schedule: { label: 'Morning dependency check', when: { kind: 'daily', time: '08:30' }, action: { type: 'start', dir: path.join(projects, 'api-server'), profile: 'auto', prompt: 'Check for outdated dependencies and open a summary' } },
      }).catch(() => {});
      await api('/api/automation/schedules', {
        op: 'add',
        schedule: { label: 'Evening test run', when: { kind: 'weekly', time: '18:00', days: [1, 2, 3, 4, 5] }, action: { type: 'send', session: 'data-pipeline', text: 'Run the full test suite and sum up what fails' } },
      }).catch(() => {});
      await demoActivity();

      // ---- Tia and the second computer come up in the background: the address is shown at once ----
      background = (async () => {
      // ---- Tia: a question, a job that finishes, a card that waits for the OK ----
      try {
        if (stopped) return;
        const chat = async (text, conversation) => (await api('/api/assistant/chat', { text, ...(conversation ? { conversation } : {}) })).conversation;
        const conv = await chat('What needs me right now?');
        await sleep(2500);
        await chat('Start a session in ~/Workspace/projects/landing-page: add a dark mode toggle, and tell me when it is done', conv);
        await until(async () => (await api('/api/assistant/jobs')).jobs?.some((j) => j.state === 'done'), 30_000);
        await chat('Move docs-site to the API provider so it can go on', conv);
        await until(async () => (await api('/api/assistant/cards')).cards?.length, 15_000);
      } catch {
        /* Tia is optional in the demo */
      }

      // ---- a second computer ----
      try {
        if (stopped) return;
        laptop = await startLaptop();
        if (stopped) return void laptop.child.kill('SIGTERM'); // the demo stopped while it was starting
        if (laptop.info) {
          const { putMachine } = await import('../machines/store.mjs');
          putMachine({ name: 'laptop', label: 'Laptop', via: 'url', url: laptop.info.url, token: laptop.info.token, tokenId: laptop.info.tokenId, added: Date.now(), info: { hostname: 'laptop', platform: 'darwin', version: laptop.info.version } });
        }
      } catch {
        /* the demo works without it */
      }
      })();
    }

    const { createLoginLink } = await import('../server/loginlink.mjs');
    const link = createLoginLink({ baseUrl: base, minutes: 30 }).url;
    const info = { url: base, link, root, port: addr.port };
    if (o.secondary) {
      const { createToken } = await import('../machines/tokens.mjs');
      const t = createToken('Workstation (demo)');
      Object.assign(info, { token: t.token, tokenId: t.id, version: JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).version });
    }
    if (o.readyFile) fs.writeFileSync(o.readyFile, JSON.stringify(info), { mode: 0o600 });
    hooks.background = background;
    await hooks.onReady?.(info);
    if (!o.quiet) {
      console.log(`\nhoprig demo is running at ${base}`);
      console.log('Sample data only: no Claude Code, no provider, nothing real. Everything is removed when you stop it (Ctrl+C).');
      console.log(`\nOpen this address to be signed in (works once):\n  ${link}\n`);
    }
    if (o.open && !o.secondary) openBrowser(link, ownEnv);
  } catch (e) {
    await stop();
    console.error(`demo: ${e.message}`);
    return 1;
  }
  const quit = () => stop().then(() => process.exit(0));
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
  process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  hooks.stop = stop;
  if (o.secondary) {
    // The second computer lives as long as the demo that started it (see startLaptop).
    process.stdin.on('end', quit).on('close', quit).resume();
  }
  return null;
}

// The second demo computer runs this file directly.
if (process.argv[1] === SELF) {
  main(process.argv.slice(2)).then((code) => {
    if (Number.isInteger(code)) process.exit(code);
  });
}

// ---------- the demo's workspace and AI brain (owned by the workspace feature: src/workspace) ----------
/**
 * A sample workspace in the demo's own home folder: the tree, an AI brain with notes, daily logs, a skill and
 * memory, and Claude Code's global rules and home memory linked into it (where links can be made). Everything is
 * made up. Returns the workspace feature's options.
 */
function demoWorkspace(home, secondary = false) {
  const ws = path.join(home, 'Workspace');
  process.env.HOPRIG_WORKSPACE_DIR = ws; // never the person's own workspace, whatever their environment says
  const brain = path.join(ws, 'ai_brain');
  const day = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  const mem = (name, description, type, body) => `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`;
  const files = {
    'BRAIN.md': '# AI brain\n\nWhat the AI knows for all projects on this computer, in its own private git repository.\n',
    'learnings.md': '# Learnings\n\n- Run the slow end-to-end tests last; the unit tests find most problems in seconds.\n- A migration is tested on a copy of the data before it runs for real.\n',
    'active_context.md': `# Active context\n\n- ${secondary ? 'Blog: the post about the new release' : 'Bookshop: the first version of the checkout'}\n- Next: the weekly dependency check\n`,
    'PENDING.md': '# Pending\n\n- Move the old laptop\'s projects into the workspace\n- Renew the test certificate before the end of the month\n',
    'claude/CLAUDE.md': '# Rules for every project\n\n- Prove the most important case first, then the rest.\n- Done means proven: run the check before saying it works.\n',
    [`daily_logs/${day(0)}.md`]: '# Today\n\n- Checkout: the card form works on small phones.\n',
    [`daily_logs/${day(1)}.md`]: '# Yesterday\n\n- The orders query is fast again (an index on the date).\n',
    [`daily_logs/${day(2)}.md`]: '# Two days ago\n\n- Set up the new computer with `hoprig setup`.\n',
    'skills/release-notes/SKILL.md': '---\nname: release-notes\ndescription: Write release notes from the git history in plain words.\n---\n\n# Release notes\n',
    'claude-memory/home/MEMORY.md': '- [How I like to work](working-style.md)\n- [The test server](test-server.md)\n',
    'claude-memory/home/working-style.md': mem('How I like to work', 'Short answers, the most important case first', 'user', 'Short answers. Prove the most important case first.'),
    'claude-memory/home/test-server.md': mem('The test server', 'Where the shared test server is and how to reach it', 'reference', 'The test server is reached through the dashboard of the second computer.'),
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(brain, rel)), { recursive: true });
    fs.writeFileSync(path.join(brain, rel), text);
  }
  for (const d of ['development', 'git', 'database/postgresql', 'backups']) fs.mkdirSync(path.join(ws, d), { recursive: true });
  fs.mkdirSync(path.join(ws, 'credentials'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ws, 'credentials', 'README.md'), '# Credentials\n\nKeys for local work. Never in git.\n');
  gitInit(brain);
  try {
    // The projects stay where the demo keeps them; the workspace's projects/ leads there.
    if (!fs.existsSync(path.join(ws, 'projects'))) fs.symlinkSync(path.join(home, 'projects'), path.join(ws, 'projects'), 'dir'); // the demo's projects are already there
    fs.symlinkSync(path.join(brain, 'claude', 'CLAUDE.md'), path.join(home, '.claude', 'CLAUDE.md'));
    const memLink = path.join(home, '.claude', 'projects', home.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
    fs.mkdirSync(path.dirname(memLink), { recursive: true });
    fs.symlinkSync(path.join(brain, 'claude-memory', 'home'), memLink, 'dir');
  } catch {
    /* no links here (Windows without the right): the brain is still shown */
  }
  return { dir: ws };
}
