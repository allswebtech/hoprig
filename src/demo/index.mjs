// `hoprig demo`: the dashboard with believable sample data and working sessions, needing no Claude Code and
// no account — to try it in ten seconds and to take the README's screenshots.
//
// Everything lives in a fresh folder under the OS temp folder (settings, accounts, state, a home folder for the
// sessions) and is removed when the demo stops; the real settings, accounts and Claude folders are never read or
// written. The server listens on 127.0.0.1 only, on a free port, and the browser is signed in with a one-time
// link. What it sets up:
//   five sessions in different states (working with output flowing, waiting for you, needs your OK, limit
//   reached, waiting with a queue), a chat that changed a file and waits for your OK, three accounts with usage, Auto mode on, a second computer ("Laptop", a
//   second demo server in its own temp folder), a schedule, a Tia conversation with a confirm card and a finished
//   job, the shipped gateway add-on (pretend: "installing" it prints lines and installs nothing), OpenCode as a second coding
//   tool (pretend: its package file is there, its program only says that it does not run in the demo).
// The sessions are src/demo/session.mjs (looks like Claude Code, talks to no model); Tia's engine is
// src/demo/tia.mjs; the chat is src/demo/chat.mjs; the sign-in on the Providers page is src/demo/signin.mjs.
//
//   hoprig demo [--port N] [--no-open]
// Internal (the second computer, and tests): --secondary, --ready-file <file> (writes { url, link, root, … }).
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoInfo } from '../pcsetup/workspace.mjs';
import { demoOpenCode, seedCart } from './coding.mjs';
import { demoDesktop } from './desktop.mjs';
import { GATEWAY, HOPRIG, KITS, TOOLS, newer } from './versions.mjs';
import { demoWork } from './work.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.join(HERE, 'session.mjs');
const TIA = path.join(HERE, 'tia.mjs');
const SIGNIN = path.join(HERE, 'signin.mjs');
const CHAT = path.join(HERE, 'chat.mjs');
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

/** A folder holding only a link to the Node that runs the demo, for its PATH. */
function nodeOnly(root) {
  const dir = path.join(root, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'node'))) fs.symlinkSync(process.execPath, path.join(dir, 'node'));
  return dir;
}

/**
 * What the demo keeps of the environment it was started from. Everything else goes: provider keys, tokens, the
 * session it may have been started in, the owner's own settings. The demo's sessions and shells inherit what is
 * left, one `env` away from a screenshot, so this is a list of what may stay, not of what must go.
 */
const KEEP = new Set([
  'PATH', 'Path', // finding programs (on POSIX replaced below by the system's folders and this Node)
  'LANG', 'LANGUAGE', // the language and characters of the terminals' text (with every LC_* variable)
  'TERM', // what the terminal can draw
  'TMPDIR', 'TEMP', 'TMP', // the temp folder: the demo's own folder is there, and the second computer's ready file
  'HOPRIG_TEST_SUDO', // the demo stands in a sample answer for this computer's sudo (below); this lets a screenshot run choose which state it shows, so the demo never runs the real sudo
  'HOPRIG_TEST_GITCHECK', // the demo stands in a git server for Tia's sign-in check (below); this lets a screenshot run choose which answer it shows, so the demo never reaches a real git server
  'HOPRIG_TEST_SIGNIN', // the demo stands in Claude Code's stored sign-in (claudesignin.mjs); this lets a screenshot run show it signed in, so the demo never asks a real Claude Code
  // The test runner's own variables (tools/test.mjs: the folder of its traps for sudo, systemctl and the like, the test
  // file and process they name, its ports refused). They are there only under the suite. Thrown away, a demo a test
  // started, and its second computer, started the computer's real programs and reached its real ports.
  'HOPRIG_TEST_TRAPS', 'HOPRIG_TEST_FILE', 'HOPRIG_TEST_PID', 'HOPRIG_TEST_MARK', 'HOPRIG_NODE_NPM', 'HOPRIG_SEAL_EXTRA_TRAPS', 'HOPRIG_SEAL_EXTRA_PORTS', 'HOPRIG_SEAL_REAL', 'TMUX_TMPDIR',
  // On Windows the run's one PowerShell module cache (tools/test-plan.mjs psModuleCache): a path, no secret.
  'PSModuleAnalysisCachePath',
  // Windows itself: its folder, its command shell, how a program name is found, the system drive.
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'SystemDrive', 'SYSTEMDRIVE',
  // Where Windows' programs and PowerShell's modules are: a demo terminal's PowerShell loads its own modules from
  // there. Folders of the system, the same for every user, no secret (the user's own AppData is the demo's below).
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'ProgramData', 'PSModulePath',
]);
const kept = (k) => KEEP.has(k) || k.startsWith('LC_');

/**
 * Point every place hoprig and Claude Code look at into `root`, and keep nothing else of `env` (KEEP). Called
 * before anything reads a path (paths.mjs reads the environment on every call). Returns the demo's home folder.
 */
