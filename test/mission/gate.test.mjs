// The gate (src/mission/gate.mjs) on its own, over small real git repositories: the "file" gate counts documentation
// by its ending alone (finding 3), and the "tests" gate runs the project's test command ONLY through a box, starting
// nothing itself when there is none (findings 1/2: a session's own test code is never run here without a box).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { gate, printedTail, PRINTED_LINES, PRINTED_CHARS } = await import('../../src/mission/gate.mjs');
const { stateDir } = await import('../../src/paths.mjs');
const seam = await import('../../src/mission/seam.mjs');
const { boxCheck, runBoxed } = await import('../../src/box/box.mjs');
// Before the first test: a test registered after an await that comes later is lost by the runner.
const real = await boxCheck();
const noBox = !real.ok && `no box here: ${real.why}`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r17-op4-gate-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

/** A repo with a base commit, then a branch `main` that adds `files`. → { top, tree, base, branch }. */
function repoWith(name, files) {
  const top = fs.mkdtempSync(path.join(root, `${name}-`));
  const git = (...a) => execFileSync('git', ['-C', top, ...a], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '-b', 'main', top]);
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'a');
  fs.writeFileSync(path.join(top, 'seed'), 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(top, f)), { recursive: true });
    fs.writeFileSync(path.join(top, f), c);
  }
  git('add', '-A');
  git('commit', '-qm', 'change');
  return { top, tree: top, base, branch: 'main' };
}

test('the file gate with no named file: documentation by its ending passes, code under a docs/ folder does not', async () => {
  const okd = repoWith('docs-md', { 'docs/guide.md': '# hi\n', 'notes.txt': 'x\n' });
  assert.equal((await gate({ check: 'file', ...okd, brief: 'write the docs' })).ok, true, 'markdown and text are documentation');
  const bad = repoWith('docs-js', { 'docs/app.js': 'console.log(1)\n' });
  const r = await gate({ check: 'file', ...bad, brief: 'write the docs' });
  assert.equal(r.ok, false, 'code placed under a docs/ folder is not documentation');
  assert.ok(r.words.some((w) => /only documentation may change/.test(w)), r.words.join('; '));
});

test('the tests gate runs the command only through a box, and starts nothing itself when there is none', async () => {
  const r = repoWith('tests', { 'a.js': 'x\n' });
  const o = { check: 'tests', ...r, brief: 'Files: a.js', test: [process.execPath, '-e', 'process.exit(0)'] };
  const none = await gate({ ...o, box: null });
  assert.equal(none.ok, true, 'the diff was fine, so the work is not failed');
  assert.equal(none.testsNotRun, true, 'with no box the tests are not run');
  assert.ok(none.words.some((w) => /tests not run: yours to check/.test(w)), none.words.join('; '));
  const calls = [];
  const spy = { check: () => ({ ok: true }), run: (argv) => (calls.push(argv), { ok: true, code: 0 }) };
  const ran = await gate({ ...o, box: spy });
  assert.equal(calls.length, 1, 'the one command went through the box');
  assert.deepEqual(calls[0], o.test, 'the box got the command as given');
  assert.equal(ran.testsNotRun, undefined);
  assert.ok(ran.words.some((w) => /tests passed/.test(w)), ran.words.join('; '));
  const failing = { check: () => ({ ok: true }), run: () => ({ ok: true, code: 1 }) };
  assert.equal((await gate({ ...o, box: failing })).ok, false, 'a non-zero exit through the box does not pass');
  const unready = { check: () => ({ ok: false, why: 'no box here' }), run: () => assert.fail('must not run when the box is not ready') };
  assert.equal((await gate({ ...o, box: unready })).testsNotRun, true, 'a box whose own check fails does not run the command');
});

/** Holds the run lock of `tree` as another dashboard would (a live process of another pid), while `fn` runs. */
async function heldBy(tree, fn) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 55000)'], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  const lock = path.join(stateDir(), 'mission-runs', `${crypto.createHash('sha256').update(tree).digest('hex').slice(0, 24)}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, ident: null }));
  try {
    return await fn();
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(lock, { force: true });
  }
}

