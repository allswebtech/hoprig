// Who a process is, beyond its pid. A pid is handed out again once its process has ended (after a reboot the small
// ones are all taken again, macOS wraps at 99999, Windows reuses one at once), so a file that names a pid says nothing
// about the process that has it now. A process's identity is its pid plus when it started:
//
//   Linux           "L:<boot id>:<start>": the start in clock ticks since boot (/proc/<pid>/stat, field 22) and the
//                   boot it belongs to (/proc/sys/kernel/random/boot_id). Exact, no clock involved, one small read.
//   macOS, Windows  "T:<epoch milliseconds of the start>": a process knows its own (now - its uptime); another's comes
//                   from the system (ps's elapsed time; PowerShell's creation time). Two are the same process when
//                   they are less than 3 seconds apart.
//
// It never guesses: when the system cannot be asked, says nothing about a pid, or answers wrongly about this process
// itself, the identity is "not known" (null), and not known is never "another process".
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

export const SAME_WITHIN = 3000;
// A file written within this much before the boot may still be of this boot: the clock may have been corrected
// after the machine started.
const BOOT_SLACK = 10 * 60_000;

/** Field 22 (starttime) of a /proc/<pid>/stat text, or null. The name in it may contain spaces and ")". */
export function statStart(text) {
  const i = String(text).lastIndexOf(')');
  const v = i < 0 ? '' : String(text).slice(i + 2).split(' ')[19]; // fields from the 3rd on
  return /^\d+$/.test(v || '') ? v : null;
}

/** `ps -o pid=,etime=` ("[[dd-]hh:]mm:ss" elapsed) → Map pid → start in epoch milliseconds (`now` - elapsed). */
export function parseEtimes(out, now) {
  const starts = new Map();
  for (const line of String(out).split('\n')) {
    const m = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(line);
    if (m) starts.set(Number(m[1]), now - ((Number(m[2] || 0) * 24 + Number(m[3] || 0)) * 3600 + Number(m[4]) * 60 + Number(m[5])) * 1000);
  }
  return starts;
}

/** The PowerShell lines "<pid> <creation time in epoch milliseconds>" → Map pid → start. */
export function parseCreations(out) {
  const starts = new Map();
  for (const line of String(out).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line); // \s* takes the "\r" of Windows line ends
    if (m) starts.set(Number(m[1]), Number(m[2]));
  }
  return starts;
}

// The time goes through [DateTimeOffset] as a number, so that neither the PowerShell version nor the locale decides
// how it is written. Pids are numbers we checked, never text from elsewhere.
export const creationScript = (pids) => `$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process -Filter 'ProcessId=${pids.join(' OR ProcessId=')}' | ForEach-Object { if ($_.CreationDate) { "$($_.ProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" } }`;

// As server/platform/win32.mjs calls it; not imported from there, because every launcher start loads this module and
// that one costs it about 5 ms.
const powershellArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

/** stdout of a program, also when it exits non-zero (ps does when one of the pids is gone); null when it cannot run. */
function runProgram(cmd, args, timeout) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
  return r.error ? null : r.stdout || '';
}

/** Whether two identities are the same process: true, false, or null when they cannot be compared. */
export function sameProcess(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const [ka, ...x] = a.split(':');
  const [kb, ...y] = b.split(':');
  if (ka !== kb) return null;
  if (ka === 'L' && x.length === 2 && y.length === 2 && x[1] && y[1]) {
    if (x[1] !== y[1]) return false;
    return !x[0] || !y[0] || x[0] === y[0]; // a boot id that could not be read on one side does not decide
  }
  if (ka === 'T' && x.length === 1 && y.length === 1 && /^\d+$/.test(x[0]) && /^\d+$/.test(y[0])) return Math.abs(Number(x[0]) - Number(y[0])) < SAME_WITHIN;
  return null;
}

/**
 * The identity reader of one system. Tests hand in what a system would print: `read(path)` (a file's text, throws
 * when it cannot), `run(cmd, args, timeout)` (stdout, or null when it cannot run), `now`, `ownStart` (this process's
 * start in epoch ms), `osUptime` (seconds), `pid` (this process).
 *   self()       this process's identity (null on Linux when /proc cannot be read: its records carry none)
 *   of(pids)     Map pid → identity or null (not known); all pids in one call to the system
 *   bootAt()     when this boot began, in epoch ms
 */
