// The runner ends the box's own pid 1 by its number only while that number is still the box's: at the timeout, before
// bwrap has reported that pid 1 ended. Once bwrap has reaped it (a normal end), the number is free and may already be
// another process's, which must not be killed. A stand-in means (a small Node script) reports the pid of a made-up
// unrelated process as its child-pid, the way a reused number would look.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { runMeans } from '../../src/box/run.mjs';

const skip = process.platform === 'win32' && 'process groups and fd 3 status are POSIX';

/** A made-up unrelated process; → { pid, ended } where `ended` resolves with its signal when it ends. */
function bystander() {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  const ended = new Promise((r) => c.on('exit', (code, signal) => r(signal || `code ${code}`)));
  return { c, pid: c.pid, ended };
}

/** A stand-in means: writes `docs` to fd 3 as bwrap does, then ends or (hold) waits to be ended. */
const means = (docs, hold) => ['-e', `const fs = require('fs'); for (const d of ${JSON.stringify(docs)}) fs.writeSync(3, JSON.stringify(d) + '\\n'); ${hold ? 'setInterval(() => {}, 1000);' : ''}`];
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a normal end does not kill the number the box\'s pid 1 had: it may be another process\'s by then', { skip, timeout: 30_000 }, async (t) => {
  const b = bystander();
  t.after(() => b.c.kill('SIGKILL'));
  const r = await runMeans(process.execPath, means([{ 'child-pid': b.pid }, { 'exit-code': 0 }], false), { timeoutMs: 20_000, statusFd: true });
  assert.equal(r.timedOut, false);
  assert.equal(r.code, 0);
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(alive(b.pid), 'the unrelated process is still running');
});

test('at the timeout the box\'s pid 1 is ended by its number while bwrap has not reported its end', { skip, timeout: 30_000 }, async (t) => {
  const b = bystander();
  t.after(() => b.c.kill('SIGKILL'));
  const r = await runMeans(process.execPath, means([{ 'child-pid': b.pid }], true), { timeoutMs: 1500, statusFd: true });
  assert.equal(r.timedOut, true);
  assert.equal(await b.ended, 'SIGKILL', 'the pid 1 stand-in was ended');
});

test('at the timeout, once bwrap has reported pid 1\'s end, that number is not killed', { skip, timeout: 30_000 }, async (t) => {
  const b = bystander();
  t.after(() => b.c.kill('SIGKILL'));
  const r = await runMeans(process.execPath, means([{ 'child-pid': b.pid }, { 'exit-code': 0 }], true), { timeoutMs: 1500, statusFd: true });
  assert.equal(r.timedOut, true);
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(alive(b.pid), 'the unrelated process is still running');
});
