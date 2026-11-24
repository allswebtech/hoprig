// The box (docs/BOX.md): never unboxed. When the box cannot be made (no means, the self-test fails, the start fails, a
// folder is not there, an option is wrong) NOTHING runs, and nothing switches the box off.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { boxCheck, checkWith, planRun, runBoxed, runWith } from '../../src/box/box.mjs';
import { findMeans } from '../../src/box/means.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'box');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'box-never-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const work = path.join(tmp, 'work');
fs.mkdirSync(work);

const YES = async () => ({ ok: true, kind: 'bwrap', file: '/usr/bin/bwrap', why: '' });
/** An inner runner that only counts: a test fails when it is called where nothing may run. */
function counter(result = { started: true, code: 0, signal: null, out: '', timedOut: false }) {
  const calls = [];
  const run = async (...a) => {
    calls.push(a);
    return result;
  };
  return { calls, run };
}
const OPTS = { cwd: work, write: [work], timeoutMs: 5000 };
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck();

test('no means: the check says no with one line why and a step, and the self-test never starts', async () => {
  const c = counter();
  const r = await checkWith({ means: () => ({ kind: null, why: 'bubblewrap is not installed', step: 'install bubblewrap' }), run: c.run });
  assert.equal(r.ok, false);
  assert.equal(r.kind, null);
  assert.equal(r.why, 'bubblewrap is not installed');
  assert.equal(c.calls.length, 0);
});

test('a self-test that fails is a no, and so is one that throws', async () => {
  const means = () => ({ kind: 'bwrap', file: '/usr/bin/bwrap' });
  const failed = await checkWith({ means, run: async () => ({ started: true, code: 1, out: '', timedOut: false }) });
  assert.equal(failed.ok, false);
  assert.match(failed.why, /trial/);
  const notStarted = await checkWith({ means, run: async () => ({ started: false, code: null, out: 'bwrap: No permissions to create new namespace', timedOut: false }) });
  assert.equal(notStarted.ok, false);
  assert.match(notStarted.why, /^the box does not start: bubblewrap is not allowed to make its spaces here \(bwrap: No permissions/);
  assert.match(notStarted.step, /user namespaces/, 'with the step that would help');
  const threw = await checkWith({ means, run: async () => { throw new Error('boom'); } });
  assert.equal(threw.ok, false);
  assert.match(threw.why, /boom/);
});

test('no yes from the check: nothing runs, whatever the check said instead', async () => {
  for (const answer of [{ ok: false, kind: null, why: 'no means' }, { ok: 'yes', kind: 'bwrap' }, { ok: 1, kind: 'bwrap' }, null, undefined, {}]) {
    const c = counter();
    const r = await runWith(['/bin/true'], OPTS, { check: async () => answer, run: c.run });
    assert.equal(r.ok, false);
    assert.equal(r.code, null);
    assert.match(r.why, /no box/);
    assert.equal(c.calls.length, 0, `nothing ran for ${JSON.stringify(answer)}`);
  }
});

test('a wrong option or a folder that is not there: nothing runs', async () => {
  const cases = [
    [['/bin/true'], { ...OPTS, cwd: path.join(tmp, 'nosuch') }],
    [['/bin/true'], { ...OPTS, write: [path.join(tmp, 'nosuch')] }],
    [['/bin/true'], { ...OPTS, read: ['relative/dir'] }],
    [['/bin/true'], { ...OPTS, unboxed: true }],
    [['/bin/true'], { ...OPTS, timeoutMs: undefined }],
    [['/bin/true'], { ...OPTS, timeoutMs: -1 }],
    [['/bin/true'], { ...OPTS, maxOut: 0 }],
    [['/bin/true'], { ...OPTS, env: { X: 1 } }],
    [['/bin/true'], { ...OPTS, write: work }],
    ['/bin/true', OPTS],
    [[], OPTS],
    [['/bin/true', 'a\0b'], OPTS],
    [['/bin/true'], { ...OPTS, cwd: tmp }], // the cwd is not inside a named folder
  ];
  for (const [argv, opts] of cases) {
    const c = counter();
    const r = await runWith(argv, opts, { check: YES, run: c.run });
    assert.equal(r.ok, false, JSON.stringify(opts));
    assert.match(r.why, /^nothing ran: /);
    assert.equal(c.calls.length, 0, `nothing ran for ${JSON.stringify([argv, opts])}`);
  }
});

test('a start that fails is a failure, never a run outside', async () => {
  const c = counter({ started: false, code: null, signal: null, out: 'bwrap: Unknown option --size\n', timedOut: false });
  const r = await runWith(['/bin/true'], OPTS, { check: YES, run: c.run });
  assert.equal(r.ok, false);
  assert.match(r.why, /^the box did not start: this bubblewrap does not know an option the box needs \(bwrap: Unknown option --size\)/);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0][0], '/usr/bin/bwrap', 'only the means is started');
});