test('a run another dashboard still holds past the wait: the work is not passed, and its tests are not run', { timeout: 60_000 }, async () => {
  const r = repoWith('contend', { 'a.js': 'x\n' });
  const calls = [];
  const spy = { check: () => ({ ok: true }), run: (argv) => (calls.push(argv), { ok: true, code: 0 }) };
  const g = await heldBy(r.tree, () => gate({ check: 'tests', ...r, brief: 'Files: a.js', test: [process.execPath, '-e', '0'], box: spy, timeoutMs: 1, waitMs: 300 }));
  assert.equal(g.ok, false, 'not "Checked": a reviewer would read a worktree another run still holds');
  assert.equal(g.held, true, 'held: nothing of the worktree was judged, which is not a fault of the work');
  assert.equal(g.testsNotRun, undefined);
  assert.equal(calls.length, 0, 'the tests were not run beside the other run');
  assert.ok(g.words.some((w) => /another dashboard was still running/.test(w)), g.words.join('; '));
});

test('a held worktree still fails a branch that breaks its brief: what the branch holds is read from the repository', { timeout: 60_000 }, async () => {
  const r = repoWith('contend-bad', { 'other.js': 'x\n' });
  fs.writeFileSync(path.join(r.tree, 'left.txt'), 'uncommitted\n');
  const g = await heldBy(r.tree, () => gate({ check: 'tests', ...r, brief: 'Files: a.js', test: [process.execPath, '-e', '0'], box: null, timeoutMs: 1, waitMs: 300 }));
  assert.equal(g.ok, false);
  assert.equal(g.held, undefined, 'a fault of the work fails it as usual: a fix run follows');
  assert.deepEqual(g.words, ['it changed files the brief did not name: other.js'], 'the worktree itself was not read while held');
  const f = repoWith('contend-file', { 'b.md': 'x\n' });
  const gf = await heldBy(f.tree, () => gate({ check: 'file', ...f, brief: 'Files: a.md', timeoutMs: 1, waitMs: 300 }));
  assert.equal(gf.ok, false);
  assert.ok(gf.words.some((w) => /a\.md is not on the branch/.test(w)), gf.words.join('; '));
});

test('the seam hands out the real box: its own check and its own run, unchanged', () => {
  const b = seam.box();
  assert.ok(b, 'the seam answers a box, not null');
  assert.equal(b.check, boxCheck, 'the check is the box\'s own boxCheck');
  assert.equal(b.run, runBoxed, 'the run is the box\'s own runBoxed');
});

test('the gate waits for an asynchronous check: a yes that comes as a promise runs the tests', async () => {
  const r = repoWith('async', { 'a.js': 'x\n' });
  const calls = [];
  const box = { check: async () => ({ ok: true, kind: 'test' }), run: async (argv) => (calls.push(argv), { ok: true, code: 0, out: '' }) };
  const g = await gate({ check: 'tests', ...r, brief: 'Files: a.js', test: [process.execPath, '-e', '0'], box });
  assert.equal(calls.length, 1, 'read without waiting, a promise looks like "no": the tests must run');
  assert.equal(g.testsNotRun, undefined, g.words.join('; '));
  assert.equal(g.ok, true);
});

