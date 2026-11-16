// The per-OS parts of the desktop's system apps (src/server/platform/*-system.mjs) read from recorded output of the
// system's programs (no program is run), and the parts every OS shares: the CPU share from two readings, network
// rates, which processes are guarded, and the log files (a temp folder stands in for the system's log folder).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as L from '../../src/server/platform/linux-system.mjs';
import * as D from '../../src/server/platform/darwin-system.mjs';
import * as W from '../../src/server/platform/win32-system.mjs';
import { guardedPids, processSampler } from '../../src/desktop/procs.mjs';
import { addressesOf, cpuShare, differ, netRates } from '../../src/desktop/usage.mjs';
import { insideLogDirs, journalQuery, listLogFiles, readLogFile } from '../../src/desktop/logs.mjs';
import { redact } from '../../src/server/platform/common.mjs';

const TOKEN = 'sk-' + 'A'.repeat(30);

test('Linux: ps and /proc give every process with its CPU time; kernel threads and secrets left out', async () => {
  const ps = [
    '      1       0     0 root                             16660   81309 /usr/lib/systemd/systemd --switched-root',
    '      2       0     0 root                                 0   81309 [kthreadd]',
    `   4242       1  1000 dev                              51200     300 node server.js --token=${TOKEN}`,
    '   4300    4242  1000 dev                               2048      10 ',
  ].join('\n');
  const stat = {
    '/proc/1/stat': '1 (systemd) S 0 1 1 0 -1 4194560 1 1 0 0 120 80 0 0 20 0 1 0 2 0 0',
    '/proc/4242/stat': '4242 (node (worker) x) R 1 4242 4242 0 -1 0 0 0 0 0 250 50 0 0 20 0 1 0 2 0 0',
  };
  const io = { run: async (cmd, args) => (assert.equal(cmd, 'ps'), assert.deepEqual(args, ['-eo', 'pid=,ppid=,uid=,user:32=,rss=,etimes=,args=']), { ok: true, stdout: ps }), readFile: (p) => stat[p] || null };
  const list = await L.processes(io);
  assert.deepEqual(list.map((p) => p.pid), [1, 4242, 4300]);
  const n = list.find((p) => p.pid === 4242);
  assert.equal(n.name, 'node (worker) x', 'the name in brackets, spaces and ")" kept');
  assert.equal(n.cpuTime, 3, '(250 + 50) ticks at 100 a second');
  assert.equal(n.user, 'dev');
  assert.equal(n.rss, 51200 * 1024);
  assert.ok(!n.args.includes(TOKEN) && n.args.includes('--token=***'));
  assert.equal(list.find((p) => p.pid === 4300).cpuTime, null, 'gone before /proc was read: no CPU time');
  assert.deepEqual(L.parseStat('garbage'), null);
});

test('Linux: /proc/net/dev counters, systemd units and unit files, the units the dashboard runs in', () => {
  const dev = 'Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets\n    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0\n  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0\n';
  assert.deepEqual(L.parseNetDev(dev), [{ name: 'lo', rx: 1000, tx: 1000 }, { name: 'eth0', rx: 5000, tx: 7000 }]);
  const units = [
    'cron.service              loaded    active   running Regular background program processing daemon',
    '● auditd.service          not-found inactive dead    auditd.service',
    'ssh.service               loaded    failed   failed  OpenBSD Secure Shell server',
  ].join('\n');
  assert.deepEqual(L.parseUnits(units).map((u) => [u.name, u.load, u.active, u.sub]), [['cron.service', 'loaded', 'active', 'running'], ['auditd.service', 'not-found', 'inactive', 'dead'], ['ssh.service', 'loaded', 'failed', 'failed']]);
  assert.deepEqual([...L.parseUnitFiles('cron.service enabled enabled\nfoo@.service static -\n').entries()], [['cron.service', 'enabled'], ['foo@.service', 'static']]);
  const own = L.ownUnits({ readFile: () => '0::/user.slice/user-1000.slice/user@1000.service/app.slice/my-dash.service\n' });
  assert.deepEqual([...own].sort(), ['hoprig.service', 'my-dash.service', 'user@1000.service']);
  for (const ok of ['cron.service', 'systemd-fsck@dev-disk-by\\x2duuid-1.service', 'user@1000.service']) assert.ok(L.services.nameOk(ok), ok);
  for (const bad of ['-x.service', 'cron', 'a b.service', 'a;b.service', '../x.service', '', 7]) assert.ok(!L.services.nameOk(bad), String(bad));
  assert.deepEqual(L.services.argv('user', 'restart', 'cron.service'), ['systemctl', '--user', 'restart', '--', 'cron.service']);
  assert.deepEqual(L.services.argv('system', 'stop', 'cron.service'), ['sudo', 'systemctl', 'stop', '--', 'cron.service']);
});

