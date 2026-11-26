// One command of a project's check or go-live: a list of words started without a shell, in a folder, with a time
// limit. At the limit the command and everything it started (its own process group) get SIGTERM, then SIGKILL.
// What it prints goes to a file of its own in the state folder (mode 600), never to a pipe: a server it starts in the
// background without redirecting its output inherits that file and goes on writing to it after the command ended,
// where a pipe that is let go would end it (EPIPE). Only the last lines are kept, then the file is removed. When
// something of the command's process group still runs then, a small keeper (outkeeper.mjs) holds the removed file and
// empties it whenever it is past KEEP_BYTES, until that group is gone: what a server prints is bounded, never a file
// that grows unseen until the disk is full. The command is started detached on every system: on Windows too it then
// outlives a restart of the dashboard (Node would otherwise end it with the dashboard's process), and it and what it
// started are ended as one tree (src/cmdtree.mjs: its process group, or on Windows its tree by parent pid). `low`: at low priority (nice 10, where there is nice; on Windows the class below normal). `prefix`:
// the owner's limiter (allow.mjs limiterWords), put before the command's own words.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../paths.mjs';
import { FRESH_MS, alive, freshAfter, sameProcess, startOf, system } from '../procid.mjs';
import { forInstalls, withoutProviderKeys } from '../secretenv.mjs';
import { which } from '../setup/system.mjs';
import { endTree } from '../cmdtree.mjs';

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

/**
 * Hand the output file to a keeper while what the command left in its group may still write into it. Windows has no
 * group to ask: a keeper is started all the same, with the command's pid and start, and ends when nothing descends
 * from it (outkeeper.mjs).
 */
