// A process's identity beyond its pid (src/procid.mjs): the readers of each system with what that system prints, the
// comparison, and the rule that a system that answers wrongly about this process itself is not believed about others.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { POWERSHELL, psArgs } from '../src/server/platform/win32.mjs';
import { creationScript, makeIdentity, parseCreations, parseLstarts, sameProcess, statStart } from '../src/procid.mjs';
import { lstart } from './server/helpers.mjs';

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

test('macOS: the start date ps prints (lstart, C locale, UTC), and nothing else', () => {
  const out = '  101 Tue Nov 17 06:38:18 2026\n  202    Sun Nov  1 00:00:07 2026\n 303 Thu Jan  1 00:00:00 1970\n404 Mon Feb 29 23:59:59 2024\nnonsense\n 505 \n 606 Tue Foo 17 06:38:18 2026\n 707 Di Nov 17 06:38:18 2026\n';
  const m = parseLstarts(out);
  assert.equal(m.get(101), Date.UTC(2026, 10, 17, 6, 38, 18));
  assert.equal(m.get(202), Date.UTC(2026, 10, 1, 0, 0, 7));
  assert.equal(m.get(303), 0);
  assert.equal(m.get(404), Date.UTC(2024, 1, 29, 23, 59, 59));
  assert.equal(m.size, 4, 'a line in another form says nothing');
  // What this file's stand-ins print is what ps prints.
  assert.equal(lstart(Date.UTC(2026, 10, 1, 0, 0, 7) + 999), 'Sun Nov  1 00:00:07 2026');
  for (let month = 0; month < 12; month++) assert.equal(parseLstarts(`9 ${lstart(Date.UTC(2031, month, 28, 13, 0, 59))}`).get(9), Date.UTC(2031, month, 28, 13, 0, 59));
});

test('Windows: PowerShell lines, with the carriage return at the end', () => {
  const m = parseCreations('101 1799999990000\r\n202 1799999999123\r\n\r\n');
  assert.deepEqual([...m], [[101, 1799999990000], [202, 1799999999123]]);
});

