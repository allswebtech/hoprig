// The desktop's system apps as a server feature: the Task manager, Services and Logs (web/desktop/tasks.js,
// services.js, logs.js). Every route sits behind the sign-in like its neighbours and works the same for another
// computer through the relay (/m/<computer>/api/…). Live views poll: only the terminal has a socket there.
//
//   GET  /api/system/usage                 { cpu: { total, cores[] } (%), mem, load, uptime, cpus, platform }
//   GET  /api/system/processes             { processes: [{ pid, ppid, user, name, args, rss, age, cpu, mine, guarded }], cpus }
//   POST /api/system/processes/end { pid, force? }   ends one of this user's processes; never this dashboard or a
//                                          process it runs inside (procs.mjs)
//   GET  /api/system/disks                 { disks: [{ mount, fs, size, used, avail }] }
//   GET  /api/system/network               { interfaces: [{ name, addresses, rx, tx, rxRate, txRate }], ports }
//   GET  /api/services?scope=user|system   { scope, scopes, readOnly, available, note, services: [{ name,
//                                          description, active, sub, enabled, own, ssh }] }
//   POST /api/services/action { scope, name, action: start|stop|restart, password?, confirm? }
//                                          { ok, output } or a question: { needsPassword, wrong?, notAllowed?,
//                                          plainLeg? } | { needsConfirm, why } (services.mjs has the rules)
//   GET  /api/services/logs?scope=&name=&lines=      { entries, note }
//   GET  /api/logs?scope=&unit=&priority=&lines=&after=|before=   the journal: { available, entries: [{ cursor,
//                                          time, priority, unit, pid, message }], note }
//   GET  /api/logs/files                   { files: [{ path, size, mtime }] } in the system's log folders
//   GET  /api/logs/file?path=&from=        { path, text, from, next, size, reset } (logs.mjs)
//
// `opts` (tests, the demo): { platform, os (an OS part), run, stream, readFile, adminNeeded, root, kill, parentLookup,
// logDirs, cpus }. Nothing here returns a password or a token: command lines and log lines are masked (redact).
import fs from 'node:fs';
import nodeOs from 'node:os';
import { tokenIdOf } from '../machines/index.mjs';
import { arrivedEncrypted } from '../machines/legs.mjs';
import { killProcess, parentLookup } from '../server/platform.mjs';
import { run } from '../server/platform/common.mjs';
import * as darwin from '../server/platform/darwin-system.mjs';
import * as linux from '../server/platform/linux-system.mjs';
import * as win32 from '../server/platform/win32-system.mjs';
import { stream } from '../setup/system.mjs';
import { journalQuery, listLogFiles, readLogFile, LINES_MAX } from './logs.mjs';
import { endProcess, guardedPids, processSampler } from './procs.mjs';
import { servicesPart } from './services.mjs';
import { addressesOf, cpuShare, cpuTimes, differ, netRates } from './usage.mjs';

export const OS_PARTS = { linux, darwin, win32 };
const UNIT_FILTER = /^(?!-)[A-Za-z0-9@._:\\-]{1,200}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

const readFileOrNull = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

