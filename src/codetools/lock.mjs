// A lock between processes on one computer: a folder (making one is atomic everywhere) with the holder's pid in it.
// A holder that died leaves the folder behind; it counts as free again. Used for a tool's server (one start at a
// time, ./servers.mjs) and for a tool's install folder (one npm at a time, ./npmtool.mjs): the dashboard, Setup and
// the command line are different processes.
import fs from 'node:fs';
import path from 'node:path';

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Take the lock `dir`. Waits up to `waitMs` (0: one try). Resolves to a release function, or null when another
 * living process holds it. A lock older than `staleMs` is taken over whoever holds it.
 */
export async function takeLock(dir, { waitMs = 0, staleMs = 90_000 } = {}) {
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      return () => fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const owner = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
        const old = Date.now() - fs.statSync(dir).mtimeMs > staleMs;
        if (old || (Number.isInteger(owner) && owner > 0 && !alive(owner))) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* gone meanwhile, or its pid not written yet */
      }
      if (Date.now() >= until) {
        if (!fs.existsSync(dir)) continue; // freed just now: one more try
        return null;
      }
      await sleep(150);
    }
  }
}

/** Does a living process hold the lock `dir` right now (and not for longer than `staleMs`)? */
export function held(dir, { staleMs = 90_000 } = {}) {
  try {
    const owner = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
    return alive(owner) && Date.now() - fs.statSync(dir).mtimeMs <= staleMs;
  } catch {
    return false;
  }
}
