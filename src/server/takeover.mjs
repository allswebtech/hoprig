// The dashboard that runs now, as its own record names it (<stateDir>/dashboard.json: pid, identity, port), and how
// a newer start ends it. On Windows an update or `service install` ended only the task's PowerShell wrapper: the old
// `node … serve` kept the port, the new one could not listen, and the old code went on serving. So the old one is
// ended by its own process id, and only after it is shown to be that very program:
//
//   - the record's pid is not 0, 4 (Windows' idle and System), this process or its parent;
//   - the process behind the pid started when the record says (a pid is handed out again once its process ended);
//   - its command line is Hoprig's bin with "serve";
//   - it runs as this user;
//   - it is not above this process (a terminal of that dashboard: ending it would end this command too);
//   - where the record carries its key, the program on the record's port answers it (GET /api/local/facts) as that pid
//     of this state folder.
//
// Anything that is not shown to be all of that is never ended: it is named, and the caller stops.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { dashboardFile, ownVersion, stateKey } from './dashboardfile.mjs';
import { alive as isAlive, sameProcess, system } from '../procid.mjs';
import { compareVersions } from '../setup/system.mjs';

/**
 * The words of a Hoprig dashboard's command line: its bin and the word "serve" after it. The bin is bin/hoprig.mjs (an
 * install, or a source checkout started with a relative path: `node bin\\hoprig.mjs serve`) or npm's own link to it
 * without the extension (`<prefix>/bin/hoprig`, `hop`).
 */
export function isHoprigServe(cmd) {
  const s = String(cmd || '');
  const bin = /(?:^|[\s"\\/])bin[\\/](?:hoprig|hop)(?:\.mjs)?"?(?=\s|$)/.exec(s);
  return !!bin && /(^|\s)"?serve"?(\s|$)/.test(s.slice(bin.index + bin[0].length));
}

// Windows: the command line, the owner's SID and the start of one pid in one PowerShell call, printed as JSON. The pid
// is an integer checked by the caller; nothing else is ever put into the script. The owner is its SID, not its name: a
// name comes back in the console's code page (a non-ASCII letter is garbled) and in more than one form for one account
// (a Microsoft or work account), while a SID is plain ASCII and one string.
export const facts32Script = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('bad pid');
  return `$ErrorActionPreference = 'SilentlyContinue'
$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'
if ($p) {
  $o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid
  [pscustomobject]@{
    cmd = $p.CommandLine
    sid = if ($o.ReturnValue -eq 0) { $o.Sid } else { $null }
    start = if ($p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } else { $null }
  } | ConvertTo-Json -Compress
}`;
};

const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

const runReal = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || (err && err.message) || '').trim() }),
    );
  });

/**
 * What the system says about `pid`: { cmd, mine, proc } (proc: its identity as procid.mjs writes it), or null when it
 * cannot be told. `deps` are what a test hands in for a made-up system.
 */
export async function processFacts(pid, { platform = process.platform, run = runReal, read = (p) => fs.readFileSync(p, 'utf8'), ident = system, me = null } = {}) {
  if (platform === 'win32') {
    const r = await run('powershell.exe', psArgs(facts32Script(pid)));
    if (!r.ok || !r.out) return null;
    let d;
    try {
      d = JSON.parse(r.out);
    } catch {
      return null;
    }
    const who = me || (await (await import('./service/windows.mjs')).whoAmI(run));
    const mine = !!(who && who.sid && typeof d.sid === 'string' && d.sid.toUpperCase() === who.sid.toUpperCase());
    return { cmd: d.cmd || '', mine, proc: Number.isFinite(d.start) ? `T:${Math.round(d.start)}` : null };
  }
  try {
    const cmd = platform === 'linux' ? read(`/proc/${pid}/cmdline`).split('\0').join(' ').trim() : null;
    let text = cmd;
    let uid = null;
    if (platform === 'linux') {
      const m = /^Uid:\s+(\d+)/m.exec(read(`/proc/${pid}/status`));
      uid = m ? Number(m[1]) : null;
    } else {
      const r = await run('ps', ['-o', 'uid=,args=', '-p', String(pid)]);
      const m = r.ok ? /^\s*(\d+)\s+(.*)$/.exec(r.out) : null;
      if (!m) return null;
      uid = Number(m[1]);
      text = m[2];
    }
    const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
    return { cmd: text || '', mine: uid !== null && uid === myUid, proc: ident.of([pid]).get(pid) ?? null };
  } catch {
    return null;
  }
}

/** The record of the dashboard of this state folder, or null. */
export function readRecord(file = dashboardFile()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(d.pid) && Number.isInteger(d.port) ? d : null;
  } catch {
    return null;
  }
}

