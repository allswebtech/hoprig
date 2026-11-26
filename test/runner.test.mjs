// The suite's own runner (tools/test.mjs): no result is lost on the way from a test file to the totals, also when the
// runner reads slowly (a busy computer; a pipe on macOS), a file that still holds a timer open ends, and a file whose
// results did not all arrive fails the run by name instead of leaving it green. With --again a file with a failing test
// runs once more by itself, and one that then passes whole keeps the run green only loudly, never silently.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => path.join('test', 'fixtures', 'runner', name);

/** Runs tools/test.mjs on `files`; its output is read through a pipe. → { code, out } */
function runner(files, extra = {}, dir = root) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT; // set for this file's own process: a runner started with it runs no files
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(dir, 'tools', 'test.mjs'), ...files], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out }));
  });
}
const total = (out) => Number(/ℹ tests (\d+)/.exec(out)?.[1] ?? NaN);

test('300 results through a runner that reads slowly, 30 times: 300 every time, and the count says every result arrived', { timeout: 300_000 }, async () => {
  const seen = [];
  // Three at a time: the computer is busier still.
  for (let i = 0; i < 30; i += 3) {
    const runs = await Promise.all([0, 1, 2].map(() => runner([fixture('many.mjs')], { HOPRIG_TEST_SLOW_READER: '0.2' })));
    for (const r of runs) {
      seen.push(total(r.out));
      assert.equal(r.code, 0, r.out.slice(-2000));
      assert.match(r.out, /ℹ every result arrived: 1 file\(s\)/);
    }
  }
  assert.deepEqual(seen, Array(30).fill(300));
});

