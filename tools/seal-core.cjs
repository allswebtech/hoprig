'use strict';
// The seal's core, in CommonJS so that the wrap can be carried into a Node child by NODE_OPTIONS=--require (a preload
// that leaves how the child's own main file is loaded alone; tools/test-seal.cjs). Three callers share this one copy:
//  - tools/test-seal.cjs, the wrap the runner preloads into every test file's process and carries into Node children;
//  - tools/seal-core.mjs and tools/test-traps.mjs, which keep their ES-module exports by loading this file;
//  - test/seal.mjs, which a test imports to build a child's PATH or environment by hand.
// All read the runner's own variables from the environment (HOPRIG_TEST_TRAPS names the trap folder); keeping the
// logic here means a test that builds an environment by hand and a child started through the wrap seal it the same way.
// It runs on Node 22.0, which cannot require an ES module: everything it loads is CommonJS or built in.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * The runner's variables a child must keep: the trap folder, the test file's name, its process id (the root of the
 * tree of processes the df/ps/ss stand-ins and the wrap's /proc answer) and its mark (that pid and a random part, which
 * no later test file repeats), the product's npm override, the made-up
 * trapped names and ports (only in the seal's own proofs), the programs a test asked to be the real ones
 * (HOPRIG_SEAL_REAL), and the run's own tmux folder, so a child given a fresh environment never asks the tmux
 * servers of the person's default folder, and on Windows the run's one PowerShell module cache (tools/test-plan.mjs).
 */
const SEAL_VARS = ['HOPRIG_TEST_TRAPS', 'HOPRIG_TEST_FILE', 'HOPRIG_TEST_PID', 'HOPRIG_TEST_MARK', 'HOPRIG_NODE_NPM', 'HOPRIG_SEAL_EXTRA_TRAPS', 'HOPRIG_SEAL_EXTRA_PORTS', 'HOPRIG_SEAL_REAL', 'TMUX_TMPDIR', 'PSModuleAnalysisCachePath'];

/**
 * The programs trapped whatever they are asked (`brew` and `port` were the first: a test once ran `brew install`).
 * The groups: privilege and the service managers; the package managers; reaching another computer; changing the real
 * machine; and the owner's accounts and services. A test that needs one puts its own stand-in first on PATH
 * (test/seal.mjs). The macOS and Windows names are harmless on Linux (no program of that name is there). `gh`,
 * `docker`, `tailscale` and `cloudflared` are here too now: the product looks for them on PATH, so a doctor or
 * pc-setup test that wants one "installed" gives it a stand-in that answers its version and status calls. A test that
 * wants it MISSING gives the product facts that say so (a fake `sys` whose `has()` returns false), so the product
 * never runs it; the trap is the backstop that fails the run only if some test runs one for real.
 */
const TRAPPED = [
  // Privilege, the service managers, and the ways to run as another user.
  'sudo', 'doas', 'pkexec', 'su', 'runuser', 'systemctl', 'loginctl', 'systemd-run', 'launchctl', 'schtasks',
  // The programs that make or change accounts and the administrator rights file (the work user of a set-up as root).
  'useradd', 'usermod', 'userdel', 'groupadd', 'visudo', 'chpasswd',
  // The package managers.
  'apt-get', 'apt', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'snap', 'brew', 'port', 'winget', 'choco', 'scoop',
  // Reaching another computer.
  'ssh', 'scp', 'ssh-copy-id',
  // Changing the real machine (shut it down, end a process by name, the macOS keychain and preferences, crontab).
  'shutdown', 'taskkill', 'crontab', 'osascript', 'security', 'defaults',
  // The owner's accounts and services: the GitHub CLI, the container daemon, the private network, the public tunnel.
  // Each test that needs one gives it a stand-in first on PATH (a "program missing" case keeps none, so the trap
  // stands in for a computer that does not have it).
  'gh', 'docker', 'tailscale', 'cloudflared',
];
/**
 * Made-up names the runner traps as well, from HOPRIG_SEAL_EXTRA_TRAPS (only adds; letters, digits and dashes). The
 * seal's own proofs use them, so that a proof run WITHOUT the change it proves finds no real program of that name.
 */
const extraTraps = (value) => String(value || '').split(/[\s,]+/).filter((n) => /^[a-z][a-z0-9-]{0,40}$/.test(n) && n !== 'npm');
/** The exit code of a trap: no real program of these names ends with it on its own. */
const TRAP_EXIT = 97;
/** What a trap writes when the test file's process did not pass its name on (a child given an environment of its own). */
const UNKNOWN_FILE = 'an unknown test file';

const parts = (p) => (Array.isArray(p) ? p : [p]).flatMap((x) => String(x ?? '').split(path.delimiter)).filter(Boolean);
// The temporary area as it stood when the seal first loaded, before any test changed TMPDIR to a folder of its own
// (test/pcsetup/dryrun-fixture.mjs does): a test's stand-ins are made under the run's tmp and stay the test's own,
// so the traps never jump ahead of them. Captured once, so a later TMPDIR change cannot narrow it.
const BASE_TMP = (() => { try { return path.resolve(os.tmpdir()); } catch { return null; } })();
// Each root also by its real path: where TMPDIR is a link (macOS: /var/folders/… points to /private/var/folders/…), a
// test that realpaths its mkdtemp makes its stand-ins under the real path, and they are still its own.
const real = new Map();
const realOf = (d) => {
  if (!real.has(d)) { try { real.set(d, fs.realpathSync(d)); } catch { real.set(d, d); } }
  return real.get(d);
};
// The repository's own test folder: a stand-in a test keeps there (checked in, like test/fixtures/runner/bin) is the
// test's own too. No program of the computer lives there.
const TESTS = path.resolve(__dirname, '..', 'test');
// The run's own temporary roots as the runner wrote them into its trap settings (tools/test-traps.mjs makeTraps:
// its tmpdir and sandbox, each also by its real path). They do not depend on what a child is handed: a child the test
// gives an environment of its own has no TMPDIR (or another one), so its os.tmpdir() is not the run's, and without
// these the test's stand-ins under the run's tmp would count as the computer's (macOS: /var/folders/…/T against /tmp).
// Read once per trap folder; only absolute paths are taken.
const runRootsOf = new Map();
const runRoots = () => {
  const traps = process.env.HOPRIG_TEST_TRAPS;
  if (!traps) return [];
  if (!runRootsOf.has(traps)) {
    let roots = [];
    try { roots = JSON.parse(fs.readFileSync(path.join(traps, 'npm-trap.json'), 'utf8')).roots; } catch { roots = []; }
    runRootsOf.set(traps, (Array.isArray(roots) ? roots : []).filter((r) => typeof r === 'string' && path.isAbsolute(r)));
  }
  return runRootsOf.get(traps);
};
const tmpRoots = () => [...new Set([BASE_TMP, os.tmpdir(), process.env.TMPDIR, TESTS, ...runRoots()].filter(Boolean).map((d) => path.resolve(d)).flatMap((d) => [d, realOf(d)]))];
/** Whether `d` is where a test's own stand-ins live: the temporary area (os.tmpdir or TMPDIR, or their real paths) or the repository's test folder. */
const inTmp = (d) => tmpRoots().some((r) => path.resolve(d) === r || path.resolve(d).startsWith(r + path.sep));

/**
 * `value` (a PATH, as a string or a list of folders) with the runner's traps before the first folder that is not the
 * test's own: a test's stand-ins live in the temporary folder and stay first, the computer's folders (/usr/bin, the
 * folder of Node and its npm) come after the traps. A PATH of the test's own folders only is left as it is: no real
 * program can be found on it by name. When the environment names no PATH at all (`value` undefined), the operating
 * system would search its own default folders, where no trap is: the sealed PATH is then the traps followed by those
 * default folders, so a child given `{ HOME }` still finds git and sh, and finds the traps first. An EMPTY PATH ('')
 * is not absent: the system searches none of its folders for it, so it stays empty of them and gets the traps alone.
 */
// Where a child given no PATH is searched by the operating system (execvp's default on POSIX; on Windows, the system
// folders every program finds), written out so the traps can go before it.
const DEFAULT_PATH = () => {
  if (process.platform !== 'win32') return ['/usr/local/bin', '/usr/bin', '/bin'];
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return [path.join(root, 'System32'), root, path.join(root, 'System32', 'Wbem')];
};

function sealedPath(value) {
  const traps = process.env.HOPRIG_TEST_TRAPS;
  const dirs = parts(value).filter((d) => d !== traps);
  if (!traps) return dirs.join(path.delimiter);
  const at = dirs.findIndex((d) => !inTmp(d));
  if (at >= 0) dirs.splice(at, 0, traps);
  else if (value === undefined || value === null) dirs.push(traps, ...DEFAULT_PATH()); // no PATH at all: traps, then where the system would look
  else if (dirs.length === 0) dirs.push(traps); // an empty PATH: the system looks nowhere, so only the traps
  return dirs.join(path.delimiter);
}

/**
 * The key of `env` the operating system reads PATH from. Windows finds it in any case (Path is usual there); on every
 * other system only `PATH` itself counts: a `Path` is an ordinary variable, and a child given one but no `PATH` is
 * searched on the system's default folders, where no trap is. So on those systems only `PATH` is sealed, and an
 * environment that holds only `Path` is sealed as one that names no PATH at all.
 */
const pathKey = (env) => (process.platform === 'win32' ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') : undefined) || 'PATH';

/** `env` (an environment for a child) with the seal kept: its PATH sealed, the runner's variables carried. */
function sealed(env) {
  const key = pathKey(env);
  const out = { ...env, [key]: sealedPath(env[key]) };
  for (const k of SEAL_VARS) if (process.env[k] && out[k] === undefined) out[k] = process.env[k];
  return out;
}

/** The programs (df, ps, ss) and the process listing (proc) a test asked to be the computer's own: HOPRIG_SEAL_REAL. */
const STAND_INS = ['df', 'ps', 'ss'];
const realAsked = (value = process.env.HOPRIG_SEAL_REAL) => String(value || '').split(/[\s,]+/).filter((n) => [...STAND_INS, 'proc'].includes(n));
/**
 * The computer's own programs a test asked to start by a FULL PATH (HOPRIG_SEAL_REAL names them beside df, ps, ss,
 * proc): lower-cased, without a Windows ending. A trapped name (and npm) is never one of them: its trap still answers.
 */
const realByFullPath = (value = process.env.HOPRIG_SEAL_REAL) => String(value || '').split(',')
  .map((n) => n.trim().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase())
  .filter((n) => n && ![...STAND_INS, 'proc', 'npm', ...TRAPPED].includes(n));

/** The parent of each process in `proc` (Linux): Map pid -> ppid, and the pids whose environment names `mark`. */
function procTable(proc, mark, readdir = fs.readdirSync) {
  const parent = new Map();
  const marked = [];
  for (const name of readdir(proc)) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const st = fs.readFileSync(path.join(proc, name, 'stat'), 'utf8');
      parent.set(pid, Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]));
    } catch { continue; } // gone meanwhile
    if (!mark) continue;
    try { if (fs.readFileSync(path.join(proc, name, 'environ'), 'utf8').split('\0').includes(mark)) marked.push(pid); } catch { /* another user's, or gone */ }
  }
  return { parent, marked };
}