test('Linux: the service list joins loaded units and unit files; a missing systemd says so', async () => {
  const io = {
    run: async (cmd, args) => (args.includes('list-units')
      ? { ok: true, stdout: 'cron.service loaded active running Cron\n● gone.service not-found inactive dead gone.service\n' }
      : { ok: true, stdout: 'cron.service enabled enabled\nidle.service disabled enabled\ntpl@.service static -\nmasked.service masked enabled\n' }),
  };
  const r = await L.services.list(io, 'system');
  assert.deepEqual(r.services.map((s) => [s.name, s.active, s.enabled]), [['cron.service', 'active', 'enabled'], ['idle.service', 'inactive', 'disabled']]);
  const none = await L.services.list({ run: async () => ({ ok: false, stdout: '', stderr: 'System has not been booted with systemd' }) }, 'system');
  assert.equal(none.available, false);
  assert.match(none.note, /systemd does not answer/);
});

test('Linux: the journal is read with a cursor, older entries backwards, the note when only one\'s own are visible', async () => {
  assert.deepEqual(L.journalArgs({ lines: 50 }).slice(-2), ['-n', '50']);
  const a = L.journalArgs({ scope: 'user', unit: 'cron.service', priority: 3, after: 's=ab;i=1', lines: 10 });
  assert.ok(a.includes('--user'));
  assert.deepEqual(a.slice(a.indexOf('-u'), a.indexOf('-u') + 2), ['-u', 'cron.service']);
  assert.deepEqual(a.slice(-4), ['--after-cursor', 's=ab;i=1', '-n', '10']);
  assert.deepEqual(L.journalArgs({ before: 's=ab;i=1', lines: 10 }).slice(-5), ['-r', '--cursor', 's=ab;i=1', '-n', '11']);
  const line = (c, t, msg, extra = {}) => JSON.stringify({ __CURSOR: c, __REALTIME_TIMESTAMP: String(t * 1000), PRIORITY: '3', _SYSTEMD_UNIT: 'cron.service', _PID: '42', MESSAGE: msg, ...extra });
  const text = [line('s=1;i=3', 3000, 'third'), line('s=1;i=2', 2000, [104, 105]), line('s=1;i=1', 1000, `key ${TOKEN}`)].join('\n');
  const back = L.parseJournal(text, { before: 's=1;i=3' });
  assert.deepEqual(back.map((e) => e.cursor), ['s=1;i=1', 's=1;i=2'], 'the cursor itself left out, oldest first');
  assert.equal(back[1].message, 'hi', 'bytes read as text');
  assert.ok(!back[0].message.includes(TOKEN), 'a secret in a log line is masked');
  assert.deepEqual([back[0].time, back[0].priority, back[0].unit, back[0].pid], [1000, 3, 'cron.service', 42]);
  const limited = await L.journal.read({ run: async () => ({ ok: true, stdout: text, stderr: 'Hint: You are currently not seeing messages from other users and the system.' }) }, {});
  assert.match(limited.note, /Only your own entries/);
  const missing = await L.journal.read({ run: async () => ({ ok: false, stdout: '', stderr: 'spawn journalctl ENOENT' }) }, {});
  assert.equal(missing.available, false);
});