export function isolate(root, env = process.env) {
  for (const k of Object.keys(env)) if (!kept(k)) delete env[k];
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
    USERPROFILE: home, // Windows' home folder
    ...(process.platform === 'win32' ? { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') } : {}),
    // The other coding tools' own folders too (OpenCode reads XDG_CONFIG_HOME, Codex CODEX_HOME): the AI brain's
    // Link in the demo must never reach the real ones.
    XDG_CONFIG_HOME: path.join(home, '.config'),
    CODEX_HOME: path.join(home, '.codex'),
    GH_CONFIG_DIR: path.join(home, '.config', 'gh'), // GitHub's command: no real sign-in in the demo
    HOPRIG_HOSTNAME: 'workstation', // a made-up host name for the Computers page (the Laptop says its own)
    SHELL: '/bin/sh',
    PS1: '$ ',
    // Only the system's own programs and this Node (the demo's stand-ins for Claude Code are Node scripts): the
    // demo must not find (and show) the tools installed on this computer.
    ...(process.platform === 'win32' ? {} : { PATH: `${nodeOnly(root)}:/usr/bin:/bin:/usr/sbin:/sbin` }),
  });
  return home;
}

// A port nothing listens on now, picked by the system: the demo's pretend gateway lives there, never on the shipped
// gateway's own port (a gateway the person runs on this computer may answer there).
async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A pretend add-on of the gateway Hoprig ships (src/addons/gateways.mjs): its own words and names, but "install"
// prints believable lines and installs nothing, and nothing is started. `port`: where it says it is (freePort).
async function demoAddon(port) {
  const { SHIPPED } = await import('../addons/gateways.mjs');
  const { localGateway } = await import('../addons/localgateway.mjs');
  const st = { installed: false, running: false };
  const def = SHIPPED[0];
  const real = localGateway(def, { shipped: true });
  const url = `http://localhost:${port}`;
  const lines = async (onLine, list) => {
    for (const l of list) {
      onLine(l);
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  return {
    id: real.id,
    title: real.title,
    summary: real.summary,
    homepage: real.homepage,
    words: real.words,
    // The gateway feature (src/gateway) lists it by this port; nothing listens there, so it reads as not running.
    gateway: { port: () => port },
    page: () => url,
    status: async () => ({ installed: st.installed, version: st.installed ? GATEWAY : null, running: st.running, url }),
    install: async ({ onLine = () => {} } = {}) => {
      await lines(onLine, [`(demo) npm install -g ${def.npm}`, 'added 41 packages in 3s', '(demo) nothing was installed: this is the demo']);
      st.installed = true;
      return { ok: true };
    },
    update: async ({ onLine = () => {} } = {}) => {
      await lines(onLine, ['(demo) already the newest version']);
      return { ok: true };
    },
    start: async () => {
      st.running = st.installed;
      return st.installed ? { ok: true, url } : { ok: false, url, error: `${real.title} is not installed` };
    },
    stop: async () => {
      st.running = false;
      return { ok: true };
    },
    profile: () => ({ name: def.profile.name, label: def.profile.label, env: { ANTHROPIC_BASE_URL: url }, prerun: '', tokenVar: def.profile.token, tokenHint: 'demo' }),
  };
}

// The one made-up Claude Code version of the demo (versions.mjs): Setup, Health, the Overview, Updates and the
// Computers page all name it, and the Overview offers the same newer one Updates offers.
const CLAUDE_VERSION = TOOLS.claude.installed;
// The background service as the real doctor names it on this kind of computer (src/setup/checks.mjs serviceCheck).
const DEMO_SERVICE = process.platform === 'darwin' ? 'LaunchAgent' : process.platform === 'win32' ? 'scheduled task' : 'systemd user service';

// Home → Get started and Computer → Setup in the demo: made-up facts instead of this computer's own (which could
// show its user name, its tools, its projects).
const DEMO_FACTS = {
  claude: async () => ({ installed: CLAUDE_VERSION, loggedIn: true }),
  tools: async () => ({ missing: [] }),
  rules: async () => ({ installed: true, edited: false }),
  projects: async () => ['shop-frontend', 'api-server', 'data-pipeline'],
  // The demo's own Claude Code folder (isolate() points there), so the count agrees with Skills, also after a link.
  skills: async () => (await import('../skillhub/hub.mjs')).installed({}).skills.map((s) => s.name),
  machines: async () => [],
  sessions: async () => 1,
};
const C = (group, id, label, status, detail, extra = {}) => ({ group, id, label, status, detail, fix: '', ...extra });
const DEMO_CHECKS = [
  C('system', 'os', 'macOS 15.4', 'ok', 'up to date'),
  C('system', 'disk', 'Free disk space', 'ok', '182 GB free'),
  C('system', 'memory', 'Memory', 'ok', '16 GB'),
  C('kit:basics', 'basics.git', 'git', 'ok', KITS.git),
  C('kit:basics', 'basics.ripgrep', 'ripgrep', 'ok', KITS.ripgrep),
  C('kit:node', 'node.node', 'Node.js', 'ok', KITS.node),
  C('kit:node', 'node.pnpm', 'pnpm', 'fail', 'missing', { fixKit: 'node' }),
  C('kit:python', 'python.python', 'Python', 'ok', KITS.python),
  C('kit:python', 'python.uv', 'uv', 'warn', `${KITS.uv.installed} is old; ${KITS.uv.latest} is out`, { fixKit: 'python' }),
  C('kit:github', 'github.gh', 'GitHub CLI', 'ok', KITS.gh),
  C('kit:github', 'github.signin', 'Signed in to GitHub', 'info', 'not signed in (optional)'),
  C('claude', 'claude.code', 'Claude Code', 'ok', CLAUDE_VERSION),
  C('claude', 'claude.rules', 'Working rules', 'ok', 'added'),
];
// Health's checks in the demo: the same made-up lines, without a Fix (a Fix there runs the set-up for real), and its
// service line. The real doctor would run this computer's systemctl, gh and tmux and show what it found.
const DEMO_HEALTH = [
  ...DEMO_CHECKS.map(({ fixKit, ...c }) => c),
  C('dashboard', 'service', 'Background service', 'ok', `installed (${DEMO_SERVICE}, starts with your login)`),
];
// The versions Health names: the same made-up Claude Code as Setup and the Computers page, Hoprig's own and the demo's
// OpenCode as the real lookup finds them (its package file in the demo's tools folder), never this computer's claude.
const demoVersions = async () => {
  const { VERSION } = await import('../machines/pairing.mjs');
  const oc = (await import('../codetools/index.mjs')).anyTool('opencode');
  return { hoprig: VERSION, claude: CLAUDE_VERSION, opencode: (oc && (await Promise.resolve(oc.installedVersion()).catch(() => null))) || null };
};

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

const CLAUDE_INFO = { installed: CLAUDE_VERSION, path: '~/.local/bin/claude', latest: TOOLS.claude.latest, method: 'native', updateAvailable: newer(TOOLS.claude.latest, CLAUDE_VERSION) };

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
    // The other computer's own file in the brain (computer.mjs): it has invoices, which this one does not.
    fs.mkdirSync(path.join(ws, 'ai_brain', 'computers'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'ai_brain', 'computers', 'laptop.json'), `${JSON.stringify({ folders: {}, here: ['bookshop', 'invoices', 'invoices/code/invoices-api'], hoprig: HOPRIG, id: '0f1e2d3c4b5a69788796a5b4c3d2e1f0', label: 'laptop' }, null, 2)}\n`);
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
    // The name, the sign-in and the address are made up; what waits in the brain is read from its folder, the same
    // folder the save sheet's list reads (GET /api/workspace/git/brain), so the brain's row and its sheet never disagree.
    gitState: async () => {
      if (secondary) return { git: true, identity: { name: '', email: '' }, gh: { installed: true, signedIn: true, account: 'demo-user' }, helper: true, brain: { exists: true, git: true, remote: null, branch: 'main', upstream: null, ahead: 0, behind: 0, changes: 0 } };
      const s = await repoInfo(path.join(ws, 'ai_brain'));
      const st = s.ok ? { branch: s.branch, upstream: s.upstream || null, ahead: s.ahead, behind: s.behind, changes: s.changes } : { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, changes: 0 };
      return { git: true, identity: { name: 'Demo', email: 'demo@example.invalid' }, gh: { installed: true, signedIn: true, account: 'demo-user' }, helper: true, brain: { exists: true, git: true, remote: at('ai_brain'), ...st } };
    },
    // Set-up's one path: the owner's brain on GitHub, with a map in it.
    brainCandidates: async () => [{ owner: 'demo-user', name: 'ai_brain', url: at('ai_brain'), private: true, hasMap: true }],
    // "Look on the git server" (a place with a naming rule): the sample account's repositories, no program is started.
    gh: async (argv) => {
      const a = argv.slice(1).join(' ');
      if (a.startsWith('api user/orgs')) return { ok: true, code: 0, stdout: '', stderr: '' };
      if (a.startsWith('api user ')) return { ok: true, code: 0, stdout: 'demo-user\n', stderr: '' };
      if (a.startsWith('repo list demo-user ')) return { ok: true, code: 0, stdout: JSON.stringify(['shop-project', 'shop-api', 'shop-web', 'blog-project', 'blog-app', 'blog-old-api', 'wiki-app', 'notes'].map((name) => ({ name }))), stderr: '' };
      return { ok: false, code: 1, stdout: '', stderr: '(demo) not answered' };
    },
    // One thing to decide (both sides changed), one to upload unless uploading was chosen; invoices is only in the map.
    sync: async ({ memory = false, push = false, onLine = () => {} } = {}) => {
      const repos = [
        { label: 'ai_brain', did: memory ? ['saved the memory'] : [], todo: [] },
        { label: 'bookshop', did: ['pulled 1'], todo: [] },
        { label: 'bookshop/code/bookshop-api', did: [], todo: [{ why: 'changed here and on the server', command: `git -C ${P('bookshop/code/bookshop-api')} pull --rebase`, kind: 'diverged' }] },
        { label: 'bookshop/code/bookshop-web', did: [], todo: [] },
        push ? { label: 'shop-frontend', did: ['pushed 1'], todo: [] } : { label: 'shop-frontend', did: [], todo: [{ why: '1 commit to push', command: `git -C ${P('shop-frontend')} push`, kind: 'to-push' }] },
      ];
      for (const r of repos) {
        await wait(250);
        onLine(`${r.todo.length ? '!' : '✓'} ${r.label}${r.did.length ? `  ${r.did.join(', ')}` : r.todo.length ? '' : '  in step'}${r.todo.map((t) => `\n    ${t.why}  →  ${t.command}`).join('')}`);
      }
      return { fromMap: !secondary, memory: memory ? [{ label: 'ai_brain', committed: true }] : [], repos, tools: secondary ? [] : ['development/flutter'], notHere: secondary ? [] : ['invoices'], done: repos.filter((r) => !r.todo.length).length, todo: repos.reduce((n, r) => n + r.todo.length, 0) };
    },
    syncWith: async (name, { onLine = () => {} } = {}) => {
      await wait(400);
      onLine('✓ blog  pulled 2');
      return { peer: name, repos: [{ label: 'blog', did: ['pulled 2'], todo: [], notes: [] }] };
    },
    // A fresh computer bringing its workspace: the brain and the tool; the projects stay in the map unless every
    // project was asked for (then one repository cannot be reached).
    restore: async (url, { ui, dryRun = false, withProjects = false } = {}) => {
      const away = (e) => (withProjects || e.kind === 'brain' || e.kind === 'other' ? e : { ...e, action: 'notHere', why: `in the map, not on this computer: hoprig get ${e.project || e.label}` });
      const plan = [
        { kind: 'brain', label: 'ai_brain', url: at('ai_brain'), dest: path.join(ws, 'ai_brain'), action: 'clone' },
        { kind: 'project', label: 'bookshop', url: at('bookshop'), dest: P('bookshop'), action: 'clone' },
        { kind: 'repo', project: 'bookshop', label: 'bookshop/code/bookshop-api', url: at('bookshop-api'), dest: P('bookshop/code/bookshop-api'), action: 'clone' },
        { kind: 'project', label: 'invoices', url: at('invoices'), dest: P('invoices'), action: 'clone' },
        { kind: 'repo', project: 'invoices', label: 'invoices/code/invoices-api', url: at('invoices-api'), dest: P('invoices/code/invoices-api'), action: 'clone' },
        { kind: 'other', label: 'development/flutter', url: 'https://git.example.com/tools/flutter.git', dest: path.join(ws, 'development', 'flutter'), action: 'clone' },
      ].map(away);
      const notHere = withProjects ? {} : { notHere: ['bookshop', 'invoices'] };
      if (dryRun) return { ok: true, dryRun, brain: String(url), plan, folders: ['credentials', 'backups'], notes: [], projectsDir: P(''), ...notHere };
      for (const e of plan) {
        if (e.action === 'notHere') {
          e.result = e.why;
          continue;
        }
        await wait(300);
        ui.out(`  git clone ${e.url}`);
        e.result = e.label === 'invoices/code/invoices-api' ? 'failed: remote: Repository not found.' : 'cloned';
        ui.line(e.result === 'cloned' ? 'ok' : 'fail', `${e.label}: ${e.result}`);
      }
      return { ok: !withProjects, dryRun, brain: String(url), plan, folders: ['credentials', 'backups'], notes: [], projectsDir: P('').replace(/[\\/]$/, ''), ...notHere };
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
// "Claude Pro" uses Claude Code's stored sign-in: its state comes from the demo's stand-in for that sign-in, the
// same one the page's "who is signed in" asks (claudesignin.mjs), so the two always agree.
let stored = null; // the demo's stored sign-in (main sets it after isolate())
async function demoRouterState() {
  const rs = await import('../routerstate.mjs');
  // The five key providers of the Providers page's states (seedMany): the real facts (refused, signed out), a plan.
  return { ...rs, providerFacts: (p) => (p.name === 'pro' ? stored.facts() : DEMO_SIGNIN[p.name] || (MANY.includes(p.name) ? { ...rs.providerFacts(p), plan: 'max' } : rs.providerFacts(p))) };
}

// Providers of every state the Providers page can show, with made-up keys (none works anywhere): at a weekly limit, signed
// in and free, at a five-hour limit, refused by Claude (a revoked sign-in), signed out here.
const MANY = ['sub2', 'sub3', 'sub4', 'sub5', 'sub6'];
async function seedMany(writeProfile, now) {
  const h = 3600_000;
  const { saveProfileUsage } = await import('../routerstate.mjs');
  const rs = await import('../routerstate.mjs');
  const { markLimited } = await import('../autoswitch.mjs');
  const key = (n) => ({ CLAUDE_CODE_OAUTH_TOKEN: ['sk-ant-oat01', 'demo-not-a-real-token', n].join('-') });
  const at = now - 12 * 60_000;
  writeProfile('sub2', { label: 'sub2', env: key('sub2') });
  saveProfileUsage('sub2', { fiveHour: { pct: 0, resetsAt: now + 3 * h }, week: { pct: 100, resetsAt: now + 3.4 * 24 * h }, status: 'rejected', at });
  markLimited('sub2', { until: now + 3.4 * 24 * h, reason: 'rate_limit' }, now);
  writeProfile('sub3', { label: 'sub3', env: key('sub3') });
  markLimited('sub3', { until: now + 10 * 60_000, reason: 'auth' }, now); // what the router marks at a 401
  if (rs.noteRefused) rs.noteRefused('sub3', 'Claude answered 401', now - 20 * 60_000);
  writeProfile('sub4', { label: 'sub4', env: key('sub4') });
  saveProfileUsage('sub4', { fiveHour: { pct: 100, resetsAt: now + 1.35 * h }, week: { pct: 52, resetsAt: now + 4 * 24 * h }, status: 'rejected', at });
  markLimited('sub4', { until: now + 1.35 * h, reason: 'rate_limit' }, now);
  writeProfile('sub5', { label: 'sub5', env: key('sub5') });
  saveProfileUsage('sub5', { fiveHour: { pct: 22, resetsAt: now + 2 * h }, week: { pct: 88, resetsAt: now + 2.2 * 24 * h }, status: 'allowed_warning', at });
  writeProfile('sub6', { label: 'sub6', signin: 'claude', env: {} }); // signed out here: its key line is gone
}

/** The made-up read of the Refresh of the demo: after 1.5 seconds, figures by key, kept as the router keeps a real answer. No program runs. */
export function demoLimitsAsk(now = Date.now) {
  return async (p) => {
    await new Promise((r) => setTimeout(r, 1500));
    const rs = await import('../routerstate.mjs');
    const key = String((p.env && p.env.CLAUDE_CODE_OAUTH_TOKEN) || '');
    const h = 3600_000;
    const t = now();
    const win = (pct, ms) => ({ pct, resetsAt: t + ms });
    const figures = (five, week) => {
      rs.saveProfileUsage(p.name, { at: t, fiveHour: five, week });
      return { name: p.name, ok: true, read: 'figures' };
    };
    if (key.endsWith('sub3')) {
      rs.noteRefused(p.name, 'Claude answered 401', t);
      return { name: p.name, ok: false, read: 'signin', error: 'Claude refused the sign-in' };
    }
    if (key.endsWith('sub2')) return figures(win(0, 3 * h), win(100, 82 * h));
    if (key.endsWith('sub4')) return figures(win(100, 1.3 * h), win(52, 96 * h));
    if (key.endsWith('sub5')) return figures(win(24, 2 * h), win(88, 53 * h));
    if (key.endsWith('000000000000')) return figures(win(96, 2.3 * h), win(58, 77 * h));
    return { name: p.name, ok: true, read: 'none' };
  };
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
    if (f === 'shop-frontend') {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: f, private: true, scripts: { test: 'node --test' }, dependencies: { next: '15.1.0', react: '19.0.0' } }, null, 2));
      seedCart(dir); // the file the demo's chat changes (src/demo/chat.mjs)
    }
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
    // Tia thinks on the subscription: Auto mode's order holds the API account, and her paid thinking needs a daily
    // cap that the demo leaves unset, so on "Automatic" she would answer every message with the cap notice.
    assistant: { enabled: true, level: 'work', accounts: ['auto', 'max', 'team', 'api'], runsOn: 'max' },
    server: {
      backend: 'pty', host: '127.0.0.1', roots: [projects],
      passwordHash: await hashPassword(password),
      machineLabel: secondary ? 'Laptop' : 'Workstation',
      publicUrl: 'https://203.0.113.10/', // a documentation address (RFC 5737): reaches nothing
      quickActions: [{ label: 'continue', text: 'continue' }, { label: 'run the tests', text: 'run the tests and fix what fails' }],
    },
  });
  // Made-up values that look like what each kind of account stores; none of them works anywhere.
  writeProfile('max', { label: 'Claude Max', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-demo-not-a-real-token-000000000000' } });
  writeProfile('team', { label: 'Team plan', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-demo-not-a-real-token-111111111111' } });
  writeProfile('api', { label: 'API (pay as you go)', env: { ANTHROPIC_API_KEY: 'demo-not-a-real-key-2222222222' } });
  // A provider whose sign-in is gone: no token in its file (a stored sign-in), "not signed in" in DEMO_SIGNIN.
  if (!secondary) writeProfile('pro', { label: 'Claude Pro', env: {} });
  if (!secondary) await seedMany(writeProfile, Date.now());
  const h = 3600_000;
  const now = Date.now();
  saveProfileUsage('max', { fiveHour: { pct: 96, resetsAt: now + 2.4 * h }, week: { pct: 58, resetsAt: now + 3.2 * 24 * h }, status: 'allowed_warning', at: now });
  // "Team plan" reports no usage (DEMO_SIGNIN): it has no figures, and the page says so.
  return projects;
}

/**
 * The hold file of each demo session (the settings Hoprig hands a session at its start, launch.mjs settingsFile), so a
 * session's Hands-off switch can be shown: the server turns it on only for a session whose handed settings carry the
 * wall's hold (server/handsoff.mjs sessionHasHold). The demo's sessions are stand-ins that run no hook, so the file
 * holds only the wall's matcher. Written into the demo's OWN state folder under `root`, never anywhere else; a session
 * that already has one is left as it is. → the run ids it wrote for.
 */
export async function demoHolds(root) {
  const { hookSettingsDir, runsDir } = await import('../paths.mjs');
  const { WALL_MATCHER } = await import('../handsoff.mjs');
  const dir = hookSettingsDir();
  const inside = (p) => path.relative(root, p).split(path.sep)[0] !== '..' && !path.isAbsolute(path.relative(root, p));
  if (!inside(dir) || !inside(runsDir())) return []; // not the demo's own state folder: write nothing
  let names = [];
  try {
    names = fs.readdirSync(runsDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const wrote = [];
  for (const n of names) {
    const file = path.join(dir, n);
    if (fs.existsSync(file)) continue;
    try {
      if (JSON.parse(fs.readFileSync(path.join(runsDir(), n), 'utf8')).kind === 'chat') continue; // an App chat holds by its own channel
    } catch {
      continue; // a record being written: the next round takes it
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: WALL_MATCHER, hooks: [] }] } }), { mode: 0o600 });
    wrote.push(n.slice(0, -'.json'.length));
  }
  return wrote;
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
    [5 * 60, { automation: 'updates', did: 'looked for new versions', outcome: 'nothing new' }],
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
  const ended = new Promise((resolve) => child.once('exit', resolve)); // from the start: an early end is not missed
  const info = await until(() => fs.existsSync(ready) && JSON.parse(fs.readFileSync(ready, 'utf8')), 30_000);
  fs.rmSync(ready, { force: true });
  return { child, info, ended, signalled: false };
}

