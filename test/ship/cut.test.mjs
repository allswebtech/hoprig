// A go-live cut off by a kill (src/ship/live.mjs finishCut): the update command that ran runs on in its own process
// group; the next look waits for it, and closes the step as "the update was cut off", naming what did not run. The
// later update commands never run, and "live" is never said.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempShip } from './helpers.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golive-child.mjs');
const t = tempShip('ship-cut');
test.after(() => t.cleanup());
const { putTogether } = await import('../../src/ship/together.mjs');
const { runCheck } = await import('../../src/ship/check.mjs');
const { allow } = await import('../../src/ship/allow.mjs');
const { readCheck, readLive } = await import('../../src/ship/project.mjs');
const { finishCut, readJournal, readLast } = await import('../../src/ship/live.mjs');
const { gitFolder } = await import('../../src/ship/lock.mjs');

const idle = () => ({ over: false, why: null });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const marks = path.join(t.root, 'order.log');
const mark = (tag) => `require('node:fs').appendFileSync(${JSON.stringify(marks)}, ${JSON.stringify(tag)} + '\\n')`;
const order = () => (fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8').split('\n').filter(Boolean) : []);

test('killed during the first of two update commands: waited for, closed as cut off, the second never runs', async () => {
  const cafe = path.join(t.projects, 'cafe');
  const slow = `${mark('update1-start')}; setTimeout(() => { ${mark('update1-end')} }, 3000)`;
  t.repo(cafe, { 'project.json': JSON.stringify({ check: [['node', '-e', '0']], live: { update: [['node', '-e', slow], ['node', '-e', mark('update2')]], verify: [['node', '-e', mark('verify')]], back: [['node', '-e', mark('back')]] } }) });
  t.branch(cafe, 'work/menu', { 'menu.txt': 'menu\n' }, 'A menu');
  const r = await putTogether(cafe, { name: 'one', branches: ['work/menu'] });
  allow(cafe, 'check', readCheck(r.dir).check);
  await runCheck(cafe, r.dir, { busy: idle });
  allow(cafe, 'live', readLive(r.dir).live);
  const gitDir = await gitFolder(cafe);
  const child = spawn(process.execPath, [CHILD, cafe, r.id], { stdio: 'ignore' });
  // The kill comes once the command runs and the journal names it: the journal is written after the command's identity
  // is read, which on macOS is a call to ps (here the suite's), slower than the command's own first line.
  const named = () => { const j = readJournal(gitDir); return j && j.running; };
  for (let i = 0; i < 300 && !(order().includes('update1-start') && named()); i++) await sleep(25);
  assert.deepEqual(order(), ['update1-start']);
  child.kill('SIGKILL');
  await new Promise((res) => child.on('exit', res));
  const j = readJournal(gitDir);
  assert.deepEqual([j.part, j.running.part, j.running.index, j.updateDone], ['update', 'update', 0, 0]);
  assert.equal((await finishCut(cafe)).commandRunning, true, 'the first update command still runs: the look waits');
  assert.deepEqual(order(), ['update1-start'], 'nothing more ran meanwhile');
  for (let i = 0; i < 200 && !order().includes('update1-end'); i++) await sleep(25);
  await sleep(200); // its process ends just after its last write
  const done = await finishCut(cafe);
  assert.equal(done.outcome, 'update-cut', done.why);
  assert.match(done.why, /^the update was cut off while node -e .* ran, and node -e .*update2.* did not run\. It answers as it should$/);
  assert.deepEqual(order(), ['update1-start', 'update1-end', 'verify'], 'update2 never ran; verify only after update1 ended');
  assert.equal(readLast(cafe).outcome, 'update-cut');
  assert.deepEqual(t.trapped(), []);
});

test('a journal written by hand that names a process group ends nothing: it is checked first', async () => {
  const { system } = await import('../../src/procid.mjs');
  const deli = path.join(t.projects, 'deli');
  t.repo(deli, { 'a.txt': 'a\n' });
  const gitDir = await gitFolder(deli);
  // Stands in for any group leader of the owner's (a program started with setsid).
  const victim = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 40 && !system.of([victim.pid]).get(victim.pid); i++) await sleep(25);
    const running = { index: 0, pid: victim.pid, proc: system.of([victim.pid]).get(victim.pid), at: '2020-01-01T00:00:00.000Z', minutes: 1 };
    for (const part of ['update', 'back']) {
      fs.writeFileSync(path.join(gitDir, 'hoprig-ship.json'), JSON.stringify({ v: 1, id: '0123456789abcdef', real: deli, top: deli, name: 'x', part, parts: [], pictures: {}, values: {}, live: {}, running: { part, ...running } }));
      await assert.rejects(finishCut(deli), /not the ones confirmed/);
      await sleep(100);
      assert.doesNotThrow(() => process.kill(victim.pid, 0), `the group named in a ${part} journal still runs`);
    }
  } finally {
    victim.kill('SIGKILL');
  }
  assert.deepEqual(t.trapped(), []);
});
