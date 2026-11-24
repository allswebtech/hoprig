// A take-back whose back restarts the dashboard that runs it (src/ship/live.mjs): the next look finishes it as taken
// back when the cut fell on its last command, the restart; a cut earlier in the back stays "taking back was cut off".
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempShip } from './helpers.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'back-child.mjs');
const t = tempShip('ship-backcut');
test.after(() => t.cleanup());
const { putTogether } = await import('../../src/ship/together.mjs');
const { runCheck } = await import('../../src/ship/check.mjs');
const { allow } = await import('../../src/ship/allow.mjs');
const { readCheck, readLive } = await import('../../src/ship/project.mjs');
const { goLive, finishCut, readLast } = await import('../../src/ship/live.mjs');
const idle = () => ({ over: false, why: null });
const marks = path.join(t.root, 'back.log');
const mark = (tag) => ['node', '-e', `require('node:fs').appendFileSync(${JSON.stringify(marks)}, ${JSON.stringify(tag)} + '\\n')`];
// The restart: it ends the dashboard that runs the take-back.
const restart = ['node', '-e', 'process.kill(Number(process.env.DASH), "SIGKILL")'];

async function notVerified(name, back) {
  const dir = path.join(t.projects, name);
  t.repo(dir, { 'project.json': JSON.stringify({ check: [['node', '-e', '0']], live: { update: [['node', '-e', '0']], verify: [['node', '-e', 'process.exit(3)']], back, restarts: 'hoprig', waitSeconds: 5 } }) });
  t.branch(dir, 'work/x', { 'x.txt': 'x\n' });
  const r = await putTogether(dir, { name: 'one', branches: ['work/x'] });
  allow(dir, 'check', readCheck(r.dir).check);
  await runCheck(dir, r.dir, { busy: idle });
  allow(dir, 'live', readLive(r.dir).live);
  const j = await (await goLive(dir, r, { beforeUpdate: async () => {} })).done;
  assert.equal(j.outcome, 'not-verified');
  return dir;
}
const takeBackKilled = async (dir) => {
  const c = spawn(process.execPath, [CHILD, dir], { stdio: 'ignore' });
  await new Promise((res) => c.on('exit', res));
};

test('cut by its own restart, the last back command: the next look says taken back', async () => {
  const kiosk = await notVerified('kiosk', [mark('checkout'), restart]);
  await takeBackKilled(kiosk);
  const done = await finishCut(kiosk);
  assert.equal(done.outcome, 'taken-back', done.why);
  assert.match(done.why, /restarted the dashboard/);
  assert.equal(readLast(kiosk).outcome, 'taken-back');
  assert.equal(await finishCut(kiosk), null, 'nothing left for the look after');
  // Taken back is the end: no loop of "cut off" and another press.
  const { takeBack } = await import('../../src/ship/live.mjs');
  await assert.rejects(takeBack(kiosk), /no go-live of this project to take back/);
  assert.equal(fs.readFileSync(marks, 'utf8'), 'checkout\n');
});

test('cut before its last back command: still "taking back was cut off"', async () => {
  const cafe = await notVerified('cafe', [restart, mark('after')]);
  await takeBackKilled(cafe);
  const done = await finishCut(cafe);
  assert.equal(done.outcome, 'back-cut', done.why);
  assert.deepEqual(t.trapped(), []);
});
