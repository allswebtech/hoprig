// The desktop's Task manager, Services and Logs in the demo: sample processes, services, journal entries and one
// log file, so the demo never shows the computer it runs on and never changes anything on it. A service started or
// stopped in the demo changes only this sample; ending a process is refused, as it is for the sample processes on
// the PC page. Any password is taken as the computer's password here (the demo has no real one to check).
import fs from 'node:fs';
import path from 'node:path';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** The sample processes of the main demo computer, or of its second one ("Laptop"). */
function sampleProcesses(secondary) {
  // The demo's own processes carry this user's id, so the page offers to end them (the demo then refuses).
  const me = typeof process.getuid === 'function' ? process.getuid() : 501;
  const p = (pid, ppid, user, name, args, rssMb, age) => ({ pid, ppid, uid: user === 'demo' ? me : user === 'root' ? 0 : me + 7, user, name, args, rss: rssMb * MB, age });
  return secondary
    ? [p(1, 0, 'root', 'systemd', '/sbin/init', 12, 900_000), p(4120, 1, 'demo', 'node', 'node scripts/backup.mjs', 90, 4000), p(4188, 1, 'demo', 'claude', 'claude', 240, 3000)]
    : [
      p(1, 0, 'root', 'systemd', '/sbin/init splash', 14, 900_000),
      p(612, 1, 'root', 'sshd', 'sshd: /usr/sbin/sshd -D [listener]', 9, 900_000),
      p(840, 1, 'postgres', 'postgres', 'postgres -D /var/lib/postgresql/16/main', 210, 880_000),
      p(1975, 1, 'demo', 'tmux', 'tmux new-session -d -s blog-a1', 8, 86_000),
      p(1980, 1, 'demo', 'hoprig', 'node hoprig dashboard', 120, 86_000),
      p(2311, 1980, 'demo', 'node', 'node node_modules/.bin/next dev', 610, 7200),
      p(2402, 1980, 'demo', 'claude', 'claude --resume', 380, 5400),
      p(2518, 1980, 'demo', 'claude', 'claude', 300, 3600),
      p(2601, 1, 'demo', 'python3', 'python3 -m pipeline.run --dry-run', 150, 1800),
      p(2690, 1, 'demo', 'node', 'node src/server.js', 120, 1200),
    ];
}
// How busy each sample process is (share of one core); the rest idle.
const BUSY = { 2311: 0.42, 2402: 0.13, 2518: 0.05, 2601: 0.33, 840: 0.06, 1980: 0.02, 4120: 0.03 };

const SERVICES = [
  ['cron.service', 'Regular background program processing daemon', 'enabled'],
  ['docker.service', 'Docker Application Container Engine', 'enabled'],
  ['nginx.service', 'A high performance web server and a reverse proxy server', 'disabled'],
  ['postgresql.service', 'PostgreSQL RDBMS', 'enabled'],
  ['ssh.service', 'OpenBSD Secure Shell server', 'enabled'],
  ['ufw.service', 'Uncomplicated firewall', 'enabled'],
];
const USER_SERVICES = [
  ['hoprig.service', 'Hoprig dashboard', 'enabled'],
  ['backup.service', 'Nightly backup of the projects folder', 'enabled'],
  ['pipewire.service', 'PipeWire Multimedia Service', 'enabled'],
];
const JOURNAL = [
  [6, 'cron.service', 'pam_unix(cron:session): session opened for user demo'],
  [6, 'sshd.service', 'Accepted publickey for demo from 192.0.2.10 port 51234 ssh2'],
  [4, 'nginx.service', 'nginx: [warn] the "listen ... http2" directive is deprecated'],
  [6, 'postgresql.service', 'checkpoint complete: wrote 42 buffers (0.3%)'],
  [3, 'backup.service', 'backup: the folder ~/projects/old-site cannot be read: permission denied'],
  [6, 'docker.service', 'Container 3f2a started'],
  [5, 'kernel', 'usb 1-2: new high-speed USB device number 7'],
  [6, 'hoprig.service', 'session blog-a1 started under the provider "team"'],
];

