import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { killProcess, parseDf, parseMeminfo, parsePs, parseSs, power, redact } from '../../src/server/platform.mjs';

test('meminfo', () => {
  const m = parseMeminfo('MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\nSwapTotal: 2000 kB\nSwapFree: 1000 kB\n');
  assert.deepEqual(m, { total: 16000000 * 1024, available: 8000000 * 1024, swapTotal: 2048000, swapFree: 1024000 });
});

test('df', () => {
  const d = parseDf('Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/sda2 1000 400 600 40% /\n/dev/sdb1 2000 1000 1000 50% /mnt/my disk\nnone 0 0 0 - /x\n');
  assert.deepEqual(d.map((x) => x.mount), ['/', '/mnt/my disk']);
  assert.equal(d[0].used, 400);
});

test('ps, with secrets masked', () => {
  const p = parsePs('  123  1000  5.5  2048  60 node node server.js --token=abc123 --api-key xyz\n    7     0  0.0     0   9 kthreadd\n');
  assert.equal(p.length, 2);
  assert.equal(p[0].pid, 123);
  assert.equal(p[0].rss, 2048 * 1024);
  assert.equal(p[0].args.includes('abc123'), false);
  assert.equal(p[0].args.includes('xyz'), false);
  assert.equal(p[1].args, 'kthreadd');
  assert.equal(redact('curl -H Bearer sk-ant-abcdefghijkl'), 'curl -H Bearer ***');
  assert.equal(redact('PASSWORD=hunter2 run'), 'PASSWORD=*** run');
  assert.equal(redact('/usr/bin/gnome-keyring-daemon --start'), '/usr/bin/gnome-keyring-daemon --start');
});

test('ps on Linux: kernel threads (no command line, no memory) are no programs and are left out', () => {
  const p = parsePs([
    '    2     0  0.0     0 400 kthreadd        [kthreadd]',
    '   57     0  0.3     0 400 kworker/0:1-ev  [kworker/0:1-events]',
    '  812     0  0.0     0 400 rcu_sched       [rcu_sched]',
    ' 1200  1000 12.5 204800 300 node           node /srv/app/server.js',
    ' 1300  1000  0.1  51200 300 bash           -bash',
    ' 1400  1000  0.0   2048 300 [weird]        [weird] --a-program-named-with-brackets',
  ].join('\n'));
  assert.deepEqual(p.map((x) => x.pid), [1200, 1300, 1400]);
});

test('ss', () => {
  const s = parseSs('LISTEN 0 511 127.0.0.1:7433 0.0.0.0:* users:(("node",pid=4242,fd=21))\nLISTEN 0 4096 [::]:22 [::]:*\n');
  assert.deepEqual(s, [
    { addr: '[::]', port: 22, process: '', pid: null },
    { addr: '127.0.0.1', port: 7433, process: 'node', pid: 4242 },
  ]);
});

test('kill refuses this server and a pid that does not exist', () => {
  assert.equal(killProcess(process.pid).ok, false);
  assert.equal(killProcess(2 ** 30).ok, false);
});

// A process of another user to try the refusal on: pid 1, where /proc says it is not ours. On an ordinary Linux
// system it is root's; in a container started as this user it is our own (the call would signal it), and root
// may signal every process.
function someoneElsesPid() {
  if (process.platform !== 'linux' || process.getuid() === 0) return null;
  try {
    return fs.statSync('/proc/1').uid === process.getuid() ? null : 1;
  } catch {
    return null;
  }
}

test('kill refuses a process of another user', { skip: someoneElsesPid() === null && 'no process of another user here (not Linux, running as root, or pid 1 is this user\'s own)' }, () => {
  assert.match(killProcess(someoneElsesPid()).error, /not your process/);
});

test('power only takes the two actions', async () => {
  assert.equal((await power('rm -rf /')).ok, false);
});
