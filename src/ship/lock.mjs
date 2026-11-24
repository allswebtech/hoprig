// One go-live of a project at a time, also from two dashboards (docs/GO-LIVE.md): a lock file made
// exclusively in the repository's git folder (never its working tree, so git and the project never see it), holding
// the pid and the identity (pid plus start, src/procid.mjs) of the process that holds it. A lock whose process is
// shown to be gone is taken over; one that cannot be told is left alone (a lock kept is the safe side). The step's
// journal (journal.mjs) lies beside it.
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { filedProcess, system } from '../procid.mjs';
import { capture } from '../setup/system.mjs';

export const LOCK_NAME = 'hoprig-ship.lock';
const busy = (message) => Object.assign(new Error(message), { status: 409, details: { code: 'busy' } });

/** The git folder shared by all worktrees of the repository at `top` (a real path). */
export async function gitFolder(top, run = capture) {
  const r = await gitRead(top, ['rev-parse', '--git-common-dir'], { run });
  if (!r.ok) throw Object.assign(new Error('git cannot say where this repository keeps its own files'), { status: 409 });
  return fs.realpathSync(path.resolve(top, r.stdout.trim()));
}

function readLock(file) {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    return r && Number.isInteger(r.pid) ? r : { broken: true };
  } catch (e) {
    return e.code === 'ENOENT' ? null : { broken: true };
  }
}

/** Who holds the lock in `folder`: null (nobody), or { pid, proc, what, at, mine, gone }. */
export function lockHolder(folder, { ident = system, name = LOCK_NAME } = {}) {
  const file = path.join(folder, name);
  const r = readLock(file);
  if (!r) return null;
  if (r.broken) {
    // Half written by a process killed in the middle: after a minute nobody is writing it any more.
    let old = false;
    try {
      old = Date.now() - fs.statSync(file).mtimeMs > 60_000;
    } catch {
      return null;
    }
    return { pid: null, proc: null, what: '', at: null, mine: false, gone: old };
  }
  const mine = r.pid === process.pid && (!r.proc || r.proc === ident.self());
  return { ...r, mine, gone: !mine && filedProcess(file, r, { ident }) === false };
}

/**
 * Take the lock in `folder` for `what` ("go live", "put together"). → a release function. Refused (409) while
 * another living process holds it; a lock of a process shown to be gone is taken over.
 */
export function takeLock(folder, what, { ident = system, name = LOCK_NAME } = {}) {
  const file = path.join(folder, name);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const rec = JSON.stringify({ pid: process.pid, proc: ident.self(), what, at: new Date().toISOString() });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, `${rec}\n`, { flag: 'wx', mode: 0o600 });
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const now = readLock(file);
        if (now && now.pid === process.pid) fs.rmSync(file, { force: true });
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const h = lockHolder(folder, { ident, name });
    if (h && !h.gone) throw busy(h.mine ? `this dashboard is already doing "${h.what}" for this project` : `another Hoprig (process ${h.pid ?? 'unknown'}) is doing "${h.what || 'a go-live'}" for this project: it runs one at a time`);
    // Gone: away with its lock, then make ours exclusively again (another taker may win that race; then we lose).
    fs.rmSync(file, { force: true });
  }
  throw busy('another Hoprig took the lock of this project at the same moment');
}
