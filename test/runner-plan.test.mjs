// What the suite's runner hands `node --test` (tools/test-plan.mjs): a folder as one glob pattern, so the command line
// stays short on Windows (about 1,100 paths were too long there: `spawn ENAMETOOLONG`), and the files Node's glob finds
// are the files the runner lists itself, so "every result arrived" and the totals stay true.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WINDOWS_LINE, findTests, longTemp, partOfPlan, psCachePlan, psModuleCache, psWarmCall, testArgs, unlisted } from '../tools/test-plan.mjs';
import { SEAL_VARS } from './seal.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN_ROOT = 'D:\\a\\shop\\shop';

/** A stand-in for findTests on Windows: `n` made-up test files under each folder, a file as itself. */
const winFind = (n) => (full) => (full.endsWith('.mjs')
  ? { isFile: true, files: [full] }
  : { isFile: false, files: Array.from({ length: n }, (_, i) => path.win32.join(full, `area${i % 40}`, `case-with-a-long-name-${i}.test.mjs`)) });

test('on Windows the whole suite of 1,100 files goes to node --test as one short pattern, and every file is still known', () => {
  const plan = testArgs([], { root: WIN_ROOT, platform: 'win32', find: winFind(1100) });
  assert.deepEqual(plan.args, ['test/**/*.test.mjs']);
  assert.equal(plan.files.length, 1100);
  assert.ok(plan.files.every((f) => f.startsWith(`${WIN_ROOT}\\test\\`)), plan.files[0]);
  assert.ok(plan.line < 100, String(plan.line));
  assert.equal(plan.tooLong, null);
});

test('the old way, every path on the line, is longer than Windows allows: named one by one it is refused in one sentence', () => {
  const each = winFind(1100)(path.win32.join(WIN_ROOT, 'test')).files;
  assert.ok(each.reduce((n, f) => n + f.length + 3, 0) > 32_767, 'the 1,100 paths are longer than a Windows command line');
  const plan = testArgs(each, { root: WIN_ROOT, platform: 'win32', find: winFind(0) });
  assert.ok(plan.line > WINDOWS_LINE);
  assert.match(plan.tooLong, /^The test files named one by one make a command line of \d+ characters, more than Windows allows \(30000\); name their folder instead \(node tools\/test\.mjs test\/server\)\.$/);
  // The same list on Linux is no problem there (its limit is far higher) and is not refused.
  assert.equal(testArgs(each.map((f) => f.replaceAll('\\', '/').replace('D:', '')), { root: '/a/shop/shop', platform: 'linux', find: (f) => ({ isFile: true, files: [f] }) }).tooLong, null);
});

test('folders, files, a folder outside the repository and a folder whose name reads as a pattern each go the right way', () => {
  const find = (full) => (full.endsWith('.mjs') ? { isFile: true, files: [full] } : { isFile: false, files: [path.win32.join(full, 'a.test.mjs')] });
  const plan = testArgs(['test\\server', 'test/runner.test.mjs', 'E:\\elsewhere', 'test\\odd[1]'], { root: WIN_ROOT, platform: 'win32', find });
  assert.deepEqual(plan.args, [
    'test/server/**/*.test.mjs', // a folder: one pattern, with forward slashes (Node's glob reads a backslash as an escape)
    'test/runner.test.mjs', // a file: itself
    'E:\\elsewhere\\a.test.mjs', // outside the repository: its files one by one, by full path
    `${WIN_ROOT}\\test\\odd[1]\\a.test.mjs`, // "[1]" would be read as a pattern: its files one by one
  ]);
  assert.deepEqual(testArgs(['.'], { root: '/a/shop', platform: 'linux', find: () => ({ isFile: false, files: [] }) }).args, ['**/*.test.mjs']);
});

