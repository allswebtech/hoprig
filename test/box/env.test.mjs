// The box (docs/BOX.md): its environment is a closed short list (PATH, the box's HOME, LANG, TERM, CI=1, and what the
// caller names in env), never the caller's environment. A name that is not plain, or HOME, is a wrong option.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { boxCheck, planRun, runWith } from '../../src/box/box.mjs';
import { boxEnv } from '../../src/box/env.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'box-env-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const work = path.join(tmp, 'work');
fs.mkdirSync(work);
const OPTS = { cwd: work, write: [work], timeoutMs: 20_000 };
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck();
const skip = !real.ok && `no box here: ${real.why}`;

test('the list is closed: PATH from the runtime, the box\'s HOME, a plain LANG, TERM=dumb, CI=1', () => {
  assert.deepEqual(boxEnv('/opt/node', {}, 'de_DE.UTF-8'), { PATH: '/opt/node/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'de_DE.UTF-8', TERM: 'dumb', CI: '1', HOME: '/home/box' }); // seal: an expected value, no program is started with it
  for (const odd of ['$(id)', 'en_US.UTF-8; x', '../../x', '', undefined, 'a'.repeat(80)]) assert.equal(boxEnv('/n', {}, odd).LANG, 'C.UTF-8', String(odd));
  assert.equal(boxEnv('/n', { NODE_ENV: 'test' }).NODE_ENV, 'test');
  assert.equal(boxEnv('/n', { HOME: '/home/alex' }).HOME, '/home/box', 'HOME stays the box\'s own');
});

test('a name the caller gives that is not plain, or HOME, is a wrong option: nothing runs', async () => {
  for (const env of [{ HOME: '/x' }, { 'lower': 'x' }, { 'A-B': 'x' }, { '1A': 'x' }, { 'A=B': 'x' }, { '': 'x' }]) {
    assert.match(planRun(['/bin/true'], { ...OPTS, env }).why, /^env: /, JSON.stringify(env));
    let ran = 0;
    const r = await runWith(['/bin/true'], { ...OPTS, env }, { check: async () => ({ ok: true, kind: 'bwrap', file: '/usr/bin/bwrap' }), run: async () => (ran++, {}) });
    assert.equal(ran, 0);
    assert.match(r.why, /^nothing ran: env: /);
  }
  assert.equal(planRun(['/bin/true'], { ...OPTS, env: { NODE_ENV: 'test', A_1: 'x' } }).why, undefined);
});

test('the plan carries only the closed list, whatever the caller\'s environment holds', () => {
  process.env.BOX_TEST_MADE_UP_SECRET = 'made-up';
  try {
    const p = planRun(['/bin/true'], { ...OPTS, env: { NODE_ENV: 'test' } });
    assert.deepEqual(Object.keys(p.env).sort(), ['CI', 'HOME', 'LANG', 'NODE_ENV', 'PATH', 'TERM']);
  } finally {
    delete process.env.BOX_TEST_MADE_UP_SECRET;
  }
});

test('in the real box: the command sees the closed list and nothing of the caller\'s', { skip }, async () => {
  process.env.BOX_TEST_MADE_UP_SECRET = 'made-up-secret-value';
  let r;
  try {
    r = await runWith([process.execPath, '-e', 'console.log(JSON.stringify(process.env))'], { ...OPTS, env: { NODE_ENV: 'test' } });
  } finally {
    delete process.env.BOX_TEST_MADE_UP_SECRET;
  }
  assert.equal(r.ok, true, r.why + r.out);
  const seen = JSON.parse(r.out.trim().split('\n').pop());
  // PWD is bwrap's own, set to the cwd the caller named (it cannot be unset).
  assert.deepEqual(Object.keys(seen).sort(), ['CI', 'HOME', 'LANG', 'NODE_ENV', 'PATH', 'PWD', 'TERM']);
  assert.equal(seen.PWD, work);
  assert.equal(seen.HOME, '/home/box');
  assert.equal(seen.CI, '1');
  assert.ok(!r.out.includes('made-up-secret-value'));
});

test('in the real box: the means own environment reaches nothing inside (--clearenv), not only the empty env the box starts it with', { skip }, async () => {
  const { runMeans } = await import('../../src/box/run.mjs');
  const { meansCall } = await import('../../src/box/call.mjs');
  const p = planRun([process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'], OPTS);
  assert.equal(p.why, undefined);
  const call = meansCall('bwrap', p);
  // bwrap itself is started with a secret in ITS environment; --clearenv is what keeps it from reaching the command.
  const r = await runMeans(real.file, call.args, { timeoutMs: 20_000, data: call.data, statusFd: true, env: { BOX_MEANS_SECRET: 'made-up-means-secret' }, cwd: '/' });
  assert.equal(r.started, true, r.failure || r.out);
  const seen = JSON.parse(r.out.trim().split('\n').pop());
  assert.ok(!('BOX_MEANS_SECRET' in seen), 'the means environment does not reach the command');
  assert.ok(!r.out.includes('made-up-means-secret'));
});
