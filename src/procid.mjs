// Who a process is, beyond its pid. A pid is handed out again once its process has ended (after a reboot the small
// ones are all taken again, macOS wraps at 99999, Windows reuses one at once), so a file that names a pid says nothing
// about the process that has it now. A process's identity is its pid plus when it started:
//
//   Linux           "L:<boot id>:<start>": the start in clock ticks since boot (/proc/<pid>/stat, field 22) and the
//                   boot it belongs to (/proc/sys/kernel/random/boot_id). Exact, no clock involved, one small read.
//   macOS, Windows  "T:<epoch milliseconds of the start>": a process knows its own (now - its uptime); another's comes
//                   from the system: the start date that macOS's ps prints (lstart, whole seconds, read in UTC and
//                   the C locale), the start time .NET reads on Windows. Both are what the system stored when the
//                   process was made, so a slow answer, or one read late, never moves them. A record's is the same process
//                   as the system's when it is less than 3 seconds earlier, or less than a minute later: the system
//                   gives the start of the process behind the pid, Node its own, which may come later (a wrapper
//                   that execs node keeps its pid; a slow start under load). A dead writer's start is never later
//                   than that of the process that has its pid now.
//
// It never guesses: when the system cannot be asked, says nothing about a pid, or answers wrongly about this process
// itself, the identity is "not known" (null), and not known is never "another process".
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { startInTurn } from './oneturn.mjs';

export const SAME_WITHIN = 3000;
const STARTED_LATE = 60_000;
// A file written within this much before the boot may still be of this boot: the clock may have been corrected
// after the machine started.
const BOOT_SLACK = 10 * 60_000;
// This process's start, worked out once, when it is loaded: a clock set later (the time service, by hand) must not move
// it, as it does not move what the system stored when the process was created.
const STARTED = Date.now() - process.uptime() * 1000;

