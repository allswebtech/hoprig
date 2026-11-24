// One command of a project's check or go-live: a list of words started without a shell, in a folder, with a time
// limit. At the limit the command and everything it started (its own process group) get SIGTERM, then SIGKILL.
// What it prints goes to a file of its own in the state folder (mode 600), never to a pipe: a server it starts in the
// background without redirecting its output inherits that file and goes on writing to it after the command ended,
// where a pipe that is let go would end it (EPIPE). Only the last lines are kept, then the file is removed. When
// something of the command's process group still runs then, a small keeper (outkeeper.mjs) holds the removed file and
// empties it whenever it is past KEEP_BYTES, until that group is gone: what a server prints is bounded, never a file
// that grows unseen until the disk is full. `low`: at low priority (nice 10, where there is nice). `prefix`:
// the owner's limiter (allow.mjs limiterWords), put before the command's own words.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../paths.mjs';
import { alive, sameProcess, system } from '../procid.mjs';
import { forInstalls, withoutProviderKeys } from '../secretenv.mjs';
import { which } from '../setup/system.mjs';

export const LAST_LINES = 40;
const KEEP_BYTES = 64 * 1024;
const GRACE_MS = 5000;
const outDir = () => path.join(stateDir(), 'ship', 'output');
const KEEPER = fileURLToPath(new URL('./outkeeper.mjs', import.meta.url));

/** Whether a process of the group `pgid` still runs. */
function groupLives(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Hand the output file to a keeper while what the command left in its group may still write into it. */
function keepBounded(file, pgid) {
  if (process.platform === 'win32' || !groupLives(pgid)) return;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r+');
    const k = spawn(process.execPath, [KEEPER, String(pgid), String(KEEP_BYTES)], { stdio: ['ignore', 'ignore', 'ignore', fd], detached: true, env: { PATH: process.env.PATH || '' }, windowsHide: true });
    k.on('error', () => {});
    k.unref();
  } catch {
    /* no keeper: the file is removed all the same */
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** The last KEEP_BYTES of the file `file` as text ('' when it cannot be read). */
function tailOf(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const b = Buffer.alloc(Math.min(size, KEEP_BYTES));
      fs.readSync(fd, b, 0, b.length, size - b.length);
      return b.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** A new output file (mode 600, made exclusively); the files of a Hoprig that ended before it could remove them go. */
function newOutput() {
  fs.mkdirSync(outDir(), { recursive: true, mode: 0o700 });
  for (const n of fs.readdirSync(outDir())) {
    const pid = Number(/^(\d+)-[0-9a-f]+\.log$/.exec(n)?.[1]);
    if (pid && pid !== process.pid && !alive(pid)) fs.rmSync(path.join(outDir(), n), { force: true });
  }
  const file = path.join(outDir(), `${process.pid}-${crypto.randomBytes(6).toString('hex')}.log`);
  // For appending: a writer the keeper empties the file under goes on at its start, not past a hole.
  return { file, fd: fs.openSync(file, 'ax', 0o600) };
}

/**
 * → Promise<{ ok, code, signal, timedOut, ms, last (the last lines, raw), error? }>. `started(child)` for the pid.
 * `branches`: the command runs code from task branches (a check). `endGroup`: when the command's own process has
 * ended, what it left running in its process group is ended too (a check; never a go-live, whose server must live on).
 */
export function runCommand(run, { cwd, minutes = 10, env: given = process.env, low = false, prefix = null, branches = false, endGroup = false, started = () => {} } = {}) {
  // Neither gets a provider's key (also one under a name of the provider's own) or Hoprig's own tokens (secretenv.mjs),
  // whoever starts it (the dashboard, the command line, the helper). A check runs code from task branches that nobody
  // has looked at yet: it loses GitHub's tokens too, as an install does. A go-live runs the project's own confirmed
  // scripts, which may fetch from a private repository: they keep them.
  const env = branches ? forInstalls(given) : withoutProviderKeys(given);
  const words = [...(prefix || []), ...run];
  const nice = low && process.platform !== 'win32' && which('nice', env) ? ['nice', '-n', '10'] : [];
  const argv = [...nice, ...words];
  const t0 = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    let child;
    let out = null;
    try {
      out = newOutput();
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', out.fd, out.fd], detached: process.platform !== 'win32', windowsHide: true });
    } catch (e) {
      if (out) fs.rmSync(out.file, { force: true });
      resolve({ ok: false, code: null, signal: null, timedOut: false, ms: 0, last: '', error: e.code || e.message });
      return;
    } finally {
      if (out) fs.closeSync(out.fd); // the child has its own copy
    }
    const group = (sig) => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      group('SIGTERM');
      setTimeout(() => group('SIGKILL'), GRACE_MS).unref();
    }, minutes * 60_000);
    timer.unref();
    try {
      started(child);
    } catch {
      /* the caller's note only */
    }
    let error = null;
    child.on('error', (e) => {
      error = e.code || e.message;
    });
    // The command has ended when its own process has: a server it started in the background shares its output file, and
    // must neither hold the step up nor be killed at the time limit.
    let ended = false;
    const finish = (code, signal) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (endGroup) group('SIGKILL');
      const tail = tailOf(out.file);
      if (!endGroup) keepBounded(out.file, child.pid);
      try {
        fs.rmSync(out.file, { force: true });
      } catch {
        /* Windows: a server still holds it open */
      }
      const last = tail.split(/\r?\n/).filter((l, i, a) => l.length || i < a.length - 1).slice(-LAST_LINES).join('\n');
      resolve({ ok: code === 0 && !timedOut, code, signal, timedOut, ms: Date.now() - t0, last, ...(error ? { error } : {}) });
    };
    // A start that failed (ENOENT) says its error before 'close'; 'exit' waits a moment for it.
    child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), 20));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** How a command ended, in words: "ended with code 1", "stopped at its time limit of 10 min", "could not start". */
