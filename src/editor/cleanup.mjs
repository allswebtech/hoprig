// One-time cleanup of what the former VS Code Server feature left on a computer, run when the dashboard starts:
//   1. a server left running by a dashboard that crashed: its process group is stopped only when that group still
//      runs our own command (its --cli-data-dir is <stateDir>/vscode/cli), never on the process number alone, which
//      the system may have given to another program since;
//   2. its private socket folders in the temp folder (hoprig-vscode-*), only this user's and only when nothing
//      listens on the socket in them any more;
//   3. its folder in the state directory (the downloaded server, its settings and caches: often hundreds of MB);
//   4. its key in config.json.
// A marker file in the state directory makes sure this runs once. Remove this module two releases after the
// feature went.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const MARKER = 'cleaned-vscode';
const TMP_PREFIX = 'hoprig-vscode-';

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
 * function giving `ps -A -o pgid= -o args=` output), kill (signal a process group), config / saveConfig, log.
 * Returns what was done: { ran, stopped: [pgid], removedTmp: [dir], removedBytes, configKey }.
 */
export async function cleanupVscode(stateDir, opts = {}) {
  const {
    tmpDir = os.tmpdir(), platform = process.platform, ps = defaultPs, log = (m) => console.log(m),
    kill = (pgid) => process.kill(-pgid, 'SIGTERM'), config = null, saveConfig = null,
  } = opts;
  const out = { ran: false, stopped: [], removedTmp: [], removedBytes: 0, configKey: false };
  const marker = path.join(stateDir, MARKER);
  if (fs.existsSync(marker)) return out;
  out.ran = true;
  const data = path.join(stateDir, 'vscode');
  const had = fs.existsSync(data);

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
    }

    // 2. Its socket folders: this user's, named like ours, with nothing listening any more. Looked for only where
    // this computer used the feature (its state folder exists), and never where a server still answers.
    let names = [];
    try {
      names = fs.readdirSync(tmpDir).filter((n) => n.startsWith(TMP_PREFIX));
    } catch {
      /* no temp folder */
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    for (const n of names) {
      const dir = path.join(tmpDir, n);
      try {
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || (uid !== null && st.uid !== uid)) continue;
        // The folder of the server just stopped may still answer for a moment: it goes anyway.
        const justStopped = out.stopped.length > 0 && rec.run === dir;
        const sock = path.join(dir, 'vs.sock');
        if (!justStopped && fs.existsSync(sock) && (await listening(sock))) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        out.removedTmp.push(dir);
      } catch {
        /* left as it is */
      }
    }

    // 3. Its folder in the state directory.
    out.removedBytes = sizeOf(data);
    try {
      fs.rmSync(data, { recursive: true, force: true });
      log(`Removed the VS Code Server files the dashboard no longer uses (${words(out.removedBytes)}).`);
    } catch (e) {
      log(`Could not remove ${data}: ${e.message}`);
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

  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    /* runs again next start: every step is safe to repeat */
  }
  return out;
}
