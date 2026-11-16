// Linux parts of the desktop's system apps (src/desktop): every process with the CPU time it used (from /proc),
// memory, disks, listening ports, network counters, the services of systemd and the journal.
//
// Every function takes `io` = { run(cmd, args, opts) → { ok, stdout, stderr }, readFile(path) → text | null }, so the
// tests and the demo give stand-ins for the system's programs and files. Arguments are always arrays; a name that
// comes from the page is checked by the caller (src/desktop) before it gets here, and follows a "--" as well.
import path from 'node:path';
import { UNIT } from '../service/systemd.mjs';
import { redact } from './common.mjs';
import { DF_ARGS, isKernelThread, parseDf, parseMeminfo, parseSs } from './linux.mjs';

/** Clock ticks per second of /proc's CPU times (getconf CLK_TCK): 100 on every Linux that runs Node. */
export const TICKS = 100;

/** `ps -eo pid=,ppid=,uid=,user:32=,rss=,etimes=,args=` → [{ pid, ppid, uid, user, rss, age, args }], no kernel threads. */
export function parsePsAll(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (!m) continue;
    const raw = (m[7] || '').trim();
    if (isKernelThread(raw, +m[5])) continue;
    out.push({ pid: +m[1], ppid: +m[2], uid: +m[3], user: m[4], rss: +m[5] * 1024, age: +m[6], args: raw });
  }
  return out;
}

/**
 * /proc/<pid>/stat → { name, ticks } (user + system CPU time in clock ticks), or null. The name is in brackets and
 * may itself hold spaces and ")", so the fields are counted from the last ")".
 */
export function parseStat(text) {
  const s = String(text || '');
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const rest = s.slice(close + 2).split(' '); // rest[0] is field 3 (state); utime is field 14, stime 15
  const ticks = Number(rest[11]) + Number(rest[12]);
  return Number.isFinite(ticks) ? { name: s.slice(open + 1, close), ticks } : null;
}

/** Every process: { pid, ppid, uid, user, name, args, rss, age, cpuTime (seconds used, null when unknown) }. */
export async function processes(io) {
  const r = await io.run('ps', ['-eo', 'pid=,ppid=,uid=,user:32=,rss=,etimes=,args=']);
  if (!r.ok) throw new Error(r.stderr || 'ps failed');
  return parsePsAll(r.stdout).map((p) => {
    const st = parseStat(io.readFile(`/proc/${p.pid}/stat`));
    const exe = p.args.split(' ')[0] || '';
    return { ...p, name: st ? st.name : path.posix.basename(exe), args: redact(p.args || exe, 300), cpuTime: st ? st.ticks / TICKS : null };
  });
}

export const memory = (io) => parseMeminfo(io.readFile('/proc/meminfo') || '');

export async function disks(io) {
  const r = await io.run('df', DF_ARGS);
  return parseDf(r.stdout || '');
}

export async function ports(io) {
  const r = await io.run('ss', ['-Htlnp']);
  return parseSs(r.stdout || '');
}

/** /proc/net/dev → [{ name, rx, tx }] in bytes since the start. */
export function parseNetDev(text) {
  const out = [];
  for (const line of String(text || '').split('\n').slice(2)) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length >= 9) out.push({ name: m[1], rx: f[0], tx: f[8] });
  }
  return out;
}

export const net = (io) => parseNetDev(io.readFile('/proc/net/dev'));

// ---------- services: systemd ----------

/** A unit name as systemd writes it (escaped names keep their "\x2d"); never one that looks like an option. */
export const UNIT_RE = /^(?!-)[A-Za-z0-9@._:\\-]{1,200}\.service$/;

/** `systemctl list-units --type=service --all --plain --no-legend` → [{ name, load, active, sub, description }]. */
export function parseUnits(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(?:[●*]\s+)?(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) out.push({ name: m[1], load: m[2], active: m[3], sub: m[4], description: m[5].trim() });
  }
  return out;
}

/** `systemctl list-unit-files --type=service --plain --no-legend` → Map(name → enabled | disabled | static | …). */
export function parseUnitFiles(text) {
  const map = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\S+\.service)\s+(\S+)/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

/**
 * The units this dashboard runs inside, from /proc/self/cgroup ("0::/user.slice/user-1000.slice/user@1000.service/
 * app.slice/hoprig.service"): stopping any of them stops the dashboard. Hoprig's own unit name is always among them.
 */
export function ownUnits(io) {
  const own = new Set([UNIT]);
  for (const line of String(io.readFile('/proc/self/cgroup') || '').split('\n')) {
    for (const part of line.split(':').slice(2).join(':').split('/')) if (part.endsWith('.service')) own.add(part);
  }
  return own;
}

export const SSH_UNITS = new Set(['ssh.service', 'sshd.service']);

// Besides SSH, units whose stop cuts the computer off the network or ends every program of a signed-in user (this
// dashboard among them): stopping or restarting one asks for its name to be typed, like SSH.
const NETWORK_UNITS = /^(NetworkManager|systemd-networkd|networking|wpa_supplicant|tailscaled|zerotier-one|cloudflared|caddy|wg-quick@[^/]+|openvpn(?:-client|-server)?(?:@[^/]+)?)\.service$/;
const SESSION_UNITS = /^(dbus|dbus-broker|systemd-logind|user@\d+)\.service$/;

/** Why stopping unit `name` could cut this computer or this dashboard off, or null. */
export function cutsOff(name) {
  if (SSH_UNITS.has(name)) return 'Stopping SSH can cut this computer off: nobody can sign in to it over the network until it runs again.';
  if (NETWORK_UNITS.test(name)) return 'Stopping it can cut this computer off the network: nobody may reach it, or this page, until it runs again.';
  if (SESSION_UNITS.test(name)) return 'Stopping it can end every program of the signed-in users, this dashboard among them.';
  return null;
}