test('macOS: ps with CPU time, netstat -ib, launchctl lists and actions', async () => {
  assert.equal(D.parseCpuTime('1:02.50'), 62.5);
  assert.equal(D.parseCpuTime('1-02:00:01.00'), 26 * 3600 + 1);
  const stat = '  501     1   501 dev      20480   01:00:00    0:12.34 /Applications/Code Helper.app/Contents/MacOS/Code Helper\n    1     0     0 root      9000 2-00:00:00   10:00.00 /sbin/launchd\n';
  const args = '  501 /Applications/Code Helper.app/Contents/MacOS/Code Helper --type=renderer\n    1 /sbin/launchd\n';
  const p = D.parsePsFull(stat, args);
  assert.deepEqual([p[0].pid, p[0].user, p[0].name, p[0].cpuTime, p[0].age, p[0].rss], [501, 'dev', 'Code Helper', 12.34, 3600, 20480 * 1024]);
  assert.match(p[0].args, /--type=renderer/);
  const ib = 'Name  Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll\nlo0   16384 <Link#1>                        100     0      2000      100     0      2000     0\nen0   1500  <Link#4>    aa:bb:cc:dd:ee:ff   500     0     90000      400     0      30000     0\nen0   1500  192.168.1     192.168.1.5     500     -     90000      400     -      30000     -\n';
  assert.deepEqual(D.parseNetstatIb(ib), [{ name: 'lo0', rx: 2000, tx: 2000 }, { name: 'en0', rx: 90000, tx: 30000 }]);
  assert.deepEqual(D.parseLaunchctlList('PID\tStatus\tLabel\n123\t0\tcom.example.agent\n-\t78\tcom.example.broken\n-\t0\tcom.example.idle\n'), [
    { name: 'com.example.agent', pid: 123, status: 0 }, { name: 'com.example.broken', pid: null, status: 78 }, { name: 'com.example.idle', pid: null, status: 0 }]);
  assert.deepEqual(D.parseLaunchctlPrint('system = {\n\tservices = {\n\t\t       0      -    com.apple.x\n\t\t     88      0    com.openssh.sshd\n\t}\n}\n').map((x) => x.name), ['com.apple.x', 'com.openssh.sshd']);
  const r = await D.services.list({ run: async () => ({ ok: true, stdout: 'PID\tStatus\tLabel\n123\t0\tcom.example.agent\n-\t78\tcom.example.broken\n' }) }, 'user');
  assert.deepEqual(r.services.map((s) => [s.name, s.active]), [['com.example.agent', 'active'], ['com.example.broken', 'failed']]);
  assert.deepEqual(D.services.argv('system', 'restart', 'com.openssh.sshd'), ['sudo', 'launchctl', 'kickstart', '-k', 'system/com.openssh.sshd']);
  assert.equal(D.services.argv('user', 'stop', 'com.example.agent').slice(0, 3).join(' '), 'launchctl kill SIGTERM');
  assert.ok(D.services.isSsh('com.openssh.sshd'));
  assert.ok(D.services.own().has('local.hoprig.dashboard'));
  assert.ok(!D.services.nameOk('-x') && !D.services.nameOk('a/b'));
  assert.equal(D.journal, null, 'no journal: the log files instead');
});

test('Windows: processes, adapters and services from PowerShell\'s JSON; services are read-only', async () => {
  const procs = W.parseWinProcesses(JSON.stringify([{ pid: 4, ppid: 0, name: 'System', args: null, rss: 1e6, cpu: 120.5, age: 9000 }, { pid: 900, ppid: 4, name: 'node.exe', args: `node x.js --api-key ${TOKEN}`, rss: 5e7, cpu: 2, age: 60 }]));
  assert.deepEqual(procs.map((p) => [p.pid, p.name, p.cpuTime, p.user]), [[4, 'System', 120.5, null], [900, 'node.exe', 2, null]]);
  assert.ok(!procs[1].args.includes(TOKEN));
  assert.deepEqual(W.parseWinProcesses(JSON.stringify({ pid: 1, ppid: 0, name: 'one', rss: 1, cpu: 0, age: 1 })).length, 1, 'one object, not an array');
  assert.deepEqual(W.parseAdapterStats('{"Name":"Ethernet","ReceivedBytes":10,"SentBytes":20}'), [{ name: 'Ethernet', rx: 10, tx: 20 }]);
  const s = W.parseWinServices(JSON.stringify([{ Name: 'sshd', DisplayName: 'OpenSSH SSH Server', Status: 4, StartType: 2 }, { Name: 'Spooler', DisplayName: 'Print Spooler', Status: 'Stopped', StartType: 'Manual' }]));
  assert.deepEqual(s.map((x) => [x.name, x.active, x.sub, x.enabled]), [['sshd', 'active', 'running', 'enabled'], ['Spooler', 'inactive', 'stopped', 'manual']]);
  assert.equal(W.services.readOnly, true);
  assert.deepEqual(W.services.scopes, ['system']);
  assert.ok(W.services.isSsh('sshd'));
});