/** Options for desktopFeature() (src/desktop/feature.mjs) in the demo. `dir`: a folder of the demo for its log file. */
export function demoDesktop(dir, secondary = false) {
  const t0 = Date.now();
  const procs = sampleProcesses(secondary);
  const state = new Map([...SERVICES, ...USER_SERVICES].map(([n]) => [n, !['nginx.service'].includes(n)]));
  const logDir = path.join(dir, 'log');
  fs.mkdirSync(logDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(logDir, 'syslog'), JOURNAL.map(([, u, m], i) => `${day}T09:${String(10 + i).padStart(2, '0')}:00 demo ${u.replace('.service', '')}: ${m}\n`).join(''));
  const secs = () => (Date.now() - t0) / 1000;
  const journalEntries = () => {
    // One entry every 20 seconds of the demo's life after the samples, so "Follow" has something to show.
    const extra = Math.floor(secs() / 20);
    const all = [...JOURNAL, ...Array.from({ length: extra }, (_, i) => [6, 'cron.service', `(CRON) job ${i + 1} ran`])];
    return all.map(([priority, unit, message], i) => ({ cursor: `s=d;i=${(i + 1).toString(16)}`, time: t0 - (JOURNAL.length - i) * 60_000 + Math.max(0, i - JOURNAL.length + 1) * 20_000, priority, unit, pid: 1000 + i, message }));
  };
  const listOf = (rows) => rows.map(([name, description, enabled]) => ({
    name, description, enabled, active: state.get(name) ? 'active' : 'inactive', sub: state.get(name) ? 'running' : 'dead',
  }));
  const os = {
    processes: async () => procs.map((p) => ({ ...p, cpuTime: (BUSY[p.pid] || 0.001) * secs() })),
    memory: async () => ({ total: 32 * GB, available: 19.4 * GB, swapTotal: 4 * GB, swapFree: 3.6 * GB }),
    disks: async () => [
      { mount: '/', fs: '/dev/nvme0n1p2', size: 476 * GB, used: 301 * GB, avail: 151 * GB },
      { mount: '/home/data', fs: '/dev/sda1', size: 1863 * GB, used: 712 * GB, avail: 1056 * GB },
    ],
    ports: async () => (secondary ? [] : [
      { addr: '127.0.0.1', port: 3000, process: 'node', pid: 2311 },
      { addr: '0.0.0.0', port: 22, process: 'sshd', pid: 612 },
      { addr: '127.0.0.1', port: 5432, process: 'postgres', pid: 840 },
    ]),
    net: async () => [
      { name: 'lo', rx: Math.round(secs() * 20_000), tx: Math.round(secs() * 20_000) },
      { name: 'eth0', rx: Math.round(secs() * 310_000), tx: Math.round(secs() * 42_000) },
    ],
    services: {
      scopes: ['user', 'system'],
      readOnly: false,
      nameOk: (n) => typeof n === 'string' && /^[A-Za-z0-9@._:-]{1,200}\.service$/.test(n),
      isSsh: (n) => n === 'ssh.service' || n === 'sshd.service',
      own: () => new Set(['hoprig.service']),
      list: async (io, scope) => ({ available: true, note: null, services: listOf(scope === 'user' ? USER_SERVICES : SERVICES) }),
      argv: (scope, action, name) => (scope === 'user' ? ['systemctl', '--user', action, '--', name] : ['sudo', 'systemctl', action, '--', name]),
      logs: async (io, scope, name, lines) => ({ entries: journalEntries().filter((e) => e.unit === name).slice(-lines), note: null }),
    },
    journal: {
      read: async (io, q) => {
        let all = journalEntries().filter((e) => (!q.unit || e.unit === q.unit) && (q.priority === null || e.priority <= q.priority));
        const at = (c) => all.findIndex((e) => e.cursor === c);
        if (q.after) all = all.slice(at(q.after) + 1);
        else if (q.before) all = all.slice(0, Math.max(0, at(q.before)));
        return { available: true, entries: all.slice(-q.lines), note: null };
      },
    },
    logDirs: () => [logDir],
  };
  // A service action: the sample changes; sudo's password check always passes.
  const act = (argv) => {
    const name = argv[argv.length - 1];
    const action = argv[argv.length - 3];
    if (state.has(name)) state.set(name, action !== 'stop');
    return { ok: true, code: 0, stdout: '', stderr: '', output: '' };
  };
  return {
    platform: 'linux',
    os,
    cpus: () => Array.from({ length: secondary ? 4 : 8 }, (_, i) => {
      const busy = Math.round(1000 * (secs() * (0.12 + 0.08 * i) + 0.3 * Math.sin(secs() / 3 + i))); // a wobble around a steady share
      return { times: { user: busy, nice: 0, sys: 0, idle: Math.round(secs() * 1000) - busy + 1_000_000, irq: 0 } };
    }),
    interfaces: () => ({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [{ address: '192.0.2.24', family: 'IPv4', internal: false }, { address: 'fe80::1c2:3ff:fe4d:5e6f', family: 'IPv6', internal: false }],
    }),
    run: async (cmd, args) => (cmd === 'systemctl' ? act(args) : { ok: false, stdout: '', stderr: 'not in the demo' }),
    stream: async (argv) => (argv.includes('systemctl') ? act(argv) : { ok: true, code: 0, output: '' }),
    host: { loadavg: () => [1.8, 1.5, 1.2], uptime: () => 3 * 86400 + 5 * 3600 + 12 * 60 + secs() },
    readFile: () => null,
    adminNeeded: async () => true,
    root: false,
    kill: async () => ({ ok: false, error: 'not in the demo: nothing on this computer is ended' }),
    parentLookup: async () => (pid) => (procs.find((p) => p.pid === pid) || {}).ppid ?? null,
    // The sample dashboard and the tmux server of its sessions show locked, as the real ones do.
    self: secondary ? process.pid : 1980,
    sessionHosts: async () => (secondary ? [] : [1975]),
    logDirs: () => [logDir],
  };
}
