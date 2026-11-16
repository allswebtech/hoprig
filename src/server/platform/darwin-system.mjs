// macOS parts of the desktop's system apps (src/desktop): every process with the CPU time it used (ps), memory,
// disks, listening ports, network counters (netstat -ib) and the services of launchd. macOS has no journal the
// way Linux does (`log show` is slow and has no cursor), so the Logs app reads the log files there.
//
// `io` as in linux-system.mjs. Written to the same shape as the Linux part; checked by the tests with recorded
// output, not yet run on a Mac.
import os from 'node:os';
import path from 'node:path';
import { LABEL } from '../service/launchd.mjs';
import { redact } from './common.mjs';
import { joinPorts, parseDfMac, parseEtime, parseLsof, parseNetstat, parseSwapUsage, parseVmStat } from './darwin.mjs';

/** ps `time`: "[dd-][hh:]mm:ss[.cc]" → seconds of CPU used. */
export function parseCpuTime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(s).trim());
  if (!m) return null;
  return (Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/**
 * Two ps outputs, because only the last column of one call may hold spaces:
 *   stat: `ps -axo pid=,ppid=,uid=,user=,rss=,etime=,time=,comm=`
 *   args: `ps -axo pid=,args=`
 */
export function parsePsFull(stat, args = '') {
  const argsOf = new Map();
  for (const line of String(args).split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m) argsOf.set(Number(m[1]), m[2].trim());
  }
  const out = [];
  for (const line of String(stat).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s(.+)$/.exec(line);
    if (!m) continue;
    const pid = +m[1];
    const exe = m[8].trim();
    out.push({ pid, ppid: +m[2], uid: +m[3], user: m[4], rss: +m[5] * 1024, age: parseEtime(m[6]), cpuTime: parseCpuTime(m[7]), name: path.posix.basename(exe) || exe, args: redact(argsOf.get(pid) || exe, 300) });
  }
  return out;
}

export async function processes(io) {
  const [st, args] = await Promise.all([io.run('ps', ['-axo', 'pid=,ppid=,uid=,user=,rss=,etime=,time=,comm=']), io.run('ps', ['-axo', 'pid=,args='])]);
  if (!st.ok) throw new Error(st.stderr || 'ps failed');
  return parsePsFull(st.stdout, args.stdout);
}

export async function memory(io) {
  const [vm, swap] = await Promise.all([io.run('vm_stat', []), io.run('sysctl', ['-n', 'vm.swapusage'])]);
  return { total: os.totalmem(), available: parseVmStat(vm.stdout || '') ?? os.freemem(), ...parseSwapUsage(swap.stdout || '') };
}

export async function disks(io) {
  return parseDfMac((await io.run('df', ['-P', '-k', '-l'])).stdout || '');
}

export async function ports(io) {
  const [ns, lsof] = await Promise.all([io.run('netstat', ['-an', '-p', 'tcp']), io.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'])]);
  return joinPorts(parseNetstat(ns.stdout || ''), parseLsof(lsof.stdout || ''));
}

/**
 * `netstat -ibn` → [{ name, rx, tx }]. The byte counts are on each interface's "<Link#n>" row; the address column
 * may be empty there, so the numbers are counted from the end (… Ibytes Opkts Oerrs Obytes Coll).
 */
export function parseNetstatIb(text) {
  const out = [];
  for (const line of String(text).split('\n').slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 8 || !/^<Link#\d+>$/.test(p[2])) continue;
    const rx = Number(p[p.length - 5]);
    const tx = Number(p[p.length - 2]);
    if (Number.isFinite(rx) && Number.isFinite(tx)) out.push({ name: p[0].replace(/\*$/, ''), rx, tx });
  }
  return out;
}

export const net = async (io) => parseNetstatIb((await io.run('netstat', ['-ibn'])).stdout || '');

// ---------- services: launchd ----------

/** A launchd label (reverse-DNS style), never one that looks like an option. */
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `launchctl list` → [{ name, pid, status }]: "PID\tStatus\tLabel", "-" where none. */
export function parseLaunchctlList(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(-|\d+)\s+(-|-?\d+)\s+(\S+)\s*$/.exec(line);
    if (m && LABEL_RE.test(m[3])) out.push({ name: m[3], pid: m[1] === '-' ? null : Number(m[1]), status: m[2] === '-' ? null : Number(m[2]) });
  }
  return out;
}

/** `launchctl print system` → the same rows, from its "services = { … }" block ("pid  status  label"). */
export function parseLaunchctlPrint(text) {
  const s = String(text);
  const start = s.indexOf('services = {');
  if (start < 0) return [];
  const end = s.indexOf('}', start);
  return parseLaunchctlList(s.slice(start + 12, end < 0 ? undefined : end));
}

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : 0);
const target = (scope, name) => (scope === 'user' ? `gui/${uid()}/${name}` : `system/${name}`);

export const services = {
  scopes: ['user', 'system'],
  readOnly: false,
  nameOk: (name) => typeof name === 'string' && LABEL_RE.test(name),
  isSsh: (name) => name === 'com.openssh.sshd',
  own: () => new Set([LABEL]),
  async list(io, scope) {
    const r = scope === 'user' ? await io.run('launchctl', ['list']) : await io.run('launchctl', ['print', 'system']);
    if (!r.ok) return { available: false, note: `launchd does not answer here (${(r.stderr || 'no launchctl').split('\n')[0]}).`, services: [] };
    const rows = scope === 'user' ? parseLaunchctlList(r.stdout) : parseLaunchctlPrint(r.stdout);
    const list = rows.map((x) => ({
      name: x.name,
      description: '',
      active: x.pid ? 'active' : x.status ? 'failed' : 'inactive',
      sub: x.pid ? `running, pid ${x.pid}` : x.status ? `last exit ${x.status}` : 'not running',
      enabled: null,
    }));
    return { available: true, note: null, services: list.sort((a, b) => a.name.localeCompare(b.name)) };
  },
  // kickstart starts it (-k: stops it first, a restart); kill asks it to stop (one kept alive by launchd comes back).
  argv(scope, action, name) {
    const a = action === 'stop' ? ['kill', 'SIGTERM', target(scope, name)] : ['kickstart', ...(action === 'restart' ? ['-k'] : []), target(scope, name)];
    return scope === 'user' ? ['launchctl', ...a] : ['sudo', 'launchctl', ...a];
  },
  logs: async () => ({ available: true, entries: [], note: 'launchd keeps no log of its own for each service: see the Logs app for the log files.' }),
};

export const journal = null;

export const logDirs = (home = os.homedir()) => ['/var/log', '/Library/Logs', path.join(home, 'Library', 'Logs')];
