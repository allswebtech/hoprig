// The macOS and Windows platform modules: parsers against output in the exact format the real commands print
// (macOS samples taken from a real Mac, Windows samples in the shape PowerShell 5.1's ConvertTo-Json prints), and,
// on the matching OS, the real commands themselves.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as darwin from '../../src/server/platform/darwin.mjs';
import * as win from '../../src/server/platform/win32.mjs';
import { lookupFrom, parseParents } from '../../src/server/platform/common.mjs';
import * as platform from '../../src/server/platform.mjs';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     6480.
Pages active:                                 292132.
Pages inactive:                               290954.
Pages speculative:                               497.
Pages throttled:                                   0.
Pages wired down:                             180037.
Pages purgeable:                                2491.
"Translation faults":                    19047406937.
File-backed pages:                            113015.
Pages occupied by compressor:                 226313.
`;

const DF = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s3s1   971350180  13334288  58749036    19%    /
/dev/disk3s6     971350180  10486956  58749036    16%    /System/Volumes/VM
/dev/disk3s4     971350180  10627552  58749036    16%    /System/Volumes/Preboot
/dev/disk2s2        512000      6164    490920     2%    /System/Volumes/xarts
/dev/disk3s1     971350180 876419432  58749036    94%    /System/Volumes/Data
/dev/disk3s5     971350180   1503256  58749036     3%    /Volumes/Recovery
/dev/disk5s1       6967296   6480480    463244    94%    /Library/Developer/CoreSimulator/Volumes/iOS_20E247
/dev/disk8s1     500000000 100000000 400000000    20%    /Volumes/My Backup
map auto_home            0         0         0   100%    /System/Volumes/Data/home
`;

const PS_STAT = `    1     0     0   0.0  14576 02-09:51:53 /sbin/launchd
  247     1   501   0.0  15056 02-08:21:08 /Applications/Rectangle.app/Contents/MacOS/Rectangle
 9629  9548   501  10.0 1434176 02-09:32:02 /Applications/Some App.app/Contents/Frameworks/Some Helper (Renderer).app/Contents/MacOS/Some Helper (Renderer)
80501 80400   501 117.4 457216    00:09 node
`;
const PS_ARGS = `    1 /sbin/launchd
  247 /Applications/Rectangle.app/Contents/MacOS/Rectangle
 9629 /Applications/Some App.app/Contents/Frameworks/Some Helper (Renderer).app/Contents/MacOS/Some Helper (Renderer) --type=renderer
80501 node build.js --api-key sk-ant-abcdefghijklmnop
`;

const NETSTAT = `Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)
tcp4       0      0  127.0.0.1.7433         *.*                    LISTEN
tcp6       0      0  ::1.7433               *.*                    LISTEN
tcp4       0      0  *.5000                 *.*                    LISTEN
tcp46      0      0  *.22                   *.*                    LISTEN
tcp4       0      0  127.0.0.1.49699        127.0.0.1.58822        ESTABLISHED
udp4       0      0  *.5353                 *.*
`;
const LSOF = `p647
cControlCenter
f9
n*:5000
f10
n*:5000
p4242
cnode
f21
n127.0.0.1:7433
f22
n[::1]:7433
`;

test('macOS: memory, swap, disks', () => {
  assert.equal(darwin.parseVmStat(VM_STAT), (6480 + 290954 + 497) * 16384);
  assert.equal(darwin.parseVmStat('garbage'), null);
  assert.deepEqual(darwin.parseSwapUsage('total = 10240.00M  used = 8795.12M  free = 1444.88M  (encrypted)'), {
    swapTotal: 10240 * 1024 ** 2, swapFree: Math.round(1444.88 * 1024 ** 2),
  });
  assert.deepEqual(darwin.parseSwapUsage('total = 0.00M  used = 0.00M  free = 0.00M'), { swapTotal: 0, swapFree: 0 });
  assert.deepEqual(darwin.parseSwapUsage(''), { swapTotal: null, swapFree: null }, 'unknown stays null');
  const d = darwin.parseDfMac(DF);
  assert.deepEqual(d.map((x) => x.mount), ['/', '/System/Volumes/Data', '/Volumes/My Backup']);
  assert.equal(d[1].used, 876419432 * 1024);
});