test('the CPU share of each process comes from two readings; a pid used again starts over', async () => {
  let t = 0;
  const readings = [
    [{ pid: 10, age: 100, cpuTime: 5 }, { pid: 11, age: 50, cpuTime: 1 }],
    [{ pid: 10, age: 101, cpuTime: 6 }, { pid: 11, age: 0, cpuTime: 0.1 }, { pid: 12, age: 0, cpuTime: null }],
  ];
  let i = 0;
  const s = processSampler(async () => readings[Math.min(i++, 1)], { cores: () => 2, now: () => t, sleep: async (ms) => (t += ms * 2) });
  const r = await s.sample(); // first: two readings, 1 s apart (the stand-in sleep doubles 500 ms)
  assert.deepEqual(r.map((p) => [p.pid, p.cpu]), [[10, 50], [11, null], [12, null]], '1 s of CPU in 1 s on 2 cores = 50 %; the new pid 11 has none yet');
  const again = await s.sample();
  assert.equal(again, r, 'asked again at once: the same answer');
  // The guard: this dashboard and every process above it.
  const parents = new Map([[500, 400], [400, 300], [300, 1]]);
  assert.deepEqual([...guardedPids(500, (p) => parents.get(p) ?? null)].sort((a, b) => a - b), [0, 1, 300, 400, 500]);
});

test('CPU of the computer and network rates from two readings; addresses without hardware ids', async () => {
  const a = [{ busy: 100, total: 1000 }, { busy: 0, total: 1000 }];
  const b = [{ busy: 600, total: 2000 }, { busy: 100, total: 2000 }];
  assert.deepEqual(cpuShare(a, b), { total: 30, cores: [50, 10] });
  assert.deepEqual(netRates([{ name: 'eth0', rx: 100, tx: 0 }], [{ name: 'eth0', rx: 300, tx: 50 }, { name: 'new', rx: 1, tx: 1 }], 2), [
    { name: 'eth0', rx: 300, tx: 50, rxRate: 100, txRate: 25 }, { name: 'new', rx: 1, tx: 1, rxRate: null, txRate: null }]);
  let t = 0;
  let n = 0;
  const d = differ(async () => ++n, (x, y, secs) => ({ x, y, secs }), { now: () => t, sleep: async (ms) => (t += ms) });
  assert.deepEqual(await d(), { x: 1, y: 2, secs: 0.4 });
  t += 2000;
  assert.deepEqual(await d(), { x: 2, y: 3, secs: 2 });
  const addrs = addressesOf({ eth0: [{ address: '10.0.0.2', family: 'IPv4', internal: false, mac: '02:00:00:00:00:01' }] });
  assert.deepEqual(addrs.get('eth0'), [{ address: '10.0.0.2', family: 'IPv4', internal: false }]);
});