export const services = {
  scopes: ['user', 'system'],
  readOnly: false,
  nameOk: (name) => typeof name === 'string' && UNIT_RE.test(name),
  isSsh: (name) => SSH_UNITS.has(name),
  cutsOff,
  own: ownUnits,
  /** { available, note, services: [{ name, description, active, sub, enabled }] }. Unit files that are not loaded show as stopped. */
  async list(io, scope) {
    const u = scope === 'user' ? ['--user'] : [];
    const [units, files] = await Promise.all([
      io.run('systemctl', [...u, 'list-units', '--type=service', '--all', '--plain', '--no-legend', '--no-pager'], { timeout: 15_000 }),
      io.run('systemctl', [...u, 'list-unit-files', '--type=service', '--plain', '--no-legend', '--no-pager'], { timeout: 15_000 }),
    ]);
    if (!units.ok) return { available: false, note: `systemd does not answer here (${(units.stderr || 'no systemctl').split('\n')[0]}).`, services: [] };
    const state = parseUnitFiles(files.stdout || '');
    const seen = new Set();
    const list = [];
    for (const x of parseUnits(units.stdout)) {
      if (x.load === 'not-found' || seen.has(x.name)) continue; // a name something refers to, with no unit behind it
      seen.add(x.name);
      list.push({ name: x.name, description: x.description, active: x.active, sub: x.sub, enabled: state.get(x.name) || null });
    }
    for (const [name, en] of state) {
      // A template ("x@.service") is not a service by itself; its instances show when they run.
      if (seen.has(name) || name.includes('@.') || en === 'masked' || en === 'alias') continue;
      list.push({ name, description: '', active: 'inactive', sub: 'dead', enabled: en });
    }
    return { available: true, note: null, services: list.sort((a, b) => a.name.localeCompare(b.name)) };
  },
  /** The argv of an action. The system's units go through sudo (the caller adds the password flow). */
  argv: (scope, action, name) => (scope === 'user' ? ['systemctl', '--user', action, '--', name] : ['sudo', 'systemctl', action, '--', name]),
  /** The last lines of one unit's log. */
  logs: (io, scope, name, lines) => journal.read(io, { scope, unit: name, lines }),
};

// ---------- the journal ----------

/** A journal cursor ("s=…;i=…;b=…;m=…;t=…;x=…"): hex fields only. */
export const CURSOR_RE = /^[a-z]=[0-9a-f]{1,64}(;[a-z]=[0-9a-f]{1,64}){0,9}$/;
const FIELDS = 'MESSAGE,PRIORITY,_SYSTEMD_UNIT,_SYSTEMD_USER_UNIT,SYSLOG_IDENTIFIER,_COMM,_PID';

/**
 * journalctl's argv. Without a cursor: the last `lines` entries. `after`: the next `lines` entries after that one
 * (a follow reads on from where it was). `before`: up to `lines` entries before that one (newest first; reversed
 * by the parser).
 */
export function journalArgs({ scope = 'system', unit = null, priority = null, after = null, before = null, lines = 200 } = {}) {
  const a = ['--no-pager', '--all', '-o', 'json', `--output-fields=${FIELDS}`];
  if (scope === 'user') a.push('--user');
  if (unit) a.push('-u', unit);
  if (priority !== null && priority !== undefined) a.push('-p', String(priority));
  if (after) a.push('--after-cursor', after, '-n', String(lines));
  else if (before) a.push('-r', '--cursor', before, '-n', String(lines + 1));
  else a.push('-n', String(lines));
  return a;
}

/** A journal field's text: a string, or an array of bytes for text that is not valid UTF-8. */
const fieldText = (v) => (Array.isArray(v) ? Buffer.from(v.filter((n) => Number.isInteger(n))).toString('utf8') : v === null || v === undefined ? '' : String(v));

/** journalctl -o json lines → [{ cursor, time (ms), priority, unit, pid, message }] oldest first. */
export function parseJournal(text, { before = null } = {}) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('{')) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof j.__CURSOR !== 'string' || (before && j.__CURSOR === before)) continue;
    out.push({
      cursor: j.__CURSOR,
      time: Math.round(Number(j.__REALTIME_TIMESTAMP) / 1000) || null,
      priority: Number.isInteger(Number(j.PRIORITY)) ? Number(j.PRIORITY) : 6,
      unit: fieldText(j._SYSTEMD_USER_UNIT || j._SYSTEMD_UNIT || j.SYSLOG_IDENTIFIER || j._COMM).slice(0, 120),
      pid: Number(j._PID) || null,
      // Secrets sometimes end up in a log line (a token on a command line): masked like everywhere else.
      message: redact(fieldText(j.MESSAGE), 4000),
    });
  }
  return before ? out.reverse() : out;
}

export const journal = {
  /** { available, entries, note }. A user outside the journal's groups sees only their own entries: the note says so. */
  async read(io, q) {
    const r = await io.run('journalctl', journalArgs(q), { timeout: 20_000 });
    if (!r.ok && !r.stdout) return { available: false, entries: [], note: `The journal cannot be read here (${(r.stderr || 'no journalctl').split('\n')[0]}).` };
    const limited = /not seeing messages from other users/i.test(r.stderr || '');
    return { available: true, entries: parseJournal(r.stdout, q), note: limited ? 'Only your own entries: the system\'s are for members of the adm or systemd-journal group.' : null };
  },
};

/** Folders of plain log files (the Logs app's "Files"). */
export const logDirs = () => ['/var/log'];
