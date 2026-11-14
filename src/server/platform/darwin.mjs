// macOS: os, ps, df, vm_stat, sysctl, netstat, lsof, osascript. No /proc here, so everything comes from commands.
import os from 'node:os';
import path from 'node:path';
import { lookupFrom, parseParents, redact, run, runSync, splitHostPort, top, uniquePorts } from './common.mjs';
import { parseDf, signalPid } from './linux.mjs';

/**
 * `vm_stat` → available bytes: free + inactive + speculative pages, the memory macOS hands out without paging
 * anything out. Purgeable pages are already counted inside those, so they are not added again.
 */
export function parseVmStat(text) {
  const size = Number((/page size of (\d+) bytes/.exec(text) || [])[1]) || null;
  const pages = {};
  for (const line of text.split('\n')) {
    const m = /^(?:Pages )?([\w -]+?):\s+(\d+)\.?$/.exec(line.trim());
    if (m) pages[m[1].toLowerCase()] = Number(m[2]);
  }
  if (!size || pages.free === undefined) return null;
  return (pages.free + (pages.inactive || 0) + (pages.speculative || 0)) * size;
}

/** `sysctl -n vm.swapusage`: "total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)" → bytes. */
export function parseSwapUsage(text) {
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const get = (k) => {
    const m = new RegExp(`${k}\\s*=\\s*([\\d.]+)([KMGT])`).exec(text);
    return m ? Math.round(Number(m[1]) * unit[m[2]]) : null;
  };
  const total = get('total');
  const free = get('free');
  return total === null || free === null ? { swapTotal: null, swapFree: null } : { swapTotal: total, swapFree: free };
}

/**
 * `df -P -k -l` → disks. APFS lists the helper volumes of the system container (VM, Preboot, Update, …) and Xcode's
 * simulator images as separate mounts; they would only clutter the list. "/" (the sealed system) and
 * /System/Volumes/Data (where your files are) are kept: both live in one container and share its free space.
 */
export function parseDfMac(text) {
  return parseDf(text, 1024).filter(
    (d) =>
      d.fs.startsWith('/dev/') &&
      !(d.mount.startsWith('/System/Volumes/') && d.mount !== '/System/Volumes/Data') &&
      d.mount !== '/Volumes/Recovery' &&
      !d.mount.startsWith('/Library/Developer/CoreSimulator/'),
  );
}

/** ps `etime`: "[[dd-]hh:]mm:ss" → seconds. */
export function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return 0;
  return (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/**
 * Two ps outputs, because both the executable path (`comm`) and the command line (`args`) may contain spaces and
 * only the last column of one call can:
 *   stat: `ps -axo pid=,ppid=,uid=,pcpu=,rss=,etime=,comm=`
 *   args: `ps -axo pid=,args=`
 */
export function parsePsMac(stat, args = '') {
  const argsOf = new Map();
  for (const line of args.split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m) argsOf.set(Number(m[1]), m[2].trim());
  }
  const out = [];
  for (const line of stat.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s(.+)$/.exec(line);
    if (!m) continue;
    const pid = +m[1];
    const exe = m[7].trim();
    const name = path.posix.basename(exe) || exe;
    out.push({ pid, ppid: +m[2], uid: +m[3], cpu: +m[4], rss: +m[5] * 1024, age: parseEtime(m[6]), name, args: redact(argsOf.get(pid) || exe) });
  }
  return out;
}

/**
 * `netstat -an -p tcp` → every listening TCP socket (any user). macOS writes the port after a dot: "127.0.0.1.7433",
 * "::1.7433", "*.7433".
 */