test('log files: listed and read only inside the log folders, from an offset, rotated files start over', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-logs-'));
  try {
    const logs = path.join(root, 'log');
    const outside = path.join(root, 'secret.txt');
    fs.mkdirSync(path.join(logs, 'app'), { recursive: true });
    fs.writeFileSync(outside, 'not a log\n');
    fs.writeFileSync(path.join(logs, 'syslog'), 'one\ntwo\n');
    fs.writeFileSync(path.join(logs, 'app', 'app.log'), `token ${TOKEN}\n`);
    fs.writeFileSync(path.join(logs, 'old.log.2.gz'), 'packed');
    fs.writeFileSync(path.join(logs, 'wtmp'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(logs, 'bin.log'), Buffer.from([65, 0, 66, 10]));
    fs.symlinkSync(outside, path.join(logs, 'link.log'));
    const dirs = [logs];
    const names = listLogFiles(dirs).map((f) => path.relative(logs, f.path)).sort();
    assert.deepEqual(names, ['app/app.log', 'bin.log', 'syslog'], 'no packed copies, no login records, no link out');
    const first = readLogFile(path.join(logs, 'syslog'), dirs);
    assert.deepEqual([first.text, first.next], ['one\ntwo\n', 8]);
    fs.appendFileSync(path.join(logs, 'syslog'), 'three\npart');
    const more = readLogFile(path.join(logs, 'syslog'), dirs, first.next);
    assert.deepEqual([more.text, more.next], ['three\n', 14], 'a line still being written comes next time');
    fs.writeFileSync(path.join(logs, 'syslog'), 'new\n');
    const rotated = readLogFile(path.join(logs, 'syslog'), dirs, more.next);
    assert.deepEqual([rotated.reset, rotated.text], [true, 'new\n']);
    assert.ok(!readLogFile(path.join(logs, 'app', 'app.log'), dirs).text.includes(TOKEN));
    for (const bad of [outside, path.join(logs, 'link.log'), path.join(logs, '..', 'secret.txt'), 'log/syslog', `${logs}/syslog\0`, path.join(logs, 'old.log.2.gz'), path.join(logs, 'nope')]) {
      assert.equal(insideLogDirs(bad, dirs), null, bad);
      assert.throws(() => readLogFile(bad, dirs), (e) => e.status === 404, bad);
    }
    assert.throws(() => readLogFile(path.join(logs, 'bin.log'), dirs), (e) => e.status === 415);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('log files: a FIFO or other special file is refused at once, never waited on; a link swapped in is not followed', { skip: process.platform === 'win32' && 'no FIFOs on Windows' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-fifo-'));
  try {
    const logs = path.join(root, 'log');
    fs.mkdirSync(logs);
    const fifo = path.join(logs, 'pipe.log');
    execFileSync('mkfifo', [fifo]);
    // Synchronous: a blocking open would hang this very line (and the whole server with it), so the time says it.
    const t0 = Date.now();
    assert.throws(() => readLogFile(fifo, [logs]), (e) => e.status === 404);
    assert.ok(Date.now() - t0 < 1000, 'answered at once');
    assert.deepEqual(listLogFiles([logs]), [], 'not listed either');
    // A followed file swapped for a link out of the log folders between two reads: refused, the outside not read.
    const outside = path.join(root, 'secret.txt');
    fs.writeFileSync(outside, 'outside\n');
    const followed = path.join(logs, 'app.log');
    fs.writeFileSync(followed, 'one\n');
    assert.equal(readLogFile(followed, [logs]).text, 'one\n');
    fs.rmSync(followed);
    fs.symlinkSync(outside, followed);
    assert.throws(() => readLogFile(followed, [logs], 0), (e) => e.status === 404);
    // And for a FIFO swapped in for the followed file.
    fs.rmSync(followed);
    execFileSync('mkfifo', [followed]);
    assert.throws(() => readLogFile(followed, [logs], 4), (e) => e.status === 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('log files: a line longer than one read is given in parts, so Follow moves on past it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-long-'));
  try {
    const f = path.join(root, 'app.log');
    fs.writeFileSync(f, 'first\n');
    const a = readLogFile(f, [root]);
    assert.equal(a.next, 6);
    // 300 KiB with no line end (é is two bytes, so a cut could fall inside one), then more lines.
    fs.appendFileSync(f, `${'é'.repeat(150 * 1024)}\nafter\n`);
    const parts = [];
    let at = a.next;
    for (let i = 0; i < 5 && at < fs.statSync(f).size; i++) {
      const r = readLogFile(f, [root], at);
      assert.ok(r.next > at, `read ${i} moved on`);
      parts.push(r.text);
      at = r.next;
    }
    const all = parts.join('');
    assert.ok(!all.includes('\ufffd'), 'no character cut in half');
    assert.ok(all.startsWith('éé') && all.endsWith('\nafter\n'), 'the long line (clipped for the page) and the line after it');
    assert.equal(at, fs.statSync(f).size);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('secrets on command lines and in log lines are masked: URL passwords, token shapes, password options', async () => {
  const secrets = ['S3cretPw', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'glpat-abcdefghijklmnopqrstu', 'xoxb-1234567890-abcdef', 'AKIAABCDEFGHIJKLMNOP', `AIza${'b'.repeat(35)}`, 'YWRtaW46cGFzcw=='];
  const lines = [
    'git clone https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x.git',
    'DATABASE_URL=postgres://app:S3cretPw@db/x',
    'mysql -uroot -pS3cretPw shop',
    'curl -u admin:S3cretPw https://example.com',
    'sshpass -p S3cretPw ssh host',
    'git push https://glpat-abcdefghijklmnopqrstu@gitlab.example.com/x',
    'notify --slack xoxb-1234567890-abcdef',
    'aws AKIAABCDEFGHIJKLMNOP',
    `maps key=AIza${'b'.repeat(35)}`,
    'Authorization: Basic YWRtaW46cGFzcw==',
  ];
  const leaks = (text) => secrets.filter((x) => text.includes(x));
  // Kept as they are: options that only look alike.
  for (const plain of ['mkdir -p /tmp/x', 'ssh -p 22 host', 'tar -xpf a.tar', 'mysql -u root -p shop', 'https://example.com/a?b=c', 'Basic setup done']) {
    assert.equal(redact(plain, 400), plain);
  }
  // The process list.
  const ps = lines.map((l, i) => `   ${5000 + i}       1  1000 dev   2048   10 ${l}`).join('\n');
  const procs = await L.processes({ run: async () => ({ ok: true, stdout: ps }), readFile: () => null });
  assert.equal(procs.length, lines.length);
  assert.deepEqual(leaks(procs.map((p) => p.args).join('\n')), []);
  assert.ok(procs[0].args.includes('https://bot:***@github.com') && procs[3].args.includes('-u admin:***'));
  // The journal.
  const journal = lines.map((l, i) => JSON.stringify({ __CURSOR: `s=1;i=${i + 1}`, __REALTIME_TIMESTAMP: '1000', MESSAGE: l })).join('\n');
  assert.deepEqual(leaks(L.parseJournal(journal, {}).map((e) => e.message).join('\n')), []);
  // A log file.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-mask-'));
  try {
    fs.writeFileSync(path.join(root, 'app.log'), `${lines.join('\n')}\n`);
    const r = readLogFile(path.join(root, 'app.log'), [root]);
    assert.deepEqual(leaks(r.text), []);
    assert.equal(r.text.split('\n').length, lines.length + 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux: units that can cut the computer off ask for their name before a stop or restart', () => {
  for (const u of ['ssh.service', 'sshd.service', 'NetworkManager.service', 'systemd-networkd.service', 'tailscaled.service', 'wg-quick@wg0.service', 'cloudflared.service', 'caddy.service', 'dbus.service', 'systemd-logind.service', 'user@1000.service']) {
    assert.match(L.cutsOff(u) || '', /cut this computer off|end every program/, u);
  }
  for (const u of ['cron.service', 'docker.service', 'postgresql.service', 'nginx.service', 'networkd-dispatcher.service']) assert.equal(L.cutsOff(u), null, u);
});

test('the journal query from the page is checked: scope, unit, priority 0-7, one cursor', () => {
  const q = (s) => journalQuery(new URLSearchParams(s), { unitOk: (u) => /^(?!-)[A-Za-z0-9@._:\\-]{1,200}$/.test(u) });
  assert.deepEqual(q('unit=cron&priority=3&lines=5000'), { scope: 'system', unit: 'cron', priority: 3, lines: 1000, after: null, before: null });
  for (const bad of ['scope=root', 'unit=-x', 'unit=a b', 'priority=8', 'priority=x', 'after=$(id)', 'after=s=1&before=s=2']) assert.throws(() => q(bad), (e) => e.status === 400, bad);
});
