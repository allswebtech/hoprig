// The box (docs/BOX.md): its own processes only. It does not see or signal a process outside, gets no new rights, has no
// terminal of the caller's, ends with the caller, and at the timeout the WHOLE tree ends by the box's own means (its
// process group and pid space, never a name). Output is capped and the rest counted. The terminal is a pseudo-terminal
// this test makes itself (node-pty), never a real one; no program that raises rights is run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boxCheck, planRun, runBoxed } from '../../src/box/box.mjs';
import { bwrapArgs } from '../../src/box/linux.mjs';

const BOX = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'box', 'box.mjs')).href;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'box-procs-')));
const work = path.join(tmp, 'work');
fs.mkdirSync(work);
const OPTS = { cwd: work, write: [work], timeoutMs: 20_000 };
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck();
const skip = !real.ok && `no box here: ${real.why}`;
const others = [];
const marks = [];
test.after(() => {
  for (const c of others) c.kill('SIGKILL');
  // Safety net: end, by their pid (never a name), any of this file's own box processes that outlived a test. A run
  // that reaches here with leftovers is a sign the timeout kill did not end the whole tree (finding 16).
  for (const n of marks) for (const pid of sleepers(n)) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A number no other process on this computer sleeps for: its `sleep` processes are found by it, never by a name. */
const mark = () => {
  const n = `${4000 + (process.pid % 1000)}.${Math.floor(Math.random() * 1e6)}`;
  marks.push(n);
  return n;
};
/** The pids of this computer whose whole command line is `sleep <n>`. */
function sleepers(n) {
  const out = [];
  for (const p of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(p)) continue;
    try {
      if (fs.readFileSync(`/proc/${p}/cmdline`, 'utf8') === `sleep\0${n}\0`) out.push(Number(p));
    } catch {
      /* ended meanwhile */
    }
  }
  return out;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) if (fn()) return true;
  return fn();
}
const last = (r) => JSON.parse(r.out.trim().split('\n').pop());

test('the arguments: a pid space, no user space inside, no capability, a session of its own, it dies with the caller', () => {
  const { args } = bwrapArgs(planRun(['/bin/true'], OPTS));
  for (const o of ['--unshare-pid', '--unshare-cgroup-try', '--disable-userns', '--new-session', '--die-with-parent']) assert.ok(args.includes(o), o);
  assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
});

test('in the real box: a process outside is neither seen nor signalled, its environment not read', { skip, timeout: 60_000 }, async () => {
  const n = mark();
  const victim = spawn('sleep', [n], { stdio: 'ignore', env: { ...process.env, BOX_TEST_MADE_UP: 'made-up-value' } });
  others.push(victim);
  assert.ok(await until(() => sleepers(n).length === 1, 5000), 'the process outside is up');
  const script = `
    const fs = require('fs');
    const pids = fs.readdirSync('/proc').filter((p) => /^\\d+$/.test(p));
    let signal; try { process.kill(${victim.pid}, 0); signal = 'reached'; } catch (e) { signal = e.code; }
    let env; try { env = fs.readFileSync('/proc/${victim.pid}/environ', 'utf8'); } catch (e) { env = e.code; }
    const seen = pids.filter((p) => { try { return fs.readFileSync('/proc/' + p + '/cmdline', 'utf8') === ${JSON.stringify(`sleep\0${n}\0`)}; } catch { return false; } });
    console.log(JSON.stringify({ pids, signal, env, seen }));`;
  const r = await runBoxed([process.execPath, '-e', script], OPTS);
  assert.equal(r.ok, true, r.why + r.out);
  const s = last(r);
  assert.ok(s.pids.length <= 4, `only its own few processes: ${s.pids}`);
  assert.equal(s.signal, 'ESRCH');
  assert.equal(s.env, 'ENOENT');
  assert.deepEqual(s.seen, []);
  assert.equal(sleepers(n).length, 1, 'the process outside lives on');
});