test('the runner lists a folder the way Node\'s glob finds it: no node_modules, no folder whose name starts with a dot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-find-'));
  try {
    for (const f of ['a.test.mjs', 'sub/b.test.mjs', 'sub/c.mjs', 'node_modules/d.test.mjs', '.hidden/e.test.mjs', 'x[1]/f.test.mjs']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
    assert.deepEqual(findTests(dir).files.map((f) => path.relative(dir, f).split(path.sep).join('/')), ['a.test.mjs', 'sub/b.test.mjs', 'x[1]/f.test.mjs']);
    // The folder it was asked for may itself sit under a dot folder (a temporary folder often does): only what is
    // below it counts.
    const under = path.join(dir, '.hidden');
    assert.deepEqual(findTests(under).files, [path.join(under, 'e.test.mjs')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a part of a run names its own files (a pattern would run them all), every file in exactly one part', () => {
  const whole = testArgs([], { root: WIN_ROOT, platform: 'win32', find: winFind(10) });
  const parts = [1, 2, 3].map((no) => partOfPlan(whole, no, 3, { root: WIN_ROOT, platform: 'win32' }));
  assert.deepEqual(parts.map((p) => p.files.length), [4, 3, 3]);
  assert.deepEqual(parts.flatMap((p) => p.files).sort(), [...whole.files].sort(), 'every file once, none twice');
  for (const p of parts) {
    assert.ok(p.args.every((a) => a.startsWith('test/area') && !a.includes('*') && !a.includes('\\')), p.args.join(' '));
    assert.equal(p.tooLong, null);
  }
  assert.equal(partOfPlan(whole, 1, 1, { root: WIN_ROOT, platform: 'win32' }), whole, 'a whole run keeps its pattern');
  // A third of 1,100 files, named relative to the repository, fits a Windows command line; a part too large for one is
  // refused in one sentence, not with ENAMETOOLONG.
  const suite = testArgs([], { root: WIN_ROOT, platform: 'win32', find: winFind(1100) });
  assert.equal(partOfPlan(suite, 2, 3, { root: WIN_ROOT, platform: 'win32' }).tooLong, null);
  const big = testArgs([], { root: WIN_ROOT, platform: 'win32', find: winFind(2000) });
  assert.match(partOfPlan(big, 2, 2, { root: WIN_ROOT, platform: 'win32' }).tooLong, /^Part 2 of 2 names its 1000 test files one by one, a command line of \d+ characters, more than Windows allows \(30000\); run it in more parts\.$/);
});

test('Windows: a temporary folder named in the short form is used by its long name, as git and the system name it', () => {
  // What a Windows runner hands the job, and what Windows answers for its real path.
  const short = 'C:\\Users\\EXAMPL~1\\AppData\\Local\\Temp';
  const long = 'C:\\Users\\example.user\\AppData\\Local\\Temp';
  const realpath = (p) => (p === short ? long : p);
  assert.deepEqual(longTemp({ TEMP: short, TMP: short }, { platform: 'win32', realpath }), { TEMP: long, TMP: long });
  assert.deepEqual(longTemp({ TMP: short }, { platform: 'win32', realpath }), { TEMP: long, TMP: long });
  assert.equal(longTemp({ TEMP: long, TMP: long }, { platform: 'win32', realpath }), null, 'a long name stays');
  assert.equal(longTemp({ TEMP: short }, { platform: 'win32', realpath: () => { throw new Error('gone'); } }), null, 'a folder that cannot be read stays');
  // Nothing changes on another system, whatever its TMPDIR looks like.
  assert.equal(longTemp({ TEMP: '/tmp/a~1', TMPDIR: '/tmp/a~1' }, { platform: 'linux', realpath: () => '/tmp/other' }), null);
});

test('Windows: one PowerShell module cache for the whole run, in its own temporary folder, carried to every child', () => {
  const sandbox = 'C:\\t\\hoprig-tests-ab';
  assert.deepEqual(psModuleCache(sandbox, { platform: 'win32' }), { PSModuleAnalysisCachePath: 'C:\\t\\hoprig-tests-ab\\powershell\\ModuleAnalysisCache' });
  // Not inside a test's home, so a check that nothing changed in the home never sees it.
  assert.ok(!psModuleCache(sandbox, { platform: 'win32' }).PSModuleAnalysisCachePath.includes('\\home\\'));
  // The seal carries it to a child given an environment of its own.
  assert.ok(SEAL_VARS.includes('PSModuleAnalysisCachePath'));
  // Nothing on another system.
  for (const platform of ['linux', 'darwin']) assert.equal(psModuleCache('/t/hoprig-tests-ab', { platform }), null);
});

test('Windows: the run writes its PowerShell module cache once before the tests; a nested run uses the outer one', () => {
  const sandbox = 'C:\\t\\hoprig-tests-ab';
  const own = 'C:\\t\\hoprig-tests-ab\\powershell\\ModuleAnalysisCache';
  const outer = 'C:\\t\\hoprig-tests-outer\\powershell\\ModuleAnalysisCache';
  const there = (f) => f === outer;
  // The outermost run: its own cache, written first.
  assert.deepEqual(psCachePlan(sandbox, { platform: 'win32', exists: there }), { vars: { PSModuleAnalysisCachePath: own }, warm: true });
  // A runner started inside a test: the outer run's cache, already written, used as it is.
  assert.deepEqual(psCachePlan(sandbox, { platform: 'win32', nested: true, inherited: outer, exists: there }), { vars: { PSModuleAnalysisCachePath: outer }, warm: false });
  // An outer cache that is not there, or a cache path of the person's own outside a run of the suite: never used.
  assert.equal(psCachePlan(sandbox, { platform: 'win32', nested: true, inherited: 'C:\\gone', exists: there }).warm, true);
  assert.equal(psCachePlan(sandbox, { platform: 'win32', nested: false, inherited: outer, exists: there }).vars.PSModuleAnalysisCachePath, own);
  // The one call: Windows PowerShell, no profile, the cmdlets the product asks, and it waits for the file.
  const call = psWarmCall({ platform: 'win32', waitMs: 30_000 });
  assert.equal(call.command, 'powershell.exe');
  assert.deepEqual(call.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  const script = Buffer.from(call.args[5], 'base64').toString('utf16le');
  for (const part of ['Get-Command', 'Get-Process', 'Get-CimInstance -ClassName Win32_Process', 'Test-Path -LiteralPath $f', "'written'", "'missing'"]) assert.ok(script.includes(part), part);
  assert.ok(call.timeout > 30_000, 'the call may wait for the file');
  // Nothing on another system.
  for (const platform of ['linux', 'darwin']) {
    assert.equal(psCachePlan('/t/x', { platform }), null);
    assert.equal(psWarmCall({ platform }), null);
  }
});

test('a file Node ran that the runner did not mean to run is named', () => {
  assert.deepEqual(unlisted(['/r/test/a.test.mjs'], ['/r/test/a.test.mjs', '/r/test/.x/b.test.mjs']), ['/r/test/.x/b.test.mjs']);
  assert.deepEqual(unlisted(['/r/test/a.test.mjs'], ['/r/test/a.test.mjs']), []);
});

/** Runs a copy of the runner (tools/, src/ linked) in `copy` on `places`. → { code, out } */
function runCopy(copy, places) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // set for this file's own process: a runner started with it runs no files
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(copy, 'tools', 'test.mjs'), ...places], { cwd: copy, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out }));
  });
}

