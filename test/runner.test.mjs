// The suite's own runner (tools/test.mjs): no result is lost on the way from a test file to the totals, also when the
// runner reads slowly (a busy computer; a pipe on macOS), a file that still holds a timer open ends, and a file whose
// results did not all arrive fails the run by name instead of leaving it green.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('below the lowest Node.js Hoprig supports the runner says so in one line and starts no test; at it, it runs', { timeout: 120_000 }, async () => {
  // A made-up version, played by test/fixtures/runner/node-version.mjs loaded into the runner itself.
  const play = (v) => new Promise((resolve, reject) => {
    const env = { ...process.env, SEAL_FAKE_NODE: v };
    delete env.NODE_TEST_CONTEXT;
    const c = spawn(process.execPath, ['--import', path.join(root, fixture('node-version.mjs')), path.join(root, 'tools', 'test.mjs'), fixture('holds.mjs')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', reject);
    c.on('close', (code) => resolve({ code, out }));
  });
  for (const v of ['22.0.0', '22.10.9']) {
    const r = await play(v);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.out, `The tests need Node.js 22.11 or newer, the lowest Hoprig supports; this is Node.js ${v}. Run them with a newer Node.js.\n`);
  }
  for (const v of ['22.11.0', '24.1.0']) {
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
});