export function makeIdentity({ platform = process.platform, read = (p) => fs.readFileSync(p, 'utf8'), run = runProgram, now = Date.now, ownStart = () => Date.now() - process.uptime() * 1000, osUptime = os.uptime, pid = process.pid } = {}) {
  let boot;
  const bootId = () => {
    if (boot === undefined) {
      try {
        boot = read('/proc/sys/kernel/random/boot_id').trim();
      } catch {
        boot = ''; // compared as "not known" on both sides (sameProcess)
      }
    }
    return boot;
  };
  const linuxOf = (p) => {
    try {
      const start = statStart(read(`/proc/${p}/stat`));
      return start ? `L:${bootId()}:${start}` : null;
    } catch {
      return null;
    }
  };
  let mine;
  const self = () => {
    if (mine === undefined) mine = platform === 'linux' ? linuxOf(pid) : `T:${Math.round(ownStart())}`;
    return mine;
  };

  // macOS and Windows: what the system said about each pid, kept for a while (PowerShell takes most of a second, and
  // the dashboard lists the records every few seconds), and whether its answer about this process itself was right.
  const ask = platform === 'darwin'
    ? { ttl: 30_000, starts: (pids) => { const out = run('ps', ['-o', 'pid=,etime=', '-p', pids.join(',')], 5000); return out === null ? null : parseEtimes(out, now()); } }
    : platform === 'win32'
      ? { ttl: 300_000, starts: (pids) => { const out = run('powershell.exe', powershellArgs(creationScript(pids)), 15_000); return out === null ? null : parseCreations(out); } }
      : null;
  const memo = new Map(); // pid → { start (null: nothing said), answered (the system could be asked), at }
  let trusted = null; // null until the system has answered about this process
  const fresh = (p) => memo.has(p) && now() - memo.get(p).at < ask.ttl;
  const learn = (pids) => {
    const starts = ask.starts(pids);
    const at = now();
    for (const [p, m] of memo) if (at - m.at >= ask.ttl) memo.delete(p);
    for (const p of pids) memo.set(p, { start: starts && Number.isFinite(starts.get(p)) ? Math.round(starts.get(p)) : null, answered: !!starts, at });
  };

  function of(pids) {
    const out = new Map();
    const others = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0 && p !== pid);
    if (pids.includes(pid)) out.set(pid, self());
    if (platform === 'linux') {
      for (const p of others) out.set(p, linuxOf(p));
      return out;
    }
    if (ask && trusted !== false && others.length) {
      const wanted = others.filter((p) => !fresh(p));
      if (trusted === null && !fresh(pid)) wanted.push(pid); // the self check rides on the first call
      if (wanted.length) learn(wanted);
      const me = memo.get(pid);
      if (trusted === null && me && me.answered) trusted = me.start !== null && Math.abs(me.start - ownStart()) < SAME_WITHIN;
    }
    for (const p of others) {
      const m = trusted ? memo.get(p) : null;
      out.set(p, m && m.start !== null ? `T:${m.start}` : null);
    }
    return out;
  }

  return { self, of, bootAt: () => now() - osUptime() * 1000 };
}

export const system = makeIdentity();

/** The process `pid` exists (EPERM: it does, as another user's). */
export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * For each { run, file } (a record that names its writer's pid, and its writer's identity in `proc` when it has one):
 * whether that process still runs. Its pid must be alive; then the identities decide when both are known; when they
 * cannot (a record of a launcher from before identities, or a system that cannot be asked), a file last written before
 * this boot is of a process that cannot be alive.
 */
export function stillOwned(list, ident = system) {
  const live = list.map(({ run }) => Number.isInteger(run.pid) && alive(run.pid));
  const ids = ident.of(list.filter((e, i) => live[i] && e.run.proc).map((e) => e.run.pid));
  const boot = ident.bootAt();
  return list.map(({ run, file }, i) => {
    if (!live[i]) return false;
    const same = run.proc ? sameProcess(run.proc, ids.get(run.pid)) : null;
    if (same !== null) return same;
    try {
      return fs.statSync(file).mtimeMs >= boot - BOOT_SLACK;
    } catch {
      return false; // gone meanwhile
    }
  });
}
