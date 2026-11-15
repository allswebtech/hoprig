// What this computer is and how to run things on it: the OS, the package manager, finding a program on PATH,
// and running a command either quietly (to read its answer) or in the open (so the user sees it and sudo can ask
// for its password). Decisions are pure functions over plain inputs so tests can check them for every OS.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Linux package managers, in the order we look for them. The first one found is the system's own. */
export const LINUX_MANAGERS = ['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk'];

/**
 * The package manager to use: 'apt' | 'dnf' | 'yum' | 'pacman' | 'zypper' | 'apk' | 'brew' | null.
 * `has(cmd)` says whether a program exists. Windows gets null: nothing we install there goes through one.
 */
export function detectPackageManager(platform, has) {
  if (platform === 'darwin') return has('brew') ? 'brew' : null;
  if (platform !== 'linux') return null;
  for (const m of LINUX_MANAGERS) if (has(m)) return m === 'apt-get' ? 'apt' : m;
  return null;
}

/**
 * apt-get told not to ask: a package may ask a question while it is set up (tzdata asks for the "Geographic area"
 * on a minimal system), which waits for ever where nobody sees it, and without a terminal reads whatever the
 * command's input is. Inside the sudo command, because sudo drops the environment.
 */
export const APT = ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get'];

/** How this user gets administrator rights: "root" (is root), "sudo" (it is installed) or "none". */
export const adminWay = (sys) => (sys && sys.root ? 'root' : sys && typeof sys.has === 'function' && sys.platform !== 'win32' && !sys.has('sudo') ? 'none' : 'sudo');

/**
 * A command line that was written with sudo, as this user has to run it. The one way a privileged command is
 * phrased, for doctor's fix lines and setup's plans alike:
 *   root                the commands without sudo
 *   sudo is installed   as written
 *   neither             "as root: …" for the commands that had sudo, and "then as yourself: …" for the rest of the
 *                       line (commands joined with &&), so nobody builds something in their own folder as root
 */
export function forThisUser(line, sys) {
  if (typeof line !== 'string' || !/\bsudo\b/.test(line)) return line;
  const way = adminWay(sys);
  if (way === 'sudo') return line;
  const strip = (t) => t.replace(/\bsudo +/g, '');
  if (way === 'root') return strip(line);
  const groups = [];
  for (const part of line.split(' && ')) {
    const admin = /\bsudo\b/.test(part);
    const last = groups[groups.length - 1];
    if (last && last.admin === admin) last.parts.push(strip(part));
    else groups.push({ admin, parts: [strip(part)] });
  }
  return groups.map((g, i) => `${i ? 'then ' : ''}${g.admin ? 'as root' : 'as yourself'}: ${g.parts.join(' && ')}`).join('   ');
}

/**
 * The commands (argv arrays, run one after the other) that install `packages` with `pm`.
 * `root` is true when we already run as root: then no sudo. brew never runs under sudo.
 * apt needs its package lists first: on a fresh machine or container they are empty and the install fails.
 */
export function installCommands(pm, packages, { root = false } = {}) {
  const pk = [...packages];
  const su = (argv) => (root || pm === 'brew' ? argv : ['sudo', ...argv]);
  switch (pm) {
    case 'apt':
      return [su([...APT, 'update']), su([...APT, 'install', '-y', ...pk])];
    case 'dnf':
      return [su(['dnf', 'install', '-y', ...pk])];
    case 'yum':
      return [su(['yum', 'install', '-y', ...pk])];
    case 'pacman':
      return [su(['pacman', '-S', '--needed', '--noconfirm', ...pk])];
    case 'zypper':
      return [su(['zypper', '--non-interactive', 'install', ...pk])];
    case 'apk':
      return [su(['apk', 'add', ...pk])];
    case 'brew':
      return [['brew', 'install', ...pk]];
    default:
      return null;
  }
}

