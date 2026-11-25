// What is already on this computer, per kit item: present (with its version), missing, or old (past the end of
// life its project publishes). Nothing here changes anything, and nothing reads a key or a token: the GitHub
// sign-in is read from `gh auth status` and only the account name is kept.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture, detectPackageManager, isRoot, npmArgv, showCommand, which, wingetState } from '../setup/system.mjs';
import { KITS, PY_INSTALL, askingInstall, itemHere, kitById, kitCovered, noDesktop } from './kits.mjs';
import { pathNow } from '../setup/winpath.mjs';
import { kitsBlockHas } from '../setup/localbin.mjs';
import { isDir, workspaceDir } from '../workspace/layout.mjs';
import { findNvm } from './devplaces.mjs';

/** The workspace's folder when it is there (a kit installs into its development/ folder only then), else null. */
const workspaceHere = () => {
  try {
    const d = workspaceDir();
    return isDir(d) ? d : null;
  } catch {
    return null;
  }
};

/**
 * The facts plans and checks need. Tests pass their own `has`, `run` (a capture() stand-in) and `exists`.
 * On a Mac the system's /usr/bin/git and python3 are only stubs until the Xcode command line tools are installed
 * (running them opens Apple's install window), so `clt` is read first and those items count as missing without it.
 */
export async function sysFacts(over = {}) {
  const env = over.env || process.env;
  const platform = over.platform || process.platform;
  // Windows: every look starts from the Path the system has now (winpath.mjs), so a program installed since this
  // process started (by pc setup, or by hand while the dashboard runs) is found. A process that looks often (the
  // dashboard) reads the registry at most once a minute (pathNow), and always after an install it ran (refreshPath
  // below, forced). `registry`: the run that reads it (tests hand in a made-up one, so Windows' answers are given on
  // any system); without one the registry is read only on Windows itself. Tests may hand in their own refresh too.
  const reads = platform === 'win32' && (over.registry || (process.platform === 'win32' && !over.has));
  const refresh = over.refreshPath || (reads ? (e, o = {}) => pathNow(e, { run: over.registry || undefined, ...(over.clock ? { now: over.clock() } : {}), ...o }) : null);
  if (refresh) await refresh(env);
  const has = over.has || ((cmd) => !!which(cmd, env, platform));
  const run = over.run || ((argv, o) => capture(argv, { env, timeout: 15_000, ...o }));
  // Windows: winget counts only when it starts (`winget --version` ran): a registered one may not (spawn EACCES).
  const winget = platform !== 'win32' ? null : over.winget || (over.pm !== undefined ? { here: over.pm === 'winget', starts: over.pm === 'winget', version: null, why: '' } : await wingetState({ has, run, env }));
  let pm = over.pm !== undefined ? over.pm : platform === 'win32' ? (winget.starts ? 'winget' : null) : detectPackageManager(platform, has);
  if (pm === 'brew' && platform !== 'darwin') pm = null;
  let dnf5 = over.dnf5;
  if (dnf5 === undefined && pm === 'dnf') dnf5 = /dnf5|^5\./m.test((await run(['dnf', '--version'])).stdout);
  let clt = over.clt;
  if (clt === undefined && platform === 'darwin') clt = (await run(['xcode-select', '-p'])).ok;
  const home = over.home || os.homedir();
  // `ws`: the workspace when there is one; `nvm`: where nvm is, or where a new one goes (devplaces.mjs);
  // `blockHas(line)`: the kits block of the shell start files has that line already (setup/localbin.mjs).
  const ws = over.ws !== undefined ? over.ws : workspaceHere();
  const exists = over.exists || ((f) => fs.existsSync(f));
  return {
    ws,
    nvm: over.nvm !== undefined ? over.nvm : platform === 'win32' ? null : findNvm({ env, home, ws, exists }),
    blockHas: over.blockHas || ((line) => kitsBlockHas(line, { home, shell: env.SHELL || '', platform })),
    env, platform, has, run, pm, winget, dnf5: Boolean(dnf5), clt: clt !== false,
    root: over.root ?? isRoot(),
    user: over.user ?? safeUser(),
    arch: over.arch || process.arch,
    home,
    tmp: over.tmp || os.tmpdir(),
    // /etc/os-release as read already (set-up hands its own), else read where it is named.
    ...(over.release ? { release: over.release } : {}),
    exists,
    // Where a program on PATH is, and the names in a folder ([] when it cannot be read): tests pass their own.
    which: over.which || ((cmd) => which(cmd, env, platform)),
    // Read the system's Path again (after an install): the folders added, [] when none.
    refreshPath: refresh ? () => refresh(env, { force: true }) : async () => [],
    // Where a link leads in the end (java on PATH is often /usr/bin/java → /usr/lib/jvm/<jdk>/bin/java), or null.
    realpath: over.realpath || ((p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return null;
      }
    }),
    list: over.list || ((dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    }),
  };
}

