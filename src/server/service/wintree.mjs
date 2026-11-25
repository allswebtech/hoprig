// Windows: the old dashboard's whole process tree, and the new one seen to answer. Ending the task stops only its
// PowerShell wrapper; the `node … serve` it started can keep the port, the new start then fails, and the old code goes
// on serving. So, around `schtasks /Run`:
//   - before the task is ended, the tree is read while the wrapper still links the serve to this task (its command
//     line names this state folder's startup script);
//   - after the old one was ended, the port must be free. If something still holds it, the processes of that tree are
//     ended one by one (taskkill /PID /F, never /T), except a program Hoprig keeps running on purpose beside the
//     dashboard (each has a record of its own), a process of another account (SID), one that started before its parent
//     (a pid handed out again) and this command or a process above it. A holder that is not ended is named with why,
//     and nothing starts;
//   - after the start, the new dashboard must answer on its port with its record's key, as a dashboard of this state
//     folder with a new pid. Only then has it worked.
// Every program goes through `run`; tests hand in a made-up Windows, its clock and its sleep.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../../paths.mjs';
import { stateKey } from '../dashboardfile.mjs';
import { askHolder, isHoprigServe, processFacts, readRecord, taskkillArgs } from '../takeover.mjs';

const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

/** Who listens on `port`, and every process with its parent, command line and start, in one PowerShell call. */
export const treeScript = (port) => {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('bad port');
  return `$ErrorActionPreference = 'SilentlyContinue'
$held = @(Get-NetTCPConnection -LocalPort ${port} -State Listen | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
$procs = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine; start = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null } } })
[pscustomobject]@{ held = $held; procs = $procs } | ConvertTo-Json -Depth 3 -Compress`;
};

const arr = (x) => (Array.isArray(x) ? x : x === null || x === undefined ? [] : [x]);

/** That JSON → { held: [pid], procs: Map(pid → { pid, ppid, name, cmd, start }) }, or null when it is not that. */
export function parseTree(out) {
  try {
    const d = JSON.parse(out);
    if (!d || typeof d !== 'object') return null;
    const procs = new Map();
    for (const p of arr(d.procs)) {
      if (Number.isInteger(p.pid)) procs.set(p.pid, { pid: p.pid, ppid: Number(p.ppid), name: p.name || '', cmd: p.cmd || '', start: Number.isFinite(p.start) ? p.start : null });
    }
    return { held: arr(d.held).map(Number).filter((p) => Number.isInteger(p) && p > 4), procs };
  } catch {
    return null;
  }
}

export async function readTree(port, run) {
  const r = await run('powershell.exe', psArgs(treeScript(port)));
  return r.ok && r.out ? parseTree(r.out) : null;
}

/** The pids of the programs Hoprig keeps running on purpose beside the dashboard, from their own records. */
export function keptPids(dir = stateDir()) {
  const out = new Set();
  const add = (v) => Number.isInteger(v) && v > 0 && out.add(v);
  const take = (file) => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8').trim();
    } catch {
      return;
    }
    if (/^\d+$/.test(text)) return add(Number(text));
    try {
      const d = JSON.parse(text);
      add(d?.pid);
      add(d?.listener?.pid);
    } catch {
      /* not a record */
    }
  };
  const list = (d) => {
    try {
      return fs.readdirSync(d).map((n) => path.join(d, n));
    } catch {
      return [];
    }
  };
  const addons = path.join(dir, 'addons');
  for (const f of list(addons)) if (f.endsWith('.pid')) take(f); // the gateway add-ons
  for (const f of ['public-link.json', 'public-link-service.json', 'link.json', path.join('fixed-link', 'fixed.json')]) take(path.join(addons, f));
  for (const f of list(path.join(dir, 'codetools'))) if (f.endsWith('-server.json')) take(f); // the coding tools' servers
  return out;
}

/** The router runs from Hoprig's own bin with the word "router" (router.mjs): kept, as it has no pid record. */
const isRouter = (cmd) => isHoprigServe(String(cmd || '').replace(/(^|\s)"?router"?(?=\s|$)/, '$1serve')) && !isHoprigServe(cmd);

const KEPT_WHY = 'Hoprig keeps it running on purpose beside the dashboard (the gateway, the public link, the router or a coding tool\'s server)';

const norm = (s) => String(s || '').replace(/\//g, '\\').toLowerCase();

/**
 * The old dashboard's tree in a table read before the task was ended: the wrapper(s) whose command line runs this
 * state folder's startup script, and the processes below them. Returns { members: [proc], why: Map(pid → reason) }
 * (why: a process below that is left, and the reason).
 */
export function treeOf(snap, script, kept = new Set()) {
  const members = [];
  const why = new Map();
  if (!snap) return { members, why };
  const all = [...snap.procs.values()];
  const queue = all.filter((p) => /powershell/i.test(p.name) && norm(p.cmd).includes(norm(script)));
  const seen = new Set();
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    members.push(p);
    for (const c of all) {
      if (c.ppid !== p.pid || c.pid === p.pid || seen.has(c.pid)) continue;
      if (kept.has(c.pid) || isRouter(c.cmd)) why.set(c.pid, KEPT_WHY);
      else if (c.start === null || p.start === null || c.start < p.start) why.set(c.pid, 'it started before the old dashboard (its process number was handed out again)');
      else queue.push(c);
    }
  }
  return { members, why };
}

