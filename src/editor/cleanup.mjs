// One-time cleanup of what the former VS Code Server feature left on a computer, run when the dashboard starts:
//   1. a server left running by a dashboard that crashed: its process group is stopped only when that group still
//      runs our own command (its --cli-data-dir is <stateDir>/vscode/cli), never on the process number alone, which
//      the system may have given to another program since;
//   2. its private socket folders in the temp folder (hoprig-vscode-*), only this user's and only when nothing
//      listens on the socket in them any more;
//   3. what it kept in the state directory (the downloaded server, its settings and caches: often hundreds of MB):
//      only the three entries it made (cli/, server/, server.pid), then the folder itself only when nothing else is in
//      it (a state directory can be a shared data folder; another program's "vscode" folder is never touched);
//   4. its key in config.json.
// A marker file in the state directory makes sure this runs once: it is written only when step 3 is done, so a
// removal that failed is tried again at the next start. Remove this module two releases after the feature went.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const MARKER = 'cleaned-vscode';
const TMP_PREFIX = 'hoprig-vscode-';
const OURS = ['cli', 'server', 'server.pid']; // what the feature made in <stateDir>/vscode
const TMP_AGE_MS = 10 * 60_000; // a socket folder younger than this may belong to a server that is still starting

const sizeOf = (dir) => {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!e.isFile()) continue;
      try {
        n += fs.lstatSync(path.join(e.parentPath ?? e.path, e.name)).size;
      } catch {
        /* gone meanwhile */
      }
    }
  } catch {
    /* unreadable: counted as nothing */
  }
  return n;
};

const words = (bytes) => (bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.round(bytes / (1 << 20))} MB`);

/** True when something accepts a connection on the Unix socket `p`. */
function listening(p) {
  return new Promise((resolve) => {
    const s = net.connect(p);
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000).unref();
  });
}

/** The process groups whose command line carries `marker`, from `ps` (POSIX only). */
function groupsWith(marker, ps) {
  let list = '';
  try {
    list = ps();
  } catch {
    return [];
  }
  const out = new Set();
  for (const l of list.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l);
    if (m && m[2].includes(marker)) out.add(Number(m[1]));
  }
  return [...out];
}

const defaultPs = () => execFileSync('ps', ['-A', '-o', 'pgid=', '-o', 'args='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * Run the cleanup once. `stateDir`: the dashboard's state directory. Options (tests): tmpDir, platform, ps (a
 * function giving `ps -A -o pgid= -o args=` output), kill (signal a process group), config / saveConfig, log, uid
 * (this user's), waitMs (how long a stopped server may take to go), now.
 * Returns what was done: { ran, stopped: [pgid], removedTmp: [dir], removedBytes, configKey }.
 */
export async function cleanupVscode(stateDir, opts = {}) {
  const {
    tmpDir = os.tmpdir(), platform = process.platform, ps = defaultPs, log = (m) => console.log(m),
    kill = (pgid) => process.kill(-pgid, 'SIGTERM'), config = null, saveConfig = null,
    uid = typeof process.getuid === 'function' ? process.getuid() : null, waitMs = 3000, now = Date.now,
  } = opts;
  const out = { ran: false, stopped: [], removedTmp: [], removedBytes: 0, configKey: false };
  const marker = path.join(stateDir, MARKER);
  if (fs.existsSync(marker)) return out;
  out.ran = true;
  const data = path.join(stateDir, 'vscode');
  const had = fs.existsSync(data);
  let failed = false;

  if (had) {
    // 1. A leftover server. Its pid file names the group; the command line must still carry our own data folder.
    const pidFile = path.join(data, 'server.pid');
    let rec = null;
    try {
      rec = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    } catch {
      /* no pid file: nothing was left running, or it cannot be told apart */
    }
    const ourMarker = path.join(data, 'cli');
    const pgid = rec ? Number(rec.pid) : NaN;
    if (platform !== 'win32' && Number.isInteger(pgid) && pgid > 1 && groupsWith(ourMarker, ps).includes(pgid)) {
      try {
        kill(pgid);
        out.stopped.push(pgid);
      } catch {
        /* already gone */
      }
      // A stopping server may still write into its folder for a moment: wait for the group to be gone.
      for (const until = now() + waitMs; now() < until && groupsWith(ourMarker, ps).includes(pgid);) await new Promise((r) => setTimeout(r, 100));
    }

    // 2. Its socket folders: this user's, named like ours, with nothing listening any more. Looked for only where
    // this computer used the feature (its state folder exists), and never where a server still answers.
    let names = [];
    try {
      names = fs.readdirSync(tmpDir).filter((n) => n.startsWith(TMP_PREFIX));
    } catch {
      /* no temp folder */
    }
    for (const n of names) {
      const dir = path.join(tmpDir, n);
      try {
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || (uid !== null && st.uid !== uid)) continue;
        // The folder of the server just stopped may still answer for a moment: it goes anyway.
        const justStopped = out.stopped.length > 0 && rec.run === dir;
        const sock = path.join(dir, 'vs.sock');
        if (!justStopped && fs.existsSync(sock) && (await listening(sock))) continue;
        // No socket yet may mean a server of another install that is still starting: only old folders go.
        if (!justStopped && !fs.existsSync(sock) && now() - st.mtimeMs < TMP_AGE_MS) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        out.removedTmp.push(dir);
      } catch {
        /* left as it is */
      }
    }

    // 3. What it kept in the state directory: its own entries only, then the folder when that left it empty.
    try {
      for (const n of OURS) {
        const p = path.join(data, n);
        const st = fs.lstatSync(p, { throwIfNoEntry: false });
        if (!st) continue;
        out.removedBytes += st.isDirectory() ? sizeOf(p) : st.size;
        fs.rmSync(p, { recursive: true, force: true });
      }
      if (!fs.readdirSync(data).length) fs.rmdirSync(data);
      else log(`Left ${data} in place: it holds files the dashboard did not make.`);
      log(`Removed the VS Code Server files the dashboard no longer uses (${words(out.removedBytes)}).`);
    } catch (e) {
      log(`Could not remove the VS Code Server files in ${data} (tried again at the next start): ${e.message}`);
      failed = true;
    }
  }

  // 4. Its settings key.
  try {
    const cfg = config ? config() : null;
    if (cfg && Object.prototype.hasOwnProperty.call(cfg, 'vscode') && saveConfig) {
      saveConfig({ vscode: undefined }); // undefined is left out when the file is written
      out.configKey = true;
    }
  } catch {
    /* the settings stay as they are */
  }

  if (failed) return out; // runs again at the next start: every step is safe to repeat
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    /* runs again at the next start */
  }
  return out;
}