test('the plan keeps the command as a list of words after "--"', () => {
  const p = planRun(['-x', 'a b'], OPTS);
  assert.deepEqual(p.argv, ['-x', 'a b']);
});

test('nothing in the box reads an environment variable or a file that could switch it off', () => {
  for (const f of fs.readdirSync(SRC)) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.doesNotMatch(text.replace(/process\.env\.LANG\b/g, ''), /process\.env\b/, `${f} reads no environment variable but LANG (rule 5)`);
    assert.doesNotMatch(text, /loadConfig|configDir|stateDir/, `${f} reads no setting`);
  }
});

test('the means is found at fixed paths only, never through PATH, and must be root\'s own', () => {
  const asRoot = { isFile: () => true, uid: 0, mode: 0o100755 };
  const dirRoot = { isFile: () => false, uid: 0, mode: 0o40755 };
  const stat = (over = {}) => (p) => (p === '/usr/bin' || p === '/bin' ? dirRoot : { ...asRoot, ...over });
  assert.deepEqual(findMeans('linux', { stat: stat(), real: (p) => p }), { kind: 'bwrap', file: '/usr/bin/bwrap' });
  assert.equal(findMeans('linux', { stat: stat({ uid: 1000 }), real: (p) => p }).kind, null);
  assert.match(findMeans('linux', { stat: stat({ mode: 0o100777 }), real: (p) => p }).why, /changed by others/);
  const missing = findMeans('linux', { stat: () => { throw new Error('ENOENT'); }, real: () => { throw new Error('ENOENT'); } });
  assert.equal(missing.kind, null);
  assert.equal(missing.why, 'bubblewrap is not installed');
  assert.match(missing.step, /install bubblewrap/);
});

test('boxCheck hands out a frozen answer: a holder cannot change the yes or the means it names', async () => {
  const a = await boxCheck();
  assert.ok(Object.isFrozen(a), 'the kept answer is frozen');
  const file = a.file;
  assert.throws(() => {
    a.file = '/bin/echo';
  }, 'a holder cannot point the box at another program');
  assert.equal(a.file, file);
});

test('a check or a means that throws is a no, never a rejection, and nothing runs', async () => {
  const c = counter();
  const r = await runWith(['/bin/true'], OPTS, { check: async () => { throw new Error('check boom'); }, run: c.run });
  assert.equal(r.ok, false);
  assert.match(r.why, /no box on this computer: the check could not run: check boom/);
  assert.equal(c.calls.length, 0, 'nothing ran when the check threw');
  const cw = await checkWith({ means: () => { throw new Error('means boom'); }, run: async () => assert.fail('nothing is started when the means throws') });
  assert.equal(cw.ok, false);
  assert.match(cw.why, /means could not be checked: means boom/);
});

test('on this computer: a command in the real box writes its folder, and the check is kept', { skip: !real.ok && `no box here: ${real.why}` }, async () => {
  const r = await runBoxed([process.execPath, '-e', 'require("fs").writeFileSync("made.txt", "x"); process.stdout.write("hi")'], OPTS);
  assert.equal(r.ok, true, r.why + r.out);
  assert.equal(r.code, 0);
  assert.match(r.out, /hi/);
  assert.equal(fs.readFileSync(path.join(work, 'made.txt'), 'utf8'), 'x');
  assert.strictEqual(await boxCheck(), real, 'the answer is kept in memory');
});