/**
 * The pids of the test file's own processes (Linux, from `proc`): the process `root` (the test file's, named to every
 * child as HOPRIG_TEST_PID) and its descendants, and every process whose environment carries the test file's MARK
 * (HOPRIG_TEST_MARK: a tmux server the test started puts itself in the background, so its parent is no longer the
 * test's) with its descendants. The mark is the pid and a random part, not the pid alone: a server an earlier test file
 * left running carries that file's pid, which a later test file can get again. Another run's processes, and the
 * person's own, carry another mark or none, and are not in it. With no mark, only `root` and its descendants.
 */
function ownTree(root, { proc = '/proc', readdir = fs.readdirSync, mark = process.env.HOPRIG_TEST_MARK } = {}) {
  const { parent, marked } = procTable(proc, mark ? `HOPRIG_TEST_MARK=${mark}` : null, readdir);
  const kids = new Map();
  for (const [pid, ppid] of parent) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
  const out = new Set();
  const todo = [Number(root), ...marked].filter((p) => parent.has(p));
  while (todo.length) {
    const p = todo.pop();
    if (out.has(p)) continue;
    out.add(p);
    todo.push(...(kids.get(p) || []));
  }
  return out;
}

module.exports = { STAND_INS, realAsked, realByFullPath, ownTree, SEAL_VARS, TRAPPED, extraTraps, TRAP_EXIT, UNKNOWN_FILE, inTmp, sealedPath, sealed };