test('macOS: processes (names and arguments with spaces, secrets masked, ps elapsed time)', () => {
  assert.equal(darwin.parseEtime('02-09:51:53'), 2 * 86400 + 9 * 3600 + 51 * 60 + 53);
  assert.equal(darwin.parseEtime('01:02:03'), 3723);
  assert.equal(darwin.parseEtime('00:09'), 9);
  const p = darwin.parsePsMac(PS_STAT, PS_ARGS);
  assert.equal(p.length, 4);
  assert.deepEqual(p[2].name, 'Some Helper (Renderer)');
  assert.match(p[2].args, /--type=renderer$/);
  assert.equal(p[2].rss, 1434176 * 1024);
  assert.equal(p[2].ppid, 9548);
  assert.equal(p[3].cpu, 117.4);
  assert.equal(p[3].age, 9);
  assert.equal(p[3].args.includes('sk-ant'), false);
  assert.equal(darwin.parsePsMac(PS_STAT, '')[1].args, '/Applications/Rectangle.app/Contents/MacOS/Rectangle', 'no args: the path');
});

test('macOS: listening ports joined with their owners', () => {
  const listening = darwin.parseNetstat(NETSTAT);
  assert.deepEqual(listening.map((x) => `${x.addr} ${x.port}`), ['127.0.0.1 7433', '::1 7433', '* 5000', '* 22']);
  const owned = darwin.parseLsof(LSOF);
  assert.deepEqual(owned.map((x) => `${x.pid} ${x.addr} ${x.port}`), ['647 * 5000', '647 * 5000', '4242 127.0.0.1 7433', '4242 ::1 7433']);
  assert.deepEqual(darwin.joinPorts(listening, owned), [
    { addr: '*', port: 22, process: '', pid: null },
    { addr: '*', port: 5000, process: 'ControlCenter', pid: 647 },
    { addr: '127.0.0.1', port: 7433, process: 'node', pid: 4242 },
  ]);
});

test('process table → ancestry', () => {
  const map = parseParents('  1 0\n 100 1\n 110 100\nbad line\n');
  const parentOf = lookupFrom(map);
  assert.equal(parentOf(110), 100);
  assert.equal(parentOf(5), null);
  assert.equal(platform.descendsFrom(110, 100, parentOf), true);
  assert.equal(platform.descendsFrom(100, 110, parentOf), false);
});

test('macOS, for real on this machine', { skip: process.platform !== 'darwin' && 'not macOS' }, async () => {
  const s = await platform.snapshot();
  assert.equal(s.platform, 'darwin');
  assert.equal(s.load.length, 3);
  assert.ok(s.cpus > 0 && s.uptime > 0);
  assert.ok(s.mem.total > 0 && s.mem.available > 0 && s.mem.available <= s.mem.total, JSON.stringify(s.mem));
  assert.ok(Number.isFinite(s.mem.swapTotal) && Number.isFinite(s.mem.swapFree));
  assert.ok(s.disks.some((d) => d.mount === '/'), 'the root volume is listed');
  assert.ok(s.disks.every((d) => d.size > 0 && d.used >= 0 && d.avail >= 0));
  assert.ok(s.topCpu.length > 0 && s.topMem.length > 0);
  // rss 0 is a true answer: under the runner ps lists only this test's own processes, and one that started this
  // moment (the other commands of the same snapshot) has no memory counted yet.
  assert.ok(s.topMem.every((p) => Number.isInteger(p.pid) && Number.isInteger(p.uid) && p.rss >= 0 && typeof p.name === 'string'), JSON.stringify(s.topMem.map((p) => [p.pid, p.uid, p.rss, typeof p.name])));
  assert.ok(s.topMem.some((p) => p.mine), 'some of the biggest processes are ours');
  assert.ok(Array.isArray(s.ports));
  assert.deepEqual(s.errors, []);
  assert.equal(darwin.ownerOf(process.pid), process.getuid());
  // Pid 1 (root's) is refused either way: by its owner, or, under the runner, whose ps answers only for this test's own
  // processes, as not there. The refusal of another user's process is proved in test/server/platform.test.mjs.
  assert.equal(darwin.ownerOf(2 ** 30), null);
  assert.equal(platform.killProcess(1).ok, false);
  assert.match(platform.killProcess(2 ** 30).error, /no such process/);
  assert.match(platform.killProcess(process.pid).error, /dashboard itself/);
  const parentOf = await platform.parentLookup();
  assert.equal(parentOf(process.pid), process.ppid);
  assert.equal(platform.procParent(process.pid), null, 'single lookups need the snapshot on macOS');
});