test('Windows: the identity script calls no cmdlet (Windows PowerShell loads a module for its first one, about 17 s each time in a fresh home)', () => {
  const script = creationScript([101, 202]);
  // The verbs of cmdlets, and the pipeline cmdlets that look like words of the language.
  for (const word of [/\bGet-/i, /\bSet-/i, /\bNew-/i, /\bWrite-/i, /\bSelect-/i, /\bSort-/i, /\bOut-/i, /\bForEach-Object\b/i, /\bWhere-Object\b/i, /\bInvoke-/i, /\bImport-Module\b/i, /\|/]) {
    assert.doesNotMatch(script, word, `${word} in the script`);
  }
  assert.match(script, /@\(101, 202\)/, 'each pid asked about, as a number');
  assert.match(script, /\[System\.Diagnostics\.Process\]::GetProcessById\(\$id\)/);
  assert.match(script, /\(\[DateTimeOffset\]\[System\.Diagnostics\.Process\]::GetProcessById\(\$id\)\.StartTime\)\.ToUnixTimeMilliseconds\(\)/, 'the same number as before: Unix milliseconds');
  // A process whose StartTime may not be read (another account's, a protected one): its CreationDate through the
  // searcher, cut to the same Unix millisecond; a pid with no process gives no line.
  assert.match(script, /if \(\$ms -eq \$null\) \{ try \{ foreach \(\$w in \[System\.Management\.ManagementObjectSearcher\]::new\("SELECT CreationDate FROM Win32_Process WHERE ProcessId=\$id"\)\.Get\(\)\)/);
  assert.match(script, /\(\[DateTimeOffset\]\[System\.Management\.ManagementDateTimeConverter\]::ToDateTime\(\$w\['CreationDate'\]\)\)\.ToUnixTimeMilliseconds\(\)/);
  assert.match(script, /if \(\$ms -ne \$null\) \{ \[Console\]::Out\.WriteLine\("\$id \$ms"\) \}/);
  assert.match(script, /try \{[^]*\} catch \{\}/, 'a pid that is gone or may not be read gives no line');
  // What it prints is read as before: one "<pid> <ms>" line per process that is there.
  assert.deepEqual([...parseCreations('101 1795615533147\r\n')], [[101, 1795615533147]]);
});

test('the same process: Linux exactly, the others within 3 seconds or a late start, and never a guess', () => {
  assert.equal(sameProcess('L:b1:500', 'L:b1:500'), true);
  assert.equal(sameProcess('L:b1:500', 'L:b1:501'), false, 'another start');
  assert.equal(sameProcess('L:b1:500', 'L:b2:500'), false, 'the same tick of another boot');
  assert.equal(sameProcess('L::500', 'L:b2:500'), true, 'a boot id one side could not read does not decide');
  assert.equal(sameProcess('L::500', 'L::501'), false);
  assert.equal(sameProcess('T:1000000', 'T:1002999'), true);
  assert.equal(sameProcess('T:1000000', 'T:1003000'), false);
  // Node's own start may come after the start of the process behind its pid (a wrapper that execs node, a slow load):
  // up to a minute later; never earlier than the 3 seconds (a dead writer started before the pid's process now).
  assert.equal(sameProcess('T:1004000', 'T:1000000'), true, 'started 4 s after its process');
  assert.equal(sameProcess('T:1059999', 'T:1000000'), true);
  assert.equal(sameProcess('T:1060000', 'T:1000000'), false);
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
const T0 = 1_800_000_000_000;
const sys = (platform, answer) => {
  const calls = [];
  let t = T0;
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
    assert.deepEqual(args.slice(0, 3), ['-o', 'pid=,lstart=', '-p']);
    // The two others started 70 s and a day ago; this process 5 s ago, as it knows itself.
    return args[3].split(',').map((p) => ({ 7: `    7 ${lstart(T0 - 5_000)}`, 101: `  101 ${lstart(T0 - 70_000)}`, 202: `  202 ${lstart(T0 - 86_400_000)}` })[p] || '').join('\n') + '\n';
  };
  const s = sys('darwin', ps);
  const first = s.id.of([101, 202, 303]);
  assert.equal(s.calls.length, 1, 'one call');
  assert.deepEqual(s.calls[0][1][3].split(',').map(Number).sort((a, b) => a - b), [7, 101, 202, 303], 'with the self check in it');
  assert.equal(first.get(101), `T:${T0 - 70_000}`);
  assert.equal(first.get(202), `T:${T0 - 86_400_000}`);
  assert.equal(first.get(303), null, 'nothing said about it: not known');
  assert.equal(s.id.self(), `T:${s.now() - 5_000}`);
  assert.equal(sameProcess(s.id.of([7]).get(7), s.id.self()), true, 'itself without asking');
  s.later(29_000);
  s.id.of([101, 202]);
  assert.equal(s.calls.length, 1, 'kept 30 seconds');
  s.id.of([101, 404]);
  assert.deepEqual(s.calls[1][1][3], '404', 'only what is not known yet');
  s.later(2_000);
  const again = s.id.of([101, 202]);
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[2][1][3], '101,202', 'asked again after 30 seconds; the self check is done');
  assert.deepEqual([...again], [...first].slice(0, 2), 'the same process is the same at every read, whenever it is asked');
  assert.deepEqual(new Map([...s.id.of([])]), new Map(), 'nothing to ask: no call');
  assert.equal(s.calls.length, 3);
});

test('macOS: a slow answer, or one read late, never moves a process\'s start', () => {
  // ps answers quickly once (the check against this process's own start passes), and after the kept answer is old it
  // takes 3.5 s (a computer under load, a dashboard busy with something else): the start it says is the same, so the
  // record that process wrote about itself is still its own.
  let t = T0 + 400;
  const own = t - 5_300;
  const other = t - 70_250; // the kernel made pid 101 then; its Node began 40 ms later and wrote that into its record
  const record = `T:${other + 40}`;
  let n = 0;
  const id = makeIdentity({
    platform: 'darwin', pid: 7, now: () => t, ownStart: own,
    run: () => {
      const out = `    7 ${lstart(own)}\n  101 ${lstart(other)}\n`;
      t += n++ === 0 ? 20 : 3_500;
      return out;
    },
  });
  const first = id.of([101]).get(101);
  t += 31_000;
  const second = id.of([101]).get(101);
  assert.equal(n, 2, 'asked twice');
  assert.equal(first, `T:${Math.floor(other / 1000) * 1000}`, 'the second the system stored');
  assert.equal(second, first, 'the same at every read');
  assert.equal(sameProcess(record, second), true, 'a living process is never another one');
  // The process that gets pid 101 later is another one.
  assert.equal(sameProcess(record, `T:${Math.floor((other + 3_600_000) / 1000) * 1000}`), false);
});

test('a system that answers wrongly about this process itself is never believed about others', () => {
  for (const [why, self] of [['an hour off (another time zone)', `    7 ${lstart(T0 - 3_605_000)}`], ['four seconds off', `    7 ${lstart(T0 - 9_000)}`]]) {
    const s = sys('darwin', (cmd, args) => `${self}\n  101 ${lstart(T0 - 70_000)}\n`);
    assert.equal(s.id.of([101]).get(101), null, why);
    s.later(60_000);
    assert.equal(s.id.of([101]).get(101), null, why);
    assert.equal(s.calls.length, 1, `${why}: not asked again`);
  }
  // One that said nothing about this process (PowerShell prints nothing on a busy moment): not believed while it says
  // nothing, asked again after the while, and believed once it answers rightly.
  const quiet = sys('darwin', (cmd, args, n) => `${n === 1 ? '' : `    7 ${lstart(T0 - 5_000)}`}\n  101 ${lstart(T0 - 39_000)}\n`);
  assert.equal(quiet.id.of([101]).get(101), null, 'nothing about itself');
  quiet.later(10_000);
  assert.equal(quiet.id.of([101]).get(101), null, 'still not believed');
  assert.equal(quiet.calls.length, 1, 'kept for the while');
  quiet.later(21_000);
  assert.equal(quiet.id.of([101]).get(101), `T:${T0 - 39_000}`, 'asked again: right about itself, believed');
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
    assert.match(script, /foreach \(\$id in @\(101, 202, 7\)\)/);
    assert.match(script, /GetProcessById\(\$id\)\.StartTime\)\.ToUnixTimeMilliseconds\(\)/);
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
  // start the system stored at creation (Windows' process start time does not move with the clock), not one an hour off.
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
  assert.equal(asked.length, 2, 'the pid wanted while the first question was on its way (202) is asked right after it');
  assert.equal(waited.length, 0, 'never waited for the system');
  // Before a signal: asked now, and of() uses only that answer.
  t += 1_000;
  const at = id.refresh([101]);
  answer();
  assert.equal(await at, t);
  assert.equal(id.of([101], { after: t }).get(101), `T:${t - 60_000}`);
  assert.equal(asked.length, 3);
});