/** One argv as a line the user could type (for showing, never for running). */
export function showCommand(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** Several argv arrays as one line joined with &&. */
export const showCommands = (list) => list.map(showCommand).join(' && ');

/** The full path of `cmd` on PATH, or null. An absolute or relative path is checked as it is. */
export function which(cmd, env = process.env, platform = process.platform) {
  if (!cmd) return null;
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  const isFile = (f) => {
    try {
      const st = fs.statSync(f);
      if (!st.isFile()) return false;
      if (platform !== 'win32') fs.accessSync(f, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  const tryAll = (base) => {
    for (const e of ['', ...exts]) if (isFile(base + e)) return base + e;
    return null;
  };
  if (cmd.includes('/') || (platform === 'win32' && cmd.includes('\\'))) return tryAll(path.resolve(cmd));
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of (env.PATH || env.Path || '').split(sep)) {
    if (!dir) continue;
    const found = tryAll(path.join(dir, cmd));
    if (found) return found;
  }
  return null;
}

/** True when this process runs as root (POSIX). Windows: false. */
export const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * Run a command and collect its output. Never throws: { ok, code, stdout, stderr, error }.
 * `error` is set when the program could not start at all (for example it is not installed).
 */
export function capture(argv, { env = process.env, timeout = 20_000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { env, timeout, cwd, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({
        ok: !err,
        code,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err && typeof err.code === 'string' ? err.code : null,
      });
    });
  });
}

/**
 * Run a command without showing its output: every line goes to the file `log`, and the last lines come back when it
 * fails. For package managers and the like, whose output is long and says nothing while all goes well. The command
 * gets no input (nothing may ask: see APT); sudo asks for its password on the terminal itself.
 * Resolves to { ok, code, tail }.
 */
export async function runQuiet(argv, { env = process.env, cwd, log } = {}) {
  const note = (text) => {
    if (!log) return;
    try {
      fs.appendFileSync(log, text, { mode: 0o600 });
    } catch {
      /* a log that cannot be written must not stop the work */
    }
  };
  note(`$ ${showCommand(argv)}\n`);
  const r = await stream(argv, { env, cwd, onLine: (l) => note(`${l}\n`) });
  note(`(exit ${r.code})\n`);
  return { ok: r.ok, code: r.code, tail: r.ok ? '' : r.output.split('\n').filter((l) => l.trim()).slice(-12).join('\n') };
}

/**
 * Run a command and pass each output line to onLine as it comes. With `interactive` the command gets this
 * terminal (stdin and output) instead, so sudo, a browser sign-in or a prompt can talk to the user directly;
 * its output is then not collected. `input` (text) is written to the command's input, which is then closed: how
 * `sudo -S` gets a password without a terminal (pcsetup/admin.mjs). Resolves to { ok, code, output }.
 */
export function stream(argv, { env = process.env, cwd, onLine = () => {}, interactive = false, input = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: interactive ? 'inherit' : [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: null, output: e.message });
      return;
    }
    if (!interactive && input !== null) {
      child.stdin.on('error', () => {}); // a command that exits without reading its input
      child.stdin.end(input);
    }
    const lines = [];
    const feed = (stream) => {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        rest += chunk;
        const parts = rest.split(/\r?\n|\r/);
        rest = parts.pop();
        for (const l of parts) {
          lines.push(l);
          onLine(l);
        }
      });
      stream.on('end', () => {
        if (rest) {
          lines.push(rest);
          onLine(rest);
        }
      });
    };
    if (!interactive) {
      feed(child.stdout);
      feed(child.stderr);
    }
    child.on('error', (e) => {
      lines.push(e.message);
      onLine(e.message);
    });
    child.on('close', (code) => resolve({ ok: code === 0, code, output: lines.join('\n') }));
  });
}

/** Read /etc/os-release into an object ({ ID, ID_LIKE, PRETTY_NAME, ... }); {} when there is none. */
export function osRelease(file = '/etc/os-release') {
  try {
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
    return out;
  } catch {
    return {};
  }
}

/** A short human name for this OS, e.g. "macOS 15.1", "Ubuntu 24.04 LTS", "Windows 10.0.22631". */
export function osName(platform = process.platform) {
  if (platform === 'linux') return osRelease().PRETTY_NAME || `Linux ${os.release()}`;
  if (platform === 'darwin') return `macOS (Darwin ${os.release()})`;
  if (platform === 'win32') return `Windows ${os.release()}`;
  return `${platform} ${os.release()}`;
}

/** Parse "v20.11.1" / "20.11.1" / "2.1.325 (Claude Code)" / "tmux 3.4" / "tmux next-3.5" into [major, minor, patch]. */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** Compare two version strings: -1, 0 or 1. Unparsable sorts first. Pre-release suffixes are ignored. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return !x && !y ? 0 : !x ? -1 : 1;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * argv that runs npm. On Windows npm is a .cmd script, and Node refuses to start .cmd files without a shell
 * (since the 2024 security fix), so it goes through cmd.exe there.
 */
export function npmArgv(args, platform = process.platform) {
  return platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', 'npm', ...args] : ['npm', ...args];
}

/** The major version of the npm on PATH (12 for "12.2.2"), or null when npm does not answer. */
export async function npmMajor({ env = process.env, platform = process.platform } = {}) {
  const r = await capture(npmArgv(['--version'], platform), { env, timeout: 20_000 });
  const m = r.ok ? /^(\d+)\./.exec(r.stdout.trim()) : null;
  return m ? Number(m[1]) : null;
}

/**
 * What `npm install -g <source>` needs on npm 12 and newer when the package is named by an address: from 12 on
 * npm refuses a tarball URL and a git address unless allowed (its settings allow-remote and allow-git, default
 * "none"). "root" allows only what the command itself names, not what a dependency points to. A name on npm, a
 * file and a folder need nothing, and neither does an older npm, where these are the default (npm 12 itself
 * refuses a flag it does not know, so nothing is passed that is not needed).
 */
export function npmSourceFlags(source, major) {
  if (!(major >= 12)) return [];
  if (/^(git\+|git:\/\/|github:)|\.git(#.*)?$/.test(source)) return ['--allow-git=root'];
  if (/^https?:\/\//.test(source)) return ['--allow-remote=root'];
  return [];
}