export function parseNetstat(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 6 || !/^tcp/.test(p[0]) || p[5] !== 'LISTEN') continue;
    const hp = splitHostPort(p[3], '.');
    if (hp) out.push(hp);
  }
  return out;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pcn` → [{ pid, process, addr, port }]. Without root it sees only our processes. */
export function parseLsof(text) {
  const out = [];
  let pid = null;
  let cmd = '';
  for (const line of text.split('\n')) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') pid = Number(val);
    else if (tag === 'c') cmd = val;
    else if (tag === 'n') {
      const hp = splitHostPort(val);
      if (hp && pid) out.push({ ...hp, addr: hp.addr.replace(/^\[(.*)\]$/, '$1'), process: cmd, pid });
    }
  }
  return out;
}

/** netstat gives every port, lsof the owners it can see; joined by port, like `ss -p` on Linux. */
export function joinPorts(listening, owned) {
  const byPort = new Map();
  for (const o of owned) byPort.set(o.port, [...(byPort.get(o.port) || []), o]);
  const rows = [];
  for (const l of listening) {
    const owners = byPort.get(l.port);
    if (owners) for (const o of owners) rows.push({ addr: l.addr, port: l.port, process: o.process, pid: o.pid });
    else rows.push({ addr: l.addr, port: l.port, process: '', pid: null });
  }
  return uniquePorts(rows);
}

const myUid = () => process.getuid();

export async function snapshot() {
  const [vm, swap, df, ps, psArgs, ns, lsof] = await Promise.all([
    run('vm_stat', []),
    run('sysctl', ['-n', 'vm.swapusage']),
    run('df', ['-P', '-k', '-l']),
    run('ps', ['-axo', 'pid=,ppid=,uid=,pcpu=,rss=,etime=,comm=']),
    run('ps', ['-axo', 'pid=,args=']),
    run('netstat', ['-an', '-p', 'tcp']),
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']),
  ]);
  const procs = parsePsMac(ps.stdout, psArgs.stdout).map(({ ppid, ...p }) => p);
  const uid = myUid();
  const mine = (p) => p.uid === uid;
  const available = parseVmStat(vm.stdout);
  return {
    host: os.hostname(),
    platform: process.platform,
    uptime: os.uptime(),
    load: os.loadavg(),
    cpus: os.cpus().length,
    mem: { total: os.totalmem(), available: available ?? os.freemem(), ...parseSwapUsage(swap.stdout) },
    disks: parseDfMac(df.stdout),
    topCpu: top(procs, 'cpu', mine),
    topMem: top(procs, 'rss', mine),
    ports: joinPorts(parseNetstat(ns.stdout), parseLsof(lsof.stdout)),
    // lsof exits 1 when it finds nothing of ours listening; that is not an error worth showing.
    errors: [vm, df, ps, ns].filter((r) => !r.ok).map((r) => r.stderr).filter(Boolean),
  };
}

/** Owner uid of a process, or null when it is gone. */
export function ownerOf(pid) {
  const out = runSync('ps', ['-o', 'uid=', '-p', String(pid)]);
  const uid = out === null ? NaN : Number(out.trim());
  return Number.isInteger(uid) && out.trim() !== '' ? uid : null;
}

export function killOwn(pid, signal) {
  const owner = ownerOf(pid);
  if (owner === null) return { ok: false, error: 'no such process' };
  if (owner !== myUid()) return { ok: false, error: 'not your process' };
  return signalPid(pid, signal);
}

/**
 * Restart / shut down through System Events, as the Apple menu does: no root needed, but macOS asks once for
 * permission to control System Events, and an app with unsaved work can cancel it. The real error is passed on.
 */
export async function power(action) {
  const verb = action === 'reboot' ? 'restart' : 'shut down';
  const r = await run('osascript', ['-e', `tell application "System Events" to ${verb}`], { timeout: 15_000 });
  return r.ok ? { ok: true } : { ok: false, error: r.stderr || 'refused' };
}

/** No /proc: one-pid lookups would mean one ps call each, so the caller takes a snapshot with parentLookup(). */
export const procParent = () => null;

export async function parentLookup() {
  const r = await run('ps', ['-axo', 'pid=,ppid=']);
  return r.ok ? lookupFrom(parseParents(r.stdout)) : procParent;
}