test('filedProcess: one judgement of the identities, never a second read that may say otherwise', async () => {
  const { filedProcess } = await import('../src/procid.mjs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filed-'));
    const file = path.join(dir, 'f.json');
    fs.writeFileSync(file, '{}'); // of this boot
    const rec = { pid: c.pid, proc: 'T:1000000' };
    const bootAt = () => Date.now() - os.uptime() * 1000;
    // A kept answer "another process" (perhaps from before the record's process started), asked again: not known yet.
    // Nothing shows the process is ours, so the fact decides; a later read saying "another process" must not make it so.
    let n = 0;
    const doubted = { of: (pids) => new Map(pids.map((p) => [p, n++ === 1 ? null : 'T:9000000'])), bootAt };
    assert.equal(filedProcess(file, rec, { ident: doubted, fact: () => false }), false, 'the fact says it is not ours');
    n = 0;
    assert.equal(filedProcess(file, rec, { ident: doubted }), null, 'cannot be told');
    // The identities equal: shown, on that one answer.
    let reads = 0;
    const same = { of: (pids) => (reads++, new Map(pids.map((p) => [p, 'T:1000000']))), bootAt };
    assert.equal(filedProcess(file, rec, { ident: same, fact: () => false }), true);
    assert.equal(reads, 1, 'the system was asked once');
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    c.kill('SIGKILL');
  }
});

