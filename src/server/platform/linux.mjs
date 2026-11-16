// Linux: /proc, df, ps, ss, systemctl.
import fs from 'node:fs';
import os from 'node:os';
import { redact, run, splitHostPort, top, uniquePorts } from './common.mjs';

export function parseMeminfo(text) {
  const kb = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb[m[1]] = Number(m[2]) * 1024;
  }
  return {
    total: kb.MemTotal || os.totalmem(),
    available: kb.MemAvailable ?? os.freemem(),
    swapTotal: kb.SwapTotal || 0,
    swapFree: kb.SwapFree || 0,
  };
}

/** `df -P` output (sizes in `unit` bytes) → [{ mount, fs, size, used, avail }]. The mount point is last and may hold spaces. */
export function parseDf(text, unit = 1) {
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 6) continue;
    const [fsName, size, used, avail] = p;
    const mount = p.slice(5).join(' ');
    if (!Number(size)) continue;
    out.push({ fs: fsName, mount, size: Number(size) * unit, used: Number(used) * unit, avail: Number(avail) * unit });
  }
  return out;
}

/**
 * A kernel thread, not a program: it has no command line (ps then shows its name in brackets, "[kworker/0:1]") and
 * no memory of its own (rss 0). A person cannot recognise or stop one, so the lists leave them out.
 */
export const isKernelThread = (rawArgs, rssKb) => rssKb === 0 && /^\[.*\]$/.test(rawArgs);

/** `ps -eo pid,uid,pcpu,rss,etimes,comm,args` (no headers) → process list, without kernel threads. */
export function parsePs(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
    if (!m) continue;
    const raw = (m[7] || '').trim();
    if (isKernelThread(raw, +m[4])) continue;
    out.push({ pid: +m[1], uid: +m[2], cpu: +m[3], rss: +m[4] * 1024, age: +m[5], name: m[6], args: redact(raw || m[6]) });
  }
  return out;
}

/** `ss -Htlnp` → [{ addr, port, process, pid }]. The owner is only visible for our own processes without root. */
export function parseSs(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    const hp = splitHostPort(p[3]);
    if (!hp) continue;
    const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    out.push({ ...hp, process: users ? users[1] : '', pid: users ? Number(users[2]) : null });
  }
  return uniquePorts(out);
}

/** df for the disks a person cares about: sizes in bytes, without memory and image file systems. */
export const DF_ARGS = ['-P', '-B1', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs', '-x', 'overlay', '-x', 'efivarfs'];

const myUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);

export async function snapshot() {
  let mem;
  try {
    mem = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'));
  } catch {
    mem = { total: os.totalmem(), available: os.freemem(), swapTotal: null, swapFree: null };
  }
  const [df, ps, ss] = await Promise.all([
    run('df', DF_ARGS),
    run('ps', ['-eo', 'pid=,uid=,pcpu=,rss=,etimes=,comm=,args=']),
    run('ss', ['-Htlnp']),
  ]);
  const procs = parsePs(ps.stdout);
  const uid = myUid();
  const mine = (p) => p.uid === uid;
  return {
    host: os.hostname(),
    platform: process.platform,
    uptime: os.uptime(),
    load: os.loadavg(),
    cpus: os.cpus().length,
    mem,
    disks: parseDf(df.stdout),
    topCpu: top(procs, 'cpu', mine),
    topMem: top(procs, 'rss', mine),
    ports: parseSs(ss.stdout),
    errors: [df, ps, ss].filter((r) => !r.ok).map((r) => r.stderr).filter(Boolean),
  };
}

/** Owner uid of a process (from /proc), or null when it is gone or unknown. */
export function ownerOf(pid) {
  try {
    return fs.statSync(`/proc/${pid}`).uid;
  } catch {
    return null;
  }
}

/** Kill one of the user's own processes (the caller refuses this server itself). */
export function killOwn(pid, signal) {
  const owner = ownerOf(pid);
  if (owner === null) return { ok: false, error: 'no such process' };
  if (owner !== myUid()) return { ok: false, error: 'not your process' };
  return signalPid(pid, signal);
}

export function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.code === 'ESRCH' ? 'no such process' : e.code === 'EPERM' ? 'not your process' : e.message };
  }
}

/** systemctl reboot | poweroff. Returns the real error text when the system refuses (no polkit rule, etc.). */
export async function power(action) {
  const r = await run('systemctl', [action]);
  return r.ok ? { ok: true } : { ok: false, error: r.stderr || 'refused' };
}

/** Parent pid of a process, or null when unknown (gone, or no /proc). */
export function procParent(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // the process name may contain spaces and ")"
    return Number(rest[1]);
  } catch {
    return null;
  }
}

/** /proc answers one pid at a time, cheaply, so no snapshot is needed. */
export const parentLookup = async () => procParent;
