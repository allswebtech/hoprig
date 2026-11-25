// The databases of the whole-computer check (leavehome.mjs): an engine that runs on this computer while the workspace's
// database/<engine>/ holds no dump newer than its newest change. The design's rule: Hoprig never opens a database to
// decide this, and never runs a database client. It only lists processes (the desktop's own per-OS listing, the same
// `ps` the dashboard uses) and reads the times of files: what it cannot see without a password is said, never guessed.
//
// Tests (and the demo) hand facts in instead of the computer: facts.databases = [{ engine, dataDir, running,
// newestChange }]; then nothing of the computer is looked at.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run as runCmd } from '../server/platform/common.mjs';
import * as darwin from '../server/platform/darwin-system.mjs';
import * as linux from '../server/platform/linux-system.mjs';
import { tilde } from '../paths.mjs';

// Where each engine keeps its data when installed the usual way (Linux packages, Homebrew, Postgres.app), and the
// name its server process has. MariaDB uses MySQL's folder. Only these engines: a mark of test data names one of them.
const ENGINES = [
  { engine: 'postgresql', procs: ['postgres'], dirs: (home) => ['/var/lib/postgresql', '/var/lib/pgsql', '/usr/local/var/postgres', '/usr/local/var/postgresql', '/opt/homebrew/var/postgres', '/opt/homebrew/var/postgresql', path.join(home, 'Library', 'Application Support', 'Postgres')] },
  { engine: 'mysql', procs: ['mysqld'], dirs: () => ['/var/lib/mysql', '/usr/local/var/mysql', '/opt/homebrew/var/mysql'] },
  { engine: 'mariadb', procs: ['mariadbd'], dirs: () => ['/var/lib/mysql', '/usr/local/var/mysql', '/opt/homebrew/var/mysql'] },
];
// Without a way to list processes, a data folder that changed within this time counts as running.
const RECENT_MS = 7 * 24 * 3600 * 1000;

const isDirAt = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const msOf = (v) => (v === null || v === undefined ? null : Number.isFinite(new Date(v).getTime()) ? new Date(v).getTime() : null);

/** The names of the running processes, or null when they cannot be listed here. `run`: capture-style (argv). */
async function runningNames(run) {
  const part = { linux, darwin }[process.platform];
  if (!part) return null;
  const io = {
    run: run ? async (cmd, args) => run([cmd, ...args]) : runCmd,
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
  };
  try {
    return new Set((await part.processes(io)).map((p) => p.name));
  } catch {
    return null;
  }
}

/**
 * The newest change of a folder as far as it can be read: { at } or { why }. Every file and folder time counts (a new
 * file changes its folder's time). A folder inside that cannot be read (a server's data is its own user's) makes the
 * newest change unknown: said, not guessed.
 */
async function newestOf(dir, walker) {
  let at = 0;
  const seen = (st) => {
    if (st.mtimeMs > at) at = st.mtimeMs;
  };
  try {
    seen(fs.statSync(dir));
  } catch {
    return { why: 'its data folder cannot be read without a password' };
  }
  const r = await walker.walk(dir, { madeAgain: false, onFile: (_p, st) => seen(st), onDir: (_p, st) => seen(st) });
  if (!r.opened || r.unreadable) return { why: 'its data folder cannot be read without a password, so its newest change is not known' };
  if (!r.done) return { why: 'its data folder is too large to read its newest change within the budget' };
  return { at };
}

/** The newest dump in the workspace's database/<engine>/ (any file's time), or 0 when there is none. */
async function newestDump(dir, engine, walker) {
  let at = 0;
  const r = await walker.walk(path.join(dir, 'database', engine), { madeAgain: false, onFile: (_p, st) => (at = Math.max(at, st.mtimeMs)) });
  return { at, done: r.done || !r.opened };
}

/**
 * The databases part: { items, notChecked }. `facts`: handed-in databases (then nothing of the computer is read);
 * `testData`: engines the owner marked as holding test data only (never counted).
 */
export async function databaseLook({ dir, home = os.homedir(), facts, testData = [], walker, run, now = () => Date.now() }) {
  const items = [];
  const notChecked = [];
  let found = [];
  if (Array.isArray(facts)) {
    found = facts.filter((f) => f && typeof f.engine === 'string').map((f) => ({ engine: f.engine, dataDir: f.dataDir || null, running: !!f.running, newest: msOf(f.newestChange) }));
  } else {
    const names = await runningNames(run);
    const seenDirs = new Set();
    for (const e of ENGINES) {
      const dataDir = e.dirs(home).find(isDirAt);
      if (!dataDir) continue;
      const running = names ? e.procs.some((n) => names.has(n)) : null;
      if (running === false) continue;
      if (names === null && seenDirs.has(dataDir)) continue; // MySQL and MariaDB share a folder: one line for it
      seenDirs.add(dataDir);
      found.push({ engine: e.engine, dataDir, running, newest: null });
    }
  }
  for (const f of found) {
    if (testData.includes(f.engine)) continue;
    let newest = f.newest;
    if (newest === null && f.dataDir) {
      const n = await newestOf(f.dataDir, walker);
      if (n.why) {
        if (f.running !== false) notChecked.push({ where: tilde(f.dataDir), why: `${f.engine} runs here, and ${n.why}` });
        continue;
      }
      newest = n.at;
    }
    // Without a process listing: a data folder that changed lately is taken as a server in use.
    const running = f.running === null ? newest !== null && now() - newest < RECENT_MS : f.running;
    if (!running) continue;
    const dump = await newestDump(dir, f.engine, walker);
    if (newest !== null && dump.at >= newest) continue;
    if (!dump.done) {
      notChecked.push({ where: tilde(path.join(dir, 'database', f.engine)), why: 'too many files to find its newest dump within the budget' });
      continue;
    }
    const where = f.dataDir ? tilde(f.dataDir) : f.engine;
    items.push({
      id: `database:${where}`,
      kind: 'database',
      where,
      what: dump.at ? `${f.engine} runs here and its newest dump in the workspace is older than its data` : `${f.engine} runs here and has no dump in the workspace`,
      size: null,
      todo: `put a dump of it in ${tilde(path.join(dir, 'database', f.engine))} with the engine's own dump tool, or, if it holds test data only, mark it:  hoprig pc leave --test-data ${f.engine}`,
      command: `hoprig pc leave --test-data ${f.engine}`,
      pushable: false,
    });
  }
  return { items, notChecked };
}