test('a check that throws or says no, and a box that does not start: the tests are not run, the work is not failed', async () => {
  const r = repoWith('nobox', { 'a.js': 'x\n' });
  const o = { check: 'tests', ...r, brief: 'Files: a.js', test: [process.execPath, '-e', '0'] };
  const never = () => assert.fail('nothing may run when the check did not say yes');
  const home = os.homedir();
  for (const [name, box, why] of [
    ['throws', { check: () => { throw new Error(`broken at ${home}/secret-place`); }, run: never }, /broken at ~\/secret-place/],
    ['rejects', { check: async () => { throw new Error('the self-test could not run'); }, run: never }, /self-test could not run/],
    ['no', { check: async () => ({ ok: false, why: 'bubblewrap is not installed' }), run: never }, /bubblewrap is not installed/],
    ['no run', { check: async () => ({ ok: true }) }, /no box/],
    ['did not start', { check: async () => ({ ok: true }), run: async () => ({ ok: false, code: null, timedOut: false, why: `the box did not start: no user namespaces (${home}/x)` }) }, /the box did not start: no user namespaces \(~\/x\)/],
  ]) {
    const g = await gate({ ...o, box });
    assert.equal(g.ok, true, `${name}: not a failure of the work`);
    assert.equal(g.testsNotRun, true, `${name}: the tests are not run`);
    const all = g.words.join('; ');
    assert.match(all, /tests not run/, name);
    assert.match(all, why, `${name}: the box's own why, in the gate's words: ${all}`);
    assert.ok(!all.includes(home), `${name}: no path of this computer: ${all}`);
  }
});

test('in the real box, through the seam: passing tests pass, failing tests fail', { skip: noBox, timeout: 60_000 }, async () => {
  const r = repoWith('realbox', { 'a.js': 'x\n' });
  const o = { check: 'tests', ...r, brief: 'Files: a.js', box: seam.box() };
  const pass = await gate({ ...o, test: [process.execPath, '-e', 'process.exit(0)'] });
  assert.equal(pass.ok, true, pass.words.join('; '));
  assert.equal(pass.testsNotRun, undefined, pass.words.join('; '));
  assert.ok(pass.words.some((w) => /the tests passed/.test(w)), pass.words.join('; '));
  const failing = await gate({ ...o, test: [process.execPath, '-e', 'process.exit(3)'] });
  assert.equal(failing.ok, false, failing.words.join('; '));
  assert.ok(failing.words.some((w) => /exit code 3/.test(w)), failing.words.join('; '));
});

test('the gate\'s words say where the tests ran: in the box, with no network; a timeout says how long it was given', async () => {
  const r = repoWith('words', { 'a.js': 'x\n' });
  const o = { check: 'tests', ...r, brief: 'Files: a.js', test: ['/usr/bin/npm', 'test'] };
  const box = (res) => ({ check: async () => ({ ok: true }), run: async () => res });
  const pass = await gate({ ...o, box: box({ ok: true, code: 0, out: 'ok 1\n', timedOut: false }) });
  assert.ok(pass.words.includes('the tests passed (npm test, in the box, no network)'), pass.words.join('; '));
  assert.equal(pass.boxed, true, 'the gate keeps that the tests ran in the box');
  const slow = await gate({ ...o, timeoutMs: 120_000, box: box({ ok: false, code: null, signal: 'SIGKILL', out: '', timedOut: true }) });
  assert.equal(slow.ok, false);
  assert.match(slow.words.join('; '), /did not end in time \(npm test, in the box, stopped after 2 minutes\)/);
  const red = await gate({ ...o, box: box({ ok: false, code: 1, out: 'Error: getaddrinfo EAI_AGAIN registry.example.com\n', timedOut: false }) });
  assert.equal(red.ok, false);
  assert.match(red.words.join('; '), /exit code 1; they ran in the box, with no network/);
  const none = await gate({ ...o, box: null });
  assert.equal(none.boxed, undefined, 'tests not run are never "boxed"');
});

