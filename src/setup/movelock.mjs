// One move at a time on a server. The page's move (a process of its own, moveroutes.mjs), a terminal's
// `hoprig move-to-user --yes` and the hub's move over SSH all run movecli.mjs, which takes this lock before it looks:
// one file in root's state folder, made with O_EXCL, that holds the pid of the move that runs. Two moves at once would
// copy into the same home and write one mark and one job file. A lock whose process is gone (killed, a reboot) is
// taken over. The pid is written to a file of its own first and then linked into place, so the lock file never exists
// empty; one that is empty anyway (an older Hoprig, a crash) counts as held while it is young. Not covered: two moves
// that both find the same dead lock at the same moment (one may remove the other's new file); a pid of a dead move
// that the system gave to another process (the line then names the file to remove); a state folder whose file system
// has no hard links (the link then fails and the move does not start).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
 * holds it (no file, its process is gone, or it is empty and old).
 */
export function lockHolder(dir, { alive = aliveDefault, now = Date.now } = {}) {
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
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? { pid } : null;
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
    if (m && !alive(Number(m[1]))) fs.rmSync(path.join(dir, n), { force: true });
  }
}

/**
 * Take the lock in `dir` for `pid`. → { ok: true, release } or { ok: false, pid } (the holder). `release()` removes the
 * file only while it is still this move's.
 */
export function takeLock(dir, { pid = process.pid, alive = aliveDefault, now = Date.now } = {}) {
  const file = path.join(dir, LOCK_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  clearLeftovers(dir, alive);
  for (let i = 0; i < 2; i += 1) {
    // The pid in a file of its own, then a link: the lock file appears whole or not at all (link fails on EEXIST).
    const own = path.join(dir, `.${LOCK_FILE}.${pid}.${crypto.randomBytes(4).toString('hex')}`);
    let linked = false;
    try {
      fs.writeFileSync(own, `${pid}\n`, { mode: 0o600, flag: 'wx' });
      try {
        fs.linkSync(own, file);
        linked = true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    } finally {
      fs.rmSync(own, { force: true });
    }
    if (linked) {
      return {
        ok: true,
        release: () => {
          try {
            if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.rmSync(file, { force: true });
          } catch {
            /* gone already */
          }
        },
      };
    }
    const holder = lockHolder(dir, { alive, now });
    if (holder) return { ok: false, pid: holder.pid };
    fs.rmSync(file, { force: true }); // its move is gone: taken over
  }
  return { ok: false, pid: lockHolder(dir, { alive, now })?.pid ?? null };
}