test('a test that makes an entry in the repository root fails the run by name', { timeout: 120_000 }, async () => {
  // In a copy of the runner (tools/, with src/ linked): the probe entry lands in the copy's root, never in this
  // repository's, which every other runner of the same run watches (the seal's own tests start some side by side).
  const name = 'hoprig-root-guard-probe.tmp';
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-root-'));
  try {
    fs.cpSync(path.join(root, 'tools'), path.join(copy, 'tools'), { recursive: true });
    fs.symlinkSync(path.join(root, 'src'), path.join(copy, 'src'));
    fs.mkdirSync(path.join(copy, 'test', 'fixtures', 'runner'), { recursive: true });
    fs.copyFileSync(path.join(root, fixture('writes-root.mjs')), path.join(copy, fixture('writes-root.mjs')));
    const r = await runner([fixture('writes-root.mjs')], {}, copy);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /WORKTREE ROOT CHANGED/);
    assert.match(r.out, new RegExp(name.replace(/[.\\]/g, '\\$&')));
    assert.ok(fs.existsSync(path.join(copy, name)), 'the entry was made in the copy\'s root');
    assert.equal(fs.existsSync(path.join(root, name)), false, 'and not in this repository\'s');
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test('a file that still holds a timer open after its tests ends, and its result is counted', { timeout: 120_000 }, async () => {
  const r = await runner([fixture('holds.mjs')]);
  assert.equal(r.code, 0, r.out);
  assert.equal(total(r.out), 1);
  assert.match(r.out, /ℹ every result arrived/);
});

test('a file whose results never all arrive (a test ended its process) fails the run by name, though the runner itself saw no failure', { timeout: 120_000 }, async () => {
  const r = await runner([fixture('cut.mjs'), fixture('holds.mjs')]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ℹ fail 0/, 'Node\'s own totals say nothing failed');
  assert.match(r.out, /RESULTS LOST: 1 test file\(s\)/);
  assert.match(r.out, new RegExp(`${fixture('cut.mjs').replace(/[\\.]/g, '\\$&')}: its own summary never came`));
  assert.doesNotMatch(r.out, /holds\.mjs: /, 'the whole file is not named');
});

test('a file whose summary never came is run once more by itself: LOST FILE says its exit code or signal and its last error lines', { timeout: 300_000 }, async () => {
  // process.kill of itself ends a process by a signal where the system has signals (not on Windows).
  const signals = process.platform !== 'win32';
  const files = [fixture('lost-exit3.mjs'), fixture('lost-timer.mjs'), ...(signals ? [fixture('lost-signal.mjs')] : []), fixture('cut.mjs')];
  const r = await runner(files);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`RESULTS LOST: ${files.length} test file\\(s\\)`), 'the totals and the lines that name them are as before');
  const block = (name) => {
    const at = r.out.indexOf(`LOST FILE: ${fixture(name)}: `);
    assert.ok(at >= 0, `${name} has its block:\n${r.out.slice(-4000)}`);
    const rest = r.out.slice(at);
    const next = rest.indexOf('\nLOST FILE: ', 1);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const three = block('lost-exit3.mjs');
  assert.match(three, /ended with exit code 3 \(0x3\), signal none/);
  assert.match(three, /its error output, the last \d+ of \d+ line\(s\):\n[\s\S]*made-up last words before exit 3/);
  const timer = block('lost-timer.mjs');
  assert.match(timer, /ended with exit code 1 \(0x1\), signal none/);
  assert.match(timer, /Error: made-up error in a timer/);
  if (signals) assert.match(block('lost-signal.mjs'), /ended with no exit code, signal SIGTERM/);
  // Three at most are run again; the rest are counted.
  if (files.length > 3) assert.match(r.out, new RegExp(`LOST FILE: ${files.length - 3} more file\\(s\\) whose own summary never came were not run again \\(three at most\\)`));
  for (const b of r.out.split('\nLOST FILE: ').slice(1)) assert.ok(b.split('\n').length <= 60, `one block, at most 60 lines:\n${b}`);
});

test('the second run of a lost file is checked by the traps as the first run is: a reach of it is named', { timeout: 120_000 }, async () => {
  const r = await runner([fixture('lost-reaches.mjs')]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /LOST FILE: \S*lost-reaches\.mjs: /);
  assert.match(r.out, /A TEST REACHED THE REAL sudo: .*\(it asked: sudo made-up-second-run; stopped by the runner's trap\)/);
});

test('a lost file whose second run by itself passes whole is counted from that run and said loudly; the run stays green', { timeout: 120_000 }, async () => {
  const r = await runner([fixture('lost-then-passes.mjs'), fixture('holds.mjs')]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`⚠ LOST FILE PASSED ON ITS SECOND RUN: ${fixture('lost-then-passes.mjs').replace(/[\\.]/g, '\\$&')}: its first process ended without its own summary (after \\d+ ms|at a time not told) \\(0 result\\(s\\) came, none failing\\); run again by itself it passed whole in \\d+ ms: tests 2, pass 2, fail 0, skipped 0, todo 0\\.`));
  assert.doesNotMatch(r.out, /RESULTS LOST/);
  assert.match(r.out, /ℹ every result arrived: 2 file\(s\), each with its own summary \(1 of them from a second run by itself, said above\)/);
});

test('a lost file whose second run fails stays a lost result: the run fails, with its block', { timeout: 120_000 }, async () => {
  const r = await runner([fixture('lost-then-fails.mjs')]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /RESULTS LOST: 1 test file\(s\)/);
  assert.match(r.out, /LOST FILE: \S*lost-then-fails\.mjs: run again by itself, as a process of its own, it ended with exit code 1 /);
  assert.doesNotMatch(r.out, /PASSED ON ITS SECOND RUN|every result arrived/);
});

test('a file whose first run reported a failing test is never rescued by a second run that passes', { timeout: 120_000 }, async () => {
  const r = await runner([fixture('lost-after-failing.mjs')]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /RESULTS LOST: 1 test file\(s\)/);
  assert.match(r.out, /LOST FILE: \S*lost-after-failing\.mjs: run again by itself, as a process of its own, it ended with exit code 0 /, 'it ran again, for the reason only');
  assert.doesNotMatch(r.out, /PASSED ON ITS SECOND RUN|every result arrived/);
});

// --again: each fixture (test/fixtures/runner/again-*.mjs) adds a line per run to <name>.runs in its temporary folder,
// a folder of this test's own handed in as TMPDIR (TEMP and TMP on Windows), so a test counts how often a file ran.
async function againRun(files, extra = {}, { before = () => {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-again-'));
  try {
    before(tmp);
    const summaryFile = path.join(tmp, 'step-summary.md');
    fs.writeFileSync(summaryFile, '# made-up earlier step\n');
    const r = await runner(files, { TMPDIR: tmp, TEMP: tmp, TMP: tmp, GITHUB_STEP_SUMMARY: summaryFile, ...extra });
    const runs = {};
    for (const f of fs.readdirSync(tmp).filter((x) => x.endsWith('.runs'))) runs[f.slice(0, -5)] = fs.readFileSync(path.join(tmp, f), 'utf8').split('\n').filter(Boolean).length;
    return { ...r, runs, summary: fs.readFileSync(summaryFile, 'utf8') };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const esc = (s) => s.replace(/[\\.()[\]*+?^$|{}]/g, '\\$&');
/** The block of `out` that starts with `head` (a marker line and its file), up to the next empty line. */
function blockOf(out, head) {
  const at = out.indexOf(`${head}\n`);
  assert.ok(at >= 0, `a block "${head}":\n${out.slice(-4000)}`);
  const rest = out.slice(at);
  const end = rest.indexOf('\n\n');
  return end < 0 ? rest : rest.slice(0, end);
}

test('--again off (the default): a file with a failing test fails the run as before, and nothing is run again', { timeout: 120_000 }, async () => {
  const r = await againRun([fixture('again-once.mjs')]);
  assert.equal(r.code, 1, r.out);
  assert.equal(r.runs['again-once'], 1, 'it ran once');
  assert.match(r.out, /ℹ fail 1/);
  assert.match(r.out, /ℹ every result arrived: 1 file\(s\), each with its own summary\n/);
  assert.doesNotMatch(r.out, /SECOND RUN|NOT RUN AGAIN|NOT RESCUED|passed only on their second run/i);
  assert.equal(r.summary, '# made-up earlier step\n', 'the step summary is left alone');
});

test('--again: a file that fails once and passes when run again by itself keeps the run green, said loudly with the test that failed', { timeout: 120_000 }, async () => {
  const r = await againRun(['--again', fixture('again-once.mjs')]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.runs['again-once'], 2, 'run once more, and only once');
  assert.match(r.out, /ℹ fail 1/, 'the first run\'s own totals are shown as they were');
  const b = blockOf(r.out, `⚠ PASSED ONLY ON ITS SECOND RUN: ${fixture('again-once.mjs')}`);
  assert.match(b, /\n {2}its first run, in the whole run, failed with:\n {4}✖ fails on its first run only\n {6}made-up failure of the first run only\n {6}its second line\n/);
  assert.match(b, /\n {2}run again by itself, as a process of its own, it passed whole in \d+ ms: tests 2, pass 2, fail 0, skipped 0, todo 0\n/);
  assert.match(b, /the run does not fail for it, but a test that passes only on its second run is a defect to look at, not a pass/);
  const closing = '⚠ passed only on their second run: 1 file(s), each in its block above ("⚠ PASSED ONLY ON ITS SECOND RUN:"); the run does not fail for them';
  assert.ok(r.out.includes(`${closing}\n`), r.out.slice(-2000));
  assert.ok(r.out.indexOf('ℹ every result arrived: 1 file(s)') < r.out.indexOf(closing), 'it is the closing line, after the count');
});

test('--again: a todo test that fails fails no run, so its file is not run again and nothing is said of a second run', { timeout: 120_000 }, async () => {
  const r = await againRun(['--again', fixture('again-todo.mjs')]);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.runs['again-todo'], 1);
  assert.doesNotMatch(r.out, /SECOND RUN:|SECOND RUN AS WELL:|NOT RUN AGAIN/);
  assert.match(r.out, /ℹ passed only on their second run: 0 file\(s\)\n/);
});

test('--again: a file that fails on its second run as well keeps the run red, with the failures of both runs', { timeout: 120_000 }, async () => {
  const r = await againRun([fixture('again-twice.mjs')], { HOPRIG_TEST_AGAIN: '1' });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.runs['again-twice'], 2);
  const b = blockOf(r.out, `✖ FAILED ON ITS SECOND RUN AS WELL: ${fixture('again-twice.mjs')}`);
  assert.match(b, /\n {2}its first run, in the whole run, failed with:\n {4}✖ fails on every run\n {6}made-up failure of every run\n/);
  assert.match(b, /\n {2}run again by itself, as a process of its own, it ended with exit code 1 \(0x1\), signal none, after \d+ ms: tests 2, pass 1, fail 1, cancelled 0, skipped 0, todo 0; it failed with:\n {4}✖ fails on every run\n {6}made-up failure of every run/);
  assert.doesNotMatch(r.out, /PASSED ONLY ON ITS SECOND RUN/);
  assert.match(r.out, /ℹ passed only on their second run: 0 file\(s\)\n/);
  assert.equal(r.summary, '# made-up earlier step\n');
});

test('--again: with more than three files with failing tests nothing is run again, and one line says why', { timeout: 120_000 }, async () => {
  const names = ['again-once', 'again-twice', 'again-fails-a', 'again-fails-b'];
  const r = await againRun(['--again', ...names.map((n) => fixture(`${n}.mjs`))]);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(r.runs, Object.fromEntries(names.map((n) => [n, 1])), 'each ran once');
  assert.match(r.out, /✖ NOT RUN AGAIN: 4 files have failing tests, more than 3: that many at once is not a flake, so none was run a second time, and the run fails for them as without --again\.\n/);
  assert.doesNotMatch(r.out, /SECOND RUN:|SECOND RUN AS WELL:/);
  assert.match(r.out, /ℹ passed only on their second run: 0 file\(s\)\n/);
});

test('--again: a file that the seal marked (it reached a trapped program) is never rescued, on its first run or on its second', { timeout: 120_000 }, async () => {
  const first = await againRun(['--again', fixture('again-reaches.mjs')], {}, { before: (tmp) => fs.writeFileSync(path.join(tmp, 'again-reaches.when'), 'first') });
  assert.equal(first.code, 1, first.out);
  assert.match(first.out, /A TEST REACHED THE REAL sudo: \S*again-reaches\.mjs \(it asked: sudo made-up-again;/);
  assert.equal(first.runs['again-reaches'], 1, 'not run again');
  assert.match(first.out, /✖ NOT RUN AGAIN: this run has a mark of the seal, said above \(a test reached a real program, the real home, a default port, a public registry or the repository root\): a failure in such a run is never rescued by a second run\.\n/);
  assert.doesNotMatch(first.out, /PASSED ONLY ON ITS SECOND RUN/);
  // Its second run passes, but reaches the trap: named by the file as a first run is, and not rescued.
  const second = await againRun(['--again', fixture('again-reaches.mjs')], {}, { before: (tmp) => fs.writeFileSync(path.join(tmp, 'again-reaches.when'), 'second') });
  assert.equal(second.code, 1, second.out);
  assert.equal(second.runs['again-reaches'], 2);
  assert.match(second.out, new RegExp(`A TEST REACHED THE REAL sudo: ${esc(fixture('again-reaches.mjs').split(path.sep).join('/'))} \\(it asked: sudo made-up-again;`));
  assert.match(second.out, new RegExp(`✖ NOT RESCUED: ${esc(fixture('again-reaches.mjs'))} passed on its second run, but this run has a mark of the seal, said above: a failure in such a run is never rescued by a second run\\.\\n`));
  assert.doesNotMatch(second.out, /PASSED ONLY ON ITS SECOND RUN/);
  assert.match(second.out, /ℹ passed only on their second run: 0 file\(s\)\n/);
});

test('--again: the step summary of a GitHub run gets the files that passed only on their second run, with the tests that failed', { timeout: 120_000 }, async () => {
  const r = await againRun(['--again', fixture('again-once.mjs')]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.summary.startsWith('# made-up earlier step\n'), 'appended, not written over');
  const md = r.summary.slice('# made-up earlier step\n'.length);
  assert.match(md, /^\n### ⚠ Passed only on their second run: 1 file\(s\)\n\n/);
  assert.match(md, /a defect to look at, not a pass/);
  assert.ok(md.includes(`\n- \`${fixture('again-once.mjs').split(path.sep).join('/')}\` (second run: tests 2, pass 2, fail 0): \`fails on its first run only\`: made-up failure of the first run only\n`), md);
});

test('the workflows of every push and of Windows run the tests with --again, a release runs them plainly, and CONTRIBUTING.md says so', () => {
  const runs = (f) => [...fs.readFileSync(path.join(root, '.github', 'workflows', f), 'utf8').matchAll(/^\s*- run: ((?:npm test|node tools\/test\.mjs)\b.*)$/gm)].map((m) => m[1]);
  for (const f of ['test.yml', 'windows.yml']) {
    assert.ok(runs(f).length > 0, f);
    for (const line of runs(f)) assert.match(line, /(^| )--again( |$)/, `${f}: ${line}`);
  }
  assert.deepEqual(runs('release.yml'), ['npm test'], 'a release must pass plainly');
  const page = fs.readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf8').replace(/\n\s*/g, ' ');
  assert.match(page, /The workflows run the tests with `--again`/);
  assert.ok(page.includes('"⚠ PASSED ONLY ON ITS SECOND RUN:"'), 'the marker the runner prints');
  assert.match(page, /a defect to look at, a test that depends on timing or on another test, not a pass to ignore/);
  assert.match(page, /At most three files run again, never one the seal marked, and a release runs without it/);
  assert.match(page, /`node tools\/test\.mjs --again test\/x\.test\.mjs`, or `HOPRIG_TEST_AGAIN=1 npm test`/);
});

test('below the lowest Node.js Hoprig supports the runner says so in one line and starts no test; at it, it runs', { timeout: 120_000 }, async () => {
  // A made-up version, played by test/fixtures/runner/node-version.mjs loaded into the runner itself.
  const play = (v) => new Promise((resolve, reject) => {
    const env = { ...process.env, SEAL_FAKE_NODE: v };
    delete env.NODE_TEST_CONTEXT;
    const c = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, fixture('node-version.mjs'))).href, path.join(root, 'tools', 'test.mjs'), fixture('holds.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out }));
  });
  for (const v of ['22.11.0', '24.13.0']) {
    const r = await play(v);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.out, `The tests need Node.js 24.13.1 or newer, the lowest Hoprig supports; this is Node.js ${v}. Run them with a newer Node.js.\n`);
  }
  for (const v of ['24.13.1', '26.1.0']) {
    const r = await play(v);
    assert.equal(r.code, 0, r.out);
    assert.equal(total(r.out), 1, v);
  }
});

test('npm writes no debug log for a command of this repository: its .npmrc says logs-max=0', () => {
  // npm opens its debug log before a script runs, in <cache>/_logs, and `npm test` sets the cache to the person's own
  // ~/.npm; the runner cannot reach that log, so the repository's own .npmrc (it outranks the person's) turns it off.
  const rc = fs.readFileSync(path.join(root, '.npmrc'), 'utf8');
  assert.match(rc, /^logs-max=0$/m);
  assert.doesNotMatch(rc, /^(?!#).*(token|_auth|registry)/im, 'nothing else: no registry, no token');
});

test('a run whose own temporary folder is removed under it says so, with the folder, not only that results were lost', { timeout: 120_000 }, async () => {
  const r = await runner([fixture('removes-sandbox.mjs')]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /RESULTS LOST/);
  assert.match(r.out, /this run's own temporary folder \S*hoprig-tests-\S+ was removed while its tests ran, by something other than this run/);
  assert.doesNotMatch(r.out, /every result arrived/, 'the closing line never says the opposite of RESULTS LOST');
});

test('with reporters of your own the count is left out, and the closing line does not say every result arrived', { timeout: 120_000 }, async () => {
  const r = await runner(['--test-reporter=dot', fixture('holds.mjs')]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Reporters of your own: the count of every file's results is left out/);
  assert.doesNotMatch(r.out, /every result arrived/, 'nothing was counted');
});
