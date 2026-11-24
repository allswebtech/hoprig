// A check whose Hoprig is killed while it runs (src/ship/check.mjs): the next read closes the run as cut off (neither a
// pass nor a fail) and ends the check command it left running; the next check starts only once that command is gone.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempShip } from './helpers.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'check-child.mjs');
const t = tempShip('ship-checkcut');
test.after(() => t.cleanup());
const { runCheck, readChecks, verdict, treeIdOf } = await import('../../src/ship/check.mjs');
const { allow } = await import('../../src/ship/allow.mjs');
const { readCheck } = await import('../../src/ship/project.mjs');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a check whose Hoprig was killed is closed as cut off, its command ended; the next check runs', async () => {
  const cafe = path.join(t.projects, 'cafe');
  const pidFile = path.join(t.root, 'check.pid');
  const slow = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)), setTimeout(() => {}, 30000)`;
  t.repo(cafe, { 'project.json': JSON.stringify({ check: [['node', '-e', `process.env.FAST ? 0 : (${slow})`]] }) });
  allow(cafe, 'check', readCheck(cafe).check);
  const { tree } = await treeIdOf(cafe);
  const child = spawn(process.execPath, [CHILD, cafe, cafe], { stdio: 'ignore' });
  for (let i = 0; i < 300 && !(fs.existsSync(pidFile) && readChecks(tree)?.runs.at(-1)?.running); i++) await sleep(25);
  const cmd = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(verdict(readChecks(tree)).state, 'running');
  child.kill('SIGKILL');
  await new Promise((res) => child.on('exit', res));
  assert.equal(alive(cmd), true, 'the check command runs on in its own process group');
  const v = verdict(readChecks(tree));
  assert.deepEqual([v.state, v.passed, v.failed], ['none', 0, 0], 'not "running" for ever, and neither passed nor failed');
  assert.match(v.notCounted, /cut off/);
  for (let i = 0; i < 40 && alive(cmd); i++) await sleep(25);
  assert.equal(alive(cmd), false, 'the command it left is ended');
  process.env.FAST = '1';
  try {
    const rec = await runCheck(cafe, cafe, { busy: () => ({ over: false, why: null }) });
    assert.equal(verdict(rec).state, 'ready');
  } finally {
    delete process.env.FAST;
  }
  assert.deepEqual(t.trapped(), []);
});