// What SNAPSHOT_SCRIPT prints: one object; arrays of one element stay arrays (they are built with @()).
const WIN_JSON = JSON.stringify({
  mem: { totalKB: 16641284, freeKB: 8123456 },
  pagefiles: [{ sizeMB: 2432, usedMB: 120 }],
  disks: [{ id: 'C:', size: 510770802688, free: 210770802688 }, { id: 'D:', size: 0, free: 0 }],
  procs: [
    { pid: 0, ppid: 0, name: 'System Idle Process', args: null, rss: 8192, age: 90000, cpu: 0 },
    { pid: 4, ppid: 0, name: 'System', args: null, rss: 4505600, age: 90000, cpu: 1.2 },
    { pid: 5120, ppid: 812, name: 'node.exe', args: '"C:\\Program Files\\nodejs\\node.exe" C:\\app\\bin\\hoprig.mjs serve --token=abc123', rss: 81264640, age: 3600, cpu: 2.5 },
    { pid: 7344, ppid: 5120, name: 'claude.exe', args: 'claude --resume x', rss: 301264640, age: 600, cpu: 14 },
    { pid: 1688, ppid: 640, name: 'svchost.exe', args: null, rss: 21264640, age: 90000, cpu: 0.1 },
  ],
  owners: { 5120: 'S-1-5-21-1-2-3-1001', 7344: 's-1-5-21-1-2-3-1001', 1688: 'S-1-5-18', 4: '', 0: '' },
  ports: [
    { addr: '0.0.0.0', port: 445, pid: 4 },
    { addr: '127.0.0.1', port: 7433, pid: 5120 },
    { addr: '::', port: 135, pid: 1688 },
    { addr: '0.0.0.0', port: 135, pid: 1688 },
  ],
});

test('Windows: the PowerShell snapshot', () => {
  const s = win.parseWinSnapshot(WIN_JSON, 'S-1-5-21-1-2-3-1001');
  assert.deepEqual(s.mem, { total: 16641284 * 1024, available: 8123456 * 1024, swapTotal: 2432 * 1024 ** 2, swapFree: (2432 - 120) * 1024 ** 2 });
  assert.deepEqual(s.disks, [{ fs: 'C:', mount: 'C:\\', size: 510770802688, used: 300000000000, avail: 210770802688 }]);
  assert.deepEqual(s.topCpu.map((p) => [p.name, p.mine]), [['claude.exe', true], ['node.exe', true], ['System', false], ['svchost.exe', false], ['System Idle Process', false]]);
  assert.equal(s.topCpu[0].uid, null, 'no numeric uid on Windows');
  assert.equal(s.topCpu[1].args.includes('abc123'), false, 'secrets masked');
  assert.equal(s.topCpu.find((p) => p.name === 'svchost.exe').args, 'svchost.exe', 'hidden command line: the name stands in');
  assert.deepEqual(s.ports, [
    { addr: '::', port: 135, process: 'svchost.exe', pid: 1688 },
    { addr: '0.0.0.0', port: 445, process: 'System', pid: null },
    { addr: '127.0.0.1', port: 7433, process: 'node.exe', pid: 5120 },
  ]);
  // ConvertTo-Json prints a lone object (not an array) where a pipeline had one result
  const lone = win.parseWinSnapshot(JSON.stringify({ mem: { totalKB: 1, freeKB: 1 }, pagefiles: null, disks: { id: 'C:', size: 10, free: 4 }, procs: { pid: 9, name: 'a.exe', rss: 1, age: 1, cpu: 0 }, owners: {}, ports: null }), 'X\\y');
  assert.equal(lone.disks.length, 1);
  assert.equal(lone.topMem.length, 1);
  assert.deepEqual([lone.mem.swapTotal, lone.mem.swapFree], [0, 0], 'no page file: no swap');
  assert.throws(() => win.parseWinSnapshot('not json'));
});

