// One writer of a Work file at a time, across processes (the dashboard, the command, later Tia's jobs): a lock file
// in Hoprig's state folder, never next to the Work file, so git never sees it.
//
// The lock names its process the way the run records do (src/procid.mjs: the pid and when that process started), so
// a lock is judged by who holds it, not by its age:
//   - its process is shown to be gone (the pid ended, or another process has it now): the lock is stale and taken;
//   - its process is shown to be the one that wrote it: it is never taken, however long it is held;
//   - it cannot be told (the system could not be asked; a lock written by an older Hoprig, which named only a pid):
//     it is stale once its holder has not refreshed it for UNPROVEN_STALE_MS. A holder refreshes its lock every
//     HEARTBEAT_MS, so only a holder that stopped running goes that long without.
// A release removes the lock only while it is still this holder's own (its token), never one another process holds
// now. The lock is held only around reading and writing the file and making a commit, never across the network.
//
// The same kind of lock, one per git repository (keyed by its real path), is shared by a save of the Work file and
// the workspace's upkeep in the AI brain (its map commit, its fetch and fast-forward, its push): a save holds it from
// its fetch to its send, and the upkeep skips its round while a save holds it (src/automation/workspacesync.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { filedProcess, system } from '../procid.mjs';

export const LOCK_WAIT_MS = 15_000;
// How long a save waits for the repository's lock (the upkeep's round is short) before it says so.
export const REPO_WAIT_MS = 8_000;
export const HEARTBEAT_MS = 5_000;
export const UNPROVEN_STALE_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where the lock of a file lives: Hoprig's state folder, named by the file's path. */
export const lockFile = (file) => path.join(stateDir(), 'work-locks', `${crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 24)}.lock`);

/** Where the lock of a git repository lives: Hoprig's state folder, named by the repository's real path. */
export function repoLockFile(top) {
  let real = path.resolve(top);
  try {
    real = fs.realpathSync(top);
  } catch {
    /* not there (any more): its path as given */
  }
  return path.join(stateDir(), 'repo-locks', `${crypto.createHash('sha256').update(real).digest('hex').slice(0, 24)}.lock`);
}

const held = new Set(); // the tokens of the locks this process holds now

/** The record in a lock file: an object, a pid (an older Hoprig's), null (unreadable or half there), undefined (none). */
function readLock(lock) {
  let text;
  try {
    text = fs.readFileSync(lock, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? undefined : null;
  }
  try {
    const v = JSON.parse(text);
    if (Number.isInteger(v)) return { pid: v, proc: null };
    return v && typeof v === 'object' && Number.isInteger(v.pid) ? v : null;
  } catch {
    return null;
  }
}

/** Whether the lock (its record `rec`) may be taken over. */
function isStale(lock, rec) {
  let age;
  try {
    age = Date.now() - fs.statSync(lock).mtimeMs;
  } catch {
    return false; // gone meanwhile: the next try takes it
  }
  if (!rec) return age > UNPROVEN_STALE_MS;
  // This process's own pid: stale only when no change of this process holds it (one that ended without its release).
  if (rec.pid === process.pid) return !held.has(rec.token);
  const ours = filedProcess(lock, rec);
  if (ours === false) return true;
  if (ours === true) return false;
  return age > UNPROVEN_STALE_MS;
}

/**
 * Take a stale lock away. It is moved aside under a name of this process first: of two processes that judged the same
 * stale lock, only one rename succeeds; when what was moved is not the lock that was judged (another took it
 * meanwhile), it is put back.
 */
function takeOver(lock, judged) {
  const aside = `${lock}.${crypto.randomBytes(6).toString('hex')}.stale`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return false;
  }
  const moved = readLock(aside);
  if (JSON.stringify(moved) !== JSON.stringify(judged)) {
    try {
      fs.linkSync(aside, lock);
    } catch {
      /* a new lock is there already */
    }
  }
  fs.rmSync(aside, { force: true });
  return true;
}

const fileBusy = () => Object.assign(new Error('another change to the Work file is still being written; try again in a moment'), { status: 409, code: 'busy' });

/** Take the lock at `lock`; `busy(rec)`: the error when it is still held after `wait` ms. `who`: kept in the record. */
async function takeLock(lock, wait, { who = null, busy = fileBusy } = {}) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const token = crypto.randomBytes(12).toString('hex');
  // Written whole first, then linked into place: a lock never exists half written, and the link fails when one exists.
  const tmp = `${lock}.${token}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, proc: system.self(), token, at: new Date().toISOString(), ...(who ? { who } : {}) }));
  const until = Date.now() + wait;
  try {
    for (;;) {
      try {
        fs.linkSync(tmp, lock);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      // A stale lock is taken over before any wait is counted: also a caller that does not wait gets it.
      const rec = readLock(lock);
      if (rec !== undefined && isStale(lock, rec) && takeOver(lock, rec)) continue;
      if (Date.now() >= until) throw busy(rec);
      await sleep(50);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  held.add(token);
  const mine = () => {
    const rec = readLock(lock);
    return !!rec && rec.token === token;
  };
  const beat = setInterval(() => {
    try {
      if (mine()) fs.utimesSync(lock, new Date(), new Date());
    } catch {
      /* gone: the release finds it so */
    }
  }, HEARTBEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    held.delete(token);
    if (mine()) fs.rmSync(lock, { force: true });
  };
}

const queues = new Map(); // file → the promise of the last change in this process

/**
 * Run `fn` as the only writer of `file`: in this process (a queue) and across processes (the lock). `wait`: how long
 * to wait for another process's lock before answering "busy" (409).
 */
export function withLock(file, fn, { wait = LOCK_WAIT_MS } = {}) {
  const key = path.resolve(file);
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(async () => {
    const release = await takeLock(lockFile(file), wait);
    try {
      return await fn();
    } finally {
      release();
    }
  });
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

/**
 * Take the lock of the git repository at `top` (no queue: a second taker in this process waits like another
 * process). `who`: "save" or "upkeep", for the words of the one that finds it held. → release(); throws 409 with
 * code "syncing" (the upkeep holds it) or "busy" (another save) after `wait` ms.
 */
export function takeRepoLock(top, { wait = REPO_WAIT_MS, who = 'save' } = {}) {
  return takeLock(repoLockFile(top), wait, {
    who,
    busy: (rec) => (rec && rec.who === 'upkeep'
      ? Object.assign(new Error('the workspace is being synced: Save again in a moment'), { status: 409, code: 'syncing' })
      : Object.assign(new Error('another save of the Work list is running: Save again in a moment'), { status: 409, code: 'busy' })),
  });
}

/** The repository's lock without waiting: release(), or null while another holds it. */
export async function tryRepoLock(top, { who = 'upkeep' } = {}) {
  try {
    return await takeRepoLock(top, { wait: 0, who });
  } catch (e) {
    if (e.status === 409) return null;
    throw e;
  }
}