/** Field 22 (starttime) of a /proc/<pid>/stat text, or null. The name in it may contain spaces and ")". */
export function statStart(text) {
  const i = String(text).lastIndexOf(')');
  const v = i < 0 ? '' : String(text).slice(i + 2).split(' ')[19]; // fields from the 3rd on
  return /^\d+$/.test(v || '') ? v : null;
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/**
 * `ps -o pid=,lstart=` as it prints under LC_ALL=C and TZ=UTC0 ("  123 Tue Nov 17 06:38:18 2026") → Map pid → start in
 * epoch milliseconds (whole seconds). The date the system stored when the process was created: the same at every read.
 */
export function parseLstarts(out) {
  const starts = new Map();
  for (const line of String(out).split('\n')) {
    const m = /^\s*(\d+)\s+[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(line);
    if (m && m[2] in MONTHS) starts.set(Number(m[1]), Date.UTC(Number(m[7]), MONTHS[m[2]], Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
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
// how it is written. Pids are numbers we checked, never text from elsewhere. Plain .NET, no cmdlet at all: in Windows
// PowerShell 5.1 the first cmdlet of a module loads that module ("Preparing modules for first use"), measured at about
// 17 s in a home whose module cache is not kept, at every call; the 15 s limit then gave no identity. A pid that is gone,
// or whose start may not be read (another account's process), gives no line, as a missing CIM row did. The number is
// the one Get-CimInstance's CreationDate gave (Unix milliseconds, the rest cut off), so a record written before matches.
// The second way, for a process whose StartTime .NET may not read (another account's, a protected one: access denied;
// such processes are what a freed pid is often handed to): its CreationDate from Win32_Process through the
// System.Management searcher, which needs no right on the process, as the process snapshot reads it (cmdtree.mjs).
// Both come from the kernel's creation time of the process (StartTime to 100 ns, CreationDate to the microsecond) and
// are cut to the same Unix millisecond. A pid with no process gives no line either way.
export const creationScript = (pids) => `$ErrorActionPreference = 'SilentlyContinue'
foreach ($id in @(${pids.join(', ')})) {
  $ms = $null
  try { $ms = ([DateTimeOffset][System.Diagnostics.Process]::GetProcessById($id).StartTime).ToUnixTimeMilliseconds() } catch {}
  if ($ms -eq $null) { try { foreach ($w in [System.Management.ManagementObjectSearcher]::new("SELECT CreationDate FROM Win32_Process WHERE ProcessId=$id").Get()) { if ($w['CreationDate']) { $ms = ([DateTimeOffset][System.Management.ManagementDateTimeConverter]::ToDateTime($w['CreationDate'])).ToUnixTimeMilliseconds() } } } catch {} }
  if ($ms -ne $null) { [Console]::Out.WriteLine("$id $ms") }
}`;

// As server/platform/win32.mjs calls it; not imported from there, because every launcher start loads this module and
// that one costs it about 5 ms.
const powershellArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

/** stdout of a program, also when it exits non-zero (ps does when one of the pids is gone); null when it cannot run. */
function runProgram(cmd, args, timeout) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' } });
  return r.error ? null : r.stdout || '';
}

/** runProgram without waiting: a promise of the same. */
function runProgramLater(cmd, args, timeout) {
  // One program start per turn of the server's thread (oneturn.mjs startInTurn): it is asked in the background.
  return new Promise((resolve) => startInTurn(() => {
    execFile(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' } }, (err, stdout) => {
      resolve(err && (typeof err.code !== 'number' || err.killed) ? null : stdout || '');
    });
  }).catch(() => resolve(null)));
}

/**
 * Whether identity `a` (a record's, written by the process itself) and `b` (the system's of its pid now) are the same
 * process: true, false, or null when they cannot be compared.
 */
export function sameProcess(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const [ka, ...x] = a.split(':');
  const [kb, ...y] = b.split(':');
  if (ka !== kb) return null;
  if (ka === 'L' && x.length === 2 && y.length === 2 && x[1] && y[1]) {
    if (x[1] !== y[1]) return false;
    return !x[0] || !y[0] || x[0] === y[0]; // a boot id that could not be read on one side does not decide
  }
  if (ka === 'T' && x.length === 1 && y.length === 1 && /^\d+$/.test(x[0]) && /^\d+$/.test(y[0])) {
    const late = Number(x[0]) - Number(y[0]);
    return late > -SAME_WITHIN && late < STARTED_LATE;
  }
  return null;
}

/**
 * The identity reader of one system. Tests hand in what a system would print: `read(path)` (a file's text, throws
 * when it cannot), `run(cmd, args, timeout)` (stdout, or null when it cannot run), `runLater` (the same as a promise),
 * `now`, `ownStart` (this process's start in epoch ms, fixed), `osUptime` (seconds), `pid` (this process).
 *   self()          this process's identity (null on Linux when /proc cannot be read: its records carry none)
 *   of(pids, { after, born })  Map pid → identity or null (not known); all pids in one call to the system. `after`
 *                   (epoch ms, or a Map pid → ms): an answer the system gave before then is not used, it is asked again.
 *                   `born` (the same form): the start of the process a record names; an answer from before it is about
 *                   an earlier holder of the pid and is never used. In the background a judge that gives `born` takes a
 *                   kept answer from after it while the one `after` asks for is on its way: "another process" is then
 *                   final, "the same" reads as held for one more look, and the next look has the answer it asked for
 *   refresh(pids)   asks the system about them now, without waiting for it: a promise of when it asked (0: it did not),
 *                   the `after` for of(). For the moment before a signal, and for a look that can wait for the answer
 *   askInBackground()  from now on of() never waits for the system: what it does not know yet is not known, and asked
 *                   in the background (after the question on its way, never instead of it). For the dashboard, whose
 *                   requests must not wait for PowerShell
 *   inBackground()  whether of() may not know an answer at once: in the background on a system that must be asked
 *                   (macOS, Windows; Linux reads /proc at every call)
 *   bootAt()        when this boot began, in epoch ms
 */
export function makeIdentity({ platform = process.platform, read = (p) => fs.readFileSync(p, 'utf8'), run = runProgram, runLater = run === runProgram ? runProgramLater : async (...a) => run(...a), now = Date.now, ownStart = STARTED, osUptime = os.uptime, pid = process.pid } = {}) {
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
    if (mine === undefined) mine = platform === 'linux' ? linuxOf(pid) : `T:${Math.round(ownStart)}`;
    return mine;
  };
  const valid = (pids) => [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0 && p !== pid);

  // macOS and Windows: what the system said about each pid, kept for a while (PowerShell takes most of a second, and
  // the dashboard lists the records every few seconds), and whether its answer about this process itself was right.
  const ask = platform === 'darwin'
    ? { ttl: 30_000, call: (pids) => ['ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], 5000], starts: parseLstarts }
    : platform === 'win32'
      ? { ttl: 300_000, call: (pids) => ['powershell.exe', powershellArgs(creationScript(pids)), 15_000], starts: parseCreations }
      : null;
  // pid → { start (null: nothing said), at (when the system was asked) }
  const memo = new Map();
  // null until the system has said when this process started (an answer without it, or none, is asked again after the
  // while); false for good once that answer was wrong.
  let trusted = null;
  let background = false;
  let asking = null; // the background question on its way
  let askingFor = new Set(); // the pids it asks about
  const queued = new Set(); // pids wanted while it was on its way: asked right after it
  const learn = (pids, out, at) => {
    const starts = out === null ? null : ask.starts(out);
    for (const [p, m] of memo) if (now() - m.at >= ask.ttl) memo.delete(p);
    // An answer to an older question (one on its way when a newer one was asked and answered) never replaces a newer one.
    for (const p of pids) if (!(memo.has(p) && memo.get(p).at > at)) memo.set(p, { start: starts && Number.isFinite(starts.get(p)) ? Math.round(starts.get(p)) : null, at });
    const me = memo.get(pid);
    if (trusted === null && me && me.start !== null) trusted = Math.abs(me.start - ownStart) < SAME_WITHIN;
  };
  const askNow = (pids) => {
    const at = now();
    learn(pids, run(...ask.call(pids)), at);
  };
  const askLater = async (pids) => {
    const at = now();
    let out = null;
    try {
      out = await runLater(...ask.call(pids));
    } catch {
      /* could not be asked */
    }
    learn(pids, out, at);
    return at;
  };
  const withSelf = (pids) => (trusted === null && !pids.includes(pid) ? [...pids, pid] : pids); // the self check rides on the first call
  // One background question at a time; what it does not cover is asked when it is back.
  const askQueued = () => {
    if (asking || !queued.size) return;
    const pids = withSelf([...queued]);
    queued.clear();
    askingFor = new Set(pids);
    asking = askLater(pids).finally(() => {
      asking = null;
      askingFor = new Set();
      askQueued();
    });
  };

  function of(pids, { after = 0, born = 0 } = {}) {
    const out = new Map();
    const others = valid(pids);
    if (pids.includes(pid)) out.set(pid, self());
    if (platform === 'linux') {
      for (const p of others) out.set(p, linuxOf(p));
      return out;
    }
    const bound = (x, p) => (typeof x === 'number' ? x : x.get(p) || 0);
    const kept = (p) => memo.has(p) && now() - memo.get(p).at < ask.ttl && memo.get(p).at >= bound(born, p);
    const known = (p) => kept(p) && memo.get(p).at >= bound(after, p);
    if (ask && trusted !== false && others.length) {
      const wanted = others.filter((p) => !known(p));
      if (wanted.length || (trusted === null && !known(pid))) {
        if (!background) askNow(withSelf(wanted));
        else {
          for (const p of withSelf(wanted)) if (!askingFor.has(p)) queued.add(p);
          askQueued();
        }
      }
    }
    const usable = background && born ? kept : known;
    for (const p of others) {
      const m = trusted && usable(p) ? memo.get(p) : null;
      out.set(p, m && m.start !== null ? `T:${m.start}` : null);
    }
    return out;
  }

  async function refresh(pids) {
    const others = valid(pids);
    return ask && trusted !== false && others.length ? askLater(withSelf(others)) : 0;
  }

  return { self, of, refresh, askInBackground: () => (background = true), inBackground: () => background && ask !== null, bootAt: () => now() - osUptime() * 1000 };
}

export const system = makeIdentity();

/**
 * What a judge of one record asks for (a lock, a claim, a hold: "does the process that wrote it still run?"): an
 * identity the system gave at most FRESH_MS ago, as `of(pids, { after: freshAfter() })` or `filedProcess(…, { after:
 * freshAfter() })`. A kept answer (of() keeps one 30 s on macOS, five minutes on Windows) may be from before that
 * process ended and its pid was handed to another one (Windows does that at once): the pid lives, the kept identity is
 * the old one, and the record would read as held by a process that never wrote it. Where the reader waits (the command
 * line, the helper) it asks then and there. In the dashboard it never waits (askInBackground): a look that can wait
 * asks first and hands on the moment it asked (`after: await refresh(pids)`): the go-live and check looks, the coding
 * tool server's stop, a command's identity in its record. A judge that cannot wait gives the record's start (`born`)
 * and takes a kept answer from after it while it asks: "another process" is then final, "the same" reads as held,
 * and the next look has the answer this one asked for. Ending a process never goes on a kept answer. On Linux every
 * answer is read at once from /proc: nothing is kept there, so this changes nothing.
 */
export const FRESH_MS = 2000;
export const freshAfter = () => Date.now() - FRESH_MS;
/** The start a "T:<epoch ms>" identity names (of()'s `born`), else 0. */
export const startOf = (proc) => (/^T:\d+$/.test(proc || '') ? Number(proc.slice(2)) : 0);
/** `after` for a look that can wait: the moment the system was asked about `pids` (refresh), else freshAfter(). */
export const askedAfter = async (pids, ident = system) => (await ident.refresh(pids.filter((p) => Number.isInteger(p)))) || freshAfter();

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
 * this boot is of a process that cannot be alive. `after`: only what the system said since then is used (of()).
 */
export function stillOwned(list, ident = system, { after = 0 } = {}) {
  return judge(list, ident, after).map((j) => j.owned);
}

/** stillOwned's judgement of each entry: { owned, same } (same: what the identities said, null when they could not). */
function judge(list, ident, after) {
  const live = list.map(({ run }) => Number.isInteger(run.pid) && alive(run.pid));
  // Each record's own start: an answer from before it is about another process (of()'s `born`).
  const born = new Map();
  list.forEach(({ run }, i) => live[i] && startOf(run.proc) && born.set(run.pid, Math.max(born.get(run.pid) || 0, startOf(run.proc))));
  const ids = ident.of(list.filter((e, i) => live[i] && e.run.proc).map((e) => e.run.pid), { after, born });
  // A kept answer that says "another process" may be from before the record's process started, about the process that
  // had its pid then (Windows hands a pid out again at once): it decides only when it was given after that start, and
  // is asked again otherwise.
  const doubt = new Map();
  list.forEach(({ run }, i) => {
    const start = live[i] && /^T:\d+$/.test(run.proc || '') ? Number(run.proc.slice(2)) : null;
    if (start !== null && sameProcess(run.proc, ids.get(run.pid)) === false) doubt.set(run.pid, Math.max(doubt.get(run.pid) || 0, start, after));
  });
  if (doubt.size) for (const [p, id] of ident.of([...doubt.keys()], { after: doubt, born })) ids.set(p, id);
  const boot = ident.bootAt();
  return list.map(({ run, file }, i) => {
    if (!live[i]) return { owned: false, same: null };
    const same = run.proc ? sameProcess(run.proc, ids.get(run.pid)) : null;
    if (same !== null) return { owned: same, same };
    try {
      return { owned: fs.statSync(file).mtimeMs >= boot - BOOT_SLACK, same };
    } catch {
      return { owned: false, same }; // gone meanwhile
    }
  });
}

/**
 * A state file that names a process: `rec` = { pid, proc } (proc: its identity, read when our code started it or wrote
 * the file; none in a file from before identities, or where it could not be read). Whether that process is ours now:
 *   true   shown: the identities are equal, or (none to compare) `fact(pid)`, what only our process shows (its command
 *          line), says so and the file is of this boot. Only then may a signal go to it.
 *   null   cannot be told: no identity to compare, no fact readable here, the file of this boot. It may be said to run
 *          (a file from before identities, while its process lives); it never gets a signal.
 *   false  not ours: its pid is gone, the identities differ, the fact says no, or the file is from before this boot.
 * `fact`: true, false, or null when it cannot be read. `after`: as for stillOwned (before a signal: refresh()'s answer).
 */
export function filedProcess(file, rec, { fact = () => null, ident = system, after = 0 } = {}) {
  const run = { pid: rec?.pid, proc: typeof rec?.proc === 'string' ? rec.proc : null };
  const [{ owned, same }] = judge([{ run, file }], ident, after);
  if (!owned) return false;
  if (same) return true; // the identities, as stillOwned compared them: no second read that might say otherwise
  const f = fact(run.pid);
  return f === true || f === false ? f : null;
}
