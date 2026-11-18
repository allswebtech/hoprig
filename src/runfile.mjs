// Reading and writing one run record (see runs.mjs for what it holds). Kept apart from runs.mjs and free of other
// imports on purpose: the hook (hook.mjs) is started by Claude Code many times per session, and every module it
// loads is time Claude waits.
import fs from 'node:fs';

export function readRun(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Replace the record in one step (a reader never sees half a file). */
export function writeRun(file, run) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Two writers at once (the hooks of the main agent and of a subagent start side by side; the launcher) would each read
// the record, change it and write it back, and the later write would drop the earlier change. So a change is made
// under a short lock: a file created only if it is not there (one step on every system), holding its holder's own
// word. A holder needs a millisecond. A lock whose time is more than STALE_MS from now, either way (left by a process
// that died; a clock that was set back), is taken over, and never by moving it away: while the lock's name stands
// empty a newcomer creates a lock of its own there, and a waiter that judged the old lock stale a moment earlier then
// moves the newcomer's lock away and holds as well (two holders, one change lost: seen on a slow CI runner). A take-over
// is made under a second lock (<lock>.takeover, created the same way, one taker at a time), and only when the lock is
// still the very file judged stale: the taker's own word is then renamed over it in one step, so the name is never
// empty. A takeover lock left by a taker that died is removed once it is STALE_MS old.
// A holder removes the lock only while it still holds its word. After WAIT_MS without it the change is made all the
// same: an event is never dropped for it, and the hook stays far inside the 5 seconds Claude Code gives it.
const STALE_MS = 1000;
const WAIT_MS = 1500;
const nap = new Int32Array(new SharedArrayBuffer(4));
const lockFile = (file) => `${file}.lock`;
const stale = (st) => Math.abs(Date.now() - st.mtimeMs) > STALE_MS;
let taken = 0;

/**
 * Take the record's lock; returns its release, whose `held` says whether the lock was had (false: given up after
 * WAIT_MS). Exported for the tests, as is `pause(step)`: called at the steps of a take-over, to widen them.
 */
export function lockRun(file, { pause = () => {} } = {}) {
  const l = lockFile(file);
  const me = `${process.pid}.${Date.now()}.${++taken}.${Math.random().toString(36).slice(2)}`;
  const until = Date.now() + WAIT_MS;
  const release = () => {
    try {
      if (fs.readFileSync(l, 'utf8') === me) fs.rmSync(l, { force: true });
    } catch {
      /* gone already */
    }
  };
  release.held = true;
  const without = () => {};
  without.held = false;
  for (;;) {
    try {
      fs.writeFileSync(l, me, { flag: 'wx', mode: 0o600 });
      return release;
    } catch (e) {
      if (e.code !== 'EEXIST') return without; // no lock can be made here (the folder is gone): as before
    }
    try {
      const was = fs.statSync(l);
      if (stale(was) && takeOver(l, was, me, pause)) return release;
    } catch {
      /* released or changed between the steps: try again */
    }
    if (Date.now() > until) return without;
    Atomics.wait(nap, 0, 0, 2 + Math.floor(Math.random() * 6));
  }
}

// Replace the stale lock `l` (as `was` saw it) by one holding `me`, under the takeover lock. → true when it is ours.
function takeOver(l, was, me, pause) {
  const t = `${l}.takeover`;
  try {
    fs.writeFileSync(t, me, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code === 'EEXIST') {
      try {
        if (stale(fs.statSync(t))) fs.rmSync(t, { force: true }); // its taker died
      } catch {
        /* gone already */
      }
    }
    return false;
  }
  const mine = `${l}.${me}`;
  try {
    const now = fs.statSync(l);
    if (now.ino !== was.ino || now.mtimeMs !== was.mtimeMs || !stale(now)) return false; // released, or taken over
    pause('judged');
    fs.writeFileSync(mine, me, { mode: 0o600 });
    fs.renameSync(mine, l);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(mine, { force: true });
    try {
      if (fs.readFileSync(t, 'utf8') === me) fs.rmSync(t, { force: true });
    } catch {
      /* gone already */
    }
  }
}

/**
 * Change the record under its lock: `change(run)` returns the new record, or the same object for "no change" (then
 * nothing is written). Returns the record as it stands, or null when the file is gone (the launcher cleaned up).
 */
export function changeRun(file, change) {
  const release = lockRun(file);
  try {
    const run = readRun(file);
    if (!run) return null;
    const next = change(run);
    if (next && next !== run) writeRun(file, next);
    return next || run;
  } finally {
    release();
  }
}

/**
 * The run's "tell me about tool calls" mark (hook.mjs: wantsToolNews). Claude Code's shell looks for this file
 * before it starts the hook after a batch of tool calls, so a session that is plainly working starts nothing.
 */
export const watchFile = (file) => `${file}.watch`;