// The commands that make Windows PowerShell 5.1 load a module at their first use (about 17 s in a fresh home).
const MODULE_WORDS = [/\bGet-/i, /\bSet-/i, /\bNew-Object\b/i, /\bInvoke-/i, /\bConvertTo-Json\b/i, /\bSelect-Object\b/i, /\bSort-Object\b/i, /\bWhere-Object\b/i, /\bForEach-Object\b/i, /\bWrite-/i, /\bOut-/i, /\bImport-Module\b/i];

test('Windows: the snapshot, the owner, the parents and the account are asked without a PowerShell module', () => {
  for (const [what, script] of [['snapshot', win.SNAPSHOT_SCRIPT], ['owner', win.ownerScript(5120)], ['parents', win.PARENTS_SCRIPT], ['account', win.SID_SCRIPT]]) {
    for (const word of MODULE_WORDS) assert.doesNotMatch(script, word, `${what}: ${word}`);
  }
  // The snapshot's JSON has the shape parseWinSnapshot reads: each key the script writes is one the parser takes.
  for (const key of ['mem = ', 'totalKB = ', 'freeKB = ', 'pagefiles = ', 'sizeMB = ', 'usedMB = ', 'disks = ', 'id = ', 'size = ', 'free = ', 'procs = ', 'pid = ', 'ppid = ', 'name = ', 'args = ', 'rss = ', 'age = ', 'cpu = ', 'owners = ', 'ports = ', 'addr = ', 'port = ']) {
    assert.ok(win.SNAPSHOT_SCRIPT.includes(key), key);
  }
  // Listening ports from the class Get-NetTCPConnection reads, Listen being its state 2.
  assert.match(win.SNAPSHOT_SCRIPT, /'root\\StandardCimv2' 'SELECT LocalAddress,LocalPort,OwningProcess FROM MSFT_NetTCPConnection WHERE State=2'/);
  assert.match(win.PARENTS_SCRIPT, /ProcessId = \[int\]\$p\['ProcessId'\]; ParentProcessId = \[int\]\$p\['ParentProcessId'\]/);
  // Every script writes its JSON through Emit: plain ASCII, any other letter as \uXXXX (the console's code page would
  // turn some into control bytes no JSON reader takes).
  assert.match(win.NO_MODULE_PRELUDE, /function Emit\(\$v\) \{ \[Console\]::Out\.Write\(\[regex\]::Replace\(\$json\.Serialize\(\$v\), '\[\^\\x20-\\x7e\]', \{ param\(\$m\) '\\u\{0:x4\}' -f \[int\]\[char\]\$m\.Value \}\)\) \}/);
  for (const script of [win.SNAPSHOT_SCRIPT, win.PARENTS_SCRIPT]) {
    assert.match(script, /^Emit /m);
    assert.doesNotMatch(script, /\[Console\]::Out\.Write\(\$json/, 'never the serializer\'s own text, which may hold letters the console changes');
  }
  // What .NET's JavaScriptSerializer writes for it: keys in a hashtable's own order, every number plain. Read the same.
  const dotnet = '{"ports":[{"pid":4,"port":445,"addr":"0.0.0.0"},{"pid":5120,"port":7433,"addr":"127.0.0.1"},{"pid":1688,"port":135,"addr":"::"},{"pid":1688,"port":135,"addr":"0.0.0.0"}],'
    + '"owners":{"0":"","4":"","5120":"S-1-5-21-1-2-3-1001","7344":"s-1-5-21-1-2-3-1001","1688":"S-1-5-18"},'
    + '"procs":[{"cpu":0,"ppid":0,"rss":8192,"args":null,"age":90000,"name":"System Idle Process","pid":0},{"cpu":1.2,"ppid":0,"rss":4505600,"args":null,"age":90000,"name":"System","pid":4},'
    + '{"cpu":2.5,"ppid":812,"rss":81264640,"args":"\\"C:\\\\Program Files\\\\nodejs\\\\node.exe\\" C:\\\\app\\\\bin\\\\hoprig.mjs serve --token=abc123","age":3600,"name":"node.exe","pid":5120},'
    + '{"cpu":14,"ppid":5120,"rss":301264640,"args":"claude --resume x","age":600,"name":"claude.exe","pid":7344},{"cpu":0.1,"ppid":640,"rss":21264640,"args":null,"age":90000,"name":"svchost.exe","pid":1688}],'
    + '"disks":[{"free":210770802688,"size":510770802688,"id":"C:"},{"free":0,"size":0,"id":"D:"}],"pagefiles":[{"usedMB":120,"sizeMB":2432}],"mem":{"freeKB":8123456,"totalKB":16641284}}';
  assert.deepEqual(win.parseWinSnapshot(dotnet, 'S-1-5-21-1-2-3-1001'), win.parseWinSnapshot(WIN_JSON, 'S-1-5-21-1-2-3-1001'));
  // An empty list stays a list ([] where ConvertTo-Json gave null), and a machine that said nothing of its memory.
  const bare = win.parseWinSnapshot('{"ports":[],"owners":{},"procs":[],"disks":[],"pagefiles":[],"mem":{}}', 'S-1-5-21-1-2-3-1001');
  assert.deepEqual([bare.topCpu, bare.disks, bare.ports, bare.mem.swapTotal], [[], [], [], 0]);
  assert.ok(bare.mem.total > 0, 'the memory Node knows stands in');
});

test('a program that failed without a word says how it ended: its exit code, a signal or the time limit', async () => {
  const { endedHow, run } = await import('../../src/server/platform/common.mjs');
  assert.equal(endedHow(Object.assign(new Error('Command failed: tar -czf x'), { code: 1 })), ' (exit code 1)');
  assert.equal(endedHow(Object.assign(new Error('x'), { code: null, signal: 'SIGTERM' })), ' (ended by SIGTERM)');
  assert.equal(endedHow(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' })), ' (killed: it took too long)');
  assert.equal(endedHow(Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })), '', 'a start that failed says so itself');
  const r = await run(process.execPath, ['-e', 'process.exit(3)'], { timeout: 20_000 });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /^Command failed: .* \(exit code 3\)$/);
});

