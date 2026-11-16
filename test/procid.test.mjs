// A process's identity beyond its pid (src/procid.mjs): the readers of each system with what that system prints, the
// comparison, and the rule that a system that answers wrongly about this process itself is not believed about others.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { POWERSHELL, psArgs } from '../src/server/platform/win32.mjs';
import { makeIdentity, parseCreations, parseEtimes, sameProcess, statStart } from '../src/procid.mjs';

// /proc/<pid>/stat: 52 fields; the name (field 2) in parentheses may hold spaces and ")".
const stat = (pid, name, start) => `${pid} (${name}) S 1 ${pid} ${pid} 0 -1 4194560 120 0 0 0 1 2 0 0 20 0 1 0 ${start} 1234567 456 18446744073709551615 1 1 0 0 0 0 0 4096 0 0 0 17 1 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;

test('Linux: the start from /proc/<pid>/stat, also when the name has spaces and ")"', () => {
  assert.equal(statStart(stat(42, 'node', 987654)), '987654');
  assert.equal(statStart(stat(42, 'a) b (c) S 9', 31337)), '31337');
  assert.equal(statStart('garbage'), null);
  assert.equal(statStart('42 (x) S 1'), null, 'too short');
  if (process.platform === 'linux') {
    // This process: its start in ticks since boot, as the kernel says it.
    const ticks = Number(statStart(fs.readFileSync('/proc/self/stat', 'utf8')));
    assert.ok(ticks > 0);
  }
});

test('macOS: ps elapsed time in all its forms', () => {
  const now = 1_800_000_000_000;
  const out = '  101 00:07\n  202    01:02:03\n 303 3-04:05:06\n404 59:59\nnonsense\n 505 \n';
  const m = parseEtimes(out, now);
  assert.equal(m.get(101), now - 7_000);
  assert.equal(m.get(202), now - 3_723_000);
  assert.equal(m.get(303), now - (3 * 86_400 + 4 * 3600 + 5 * 60 + 6) * 1000);
  assert.equal(m.get(404), now - 3_599_000);
  assert.equal(m.size, 4);
});

test('Windows: PowerShell lines, with the carriage return at the end', () => {
  const m = parseCreations('101 1799999990000\r\n202 1799999999123\r\n\r\n');
  assert.deepEqual([...m], [[101, 1799999990000], [202, 1799999999123]]);
});

test('the same process: Linux exactly, the others within 3 seconds, and never a guess', () => {
  assert.equal(sameProcess('L:b1:500', 'L:b1:500'), true);
  assert.equal(sameProcess('L:b1:500', 'L:b1:501'), false, 'another start');
  assert.equal(sameProcess('L:b1:500', 'L:b2:500'), false, 'the same tick of another boot');
  assert.equal(sameProcess('L::500', 'L:b2:500'), true, 'a boot id one side could not read does not decide');
  assert.equal(sameProcess('L::500', 'L::501'), false);
  assert.equal(sameProcess('T:1000000', 'T:1002999'), true);
  assert.equal(sameProcess('T:1000000', 'T:1003000'), false);
  for (const [a, b] of [['T:1', 'L:b:1'], ['L:b:1', null], [undefined, 'T:1'], ['L:b:', 'L:b:'], ['T:x', 'T:1'], ['X:1', 'X:1']]) assert.equal(sameProcess(a, b), null, `${a} ${b}`);
});

test('Linux reader: one file per pid, the boot id once, empty when it cannot be read', () => {
  const files = { '/proc/sys/kernel/random/boot_id': 'boot-1\n', '/proc/7/stat': stat(7, 'self', 100), '/proc/8/stat': stat(8, 'other one)', 200) };
  const reads = [];
  const read = (p) => {
    reads.push(p);
    if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files[p];
  };
  const id = makeIdentity({ platform: 'linux', read, pid: 7, osUptime: () => 100, now: () => 1_000_000 });
  assert.equal(id.self(), 'L:boot-1:100');
  assert.deepEqual([...id.of([7, 8, 9])], [[7, 'L:boot-1:100'], [8, 'L:boot-1:200'], [9, null]]);
  assert.equal(reads.filter((p) => p.includes('boot_id')).length, 1);
  assert.equal(id.bootAt(), 1_000_000 - 100_000);
  delete files['/proc/sys/kernel/random/boot_id'];
  const blind = makeIdentity({ platform: 'linux', read, pid: 7 });
  assert.equal(blind.self(), 'L::100');
  assert.equal(sameProcess(blind.self(), 'L:boot-1:100'), true);
});

/** A system that prints `answer(pids)` for every call, counting the calls. */
const sys = (platform, answer) => {
  const calls = [];
  let t = 1_800_000_000_000;
  const started = t - 5_000; // this process started 5 s ago
  const id = makeIdentity({
    platform, pid: 7, now: () => t, ownStart: started,
    run: (cmd, args) => {
      calls.push([cmd, args]);
      return answer(cmd, args, calls.length);
    },
  });
  return { id, calls, later: (ms) => (t += ms), now: () => t };
};

test('macOS reader: all pids in one ps call, its answer kept 30 seconds, after a right answer about itself', () => {
  const ps = (cmd, args) => {
    assert.equal(cmd, 'ps');
    assert.deepEqual(args.slice(0, 3), ['-o', 'pid=,etime=', '-p']);
    // The two others started 70 s and a day ago; this process 5 s ago, as it knows itself.
    return args[3].split(',').map((p) => ({ 7: '    7 00:05', 101: '  101 01:10', 202: '  202 1-00:00:00' })[p] || '').join('\n') + '\n';
  };
  const s = sys('darwin', ps);
  const first = s.id.of([101, 202, 303]);
  assert.equal(s.calls.length, 1, 'one call');
  assert.deepEqual(s.calls[0][1][3].split(',').map(Number).sort((a, b) => a - b), [7, 101, 202, 303], 'with the self check in it');
  assert.equal(first.get(101), `T:${s.now() - 70_000}`);
  assert.equal(first.get(202), `T:${s.now() - 86_400_000}`);
  assert.equal(first.get(303), null, 'nothing said about it: not known');
  assert.equal(s.id.self(), `T:${s.now() - 5_000}`);
  assert.equal(sameProcess(s.id.of([7]).get(7), s.id.self()), true, 'itself without asking');
  s.later(29_000);
  s.id.of([101, 202]);
  assert.equal(s.calls.length, 1, 'kept 30 seconds');
  s.id.of([101, 404]);
  assert.deepEqual(s.calls[1][1][3], '404', 'only what is not known yet');
  s.later(2_000);
  s.id.of([101, 202]);
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[2][1][3], '101,202', 'asked again after 30 seconds; the self check is done');
  assert.deepEqual(new Map([...s.id.of([])]), new Map(), 'nothing to ask: no call');
  assert.equal(s.calls.length, 3);
});

test('a system that answers wrongly about this process itself is never believed about others', () => {
  for (const [why, self] of [['an hour off', '    7 01:00:05'], ['four seconds off', '    7 00:09']]) {
    const s = sys('darwin', (cmd, args) => `${self}\n  101 01:10\n`);
    assert.equal(s.id.of([101]).get(101), null, why);
    s.later(60_000);
    assert.equal(s.id.of([101]).get(101), null, why);
    assert.equal(s.calls.length, 1, `${why}: not asked again`);
  }
  // One that said nothing about this process (PowerShell prints nothing on a busy moment): not believed while it says
  // nothing, asked again after the while, and believed once it answers rightly.
  const quiet = sys('darwin', (cmd, args, n) => `${n === 1 ? '' : '    7 00:36'}\n  101 01:10\n`);
  assert.equal(quiet.id.of([101]).get(101), null, 'nothing about itself');
  quiet.later(10_000);
  assert.equal(quiet.id.of([101]).get(101), null, 'still not believed');
  assert.equal(quiet.calls.length, 1, 'kept for the while');
  quiet.later(21_000);
  assert.equal(quiet.id.of([101]).get(101), `T:${quiet.now() - 70_000}`, 'asked again: right about itself, believed');
  assert.equal(quiet.calls.length, 2);
  // A system that cannot be asked: not known, and asked again only after the while.
  const s = sys('darwin', () => null);
  assert.equal(s.id.of([101]).get(101), null);
  s.id.of([101]);
  assert.equal(s.calls.length, 1);
  s.later(31_000);
  s.id.of([101]);
  assert.equal(s.calls.length, 2);
});

test('Windows reader: one PowerShell call for all pids, kept 5 minutes', () => {
  const s = sys('win32', (cmd, args) => {
    assert.equal(cmd, POWERSHELL);
    assert.deepEqual(args.slice(0, -1), psArgs('').slice(0, -1), 'as the other PowerShell calls');
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /Win32_Process -Filter 'ProcessId=101 OR ProcessId=202 OR ProcessId=7'/);
    assert.match(script, /\[DateTimeOffset\]\$_\.CreationDate\)\.ToUnixTimeMilliseconds\(\)/);
    return `7 ${s.now() - 4_000}\r\n101 ${s.now() - 60_000}\r\n`;
  });
  const m = s.id.of([101, 202]);
  assert.deepEqual([m.get(101), m.get(202)], [`T:${s.now() - 60_000}`, null]);
  s.later(299_000);
  s.id.of([101, 202]);
  assert.equal(s.calls.length, 1, 'kept 5 minutes');
  // A clock off by more than the 3 seconds between PowerShell and Node: not believed.
  const off = sys('win32', () => `7 ${off.now() - 9_000}\r\n101 1\r\n`);
  assert.equal(off.id.of([101]).get(101), null);
});

test('this process\'s own start is the one of when it was loaded, also after the clock was set', () => {
  // Days later the time service moves the clock an hour; then the first chat writes the dashboard's identity. It is the
  // start the system stored at creation (Windows' CreationDate does not move with the clock), not one an hour off.
  const start = Date.now() - process.uptime() * 1000;
  const real = Date.now;
  Date.now = () => real() + 3_600_000;
  let token;
  try {
    token = makeIdentity({ platform: 'win32', run: () => null }).self();
  } finally {
    Date.now = real;
  }
  assert.ok(Math.abs(Number(token.slice(2)) - start) < 1000, `${token} against T:${Math.round(start)}`);
});

test('in the background (the dashboard): what is not known yet is not known, and asked without waiting', async () => {
  let t = 1_800_000_000_000;
  const started = t - 5_000;
  const waited = [];
  const asked = [];
  let answer;
  const id = makeIdentity({
    platform: 'win32', pid: 7, now: () => t, ownStart: started,
    run: () => (waited.push(1), ''),
    runLater: (cmd, args) => (asked.push(args), new Promise((r) => (answer = () => r(`7 ${started}\r\n101 ${t - 60_000}\r\n`)))),
  });
  id.askInBackground();
  assert.equal(id.of([101]).get(101), null, 'not known yet');
  id.of([101, 202]);
  assert.equal(asked.length, 1, 'one question on its way at a time');
  answer();
  await new Promise((r) => setImmediate(r));
  assert.equal(id.of([101]).get(101), `T:${t - 60_000}`, 'known once the system answered');
  assert.equal(waited.length, 0, 'never waited for the system');
  // Before a signal: asked now, and of() uses only that answer.
  t += 1_000;
  const at = id.refresh([101]);
  answer();
  assert.equal(await at, t);
  assert.equal(id.of([101], { after: t }).get(101), `T:${t - 60_000}`);
  assert.equal(asked.length, 2);
});