export function desktopFeature(ctx, opts = {}) {
  const platform = opts.platform || process.platform;
  const os = opts.os || OS_PARTS[platform] || linux;
  const io = { run: opts.run || run, stream: opts.stream || stream, readFile: opts.readFile || readFileOrNull };
  const cpus = opts.cpus || (() => nodeOs.cpus());
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const root = opts.root ?? uid === 0;
  const dirs = () => (opts.logDirs || os.logDirs)();

  const sampler = processSampler(() => os.processes(io), { cores: () => cpus().length });
  const cpu = differ(() => cpuTimes(cpus()), (a, b) => cpuShare(a, b));
  const counters = differ(() => os.net(io), netRates);

  // sudo would ask for the computer's password (it does not when it is set up to trust this user without one).
  async function adminNeeded() {
    const r = await io.run('sudo', ['-n', 'true'], { timeout: 10_000 });
    if (!r.ok && /ENOENT/.test(r.stderr || '')) throw fail(409, 'sudo is not on this computer: the system\'s services can be changed only as root here.');
    return !r.ok;
  }
  const services = servicesPart({
    os, io, root,
    adminNeeded: opts.adminNeeded || adminNeeded,
    plainLeg: (req) => tokenIdOf(req) !== null && !arrivedEncrypted(req),
  });

  const routes = [
    ['GET', /^\/api\/system\/usage$/, async () => {
      const [c, mem] = await Promise.all([cpu(), os.memory(io)]);
      return { cpu: c, mem, load: platform === 'win32' ? null : nodeOs.loadavg(), uptime: nodeOs.uptime(), cpus: cpus().length, platform };
    }],
    ['GET', /^\/api\/system\/processes$/, async () => {
      const list = await sampler.sample();
      const parents = new Map(list.map((p) => [p.pid, p.ppid]));
      const guarded = guardedPids(process.pid, (pid) => (parents.has(pid) ? parents.get(pid) : null));
      return {
        processes: list.map(({ cpuTime, uid: u, ...p }) => ({ ...p, mine: uid === null || u === null || u === undefined ? null : u === uid, guarded: guarded.has(p.pid) })),
        cpus: cpus().length,
      };
    }],
    ['POST', /^\/api\/system\/processes\/end$/, async (req) => {
      const b = await ctx.readJson(req);
      const r = await endProcess(b.pid, { force: b.force === true, parentLookup: opts.parentLookup || parentLookup, kill: opts.kill || killProcess });
      if (!r.ok) throw fail(409, r.error);
      return { ok: true };
    }],
    ['GET', /^\/api\/system\/disks$/, async () => ({ disks: await os.disks(io) })],
    ['GET', /^\/api\/system\/network$/, async () => {
      const [rates, ports] = await Promise.all([counters(), os.ports(io)]);
      const addrs = addressesOf(opts.interfaces ? opts.interfaces() : undefined);
      const names = [...new Set([...rates.map((r) => r.name), ...addrs.keys()])];
      const byName = new Map(rates.map((r) => [r.name, r]));
      const interfaces = names.map((name) => {
        const r = byName.get(name) || { rx: null, tx: null, rxRate: null, txRate: null };
        return { name, addresses: addrs.get(name) || [], rx: r.rx, tx: r.tx, rxRate: r.rxRate, txRate: r.txRate };
      });
      return { interfaces, ports };
    }],
    ['GET', /^\/api\/services$/, async (req, m, q) => services.list(q.get('scope'))],
    ['POST', /^\/api\/services\/action$/, async (req) => services.act(await ctx.readJson(req), req)],
    ['GET', /^\/api\/services\/logs$/, async (req, m, q) => {
      const lines = Math.max(1, Math.min(LINES_MAX, Number(q.get('lines')) || 200));
      return services.logs(q.get('scope'), q.get('name'), lines);
    }],
    ['GET', /^\/api\/logs$/, async (req, m, q) => {
      if (!os.journal) return { available: false, entries: [], note: 'This computer has no journal: its logs are in the log files.' };
      return os.journal.read(io, journalQuery(q, { unitOk: (u) => UNIT_FILTER.test(u) }));
    }],
    ['GET', /^\/api\/logs\/files$/, async () => ({ files: listLogFiles(dirs()) })],
    ['GET', /^\/api\/logs\/file$/, async (req, m, q) => {
      const raw = q.get('from');
      const from = raw === null || raw === '' ? null : Number(raw);
      if (from !== null && !(Number.isSafeInteger(from) && from >= 0)) throw fail(400, 'from is a byte offset');
      return readLogFile(q.get('path'), dirs(), from);
    }],
  ];

  return { name: 'desktop', routes };
}
