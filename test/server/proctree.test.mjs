// endAll (src/server/backends/proctree.mjs): how a terminal's programs are ended before the terminal closes. Real
// processes; POSIX only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { endAll } from '../../src/server/backends/proctree.mjs';

const skip = process.platform === 'win32' && 'POSIX signals';

/** A Node process running `code`; resolves once it has printed its first line (its handlers are in place). */
async function proc(code) {
  const c = spawn(process.execPath, ['-e', `${code}; setInterval(() => {}, 1 << 30); console.log('ready')`], { stdio: ['ignore', 'pipe', 'ignore'] });
  test.after(() => c.kill('SIGKILL'));
  await new Promise((r) => c.stdout.once('data', r));
  c.ended = new Promise((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', r)));
  return c;
}
const done = (c) => c.exitCode !== null || c.signalCode !== null;

test('endAll: SIGHUP, and back as soon as every program has ended', { skip }, async () => {
  const a = await proc("process.on('SIGHUP', () => setTimeout(() => process.exit(0), 200))");
  const b = await proc('');
  const t0 = Date.now();
  await endAll([a.pid, b.pid], { waitMs: 5000 });
  const ms = Date.now() - t0;
  await Promise.all([a.ended, b.ended]);
  assert.deepEqual([a.exitCode, b.signalCode], [0, 'SIGHUP']);
  assert.ok(ms >= 150 && ms < 2000, `returned when both had ended (${ms} ms)`);
});

test('endAll: what ignores SIGHUP costs waitMs at most, and the function it returns ends it', { skip }, async () => {
  const deaf = await proc("process.on('SIGHUP', () => {})");
  const t0 = Date.now();
  const rest = await endAll([deaf.pid], { waitMs: 300 });
  const ms = Date.now() - t0;
  assert.ok(ms >= 280 && ms < 1500, `bounded by waitMs (${ms} ms)`);
  assert.equal(done(deaf), false, 'still running: it ignored SIGHUP');
  rest('SIGTERM');
  await deaf.ended;
  assert.equal(deaf.signalCode, 'SIGTERM');
});

test('endAll: a stopped program (Ctrl-Z) gets SIGCONT too, so its SIGHUP arrives without the full wait', { skip }, async () => {
  const c = await proc("process.on('SIGHUP', () => process.exit(7))");
  process.kill(c.pid, 'SIGSTOP');
  const t0 = Date.now();
  await endAll([c.pid], { waitMs: 3000 });
  await c.ended;
  assert.equal(c.exitCode, 7, 'its own SIGHUP handler ran');
  assert.ok(Date.now() - t0 < 2000, 'no full wait');
});

test('endAll: the process that holds the conversation is waited for longer, only when it is one of the programs', { skip }, async () => {
  const slow = await proc("process.on('SIGHUP', () => setTimeout(() => process.exit(0), 900))");
  let t0 = Date.now();
  await endAll([slow.pid], { waitMs: 200, hold: slow.pid, holdMs: 5000 });
  assert.ok(Date.now() - t0 >= 800, 'waited for it past waitMs');
  // Its exit event may come a moment after its pid is gone.
  assert.ok(await Promise.race([slow.ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]), 'it had ended');
  assert.equal(slow.exitCode, 0);
  // A pid that is not one of the terminal's programs (a stale record's: anyone's by now) gets no longer wait.
  const other = await proc("process.on('SIGHUP', () => {})");
  const deaf = await proc("process.on('SIGHUP', () => {})");
  t0 = Date.now();
  await endAll([deaf.pid], { waitMs: 200, hold: other.pid, holdMs: 5000 });
  assert.ok(Date.now() - t0 < 1500, 'waitMs only');
  assert.equal(done(other), false, 'and it got no signal');
});