test('a real run of a folder through the pattern: the files it meant to run, all their results, and nothing else', { timeout: 180_000 }, async () => {
  // In a copy of the runner, so its test folder is a made-up one: one file in a dot folder and one in node_modules that
  // must not run, and a folder named like a pattern whose file must.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-plan-'));
  try {
    fs.cpSync(path.join(root, 'tools'), path.join(copy, 'tools'), { recursive: true });
    fs.symlinkSync(path.join(root, 'src'), path.join(copy, 'src'), 'junction'); // a junction needs no administrator on Windows
    const body = (n) => `import { test } from 'node:test';\nfor (let i = 0; i < ${n}; i++) test(\`case \${i}\`, () => {});\n`;
    const write = (f, n) => {
      fs.mkdirSync(path.dirname(path.join(copy, f)), { recursive: true });
      fs.writeFileSync(path.join(copy, f), body(n));
    };
    write('test/one.test.mjs', 2);
    write('test/area/two.test.mjs', 3);
    write('test/x[1]/three.test.mjs', 4);
    write('test/.hidden/never.test.mjs', 50);
    write('test/node_modules/never.test.mjs', 50);
    const all = await runCopy(copy, []);
    assert.equal(all.code, 0, all.out.slice(-3000));
    assert.match(all.out, /ℹ tests 9\n/);
    assert.match(all.out, /ℹ every result arrived: 3 file\(s\), each with its own summary/);
    const area = await runCopy(copy, ['test/area', 'test/one.test.mjs']);
    assert.equal(area.code, 0, area.out.slice(-3000));
    assert.match(area.out, /ℹ tests 5\n/);
    assert.match(area.out, /ℹ every result arrived: 2 file\(s\)/);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});
