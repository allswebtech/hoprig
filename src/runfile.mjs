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
// that died; a clock that was set back), is taken over: moved aside under the taker's own name, one step that only
// one waiter can make, and dropped only when the moved file is the very one judged stale (else it is put back).
// A holder removes the lock only while it still holds its word. After WAIT_MS without it the change is made all the
// same: an event is never dropped for it, and the hook stays far inside the 5 seconds Claude Code gives it.
const STALE_MS = 1000;
const WAIT_MS = 1500;
const nap = new Int32Array(new SharedArrayBuffer(4));
const lockFile = (file) => `${file}.lock`;
let taken = 0;

/** Take the record's lock; returns its release. Exported for the tests. */
export function lockRun(file) {
  const l = lockFile(file);
  const me = `${process.pid}.${Date.now()}.${++taken}.${Math.random().toString(36).slice(2)}`;
  const until = Date.now() + WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(l, me, { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (fs.readFileSync(l, 'utf8') === me) fs.rmSync(l, { force: true });
        } catch {
          /* gone already */
        }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') return () => {}; // no lock can be made here (the folder is gone): as before
    }
    try {
      const was = fs.statSync(l);
      if (Math.abs(Date.now() - was.mtimeMs) > STALE_MS) {
        const aside = `${l}.${me}`;
        fs.renameSync(l, aside); // throws when another waiter moved it first
        const moved = fs.statSync(aside);
        if (moved.ino !== was.ino || moved.mtimeMs !== was.mtimeMs) {
          try {
            fs.linkSync(aside, l); // a fresh lock made in between: its holder keeps it
          } catch {
            /* yet another was made: that one stands */
          }
        }
        fs.rmSync(aside, { force: true });
        continue;
      }
    } catch {
      continue; // released or moved between the steps
    }
    if (Date.now() > until) return () => {};
    Atomics.wait(nap, 0, 0, 2 + Math.floor(Math.random() * 6));
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