export function endWords(r, minutes) {
  if (r.timedOut) return `stopped at its time limit of ${minutes} min`;
  // A program that could not start ends with a negative code on newer Node (-2 for ENOENT), null on older: its error says it.
  if (r.error && (r.code === null || r.code < 0)) return `could not start (${r.error === 'ENOENT' ? 'the program is not on this computer' : r.error})`;
  if (r.signal) return `was ended by ${r.signal}`;
  return r.ok ? 'passed' : `ended with code ${r.code}`;
}

/**
 * A record of a command that has just started, for a file that outlives its starter (a go-live's journal, a check's
 * record): its pid, its identity (pid plus start: src/procid.mjs), when it started and its time limit.
 */
export function commandRecord(child, minutes, ident = system) {
  const pid = Number.isInteger(child && child.pid) ? child.pid : null;
  return { pid, proc: pid ? ident.of([pid]).get(pid) ?? null : null, at: new Date().toISOString(), minutes };
}

/** Whether the command of `rec` still runs: true, false, or null when it cannot be told (no identity to compare). */
export function commandRuns(rec, ident = system) {
  if (!rec || !Number.isInteger(rec.pid) || !alive(rec.pid)) return false;
  if (!rec.proc) return null;
  return sameProcess(rec.proc, ident.of([rec.pid]).get(rec.pid));
}

/** Whether the time limit of the command of `rec` (and the grace after it) has passed. */
export const pastLimit = (rec, now = Date.now()) => !(now <= Date.parse(rec.at) + rec.minutes * 60_000 + GRACE_MS);

/** End the command of `rec` and everything it started, only when it is shown to be that command. → whether it was. */
export function endCommand(rec, ident = system) {
  if (commandRuns(rec, ident) !== true) return false;
  try {
    process.kill(process.platform === 'win32' ? rec.pid : -rec.pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