test('Windows: a live pid whose StartTime may not be read is told by its CreationDate: another start is gone, no answer at all is held', async () => {
  const L = await import('../src/pcsetup/leftovers.mjs');
  const LIVE = process.ppid;
  const THEN = 1795000000000;
  const NOW = 1795000900000;
  // The reader as the identity script answers: the second way gave the start of the process that has the pid now.
  const told = makeIdentity({ platform: 'win32', run: (cmd, args) => `${LIVE} ${NOW}\r\n${process.pid} ${Math.round(Date.now() - process.uptime() * 1000)}\r\n` });
  assert.equal(L.lockOwner(JSON.stringify({ pid: LIVE, proc: `T:${THEN}` }), Date.now(), { ident: told }).running, false, 'another start: the lock is taken over');
  // Neither way could tell (no line for that pid): held, as before.
  const silent = makeIdentity({ platform: 'win32', run: () => `${process.pid} ${Math.round(Date.now() - process.uptime() * 1000)}\r\n` });
  assert.equal(L.lockOwner(JSON.stringify({ pid: LIVE, proc: `T:${THEN}` }), Date.now(), { ident: silent }).running, true, 'not told: held');
});

test('Windows: a protected process is told by its CreationDate, and both ways give this process the same start', { skip: process.platform !== 'win32' && 'it reads Windows processes with Windows PowerShell: Windows only', timeout: 60_000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const ps = (script) => {
    const t = Date.now();
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    return { out: String(r.stdout || '').trim(), ms: Date.now() - t };
  };
  // A process of the system this test may not open: csrss, found by its name through the same searcher.
  const found = ps("foreach ($w in [System.Management.ManagementObjectSearcher]::new(\"SELECT ProcessId FROM Win32_Process WHERE Name='csrss.exe'\").Get()) { [Console]::Out.WriteLine($w['ProcessId']) }");
  const csrss = Number(found.out.split(/\r?\n/)[0]);
  assert.ok(csrss > 0, `csrss found: ${found.out}`);
  const id = makeIdentity();
  const t0 = Date.now();
  const told = id.of([csrss], { after: Date.now() - 2000 }).get(csrss);
  const readMs = Date.now() - t0;
  assert.match(String(told), /^T:\d+$/, 'answered, not unknown');
  // This process, both ways: the same Unix millisecond.
  const both = ps(`$p = [System.Diagnostics.Process]::GetProcessById(${process.pid}); $a = ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds(); foreach ($w in [System.Management.ManagementObjectSearcher]::new("SELECT CreationDate FROM Win32_Process WHERE ProcessId=${process.pid}").Get()) { $b = ([DateTimeOffset][System.Management.ManagementDateTimeConverter]::ToDateTime($w['CreationDate'])).ToUnixTimeMilliseconds() }; [Console]::Out.WriteLine("$a $b")`);
  const [a, b] = both.out.split(/\s+/).map(Number);
  console.log(`WINDIAG procid: csrss ${csrss} ${told} in ${readMs}ms; this process StartTime ${a} CreationDate ${b} (both read in ${both.ms}ms)`);
  assert.equal(a, b, 'both ways give the same start');
});
