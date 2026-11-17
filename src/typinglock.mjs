// The moment a coding tool ends, seen from two processes. The dashboard types text for a coding tool on behalf of
// someone other than the owner (src/server/typing.mjs) only while the tool's run record stands and its launcher holds
// the terminal in front. The launcher removes that record once the tool has ended, and then the terminal's shell gets
// the terminal back. Without an agreement, text checked a moment before the record went lands a moment after it, in
// the terminal's input, and the shell reads its lines as commands once the launcher is gone.
//
// One lock file per run record settles it:
//   the dashboard   takes the lock, reads the record again, types, lets go (whileTyping)
//   the launcher    once its tool has ended: takes the lock, removes the record, lets go, then reads and throws away
//                   whatever stands in its terminal's input before it ends (endRun)
// So a text either goes in while the record stands, and the launcher throws it away if its tool did not read it, or it
// finds no record and nothing is typed. The lock is a file made with "wx" (only one maker wins), next to the record.
import fs from 'node:fs';
import { removeRun } from './runs.mjs';

const STALE_MS = 10_000; // a lock older than this was left by a process that ended while it held it
const WAIT_MS = 3000; // how long either side waits for the other
const SETTLE_MS = 200; // how long the launcher reads its terminal's input after the record went

export const lockOf = (runFile) => `${runFile}.typing`;

/** true when this call made the lock; false when someone holds it. Throws when it cannot be made at all (no folder). */
function take(lock) {
  try {
    fs.closeSync(fs.openSync(lock, 'wx', 0o600));
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) fs.rmSync(lock, { force: true });
    } catch {
      /* gone meanwhile */
    }
    return false;
  }
}

const letGo = (lock) => fs.rmSync(lock, { force: true });

/**
 * The dashboard's side: run `fn` (which reads the record again and types) while holding the lock of `runFile`. A
 * lock held by someone else longer than WAIT_MS: a 409 error, nothing typed. No runs folder: the error of fs, with
 * its code (the caller reads it as "no record").
 */
export async function whileTyping(runFile, fn, { wait = WAIT_MS } = {}) {
  const lock = lockOf(runFile);
  for (const end = Date.now() + wait; !take(lock); await new Promise((r) => setTimeout(r, 20))) {
    if (Date.now() > end) throw Object.assign(new Error('Nothing was typed: another message is being typed into this session right now. Send it again in a moment'), { status: 409 });
  }
  try {
    return await fn();
  } finally {
    letGo(lock);
  }
}

/**
 * The launcher's side, synchronous (its own end): remove record `runFile` with `remove` under the lock. A typist
 * that holds the lock finishes first; after WAIT_MS the record goes anyway (a typist that hangs does not keep a
 * terminal from its shell).
 */
export function removeLocked(runFile, remove = removeRun) {
  const lock = lockOf(runFile);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let mine = false;
  for (const end = Date.now() + WAIT_MS; ; Atomics.wait(pause, 0, 0, 10)) {
    try {
      mine = take(lock);
    } catch {
      break; // no runs folder: no record, nobody to agree with
    }
    if (mine || Date.now() > end) break;
  }
  try {
    remove(runFile);
  } finally {
    if (mine) letGo(lock);
  }
}

/**
 * Read the terminal's input for `ms` and throw it away: what a typist typed for the coding tool that the tool did not
 * read, and that the shell would otherwise read as commands once this launcher ends. Raw, so a line without its
 * Enter goes too. Only where stdin is a terminal; not on Windows (no shell takes the terminal back there: the
 * dashboard's built-in terminal starts a new one).
 */
export function settleInput(ms = SETTLE_MS, { stdin = process.stdin, platform = process.platform } = {}) {
  if (platform === 'win32' || !stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    const drop = () => {};
    try {
      stdin.setRawMode(true);
    } catch {
      return resolve();
    }
    stdin.on('data', drop);
    stdin.resume();
    setTimeout(() => {
      stdin.off('data', drop);
      stdin.pause();
      try {
        stdin.setRawMode(false);
      } catch {
        /* the terminal is gone */
      }
      resolve();
    }, ms);
  });
}

/** The launcher's end of a run that had the terminal: the record goes under the lock, then the input is settled. */
export async function endRun(runFile) {
  removeLocked(runFile);
  await settleInput();
}