test('in the real box: no new rights (NoNewPrivs, every capability zero) and no new user space', { skip, timeout: 60_000 }, async () => {
  const script = `
    const fs = require('fs'), cp = require('child_process');
    const st = fs.readFileSync('/proc/self/status', 'utf8');
    const caps = Object.fromEntries([...st.matchAll(/^(Cap\\w+):\\s+(\\w+)$/gm)].map((m) => [m[1], m[2]]));
    const nnp = /^NoNewPrivs:\\s+(\\d)/m.exec(st)[1];
    const u = cp.spawnSync('/usr/bin/unshare', ['-U', '/bin/true']);
    console.log(JSON.stringify({ caps, nnp, userns: u.status }));`;
  const r = await runBoxed([process.execPath, '-e', script], OPTS);
  assert.equal(r.ok, true, r.why + r.out);
  const s = last(r);
  assert.equal(s.nnp, '1');
  for (const k of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.match(s.caps[k], /^0+$/, k);
  assert.notEqual(s.userns, 0, 'a new user space is refused');
});

test('in the real box: no terminal of the caller\'s, even when the caller runs in one', { skip, timeout: 60_000 }, async () => {
  const pty = createRequire(import.meta.url)('node-pty');
  const typed = ['TYPED', 'INTO', 'TERMINAL'].join('-');
  const caller = path.join(tmp, 'caller.mjs');
  fs.writeFileSync(caller, `
    import { runBoxed } from ${JSON.stringify(BOX)};
    const script = ${JSON.stringify(`
      const fs = require('fs'), tty = require('tty');
      let open; try { const fd = fs.openSync('/dev/tty', 'w'); fs.writeSync(fd, ${JSON.stringify(typed.split('-').join(' '))}.split(' ').join('-')); open = 'opened'; } catch (e) { open = e.code; }
      console.log(JSON.stringify({ open, isatty: [0, 1, 2].map((f) => tty.isatty(f)) }));`)};
    const r = await runBoxed([process.execPath, '-e', script], ${JSON.stringify(OPTS)});
    console.log('RESULT ' + r.out.trim().split('\\n').pop());
  `);
  const term = pty.spawn(process.execPath, [caller], { cols: 120, rows: 30, cwd: work, env: process.env });
  let seen = '';
  term.onData((d) => (seen += d));
  const code = await new Promise((r) => term.onExit((e) => r(e.exitCode)));
  assert.equal(code, 0, seen);
  const s = JSON.parse(/RESULT (\{.*\})/.exec(seen)[1]);
  assert.equal(s.open, 'ENXIO', 'the box has no controlling terminal');
  assert.deepEqual(s.isatty, [false, false, false]);
  assert.ok(!seen.includes(typed), 'nothing was typed into the caller\'s terminal');
});

test('in the real box: it ends with the caller', { skip, timeout: 60_000 }, async () => {
  const n = mark();
  const caller = path.join(tmp, 'dies.mjs');
  fs.writeFileSync(caller, `
    import { runBoxed } from ${JSON.stringify(BOX)};
    await runBoxed(['/bin/sh', '-c', 'sleep ${n} & sleep ${n} & wait'], ${JSON.stringify({ ...OPTS, timeoutMs: 120_000 })});
  `);
  const c = spawn(process.execPath, [caller], { stdio: 'ignore' });
  others.push(c);
  assert.ok(await until(() => sleepers(n).length === 2, 15_000), 'the box\'s processes are up');
  c.kill('SIGKILL');
  assert.ok(await until(() => sleepers(n).length === 0, 10_000), `gone with the caller: ${sleepers(n)}`);
});

test('in the real box: at the timeout the whole tree ends, a hundred processes too', { skip, timeout: 90_000 }, async () => {
  const n = mark();
  let most = 0;
  const watch = setInterval(() => (most = Math.max(most, sleepers(n).length)), 100);
  const started = Date.now();
  const r = await runBoxed(['/bin/sh', '-c', `i=0; while [ $i -lt 100 ]; do sleep ${n} & i=$((i+1)); done; echo up; wait`], { ...OPTS, timeoutMs: 6000 });
  clearInterval(watch);
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 15_000, 'ended near its timeout');
  assert.equal(most, 100, 'all hundred ran');
  assert.ok(await until(() => sleepers(n).length === 0, 5000), `none outlives the box: ${sleepers(n).length}`);
});

test('in the real box: output past the cap is counted, not kept', { skip, timeout: 60_000 }, async () => {
  const r = await runBoxed([process.execPath, '-e', 'process.stdout.write("x".repeat(3000)); process.stderr.write("y".repeat(2000))'], { ...OPTS, maxOut: 1000 });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.out.length, 1000);
  assert.equal(r.dropped, 4000);
});

test('in the real box: at the timeout the box\'s own pid 1 is ended, so its whole tree goes even without --die-with-parent', { skip, timeout: 60_000 }, async () => {
  const { runMeans } = await import('../../src/box/run.mjs');
  const { meansCall } = await import('../../src/box/call.mjs');
  const n = mark();
  const p = planRun(['/bin/sh', '-c', `sleep ${n} & sleep ${n} & echo up; wait`], { ...OPTS, timeoutMs: 3000 });
  assert.equal(p.why, undefined);
  const call = meansCall('bwrap', p);
  // The box's pid 1 leads a new session, so the process-group kill does not reach it. With --die-with-parent taken
  // away, only ending that pid 1 by its number (the child-pid bwrap reports) can end the tree at the timeout.
  const args = call.args.filter((a) => a !== '--die-with-parent');
  const r = await runMeans('/usr/bin/bwrap', args, { timeoutMs: 3000, data: call.data, statusFd: true, env: {}, cwd: '/' });
  assert.equal(r.timedOut, true);
  assert.ok(await until(() => sleepers(n).length === 0, 5000), `none of the box's processes outlives the timeout: ${sleepers(n).length} left`);
});
