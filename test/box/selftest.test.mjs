// The box (docs/BOX.md): the self-test is the trials in small, run inside the real box before a yes. Each trial is broken
// here in turn, through the inner function's arguments (a plan or a runner that weakens the real box), and each time
// the answer is a no that names that trial. Everything read is a made-up file in a temporary folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { boxCheck, checkWith, planRun, realHomes, runWith } from '../../src/box/box.mjs';
import { findMeans } from '../../src/box/means.mjs';
import { runMeans } from '../../src/box/run.mjs';
import { TRIALS, selfTest } from '../../src/box/selftest.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'box-self-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck({ fresh: true });
const skip = !real.ok && `no box here: ${real.why}`;
const means = findMeans();

/** The trials' settings the self-test hands its command (its last word). */
const settingsOf = (argv) => JSON.parse(argv[argv.length - 1]);
/** A plan that also names folders it must not: `extra(settings)` → { read, write }. */
const widened = (extra) => (argv, opts) => {
  const more = extra(settingsOf(argv));
  return planRun(argv, { ...opts, read: [...(opts.read || []), ...(more.read || [])], write: [...(opts.write || []), ...(more.write || [])] });
};
/** A runner that changes the means' arguments before the real start. */
const changed = (fn) => (file, args, o) => runMeans(file, fn([...args]), o);
const without = (...opts) => changed((args) => args.filter((a) => !opts.includes(a)));
const trial = (opts) => selfTest({ kind: 'bwrap', file: means.file, run: runMeans, plan: planRun, homes: realHomes(), ...opts });

test('in the real box: every trial passes, and the yes carries them', { skip, timeout: 60_000 }, async () => {
  assert.equal(real.ok, true);
  assert.deepEqual(Object.keys(real.trials).sort(), Object.keys(TRIALS).sort());
  for (const v of Object.values(real.trials)) assert.equal(v, 'ok');
});

const broken = {
  home: { plan: widened((s) => ({ read: [path.dirname(s.homeSecret)] })) },
  homes: { homes: [tmp], plan: widened(() => ({ read: [tmp] })) },
  outside: { plan: widened((s) => ({ write: [s.outsideDir] })) },
  listener: { run: without('--unshare-net') },
  // No pid space, and the computer's own /proc in place of the box's.
  process: { run: changed((a) => { const i = a.indexOf('--proc'); a.splice(i, 2, '--ro-bind', '/proc', '/proc'); return a.filter((x) => x !== '--unshare-pid'); }) },
  write: { run: changed((a) => a.map((x) => (x === '--bind' ? '--ro-bind' : x))) },
};
fs.writeFileSync(path.join(tmp, 'made-up-home-file'), 'made-up');

for (const [name, opts] of Object.entries(broken)) {
  test(`in the real box: a box that fails "${TRIALS[name]}" is a no that names it`, { skip, timeout: 60_000 }, async () => {
    const r = await trial(opts);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.why.startsWith(`trial "${TRIALS[name]}" failed`), true, r.why);
  });
}

test('in the real box: a failing trial makes the check a no, and then nothing runs', { skip, timeout: 60_000 }, async () => {
  const no = await checkWith({ run: without('--unshare-net') });
  assert.equal(no.ok, false);
  assert.match(no.why, /listener/);
  let ran = 0;
  const r = await runWith(['/bin/true'], { cwd: tmp, write: [tmp], timeoutMs: 5000 }, { check: async () => no, run: async () => (ran++, {}) });
  assert.equal(ran, 0);
  assert.match(r.why, /^no box on this computer: trial/);
});

test('a box that gives no answer is a no', async () => {
  const r = await selfTest({ kind: 'bwrap', file: '/usr/bin/bwrap', plan: planRun, homes: [], run: async () => ({ started: true, code: 0, out: 'nothing here' }) });
  assert.equal(r.ok, false);
  assert.match(r.why, /a command runs/);
});

test('a failing self-test carries a step in words: there is no fix to apply, so a person looks again and reports it', async () => {
  const r = await selfTest({ kind: 'bwrap', file: '/usr/bin/bwrap', plan: planRun, homes: [], run: async () => ({ started: true, code: 0, out: 'nothing here' }) });
  assert.equal(r.ok, false);
  assert.ok(r.step && /hoprig box check/.test(r.step), `a step for a person: ${r.step}`);
});

test('the self-test never reads a file of the real home', () => {
  const text = fs.readFileSync(new URL('../../src/box/selftest.mjs', import.meta.url), 'utf8');
  const outside = text.slice(text.indexOf('`;', text.indexOf('const INSIDE')) + 2);
  assert.doesNotMatch(outside, /homedir|readdirSync\(\s*home|\.ssh|\.config|process\.env/);
});