/**
 * Stop the second computer and wait (at most 10 s) until it has ended. It removes its own folder when the signal
 * comes, so it gets exactly ONE: its handler runs once, and a second SIGTERM would end it before it cleaned up.
 */
function endLaptop(laptop) {
  if (!laptop.signalled) {
    laptop.signalled = true;
    laptop.child.kill('SIGTERM');
  }
  return Promise.race([laptop.ended, sleep(10_000)]);
}

// ---- Tia's git sign-in check (src/server/hersignin.mjs), stood in for the demo ----
// The check asks the git server what the chosen token may do. The demo must never reach a real git server or use a
// real token, so it stands both in: a made-up token file in the demo's own credentials folder, made-up github.com
// repositories, and a fetch that answers from HOPRIG_TEST_GITCHECK so a screenshot run can show each state.
// Values: delete | nodelete | unknown | fail (default nodelete). The token value is never read back by the page.
const DEMO_GIT_TOKEN_FILE = 'git-token.txt';

/** The stand-in git server: answers the check's requests from HOPRIG_TEST_GITCHECK, reaches no network. */
async function demoGitFetch(url) {
  const state = process.env.HOPRIG_TEST_GITCHECK || 'nodelete';
  const p = new URL(url).pathname;
  const res = (status, { scopes = null, body = null } = {}) => ({
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'x-oauth-scopes' ? scopes : null) },
    json: async () => body,
  });
  if (p === '/') { // the token itself: whether it is accepted, and its scopes (whether it can delete)
    if (state === 'fail') return res(401);
    const scopes = state === 'delete' ? 'repo, delete_repo' : state === 'unknown' ? null : 'repo, read:org';
    return res(200, { scopes, body: { login: 'example' } });
  }
  if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return res(200, { body: { default_branch: 'main' } });
  const m = /^\/repos\/[^/]+\/([^/]+)\/branches\/[^/]+\/protection$/.exec(p);
  if (m) return m[1] === 'shop' // one repository's default branch is protected, one is not
    ? res(200, { body: { allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } } })
    : res(404);
  return res(404);
}

