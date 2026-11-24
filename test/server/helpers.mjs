// Test isolation: every test file gets its own config, state and profiles folders under the OS temp folder, its
// own Claude folder, its own GitHub sign-in folder (empty) and its own (empty) workspace, so nothing of the real user's setup is read or written. The
// workspace matters as much as the rest: a server that runs for a second looks after the workspace's map
// (src/automation/workspacesync.mjs), and without a workspace of its own that is the real one and its brain.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closedGateways } from '../seal.mjs';

export function sandbox(name = 'dash') {
  // Its real path: on macOS the temp folder is reached through a link (/var -> /private/var), and the dashboard works
  // with real paths (the folder it starts a coding tool in, the folder name of its conversations).
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-test-`)));
  const dirs = {
    root,
    config: path.join(root, 'config'),
    state: path.join(root, 'state'),
    profiles: path.join(root, 'profiles'),
    claude: path.join(root, 'claude'),
    home: path.join(root, 'home'),
    workspace: path.join(root, 'workspace'),
    gh: path.join(root, 'gh'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  process.env.HOPRIG_CONFIG_DIR = dirs.config;
  process.env.HOPRIG_STATE_DIR = dirs.state;
  process.env.HOPRIG_PROFILES_DIR = dirs.profiles;
  process.env.CLAUDE_CONFIG_DIR = dirs.claude;
  process.env.HOPRIG_WORKSPACE_DIR = dirs.workspace;
  // GitHub's command reads its sign-in from here (else from the real config folder, shown on a test's Setup).
  process.env.GH_CONFIG_DIR = dirs.gh;
  // What a session of the person running the tests carries: a test dashboard is never part of that session (its
  // hooks would write the real session's run record).
  for (const k of ['HOPRIG_RUN_FILE', 'HOPRIG_TERM_ID', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete process.env[k];
  // Each shipped gateway on a port of the test's own, never its default (test/seal.mjs closedGateways).
  fs.writeFileSync(path.join(dirs.config, 'config.json'), `${JSON.stringify({ addons: closedGateways() }, null, 2)}\n`, { mode: 0o600 });
  // A stand-in for the shipped gateway's program (trouteai), laid out like an npm global install so the product's
  // packageProgram accepts it (its real path is inside lib/node_modules/trouteai/, owned by us, not world-writable,
  // outside the workspace) and first on PATH. Without it the add-ons list and the Operator look run the owner's real
  // gateway program by its full path to read its version. The port stays closed (closedGateways above).
  const pkgBin = path.join(root, 'npm', 'lib', 'node_modules', 'trouteai', 'bin');
  fs.mkdirSync(pkgBin, { recursive: true });
  fs.writeFileSync(path.join(pkgBin, 'trouteai.js'), '#!/bin/sh\ncase "$1" in --version) echo "trouteai 1.0.8";; *) exit 0;; esac\n', { mode: 0o755 });
  const gwBin = path.join(root, 'npm', 'bin');
  fs.mkdirSync(gwBin, { recursive: true });
  fs.symlinkSync(path.join('..', 'lib', 'node_modules', 'trouteai', 'bin', 'trouteai.js'), path.join(gwBin, 'trouteai'));
  process.env.PATH = `${gwBin}${path.delimiter}${process.env.PATH}`;
  // A process of the test that outlives it fails the test, named, instead of being hidden by a removal that retries
  // until the folder happens to be empty. One that is just ending gets a moment (it is not ours to wait on).
  dirs.cleanup = () => {
    let left = boxProcesses(root);
    for (const stop = Date.now() + LEFT_WAIT_MS; left.length && Date.now() < stop; left = boxProcesses(root)) nap(50);
    try {
      // Without /proc (macOS) nothing is seen, so the removal retries as before; on Linux an empty list is proven.
      fs.rmSync(root, { recursive: true, force: true, ...(process.platform === 'linux' ? {} : { maxRetries: 10, retryDelay: 100 }) });
    } catch (e) {
      if (!left.length) throw e;
    }
    if (left.length) throw new Error(`still alive after the test, in its sandbox ${root}: ${left.join('; ')}`);
  };
  return dirs;
}

const LEFT_WAIT_MS = 5_000;
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The processes still alive that belong to the sandbox at `root`: started with one of its folders in their
 * environment (every child a test starts after sandbox() is), or working inside it. Each as "pid (command line)".
 * Read from /proc, so Linux only; elsewhere none are found. Never this process, never a zombie (it writes nothing).
 */
export function boxProcesses(root) {
  if (process.platform !== 'linux') return [];
  const mark = root + path.sep;
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
  } catch {
    return [];
  }
  const found = [];
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat[stat.lastIndexOf(')') + 2] === 'Z') continue;
      let cwd = '';
      try {
        cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        /* not readable: the environment decides */
      }
      const inBox = `${cwd}${path.sep}`.startsWith(mark)
        // A value that is a path in the box (HOPRIG_STATE_DIR, HOME, ...); not PATH, which holds every earlier box too.
        || fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').some((kv) => !kv.startsWith('PATH=') && kv.slice(kv.indexOf('=') + 1).startsWith(mark));
      if (!inBox) continue;
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
      found.push(`${pid} (${cmd.slice(0, 160)})`);
    } catch {
      /* gone meanwhile, or another user's */
    }
  }
  return found;
}

/** A minimal stand-in for an http.IncomingMessage with headers and a socket. */
export function fakeReq(headers = {}, socket = { remoteAddress: '10.0.0.5' }) {
  return { headers, socket };
}

/**
 * The arguments a terminal's launcher is started with, read back: the dashboard types `<launcher> --launch <file>`
 * and the file (src/launchfile.mjs) holds the rest. Returns the launcher's own words and then the file's, as they
 * were before launch files; the file stays where it is. Any other argv comes back unchanged.
 */
export function launched(argv) {
  const i = Array.isArray(argv) ? argv.indexOf('--launch') : -1;
  if (i < 0) return argv;
  return [...argv.slice(0, i), ...JSON.parse(fs.readFileSync(argv[i + 1], 'utf8')).argv];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** What macOS's `ps -o lstart=` prints (C locale, UTC) for a process started at `ms`: "Tue Nov 17 06:38:18 2026". */
export function lstart(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/**
 * The identity (src/procid.mjs) of a process that had a pid before the process whose identity is `id`: the same pid,
 * an earlier start. An hour earlier where a start is a time (well outside what counts as one process there), one tick
 * where it is the kernel's own number.
 */
export function earlierIdentity(id) {
  const i = id.lastIndexOf(':');
  return id.startsWith('T:') ? `T:${Number(id.slice(2)) - 3_600_000}` : `${id.slice(0, i + 1)}${Number(id.slice(i + 1)) - 1}`;
}
