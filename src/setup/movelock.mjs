// One move at a time on a server. The page's move (a process of its own, moveroutes.mjs), a terminal's
// `hoprig move-to-user --yes` and the hub's move over SSH all run movecli.mjs, which takes this lock before it looks:
// one file in root's state folder, made with O_EXCL, that holds the pid of the move that runs. Two moves at once would
// copy into the same home and write one mark and one job file. A lock whose process is gone (killed, a reboot) is
// taken over. The pid is written to a file of its own first and then linked into place, so the lock file never exists
// empty; one that is empty anyway (an older Hoprig, a crash) counts as held while it is young. Not covered: two moves
// that both find the same dead lock at the same moment (one may remove the other's new file); a pid of a dead move
// that the system gave to another process, only where the lock holds no identity beside the pid (an older Hoprig
// wrote the pid alone) or the system cannot tell who has that pid now (the line then names the file to remove): a
// lock with the identity of its move is taken over once that pid runs another process; a state folder whose file
// system has no hard links (the link then fails and the move does not start).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { freshAfter, sameProcess, system } from '../procid.mjs';
import { BUSY, patiently } from '../replacefile.mjs';

// Windows: a name whose removal is not through yet (another program, a virus scan, still holds the file a moment)
// refuses a new file there, and a removal of it, with EPERM (or EACCES, EBUSY): something is there, as EEXIST says,
// and it is waited for and looked at again, for up to PENDING_MS. Elsewhere those errors are refusals, as before.
const PENDING_MS = 1000;
const heldAt = (e, platform = process.platform) => e.code === 'EEXIST' || (platform === 'win32' && BUSY.has(e.code));
const nap = new Int32Array(new SharedArrayBuffer(4));

export const LOCK_FILE = 'move.lock';
/** An empty lock file younger than this is a move that is still writing its pid (an older Hoprig made it that way). */
export const YOUNG_EMPTY_MS = 60_000;
/** A move's own file beside the lock (`.move.lock.<pid>.<hex>`), before it is linked into place. */
const LEFTOVER_RE = /^\.move\.lock\.(\d+)\.[0-9a-f]+$/;

const aliveDefault = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * Who holds the lock in `dir`: { pid }, with pid null for a lock file that is still empty and young; or null when none
 * holds it (no file, its process is gone, or it is empty and old). The file holds "<pid> <identity>" (procid.mjs: pid
 * and start): a pid another process has now (Windows hands one out again at once) is a move that ended; an identity
 * that cannot be told counts as held. A file of an older version holds the pid alone: its pid alive, as before (a move
 * copies a home: no fixed length bounds its age). The identity is asked only here, once, by the move command.
 */
export function lockHolder(dir, { alive = aliveDefault, now = Date.now, ident = system } = {}) {
  const file = path.join(dir, LOCK_FILE);
  let text;
  let mtime;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (text === '') return Math.abs(now() - mtime) < YOUNG_EMPTY_MS ? { pid: null } : null;
  const [first, proc] = text.split(/\s+/);
  const pid = Number(first);
  if (!(Number.isInteger(pid) && pid > 0 && alive(pid))) return null;
  if (proc && sameProcess(proc, ident.of([pid], { after: freshAfter() }).get(pid)) === false) return null; // a fresh identity (procid.mjs freshAfter)
  return { pid };
}

/** The line said when another move holds the lock (its pid, or none when the lock file does not name one yet). */
export const HELD_LINE = (pid, dir) => `Another move runs on this server now${pid ? ` (process ${pid})` : ''}, so this one does not start. Wait until it ends, then run the move again. If no move runs, remove ${path.join(dir, LOCK_FILE)}.`;

/**
 * The files of its own (`.move.lock.<pid>.<hex>`) that a move killed between writing its pid and linking it left: each
 * whose process is gone is removed, so they do not pile up. One of a move that runs is its own and stays.
 */
function clearLeftovers(dir, alive) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const m = LEFTOVER_RE.exec(n);
    if (m && !alive(Number(m[1]))) {
      try {
        patiently(() => fs.rmSync(path.join(dir, n), { force: true }));
      } catch {
        /* a leftover another process touches still: the next move removes it */
      }
    }
  }
}

/**
 * Take the lock in `dir` for `pid`. → { ok: true, release } or { ok: false, pid } (the holder). `release()` removes the
 * file only while it is still this move's.
 */
export function takeLock(dir, { pid = process.pid, alive = aliveDefault, now = Date.now, platform = process.platform, ident = system } = {}) {
  const file = path.join(dir, LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  clearLeftovers(dir, alive);
  // A move that holds the lock answers at once (its pid alive); a name still held a moment (heldAt, not EEXIST) is
  // looked at again for up to PENDING_MS.
  const until = Date.now() + PENDING_MS;
  let pending = false;
  for (let i = 0; i < 2 || (pending && Date.now() < until); i += 1) {
    if (i >= 2) Atomics.wait(nap, 0, 0, 20);
    // The pid in a file of its own, then a link: the lock file appears whole or not at all (link fails on EEXIST).
    const own = path.join(dir, `.${LOCK_FILE}.${pid}.${crypto.randomBytes(4).toString('hex')}`);
    let linked = false;
    try {
      const proc = pid === process.pid ? ident.self() : null;
      fs.writeFileSync(own, `${pid}${proc ? ` ${proc}` : ''}\n`, { mode: 0o600, flag: 'wx' });
      try {
        fs.linkSync(own, file);
        linked = true;
      } catch (e) {
        if (!heldAt(e, platform)) throw e;
        if (e.code !== 'EEXIST') pending = true;
      }
    } finally {
      try {
        fs.rmSync(own, { force: true });
      } catch {
        /* a file of its own name left beside the lock: never an error of a lock taken */
      }
    }
    if (linked) {
      return {
        ok: true,
        release: () => {
          try {
            if (fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0] === String(pid)) patiently(() => fs.rmSync(file, { force: true }), platform);
          } catch {
            /* gone already */
          }
        },
      };
    }
    if (pending && !fs.existsSync(file)) continue; // the held name is not a lock: nobody to ask, look again
    const holder = lockHolder(dir, { alive, now, ident });
    if (holder) return { ok: false, pid: holder.pid };
    try {
      fs.rmSync(file, { force: true }); // its move is gone: taken over
    } catch (e) {
      if (!heldAt(e, platform)) throw e;
      pending = true;
    }
  }
  return { ok: false, pid: lockHolder(dir, { alive, now, ident })?.pid ?? null };
}