/** The demo's git-sign-in stand-in: a made-up token file, made-up repositories, and the stand-in git server. */
function demoHerSignin(home) {
  const credsDir = path.join(home, 'Workspace', 'credentials');
  fs.mkdirSync(credsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(credsDir, DEMO_GIT_TOKEN_FILE), 'demo-not-a-real-token\n', { mode: 0o600 });
  const repos = [
    { ref: 'shop', url: 'https://github.com/example/shop.git' }, // a protected default branch → a rule blocks it
    { ref: 'alpha', url: 'https://github.com/example/alpha.git' }, // no protection rule → allowed
    { ref: 'docs-site', url: 'https://gitlab.example.com/example/docs-site.git' }, // not github.com → not known
  ];
  return { credsDir: () => credsDir, repos: () => repos, apiBase: 'https://api.github.invalid', fetchImpl: demoGitFetch };
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
  stored = (await import('./claudesignin.mjs')).demoStoredSignin(); // after isolate(): it reads HOPRIG_TEST_SIGNIN of the demo's own environment
  if (o.secondary) process.env.HOPRIG_HOSTNAME = 'laptop';
  const password = crypto.randomBytes(18).toString('base64url'); // only this process knows it
  let app = null;
  let laptop = null;
  let stopped = false;
  let background = Promise.resolve();
  let holds = null;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(holds);
    try {
      if (laptop) endLaptop(laptop); // it stops while this one does
      if (app) await app.close();
      await Promise.race([background.catch(() => {}), sleep(3000)]);
      if (laptop) await endLaptop(laptop); // also one that started meanwhile
    } catch {
      /* stopping anyway */
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const projects = await seed(home, { secondary: o.secondary, password });
    if (!o.secondary) demoOpenCode(root);
    const { createServer } = await import('../server/server.mjs');
    const addon = await demoAddon(await freePort());
    app = createServer({
      demo: true,
      routerstate: await demoRouterState(),
      watchTickMs: 1000,
      claudecode: { claudeInfo: async () => CLAUDE_INFO, claudeUpdate: async ({ onLine }) => { onLine('(demo) Claude Code would be updated here; nothing is installed in the demo'); return { ok: true, version: CLAUDE_INFO.installed, output: '' }; } },
      addons: { addons: [addon] },
      // The Operator's look checks the pretend gateway too: the real one's port on this computer is never asked.
      operator: { gateways: () => [addon] },
      // The automations' lines go to the demo's own log file: under the address they read as if something real ran.
      // A restart (Updates' Restart now, Health's Restart the dashboard) is pretend too: this computer's own service
      // manager is never asked, and the demo goes on running.
      automation: { updateItems: (await import('./updates.mjs')).demoUpdateItems(), log: (line) => fs.appendFileSync(path.join(root, 'demo.log'), `${line}\n`),
        restarter: { installed: () => true, run: () => fs.appendFileSync(path.join(root, 'demo.log'), '(demo) the dashboard would restart here\n') } },
      onboarding: { facts: DEMO_FACTS },
      pcsetup: { status: async () => DEMO_CHECKS },
      // Tia's administrator-rights page reads whether this computer has sudo and asks a password. The demo must never
      // run the real sudo, so it stands in a sample answer (sudo present, no password, so Full may be offered).
      // HOPRIG_TEST_SUDO (none | password) picks another state for the screenshots; it is the only sudo this page sees.
      herrights: { sudoInfo: async () => ({ present: process.env.HOPRIG_TEST_SUDO !== 'none', needsPassword: process.env.HOPRIG_TEST_SUDO === 'password' }) },
      // Tia's git sign-in page has a "check" that asks the git server what the chosen token may do. The demo stands
      // in a git server and a made-up token so the check never reaches a real one (HOPRIG_TEST_GITCHECK picks the state).
      hersignin: demoHerSignin(home),
      // The workspace tree and the AI brain (sample files), then the map, sync, restore and git state samples.
      workspace: { ...demoWorkspace(home, o.secondary), ...demoWorkspaceMore(home, o.secondary) },
      system: demoSystem(o.secondary),
      // The Operator's Computers part and the Health answer another demo computer reads: the made-up computer's figures, never the real one's.
      rooms: { snapshot: demoSystem(o.secondary).snapshot },
      health: { parts: { snapshot: demoSystem(o.secondary).snapshot, checks: async () => DEMO_HEALTH, plans: async () => ({}), versions: demoVersions } },
      // Health → Gateways: the pretend gateway too, and no service manager or loginctl of this computer is asked.
      gatewayhost: {
        addons: () => [addon],
        plan: () => ({ kind: 'none', sentence: 'In the demo a gateway does not run as a service. On your own computer it can, from here.' }),
        run: async () => ({ ok: false, code: 1, stdout: '', stderr: '', error: null }),
      },
      // The gateway page and its checks know only the pretend gateway: the shipped gateway's real port is never asked.
      gateway: { addons: [addon] },
      desktop: demoDesktop(root, o.secondary), // the desktop's Task manager, Services and Logs: samples, nothing real
      // The list of computers: the sample version, not "not installed". The join line: what a hub with its own
      // certificate answers (the address in server.publicUrl below; a made-up fingerprint), so the page shows it whole.
      machines: { claudeVersion: async () => CLAUDE_INFO.installed, certOf: async () => ({ kind: 'own', pin: DEMO_PIN }) },
      accounts: { gateways: [addon], readLimits: { askOne: demoLimitsAsk() } },
      // Who is signed in to Claude Code (Providers, the sign-in sheets): the demo's made-up stored sign-in, never a program.
      claudeLogin: { status: stored.status, logout: stored.logout },
      // The demo's chat talks to no model. OpenCode is on (its pages show it) but has no server here: a chat of it says
      // so in one plain line instead of a server that did not start. No provider's environment either: a chat on Auto
      // would start Auto mode's router on its usual port, outside the demo's folder, and leave it running.
      chat: { command: { command: process.execPath, args: [CHAT] }, resolveEnv: async () => ({ ...process.env }), engineOpts: { served: { ensure: async () => ({ ok: false, why: 'OpenCode does not run in the demo. On your own computer it runs as Claude Code does here.' }) } } },
      // Learning skills talks to no model in the demo: a look answers with one sample draft, a test request with a line.
      learn: { turn: demoLearnTurn },
      improve: { demo: 'In the demo a round does not run: it would call a model. On your own computer it starts from here.' }, // Improve Tia: never the eval or a model
      assistant: {
        claudecode: async () => ({ claudeInfo: async () => CLAUDE_INFO }),
        engine: { command: { command: process.execPath, args: [TIA] }, resolveEnv: async () => ({ ...process.env }) },
      },
    });
    if (!o.secondary) await demoWork(projects).catch(() => {}); // a plan and a Lead run with helpers (Work's "Who did what")
    const addr = await app.listen(o.port || 0, '127.0.0.1');
    const base = `http://127.0.0.1:${addr.port}`;
    const api = await client(base, password);

    // ---- sessions: each folder's story is in session.mjs ----
    const start = (folder, profile) => api('/api/sessions', { dir: path.join(projects, folder), profile, mode: 'new' });
    // Each session's hold file, also for one started or moved later from the page (a new run id each time).
    holds = setInterval(() => demoHolds(root).catch(() => {}), 1000);
    holds.unref();
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
      await demoHolds(root);

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
      await (await import('./history.mjs')).demoHistory({ projects, brain: path.join(home, 'Workspace', 'ai_brain') }); // Work → Activity's made-up history

      await api('/api/codetools/opencode', { on: true }).catch(() => {});
      // ---- a chat: it changes a file and waits for the OK to run the tests ----
      await api('/api/chats', { dir: path.join(projects, 'shop-frontend'), profile: 'max', text: 'The cart total is a cent off when there is a discount. Fix it and run the tests.' }).catch(() => {});

      // ---- Tia and the second computer come up in the background: the address is shown at once ----
      background = (async () => {
      // ---- Tia: a question, a job that finishes, a card that waits for the OK ----
      try {
        if (stopped) return;
        const chat = async (text, conversation) => (await api('/api/assistant/chat', { text, ...(conversation ? { conversation } : {}) })).conversation;
        const conv = await chat('What needs me right now?');
        await sleep(2500);
        // On the subscription by name: Auto mode's order holds the API account, so a start under it waits for an OK.
        await chat('Start a session in ~/Workspace/projects/landing-page on Claude Max: add a dark mode toggle, and tell me when it is done', conv);
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
        if (stopped) return void endLaptop(laptop); // the demo stopped while it was starting
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

/** The demo's stand-in for the model turn of a look (src/skillhub/learnlook.mjs): no model, made-up answers. */
async function demoLearnTurn({ system }) {
  const look = system.startsWith('You review');
  const text = look
    ? JSON.stringify({ kind: 'new', name: 'tests-before-done', description: 'Run the project\'s tests before saying a task is done. Use at the end of every coding task.', steps: '1. Find the test command in the project (package.json, a Makefile, the README).\n2. Run it.\n3. Say what passed and what failed, in one line each.', edgeCases: 'No tests in the project: say so, and say how you checked the change instead.', why: 'The result was sent back because the tests were not run.', tests: ['Fix the typo in the page header and tell me when you are done', 'Add a phone number field to the sign-up form'] })
    : system.includes('<skill>') ? 'I would make the change, then run the project\'s tests and report: 42 passed, 0 failed.' : 'I would make the change and tell you it is done.';
  return { ok: true, text, usd: look ? 0.0031 : 0.0004, tokens: look ? 2900 : 350 };
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
  for (const d of ['development', 'git', 'database/postgresql', 'database/mysql', 'backups']) fs.mkdirSync(path.join(ws, d), { recursive: true });
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