test('what the tests printed: the last lines, within the bound, cleaned of this computer\'s paths', async () => {
  const r = repoWith('printed', { 'a.js': 'x\n' });
  const home = os.homedir();
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i} at ${r.tree}/a.js and ${home}/.ssh/key`);
  const box = { check: async () => ({ ok: true }), run: async () => ({ ok: false, code: 1, out: `${lines.join('\n')}\n`, timedOut: false }) };
  const g = await gate({ check: 'tests', ...r, brief: 'Files: a.js', test: [process.execPath, 't.js'], box });
  assert.ok(g.printed, 'what was printed is kept');
  const got = g.printed.split('\n');
  assert.ok(got.length <= PRINTED_LINES, `at most ${PRINTED_LINES} lines: ${got.length}`);
  assert.ok(g.printed.length <= PRINTED_CHARS);
  assert.match(got[got.length - 1], /^line 99 at a\.js and ~\/\.ssh\/key$/, 'the last line, the worktree and the home taken out');
  assert.ok(!g.printed.includes(home) && !g.printed.includes(r.tree), 'no path of this computer');
  assert.ok(!g.words.join(' ').includes('line 99'), 'the words never carry what was printed');
  const long = printedTail(`${'x'.repeat(10_000)}\nlast`, {});
  assert.equal(long, 'last', 'a line cut at its start goes whole');
  assert.equal(printedTail('', {}), '');
});

test('the tests left a file in the worktree: the gate does not pass, and says which', async () => {
  const r = repoWith('left', { 'a.js': 'x\n' });
  const box = { check: async () => ({ ok: true }), run: async (argv, { cwd }) => {
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'written by the tests\n');
    return { ok: true, code: 0, out: 'ok 1\n', timedOut: false };
  } };
  const g = await gate({ check: 'tests', ...r, brief: 'Files: a.js', test: [process.execPath, '-e', '0'], box });
  assert.equal(g.ok, false, g.words.join('; '));
  assert.match(g.words.join('; '), /the tests left files in the worktree: CLAUDE\.md/);
  assert.equal(g.boxed, true, 'they did run in the box');
});

test('a box check that never answers: the tests are not run, and the gate still ends', { timeout: 10_000 }, async () => {
  const r = repoWith('hang', { 'a.js': 'x\n' });
  const box = { check: () => new Promise(() => {}), run: () => assert.fail('nothing may run when the check did not answer') };
  // The gate's time limit is unref'd on purpose (it never keeps a process open); where the gate runs, the dashboard's
  // server holds the event loop. This stands in for it: without it Node 22 ends the file's loop before the limit.
  const hold = setInterval(() => {}, 1000);
  let g;
  try {
    g = await gate({ check: 'tests', ...r, brief: 'Files: a.js', test: [process.execPath, '-e', '0'], box, checkMs: 200 });
  } finally {
    clearInterval(hold);
  }
  assert.equal(g.ok, true, 'not a failure of the work');
  assert.equal(g.testsNotRun, true);
  assert.match(g.words.join('; '), /tests not run: yours to check \(the box's check did not answer in time\)/);
});

test('the gate keeps how the tests ended, and why they did not run with what would give this computer a box', async () => {
  const r = repoWith('kept', { 'a.js': 'x\n' });
  const o = { check: 'tests', ...r, brief: 'Files: a.js', test: [process.execPath, '-e', '0'] };
  const box = (res) => ({ check: async () => ({ ok: true }), run: async () => res });
  assert.deepEqual((await gate({ ...o, box: box({ ok: true, code: 0, out: '', timedOut: false }) })).tests, { result: 'passed' });
  assert.deepEqual((await gate({ ...o, box: box({ ok: false, code: 2, out: '', timedOut: false }) })).tests, { result: 'failed' });
  assert.deepEqual((await gate({ ...o, timeoutMs: 180_000, box: box({ ok: false, code: null, out: '', timedOut: true }) })).tests, { result: 'timeout', limit: '3 minutes' });
  const none = await gate({ ...o, box: { check: async () => ({ ok: false, why: 'bubblewrap is not installed', step: 'install bubblewrap' }), run: () => assert.fail('no run') } });
  assert.equal(none.noBox, true);
  assert.equal(none.notRunWhy, 'no box on this computer: bubblewrap is not installed');
  assert.equal(none.step, 'install bubblewrap');
  const start = await gate({ ...o, box: box({ ok: false, code: null, timedOut: false, why: 'the box did not start' }) });
  assert.equal(start.noBox, undefined, 'a box that did not start is there: the card still offers it');
  assert.equal(start.notRunWhy, 'the box did not start');
  assert.equal((await gate({ ...o, box: null })).noBox, true);
});