/**
 * Whether the record's process is a Hoprig dashboard of this user that may be ended: { ok: true, pid, port } or
 * { ok: false, why, gone } (why: words for a person; gone: the recorded dashboard does not run any more, so there is
 * nothing of this state folder's to end). ONE rule: a process is ended only when it is SHOWN to be the recorded
 * dashboard: the same start as the record says AND a command line recognised as Hoprig's `serve` AND this user's.
 *   - another start: the pid was handed out again, the recorded dashboard is gone (never ended, a start goes on);
 *   - the same start with a command line that is not recognised or cannot be read: it cannot be told. Never ended, and
 *     never taken for gone (it may well be the recorded dashboard: a second one beside it would only fail);
 *   - a start that cannot be compared with a command line plainly not Hoprig's: gone;
 *   - never itself or its parent (the program this command runs in).
 */
export async function judgeRecord(rec, deps = {}) {
  const alive = deps.alive || isAlive;
  const win = (deps.platform || process.platform) === 'win32';
  if (!rec) return { ok: false, why: 'no record of a running dashboard' };
  const { pid } = rec;
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) return { ok: false, why: `process ${pid} is not one that may be ended` };
  if (!alive(pid)) return { ok: false, gone: true, why: 'the recorded dashboard is no longer running' };
  const f = await processFacts(pid, deps);
  if (!f) return { ok: false, why: `the system did not say what process ${pid} is` };
  const same = typeof rec.proc === 'string' ? sameProcess(rec.proc, f.proc) : null;
  // The start first: a pid handed out again is another program, also when it is this command's own parent now (the
  // PowerShell window, or the cmd.exe of npm's hoprig.cmd).
  if (same === false) return { ok: false, gone: true, why: `process ${pid} is another program now (it started at another time than the recorded dashboard)` };
  if (pid === process.ppid) return { ok: false, why: `process ${pid} is not one that may be ended (this command runs in it)` };
  const known = !!f.cmd && isHoprigServe(f.cmd);
  if (same === null && f.cmd && !known) return { ok: false, gone: true, why: `process ${pid} is not a Hoprig dashboard` };
  if (!known) {
    const reason = f.cmd ? 'its command line is not one Hoprig knows' : `its command line cannot be read${win ? ' (Windows hides it, for example, for a program run as administrator)' : ''}`;
    return same
      ? { ok: false, why: `process ${pid} started when the recorded dashboard did, but ${reason}, so it cannot be told whether it is that dashboard` }
      : { ok: false, why: `it cannot be told whether process ${pid} is the recorded dashboard: ${reason}, and its start cannot be compared` };
  }
  if (same !== true) return { ok: false, why: `process ${pid} is a Hoprig dashboard, but not shown to be the recorded one (its start cannot be compared)` };
  if (!f.mine) return { ok: false, why: `process ${pid} runs as another user` };
  return { ok: true, pid, port: rec.port };
}

/**
 * taskkill argv that ends that one process (a dashboard has no window to close, so /F). Never /T: taskkill /T follows
 * the parent pid, and the gateway, the public link and the coding tools' servers the dashboard starts detached keep
 * it, so /T would end them too (on Linux and macOS they outlive the dashboard). Its built-in terminals close with it.
 */
export const taskkillArgs = (pid) => ['/PID', String(pid), '/F'];

/**
 * End a process judgeRecord said yes to, and wait until it is gone: true when it is. Windows: taskkill /F of that
 * pid alone; elsewhere SIGTERM, which the dashboard answers by stopping cleanly.
 */
export async function endDashboard(pid, { platform = process.platform, run = runReal, alive = isAlive, kill = process.kill.bind(process), waitMs = 15_000, step = 200 } = {}) {
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) return false;
  if (platform === 'win32') await run('taskkill', taskkillArgs(pid));
  else {
    try {
      kill(pid, 'SIGTERM');
    } catch {
      /* gone already */
    }
  }
  for (let t = 0; t <= waitMs; t += step) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return !alive(pid);
}