function safeUser() {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

/** The first version-looking text in a command's answer: "git version 2.43.0" → "2.43.0". */
export function versionOf(text) {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** Account name from `gh auth status` (text or --json). Never the token line. */
export function parseGhAuth({ ok, stdout = '', stderr = '' }) {
  const text = `${stdout}\n${stderr}`;
  const m = /Logged in to (\S+) (?:account|as) ([A-Za-z0-9-]+)/.exec(text);
  if (m) return { signedIn: true, host: m[1], account: m[2] };
  return { signedIn: false, host: null, account: null, unknown: ok };
}

/** git's global name and e-mail: { name, email } (empty strings when not set). */
export async function gitIdentity(sys) {
  if (!sys.has('git') || (sys.platform === 'darwin' && !sys.clt)) return { name: '', email: '' };
  const [n, e] = await Promise.all([sys.run(['git', 'config', '--global', 'user.name']), sys.run(['git', 'config', '--global', 'user.email'])]);
  return { name: n.stdout.trim(), email: e.stdout.trim() };
}

export async function ghAuth(sys) {
  if (!sys.has('gh')) return { signedIn: false, account: null, reason: 'gh is not installed' };
  return parseGhAuth(await sys.run(['gh', 'auth', 'status', '--hostname', 'github.com']));
}

/** Public SSH keys in ~/.ssh (names only; a private key is never opened). */
export function sshKeys(sys) {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa'].filter((n) => sys.exists(path.join(sys.home, '.ssh', `${n}.pub`)));
}

/** Detect one item: { id, name, state: ok | missing | old | na, version, detail }. */
export async function detectItem(item, sys) {
  const base = { id: item.id, name: item.name, version: null, detail: '' };
  if (!itemHere(item, sys.platform)) return { ...base, state: 'na', detail: `not needed on ${sys.platform}` };
  if (item.detect) return { ...base, ...(await item.detect(sys)) };
  if (item.kind === 'identity') {
    const id = await gitIdentity(sys);
    const ok = Boolean(id.name && id.email);
    return { ...base, state: ok ? 'ok' : 'missing', detail: ok ? `${id.name} <${id.email}>` : `${id.name ? '' : 'name'}${!id.name && !id.email ? ' and ' : ''}${id.email ? '' : 'e-mail'} not set` };
  }
  if (item.kind === 'signin') {
    const a = await ghAuth(sys);
    return { ...base, state: a.signedIn ? 'ok' : 'missing', detail: a.signedIn ? `signed in as ${a.account}` : a.reason || 'not signed in' };
  }
  if (sys.platform === 'darwin' && item.needsClt && !sys.clt) return { ...base, state: 'missing', detail: 'comes with the Xcode command line tools' };
  if (item.id === 'build' && sys.platform === 'darwin') return { ...base, state: sys.clt ? 'ok' : 'missing', detail: sys.clt ? 'Xcode command line tools' : '' };
  if (item.id === 'build' && sys.platform === 'win32') {
    const vswhere = path.join(sys.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const r = sys.exists(vswhere) ? await sys.run([vswhere, '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationVersion']) : { stdout: '' };
    const v = versionOf(r.stdout);
    return { ...base, state: v ? 'ok' : 'missing', version: v, detail: v ? 'Visual Studio C++ tools' : '' };
  }
  if (sys.platform === 'win32' && (item.bins || []).includes('python3')) return { ...base, ...(await detectWinPython(item, sys)) };
  const bins = (item.bins || []).map((b) => (sys.platform === 'win32' && b === 'python3' ? 'python' : b));
  const lacking = bins.filter((b) => !sys.has(b));
  // Node and npm as set-up finds them (setup/system.mjs npmArgv): a PATH without them (an ssh login that does not read
  // nvm's lines) still has the Node Hoprig runs on and the npm beside it. Not "missing": off this PATH, with the fix.
  if (lacking.length && (item.id === 'node' || item.id === 'npm') && sys.platform === process.platform) {
    // Only named (the seal: nothing here is started by a path beside process.execPath; npm goes through npmArgv).
    const node = process.execPath;
    const offPath = { ...base, state: 'offpath', detail: `not on this shell's PATH; the one that comes with the Node Hoprig runs on (${node})`, fix: `add the folder of ${node} to PATH in your shell's start file (~/.profile or ~/.bashrc)` };
    if (item.id === 'node') return { ...offPath, version: process.versions.node };
    const argv = npmArgv(['--version'], sys.platform, sys.env);
    if (argv[0] !== 'npm' && argv[0] !== 'cmd.exe') {
      const r = await sys.run(argv);
      const v = r.ok ? versionOf(r.stdout) : null;
      if (v) return { ...offPath, version: v };
    }
  }
  if (lacking.length) return { ...base, state: 'missing', detail: lacking.length < bins.length ? `${lacking.join(', ')} not found` : '' };
  if (!item.version) return { ...base, state: 'ok' };
  let argv = item.version.map((a) => (sys.platform === 'win32' && a === 'python3' ? 'python' : a));
  if (sys.platform === 'win32' && argv[0] === 'npm') argv = npmArgv(argv.slice(1), 'win32'); // npm is a .cmd script there
  const r = item.versionEnv ? await sys.run(argv, { env: { ...sys.env, ...item.versionEnv } }) : await sys.run(argv);
  if (!r.ok) return { ...base, state: 'missing', detail: (r.stderr || r.stdout).trim().split('\n').pop().slice(0, 120) };
  const version = versionOf(r.stdout || r.stderr);
  if (item.eol && version && item.eol(version)) return { ...base, state: 'old', version, detail: 'past its end of life' };
  return { ...base, state: 'ok', version };
}

// The stand-in python.exe that Windows ships under WindowsApps (an App Execution Alias of the Store) runs nothing: it
// prints this and exits with 9009, or opens the Store when started without arguments.
const STORE_STUB = /Microsoft Store|App Execution Alias/i;

/**
 * Python on Windows: `python` that runs counts, and so does the Python launcher `py` (the Python install manager
 * gives both); the Store's stand-in python.exe does not, and is named. pip and venv are asked of whichever runs.
 */
export async function detectWinPython(item, sys) {
  const tail = (r) => String(r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 120);
  let stub = false;
  for (const cmd of ['python', 'py']) {
    if (!sys.has(cmd)) continue;
    const argv = item.version.map((a) => (a === 'python3' ? cmd : a));
    const r = await sys.run(argv);
    const version = r.ok ? versionOf(r.stdout || r.stderr) : null;
    if (r.ok && (version || item.id !== 'python')) {
      const via = cmd === 'py' ? 'through the py launcher' : '';
      if (item.eol && version && item.eol(version)) return { state: 'old', version, detail: 'past its end of life' };
      return { state: 'ok', version: item.id === 'venv' ? null : version, detail: via };
    }
    if (STORE_STUB.test(`${r.stdout || ''}${r.stderr || ''}`) || r.code === 9009) stub = true;
    else if (cmd === 'python' && !r.ok && !sys.has('py')) return { state: 'missing', version: null, detail: tail(r) };
  }
  // The install manager without a Python (its last step left to the person): what is here, what is not, the next step.
  if (sys.has('pymanager')) return { state: 'missing', version: null, detail: item.id === 'python' ? pyNext(sys.env) : 'comes with Python itself, which is not installed yet (see python3)' };
  return { state: 'missing', version: null, detail: stub ? "only Windows' stand-in python is here: it opens the Microsoft Store and runs nothing" : '' };
}

/**
 * Windows, the Python install manager here and no Python yet: what a person reads, with the one next step. Without a
 * desktop (kits.mjs noDesktop) that step is the person's, in a window of their own; with one, pc setup runs it.
 */
export const pyNext = (env = {}) => `only the Python install manager is here: Python itself, pip and venv are not installed yet. Next: ${noDesktop(env) ? `in a PowerShell window of your own on this computer, run ${showCommand(PY_INSTALL)}, then hoprig pc setup again` : `hoprig pc setup installs it (${showCommand(PY_INSTALL)})`}`;

/** Every item of the given kits: { kitId: [result] }. Items run in parallel. */
export async function detectKits(sys, kitIds = KITS.map((k) => k.id)) {
  const out = {};
  await Promise.all(kitIds.map(async (id) => {
    const kit = KITS.find((k) => k.id === id);
    if (!kit) return;
    // A kit Hoprig does not set up on this OS (the PHP and fvm kits on Windows): nothing is looked for or offered.
    if (!kitCovered(kit, sys.platform)) out[id] = kit.items.map((i) => ({ id: i.id, name: i.name, state: 'na', version: null, detail: 'not covered on Windows' }));
    else out[id] = await Promise.all(kit.items.map((i) => detectItem(i, sys)));
  }));
  return out;
}

/** Kits picked when nothing was asked for: the default ones that miss something. */
export function preselect(found) {
  return KITS.filter((k) => k.defaultOn && (found[k.id] || []).some((r) => r.state === 'missing')).map((k) => k.id);
}

/** "PHP 8.5.4-0ubuntu1.5 (cli) …" → "8.5.4": the numbers only. */
export const plainVersion = (text) => ((versionOf(text) || '').match(/^\d+\.\d+(?:\.\d+)?/) || [])[0] || null;

/**
 * The version of `php -v`: the line that starts with "PHP <version>". A startup warning comes before it on stdout when an
 * ini names a missing extension ("PHP Warning:  Failed loading … ioncube_loader_lin_8.1.so"), and its file name holds a
 * version-looking text of its own.
 */
export const phpVersionOf = (text) => (/^PHP (\d+\.\d+(?:\.\d+)?)/m.exec(String(text || '')) || [])[1] || null;

/** At most this many PHP series are asked (each one runs a program): every PHP archive of 2026 has 13 (5.6 … 8.5). */
export const MAX_SERIES = 20;

/** A PHP series as numbers: "8.3" → [8, 3]; "84" (php84) → [8, 4]. */
const seriesNumbers = (s) => (s.includes('.') ? s.split('.').map(Number) : [Number(s[0]), Number(s.slice(1) || 0)]);

/** Names sorted by the series in them, newest first (a plain text sort puts php10.0 before php5.6). */
export function newestFirst(names, seriesOf) {
  const key = (n) => seriesNumbers(seriesOf(n));
  return [...names].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return y[0] - x[0] || y[1] - x[1];
  });
}

/** Other PHPs on PATH (php8.3, php84 …) that run: [{ name, version }]. The one `php` runs is the one that counts. */
export async function otherPhps(sys) {
  const sep = sys.platform === 'win32' ? ';' : ':';
  const names = new Set();
  if (typeof sys.list !== 'function') return [];
  for (const dir of String((sys.env || {}).PATH || '').split(sep).filter(Boolean)) for (const n of sys.list(dir)) if (/^php\d+(\.\d+)?$/.test(n)) names.add(n);
  const out = [];
  for (const name of newestFirst([...names], (n) => n.slice(3)).slice(0, MAX_SERIES)) {
    const r = await sys.run([name, '-v']);
    const version = r.ok ? phpVersionOf(r.stdout) : null;
    if (version) out.push({ name, version });
  }
  return out;
}

/** The PHP that `php` runs, and the others on PATH named beside it. */
export async function detectPhp(sys) {
  const others = await otherPhps(sys);
  const also = others.length ? `also here: ${others.map((o) => `${o.name} (${o.version})`).join(', ')}` : '';
  if (!sys.has('php')) return { state: 'missing', version: null, detail: also ? `no php command; ${also}` : '', others };
  const r = await sys.run(['php', '-v']);
  const version = r.ok ? phpVersionOf(r.stdout) : null;
  if (!version) return { state: 'missing', version: null, detail: `php is there but did not run: ${String(r.stderr || r.stdout || '').trim().split('\n').pop().slice(0, 100)}`, others };
  return { state: 'ok', version, detail: also, others };
}

// The package managers that replace a MySQL client with MariaDB's, and whose install without -y lists that and asks.
const REPLACES = ['apt', 'dnf', 'yum', 'pacman', 'zypper'];

// Where a database server's program lives when it is not on PATH (Debian and Ubuntu: /usr/sbin; Fedora: /usr/libexec).
const SERVER_DIRS = ['/usr/sbin', '/usr/libexec', '/usr/local/sbin', '/usr/local/mysql/bin', '/opt/homebrew/bin', '/opt/homebrew/opt/mariadb/bin', '/opt/homebrew/opt/mysql/bin', '/usr/local/opt/mariadb/bin', '/usr/local/opt/mysql/bin'];

/**
 * A MariaDB or MySQL server: either counts as the database being here (MariaDB is never put beside MySQL: a package
 * manager would replace it). A server on PATH is asked --version by its name; one that does not answer still counts.
 * A server found only by its full path in SERVER_DIRS is never started (a status starts no program by a full path):
 * the file being there counts, and the detail names it.
 */
export async function detectDbServer(sys) {
  const named = ['mariadbd', 'mysqld'].filter((n) => sys.has(n));
  const paths = [];
  for (const d of SERVER_DIRS) for (const n of ['mariadbd', 'mysqld']) if (sys.exists(`${d}/${n}`)) paths.push(`${d}/${n}`);
  if (!named.length && !paths.length) {
    const client = ['mariadb', 'mysql'].find((b) => sys.has(b));
    if (!client) return { state: 'missing', version: null, detail: '' };
    // MariaDB's own client comes with its server. MySQL's client (or one that does not say whose it is) would be
    // REMOVED by the package manager to make room for MariaDB's (apt: mariadb-client-core conflicts with it, and -y
    // does not ask), so the server is held back and the command is shown for the person to run, where it asks.
    // Only where both hold (REPLACES): Homebrew's mysql-client is keg-only and stays beside MariaDB, Alpine has no
    // MySQL package of its own to replace, and neither `brew install` nor `apk add` asks before it acts.
    const r = await sys.run([client, '--version']);
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (r.ok && /mariadb/i.test(text)) return { state: 'missing', version: null, detail: `only MariaDB's client (${client}) is here, no server` };
    const v = r.ok ? plainVersion(text) : null;
    if (!REPLACES.includes(sys.pm)) return { state: 'missing', version: null, detail: `only a MySQL client (${client}${v ? ` ${v}` : ''}) is here, no server` };
    const pkgs = (kitById('php').items.find((i) => i.id === 'mariadb').packages || {})[sys.pm];
    const own = pkgs ? askingInstall(sys, pkgs) : null;
    return {
      state: 'missing', version: null, detail: `only a MySQL client (${client}${v ? ` ${v}` : ''}) is here, no server`,
      hold: `left out: installing MariaDB's server would replace the MySQL client that is here (${client}${v ? ` ${v}` : ''}).${own ? ` To install it anyway, run it yourself (it lists what it removes and asks first): ${showCommand(own)}` : ''}`,
    };
  }
  for (const n of named) {
    const r = await sys.run([n, '--version']);
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    const version = r.ok ? plainVersion(text) : null;
    if (!version) continue;
    return { state: 'ok', version, detail: /mariadb/i.test(text) ? '' : 'a MySQL server: it counts as the database, so MariaDB is not installed beside it' };
  }
  // Debian's MariaDB also puts a mysqld beside its mariadbd, so a mariadbd anywhere says MariaDB.
  const maria = paths.find((p) => p.endsWith('/mariadbd'));
  if (maria) return { state: 'ok', version: null, detail: `MariaDB server here (${maria})` };
  if (paths.length) return { state: 'ok', version: null, detail: `a MySQL server here (${paths[0]}): it counts as the database, so MariaDB is not installed beside it` };
  return { state: 'ok', version: null, detail: `a database server is here (${named[0]}), but it did not say its version` };
}

/** fvm on PATH, or in ~/.pub-cache/bin where `dart pub global activate` puts it (not on PATH until the person adds it). */
export async function detectFvm(sys) {
  const own = path.join(sys.home, '.pub-cache', 'bin', 'fvm');
  const argv = sys.has('fvm') ? ['fvm', '--version'] : sys.exists(own) ? [own, '--version'] : null;
  if (!argv) return { state: 'missing', version: null, detail: sys.has('dart') ? '' : 'needs Flutter first (its dart command installs fvm)' };
  const r = await sys.run(argv);
  const version = r.ok ? plainVersion(r.stdout || r.stderr) : null;
  const onPath = argv[0] === 'fvm' ? '' : 'in ~/.pub-cache/bin, which is not on your PATH yet';
  return version ? { state: 'ok', version, detail: onPath } : { state: 'missing', version: null, detail: `fvm is there but did not run${onPath ? ` (${onPath})` : ''}` };
}
