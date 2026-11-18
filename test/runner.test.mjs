// The suite's own runner (tools/test.mjs): no result is lost on the way from a test file to the totals, also when the
// runner reads slowly (a busy computer; a pipe on macOS), a file that still holds a timer open ends, and a file whose
// results did not all arrive fails the run by name instead of leaving it green.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name) => path.join('test', 'fixtures', 'runner', name);

/** Runs tools/test.mjs on `files`; its output is read through a pipe. → { code, out } */
function runner(files, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT; // set for this file's own process: a runner started with it runs no files
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(root, 'tools', 'test.mjs'), ...files], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