// Windows: every process's pid and its parent's, one line each, in one PowerShell call.
const TABLE_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }`;

/** The pids above `pid` (its parent, then that one's parent, …), nearest first; null when the system cannot tell. */
export async function parentChain(pid = process.pid, { platform = process.platform, run = runReal, read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  let up;
  try {
    if (platform === 'linux') up = (p) => Number(read(`/proc/${p}/stat`).replace(/^.*\)\s+/s, '').split(/\s+/)[1]);
    else {
      const r = platform === 'win32' ? await run('powershell.exe', psArgs(TABLE_SCRIPT)) : await run('ps', ['-A', '-o', 'pid=,ppid=']);
      if (!r.ok) return null;
      const table = new Map();
      for (const line of r.out.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (m) table.set(Number(m[1]), Number(m[2]));
      }
      if (!table.has(pid)) return null;
      up = (p) => table.get(p);
    }
    const chain = [];
    for (let p = pid, i = 0; i < 64; i++) {
      const q = up(p);
      if (!Number.isInteger(q) || q <= 0 || q === p || chain.includes(q)) break;
      chain.push(q);
      p = q;
    }
    return chain;
  } catch {
    return null;
  }
}

/**
 * Whether this process runs inside the dashboard `pid` (a terminal of it, or something started there): `pid` is among
 * its parents; when they cannot be read, whether this runs in a built-in terminal of a dashboard ($HOPRIG_TERM_ID).
 */
export async function insideOf(pid, deps = {}) {
  const chain = await parentChain(process.pid, deps);
  return chain ? chain.includes(pid) : !!(deps.env || process.env).HOPRIG_TERM_ID;
}

export const insideWords = (pid) =>
  `This runs in a terminal of the dashboard it would end (process ${pid}): ending that dashboard ends this command too, before anything starts again. Nothing was changed. Run it in a window of its own (on Windows: open PowerShell from the Start menu), not in the dashboard's terminal.`;

/** Words when the recorded dashboard of this state folder is above this process (see insideOf), else null. */
export async function refusedFromInside(deps = {}) {
  const rec = readRecord(deps.file);
  if (!rec || !Number.isInteger(rec.pid) || !(deps.alive || isAlive)(rec.pid)) return null;
  // Only a dashboard a start would end (endOldDashboard). A record of another state folder is left running, and one
  // whose pid is another program now is gone: on Windows a pid handed out again may be explorer.exe, which is above
  // every window opened from the Start menu, so "run it in a window of its own" could never help.
  if (typeof rec.state === 'string' && rec.state !== stateKey()) return null;
  if ((await judgeRecord(rec, deps)).gone) return null;
  return (await insideOf(rec.pid, deps)) ? insideWords(rec.pid) : null;
}

/**
 * Ask the program on the record's port who it is, with the key only the record holds (the dashboard's GET /api/local/facts):
 * { pid, state } when it answered as a dashboard, { pid: null } when something answered but not with that, null when
 * nothing answered or the record carries no key (one written by an older Hoprig).
 */
export async function askHolder(rec, { fetchImpl = globalThis.fetch, ms = 3000 } = {}) {
  if (typeof rec.key !== 'string' || !rec.key) return null;
  let r;
  try {
    r = await fetchImpl(`${portBase(rec)}/api/local/facts`, { headers: { 'x-hoprig-local-key': rec.key }, signal: AbortSignal.timeout(ms) });
  } catch {
    return null; // nothing answered (or it hangs)
  }
  try {
    const d = r.ok ? await r.json() : null;
    return { pid: d && Number.isInteger(d.pid) ? d.pid : null, state: d && typeof d.state === 'string' ? d.state : null };
  } catch {
    return { pid: null, state: null }; // something answered, not as a dashboard
  }
}

/** Whether the record is of the old format: written by a version before the key (no key, no state folder). */
export const oldFormat = (rec) => !!rec && typeof rec.key !== 'string' && typeof rec.state !== 'string';