test('Windows: command arguments', () => {
  const args = win.psArgs("Get-Date; 'x'");
  assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  assert.equal(Buffer.from(args[5], 'base64').toString('utf16le'), "Get-Date; 'x'", 'UTF-16LE base64, as PowerShell expects');
  assert.match(win.ownerScript(5120), /WHERE ProcessId=5120'/);
  assert.throws(() => win.ownerScript('1; Remove-Item C:\\'), /bad pid/);
  assert.throws(() => win.ownerScript(1.5), /bad pid/);
  assert.deepEqual(win.taskkillArgs(42, 'SIGTERM'), ['/PID', '42']);
  assert.deepEqual(win.taskkillArgs(42, 'SIGKILL'), ['/PID', '42', '/F']);
  assert.deepEqual(win.shutdownArgs('reboot'), ['/r', '/t', '0']);
  assert.deepEqual(win.shutdownArgs('poweroff'), ['/s', '/t', '0']);
  assert.equal(win.sameUser('S-1-5-21-1-2-3-1001', 's-1-5-21-1-2-3-1001'), true);
  assert.equal(win.sameUser('', ''), false);
  const parents = win.parseParentsJson('[{"ProcessId":7344,"ParentProcessId":5120},{"ProcessId":5120,"ParentProcessId":812}]');
  assert.equal(parents.get(7344), 5120);
  assert.equal(win.parseParentsJson('{"ProcessId":1,"ParentProcessId":0}').get(1), 0);
  assert.doesNotMatch(win.SNAPSHOT_SCRIPT, /\$\{/, 'no JavaScript interpolation leaked into the script');
});

test('power refuses anything but the two actions', async () => {
  assert.equal((await platform.power('rm -rf /')).ok, false);
});