/** This process and the ones above it, in a table. */
const selfAndAbove = (snap) => {
  const out = new Set([process.pid, process.ppid]);
  const seen = new Set([process.pid]);
  for (let p = process.pid, i = 0; snap && i < 64; i++) {
    const q = snap.procs.get(p)?.ppid;
    if (!Number.isInteger(q) || q <= 0 || seen.has(q)) break;
    seen.add(q);
    out.add(q);
    p = q;
  }
  return out;
};

/**
 * The old dashboard this command runs inside, from a table read before anything was ended: a member of its tree is this
 * command or above it (typed in one of its terminals, with or without a record). The serve's pid (else the member's),
 * or null. Ending that dashboard would end this command before the new one starts, so nothing may be ended then.
 */
export function insideTree(snap, script, kept = keptPids()) {
  const above = selfAndAbove(snap);
  const hit = treeOf(snap, script, kept).members.filter((p) => above.has(p.pid));
  if (!hit.length) return null;
  return (hit.find((p) => isHoprigServe(p.cmd)) || hit[0]).pid;
}

/**
 * After the old dashboard was ended: is its port free? If not, end the old tree (from `before`) and look again.
 * True when the port is free (or the system cannot tell); false after naming each holder that was not ended.
 */
export async function clearPort({ port, before, run, me = null, script, kept = keptPids(), say = console.log, err = console.error, sleep, tries = 20 }) {
  let snap = await readTree(port, run);
  if (!snap || !snap.held.length) return true;
  const { members, why } = treeOf(before, script, kept);
  const above = new Set([...selfAndAbove(snap), ...selfAndAbove(before)]);
  const refused = new Map(why);
  const ended = new Set();
  const nameHolders = () => {
    for (const pid of snap.held) {
      const name = snap.procs.get(pid)?.name || 'unknown program';
      const reason = refused.get(pid) || (kept.has(pid) ? KEPT_WHY : ended.has(pid) ? 'it did not end' : 'it is not part of the old dashboard');
      err(`Process ${pid} (${name}) holds port ${port} and was not ended: ${reason}.`);
    }
    return false;
  };
  // Ending the old tree frees the port only when the old tree holds it, every listener of it (the same program, by its
  // start). A program outside it (the person's own, another state folder's dashboard) is named, and nothing is ended.
  const inTree = new Map(members.map((p) => [p.pid, p]));
  if (!snap.held.every((pid) => inTree.has(pid) && snap.procs.get(pid)?.start === inTree.get(pid).start)) return nameHolders();
  // Only the chain from the wrapper down to each holder (the serve) is ended. What else runs below the serve keeps
  // running: a dashboard terminal and the programs in it, a coding tool, the go-live helper that takes a go-live back
  // after exactly this restart (on Windows a detached child still names the serve as its parent).
  const chain = new Set();
  for (const h of snap.held) for (let p = h; inTree.has(p) && !chain.has(p); p = inTree.get(p).ppid) chain.add(p);
  for (const p of members.filter((m) => chain.has(m.pid))) {
    const now = snap.procs.get(p.pid);
    if (!now || now.start !== p.start) continue; // gone, or another program under that number now
    let reason = null;
    if (above.has(p.pid)) reason = 'this command runs in it';
    else if (kept.has(p.pid)) reason = KEPT_WHY;
    else {
      const f = await processFacts(p.pid, { platform: 'win32', run, me });
      if (!f || !f.mine) reason = 'it runs as another account';
    }
    if (reason) {
      refused.set(p.pid, reason);
      continue;
    }
    await run('taskkill', taskkillArgs(p.pid));
    ended.add(p.pid);
    say(`Ended process ${p.pid} (${p.name || 'unknown program'}) of the old dashboard.`);
  }
  for (let i = 0; i < tries; i++) {
    snap = (await readTree(port, run)) || snap;
    if (!snap.held.length) return true;
    if (!snap.held.some((pid) => ended.has(pid))) break; // nothing that was ended still holds it: waiting changes nothing
    await sleep(500);
  }
  return nameHolders();
}

/**
 * After the start: wait until the new dashboard answers on its port as this state folder's, with a pid that is not
 * one of `old`. Its record when it did, null when it did not within `waitMs`.
 */
export async function waitForNew({ old = new Set(), file, fetchImpl = globalThis.fetch, sleep, now = Date.now, waitMs = 30_000 }) {
  const end = now() + waitMs;
  for (;;) {
    const rec = readRecord(file);
    if (rec && !old.has(rec.pid) && rec.state === stateKey()) {
      const a = await askHolder(rec, { fetchImpl });
      if (a && a.pid === rec.pid && a.state === stateKey()) return rec;
    }
    if (now() >= end) return null;
    await sleep(500);
  }
}

/** The last lines of a log file, or null. */
export function tail(file, lines = 15) {
  try {
    const all = fs.readFileSync(file, 'utf8').replace(/\s+$/, '').split(/\r?\n/);
    return all.slice(-lines).join('\n');
  } catch {
    return null;
  }
}