function keepBounded(file, pgid, start, platform = process.platform) {
  if (platform !== 'win32' && !groupLives(pgid)) return null;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r+');
    const k = spawn(process.execPath, [KEEPER, String(pgid), String(KEEP_BYTES), ...(platform === 'win32' ? [String(start)] : [])], { stdio: ['ignore', 'ignore', 'ignore', fd], detached: true, env: { PATH: process.env.PATH || '' }, windowsHide: true });
    k.on('error', () => {});
    k.unref();
    return Number.isInteger(k.pid) ? k.pid : null;
  } catch {
    return null; // no keeper: the file is removed all the same
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
 * → Promise<{ ok, code, signal, timedOut, ms, last (the last lines, raw), error?, keeper? (the pid of the keeper of its
 * output, when one was started) }>. `started(child)` for the pid.
 * `branches`: the command runs code from task branches (a check). `endGroup`: when the command's own process has
 * ended, what it left running in its process group is ended too (a check; never a go-live, whose server must live on).
 */
// `spawnImpl` and `end` (src/cmdtree.mjs endTree) are what a test hands in for the system's answers.
export function runCommand(run, { cwd, minutes = 10, env: given = process.env, low = false, prefix = null, branches = false, endGroup = false, started = () => {}, platform = process.platform, setPriority = os.setPriority, spawnImpl = spawn, end = endTree } = {}) {
  // Neither gets a provider's key (also one under a name of the provider's own) or Hoprig's own tokens (secretenv.mjs),
  // whoever starts it (the dashboard, the command line, the helper). A check runs code from task branches that nobody
  // has looked at yet: it loses GitHub's tokens too, as an install does. A go-live runs the project's own confirmed
  // scripts, which may fetch from a private repository: they keep them.
  const env = branches ? forInstalls(given) : withoutProviderKeys(given);
  const words = [...(prefix || []), ...run];
  const nice = low && platform !== 'win32' && which('nice', env) ? ['nice', '-n', '10'] : [];
  const argv = [...nice, ...words];
  const t0 = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    let child;
    let out = null;
    try {
      out = newOutput();
      child = spawnImpl(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', out.fd, out.fd], detached: true, windowsHide: true });
    } catch (e) {
      if (out) fs.rmSync(out.file, { force: true });
      resolve({ ok: false, code: null, signal: null, timedOut: false, ms: 0, last: '', error: e.code || e.message });
      return;
    } finally {
      if (out) fs.closeSync(out.fd); // the child has its own copy
    }
    // Windows has no nice: the command's process gets the priority class below normal at once, and what it starts
    // takes that class from it.
    if (low && platform === 'win32' && child.pid) {
      try {
        setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* it ended already */
      }
    }
    // The command as this process sees it at the moment of each step of an end (src/cmdtree.mjs): running or not, ended
    // through its own handle (never by its number, which Windows may have handed on once it ended), and when it ended.
    let exitedAt = null;
    child.once('exit', () => (exitedAt = Date.now()));
    const group = (sig) => end({ pid: child.pid, start: t0, alive: () => child.exitCode === null && child.signalCode === null, killRoot: (s) => child.kill(s), endedAt: () => exitedAt }, sig, { platform });
    let grace = null;
    let atLimit = null; // whether the end at the time limit reached the whole tree (Windows: the processes were read)
    const timer = setTimeout(() => {
      timedOut = true;
      atLimit = group('SIGTERM').whole;
      grace = setTimeout(() => group('SIGKILL'), GRACE_MS);
      grace.unref();
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
      // Not after its end: by then its pid may be another process's (Windows hands a pid on at once).
      clearTimeout(grace);
      // On Windows what it left is found and ended after a look at the processes: the answer waits for it.
      const g = endGroup ? group('SIGKILL') : null;
      const left = g ? Promise.all([g.rest, g.whole]).then(([, w]) => w) : atLimit;
      const tail = tailOf(out.file);
      const keeper = endGroup ? null : keepBounded(out.file, child.pid, t0, platform);
      try {
        fs.rmSync(out.file, { force: true });
      } catch {
        /* Windows: a server still holds it open */
      }
      const last = tail.split(/\r?\n/).filter((l, i, a) => l.length || i < a.length - 1).slice(-LAST_LINES).join('\n');
      const r = { ok: code === 0 && !timedOut, code, signal, timedOut, ms: Date.now() - t0, last, ...(error ? { error } : {}), ...(keeper ? { keeper } : {}) };
      // An end that may have left part of its tree is said with the command's words (endWords), never silently.
      if (left) left.then((w) => resolve(w && w.whole === false ? { ...r, treeLeft: w.why } : r), () => resolve(r));
      else resolve(r);
    };
    // A start that failed (ENOENT) says its error before 'close'; 'exit' waits a moment for it.
    child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), 20));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** How a command ended, in words: "ended with code 1", "stopped at its time limit of 10 min", "could not start". */
export function endWords(r, minutes) {
  if (r.treeLeft) return `${endWords({ ...r, treeLeft: null }, minutes)} (${r.treeLeft})`;
  if (r.timedOut) return `stopped at its time limit of ${minutes} min`;
  // A program that could not start ends with a negative code on newer Node (-2 for ENOENT), null on older: its error says it.
  if (r.error && (r.code === null || r.code < 0)) return `could not start (${r.error === 'ENOENT' ? 'the program is not on this computer' : r.error})`;
  if (r.signal) return `was ended by ${r.signal}`;
  return r.ok ? 'passed' : `ended with code ${r.code}`;
}

/**
 * A record of a command that has just started, for a file that outlives its starter (a go-live's journal, a check's
 * record): its pid, its identity (pid plus start: src/procid.mjs), when it started and its time limit. In the dashboard
 * the identity of a new pid is not known yet (of() never waits there): it is asked, and handed to `later(proc)` to be
 * written into the record, when the command still ran after the answer (its pid is its own until Node has seen it end).
 */
export function commandRecord(child, minutes, ident = system, { later = null } = {}) {
  const pid = Number.isInteger(child && child.pid) ? child.pid : null;
  // Only an answer asked after its start: a kept one may be of the process that had its pid before (Windows hands a pid
  // on at once). The command line asks at once; the dashboard does not know it yet.
  const spawned = Date.now();
  const rec = { pid, proc: pid ? ident.of([pid], { after: spawned }).get(pid) ?? null : null, at: new Date().toISOString(), minutes };
  const runs = () => child.exitCode === null && child.signalCode === null;
  if (pid && !rec.proc && later && ident.refresh) {
    Promise.resolve(ident.refresh([pid])).then((after) => {
      const proc = runs() ? ident.of([pid], { after: Math.max(spawned, after || 0) }).get(pid) : null;
      if (proc && runs()) later(proc);
    }).catch(() => {});
  }
  return rec;
}

/**
 * Whether the command of `rec` still runs: true, false, or null when it cannot be told (no identity to compare).
 * `after`: an identity the system gave since then (procid.mjs freshAfter; a look that can wait hands on the moment it
 * asked, askedAfter). `strict`: never a kept answer, also not in the dashboard (before an end).
 */
// A kept answer may be from before the command ended and its pid was handed on (Windows does that at once), and would
// then call another process the command.
export { FRESH_MS };

export function commandRuns(rec, ident = system, { after = freshAfter(), strict = false } = {}) {
  if (!rec || !Number.isInteger(rec.pid) || !alive(rec.pid)) return false; // not alive: never the command, whatever is kept
  if (!rec.proc) return null;
  return sameProcess(rec.proc, ident.of([rec.pid], { after, born: strict ? 0 : startOf(rec.proc) }).get(rec.pid));
}

/** Whether the time limit of the command of `rec` (and the grace after it) has passed. */
export const pastLimit = (rec, now = Date.now()) => !(now <= Date.parse(rec.at) + rec.minutes * 60_000 + GRACE_MS);

/**
 * End the command of `rec` and everything it started, only when it is shown to be that command, by an answer the
 * system gave since `after`. → whether it was.
 */
export function endCommand(rec, ident = system, { platform = process.platform, end = endTree, after = freshAfter() } = {}) {
  if (commandRuns(rec, ident, { after, strict: true }) !== true) return false;
  // Its start: from its identity where that is one (T:<epoch ms>, the system's own start: on Windows it is ended in the
  // held end by it, src/cmdtree.mjs), else when its record was written, just after it.
  const exact = /^T:\d+$/.test(rec.proc || '');
  const start = exact ? Number(rec.proc.slice(2)) : Date.parse(rec.at);
  return end({ pid: rec.pid, start: Number.isFinite(start) ? start : null, alive: true, ...(exact ? { startExact: true } : {}) }, 'SIGKILL', { platform }).ok; // shown just now
}
