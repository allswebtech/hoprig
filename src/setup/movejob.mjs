// The job file of a move started from the page (`hoprig move-to-user --yes --job FILE`, moveroutes.mjs): the move
// runs in a process of its own, because it stops root's dashboard, which must not end the move with it. The file holds
// { running, pid, startedAt, lines, result }, written whole at each line (a reader never sees half a file). When the
// move switched, the file is also put into the user's state folder, so the user's dashboard on the same port shows
// the move's last lines.
import fs from 'node:fs';
import path from 'node:path';
import { replaceIn } from './movesafe.mjs';

export const JOB_FILE = 'move-job.json';
export const LINES_MAX = 2000;

/** The line added when the move's process is gone without writing its end (killed, out of memory, a reboot). */
export const LOST_LINE = 'The move ended without a result (its process is gone: killed, out of memory, or a reboot). The lines above say how far it came; the page can look again and start it again.';

/** A job that is only written, before its process wrote anything, counts as starting this long. */
export const START_MS = 2 * 60_000;

const aliveDefault = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // root's move, read by the user's dashboard after the switch
  }
};

/**
 * Read a job file, or null. A job that says it runs while its process is gone (or that never got a process within
 * START_MS) is read as ended without a result, with LOST_LINE. `alive` and `now` are handed in by tests.
 */
export function readJob(file, { alive = aliveDefault, now = Date.now } = {}) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!j || !Array.isArray(j.lines)) return null;
  if (j.running === true) {
    const gone = Number.isInteger(j.pid) && j.pid > 0 ? !alive(j.pid) : !(now() - Number(j.startedAt) < START_MS);
    if (gone) return { ...j, running: false, result: { ok: false, lost: true }, lines: [...j.lines, LOST_LINE] };
  }
  return j;
}

/**
 * The job as the page sees it at once, written whole before the move's process starts (it then writes its own):
 * running, no lines, no result. It replaces an earlier move's file, so its old lines and result are not shown again.
 */
export function startJob(file, { now = Date.now } = {}) {
  writeWhole(file, { running: true, pid: null, startedAt: now(), lines: [], result: null });
}

function writeWhole(file, j, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(j)}\n`, { mode });
  fs.renameSync(tmp, file);
}

/**
 * A writer for `file`: line(text), end(result), and mirror(userState, user): from then on each write also goes to the
 * user's state folder, owned by the user (after the switch the user's dashboard answers on the port and shows it).
 */
export function jobWriter(file, { now = Date.now, chown = fs.lchownSync } = {}) {
  const j = { running: true, pid: process.pid, startedAt: now(), lines: [], result: null };
  let also = null;
  const write = () => {
    writeWhole(file, j);
    if (also) {
      try {
        // The user's home, while the user's dashboard runs: never through a link, a new name each time.
        const own = (p) => chown(p, also.user.uid, also.user.gid ?? also.user.uid);
        let home = also.user.home;
        if (!home) {
          home = path.dirname(also.file); // no home known (a caller of its own): only its folder, made as before
          fs.mkdirSync(home, { recursive: true, mode: 0o700 });
        }
        replaceIn(home, also.file, `${JSON.stringify(j)}\n`, { mode: 0o600, own });
      } catch {
        /* the user's state folder is not there: root's file still has it */
      }
    }
  };
  write();
  return {
    line(l) {
      j.lines.push(String(l).slice(0, 1000));
      if (j.lines.length > LINES_MAX) j.lines.splice(0, j.lines.length - LINES_MAX);
      write();
    },
    end(result) {
      Object.assign(j, { running: false, result });
      write();
    },
    mirror(userState, user) {
      also = { file: path.join(userState, JOB_FILE), user };
      write();
    },
    view: () => j,
  };
}