/** The address a record's dashboard answers on, for this computer. */
export const portBase = (rec) => {
  const h = !rec.host || rec.host === '0.0.0.0' ? '127.0.0.1' : rec.host === '::' ? '::1' : rec.host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${rec.port}`;
};

/**
 * A record of the old format names a dashboard no key can confirm. It is trusted for ONE thing only: the first update
 * from the released version on this computer, when the program on its port answers as that version's dashboard does
 * (/healthz says "ok", and /api/local/facts, a route it does not have, asks for a sign-in like every other /api/ path).
 * A newer dashboard there (it has the route: 404 without its key), another program, or nothing: false.
 */
export async function answersAsOld(rec, { fetchImpl = globalThis.fetch, ms = 3000 } = {}) {
  try {
    const h = await fetchImpl(`${portBase(rec)}/healthz`, { signal: AbortSignal.timeout(ms) });
    if (h.status !== 200 || (await h.text()) !== 'ok') return false;
    const a = await fetchImpl(`${portBase(rec)}/api/local/facts`, { signal: AbortSignal.timeout(ms) });
    if (a.status !== 401) return false;
    const d = await a.json();
    return !!d && d.error === 'log in first';
  } catch {
    return false;
  }
}

/**
 * 'yes' (the recorded pid holds the port, for this state folder), 'no' (something else answered, or an old-format
 * record that the port does not confirm), 'unknown' (a record with a key whose port did not answer).
 */
export async function holderVerdict(rec, deps = {}) {
  if (oldFormat(rec)) return (await (deps.answersAsOld || answersAsOld)(rec, deps)) ? 'yes' : 'no';
  const a = await (deps.askHolder || askHolder)(rec);
  if (!a) return 'unknown';
  return a.pid === rec.pid && a.state === stateKey() ? 'yes' : 'no';
}

/**
 * Before a new dashboard of this state folder starts: the old one, if its record shows it is ours, is ended.
 * Returns { ended: pid | null, why, left } (why: when there was one of ours that was not ended; left: words when the
 * record named a dashboard that is not this state folder's, which is left running).
 */
export async function endOldDashboard(deps = {}) {
  const rec = readRecord(deps.file);
  if (!rec) return { ended: null, why: null };
  const notOurs = { ended: null, why: null, left: `the record named process ${rec.pid}, a dashboard of another state folder: it was left running` };
  // A record copied from another state folder (restored, copied, a test home built from a copy) names its dashboard.
  if (typeof rec.state === 'string' && rec.state !== stateKey()) return notOurs;
  const j = await judgeRecord(rec, deps);
  if (!j.ok) return { ended: null, why: j.gone ? null : j.why };
  // When the old dashboard can be asked, it must say it is that pid of this state folder; a record of the old format
  // must be confirmed by what answers on its port (answersAsOld). A keyed record whose dashboard does not answer (it
  // hangs) is judged by the record alone: its key and state folder are this folder's.
  if ((await holderVerdict(rec, deps)) === 'no') {
    return oldFormat(rec) ? { ended: null, why: null, left: `the record names process ${rec.pid}, but what answers on port ${rec.port} is not that older version's dashboard: it was left running` } : notOurs;
  }
  const gone = await endDashboard(j.pid, deps);
  return gone ? { ended: j.pid, why: null } : { ended: null, why: `process ${j.pid} did not end` };
}

/** An Error for a port that something else holds: named, and nothing was ended. */
const held = (port, why) =>
  Object.assign(new Error(`port ${port} is in use by another program (${why}). Nothing was ended: stop that program, or start this one with --port <another port>.`), { code: 'EADDRINUSE' });

/**
 * `listen()` (a promise), and when the port is in use: if the holder is shown to be this state folder's dashboard of
 * this user (judgeRecord, and it answers the key of its record), and it is an older version or `takeOver` was asked
 * for (--take-over), it says so, ends it, and listens again. A dashboard of the same version is named and left alone
 * (a `serve` typed by habit must not end the background one and its terminals). Anything else is never ended. So a
 * start never leaves a second dashboard beside the first.
 */
export async function listenTakingOver(listen, port, { say = console.log, takeOver = false, version = ownVersion(), ...deps } = {}) {
  try {
    return await listen();
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
  }
  const rec = readRecord(deps.file);
  if (!rec || rec.port !== port) throw held(port, 'not a dashboard of this Hoprig');
  const j = await judgeRecord(rec, deps);
  if (!j.ok) throw held(port, j.why);
  if ((await holderVerdict(rec, deps)) !== 'yes') throw held(port, `process ${j.pid} is not shown to be this state folder's dashboard on that port`);
  // A record of the old format is a version before the key: older, once its port confirmed it (holderVerdict).
  const older = oldFormat(rec) || (typeof rec.version === 'string' && !!version && compareVersions(rec.version, version) < 0);
  if (!older && !takeOver) {
    throw Object.assign(new Error(`this Hoprig's dashboard (process ${j.pid}${rec.version ? `, version ${rec.version}` : ''}) already runs there. Nothing was ended: use that one, or start this one with --take-over to end it first.`), { code: 'EADDRINUSE' });
  }
  if (await insideOf(j.pid, deps)) throw Object.assign(new Error(insideWords(j.pid)), { code: 'EINSIDE' });
  say(`${older ? 'An older' : 'The'} Hoprig dashboard (process ${j.pid}) is using port ${port}. Ending it first, then this one starts.`);
  if (!(await endDashboard(j.pid, deps))) throw held(port, `the older dashboard, process ${j.pid}, did not end`);
  for (let i = 0; ; i++) {
    try {
      return await listen();
    } catch (e) {
      // The port is let go a moment after the process is gone.
      if (e.code !== 'EADDRINUSE' || i >= 25) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
