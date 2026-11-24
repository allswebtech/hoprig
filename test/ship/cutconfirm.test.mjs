// A go-live cut off by a kill whose live block the owner changed and confirmed again (or forgot) before the next look
// (src/ship/live.mjs finishCut): the journal is genuine, so it is closed as "not confirmed: nothing more ran", the command
// it left running is ended, and Activity says it. Nothing more of the old block runs; the look does not stay stuck.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempShip } from './helpers.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golive-child.mjs');
const t = tempShip('ship-cutconfirm');
test.after(() => t.cleanup());
const { putTogether } = await import('../../src/ship/together.mjs');
const { runCheck } = await import('../../src/ship/check.mjs');
const { allow, forget } = await import('../../src/ship/allow.mjs');
const { readCheck, readLive } = await import('../../src/ship/project.mjs');
const { finishCut, readJournal, readLast } = await import('../../src/ship/live.mjs');
const { gitFolder } = await import('../../src/ship/lock.mjs');

const idle = () => ({ over: false, why: null });
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const activityText = () => {
  try {
    return fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'automation.log'), 'utf8');
  } catch {
    return '';
  }
};

for (const how of ['confirmed again with other commands', 'forgotten']) {
  test(`cut off in its update, its block ${how}: closed as not confirmed, its command ended, said`, async () => {
    const name = how.startsWith('forgotten') ? 'deli' : 'cafe';
    const dir = path.join(t.projects, name);
    const marks = path.join(t.root, `${name}.log`);
    const pidFile = path.join(t.root, `${name}.pid`);
    const mark = (tag) => `require('node:fs').appendFileSync(${JSON.stringify(marks)}, ${JSON.stringify(tag)} + '\\n')`;
    const order = () => (fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8').split('\n').filter(Boolean) : []);
    const slow = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${mark('update1')}; setTimeout(() => {}, 300000)`;
    const live = { update: [{ run: ['node', '-e', slow], minutes: 1 }, ['node', '-e', mark('update2')]], verify: [['node', '-e', mark('verify')]], back: [['node', '-e', mark('back')]] };
    t.repo(dir, { 'project.json': JSON.stringify({ check: [['node', '-e', '0']], live }) });
    t.branch(dir, 'work/menu', { 'menu.txt': 'menu\n' }, 'A menu');
    const r = await putTogether(dir, { name, branches: ['work/menu'] }); // Activity names the put-together
    allow(dir, 'check', readCheck(r.dir).check);
    await runCheck(dir, r.dir, { busy: idle });
    allow(dir, 'live', readLive(r.dir).live);
    const gitDir = await gitFolder(dir);
    const child = spawn(process.execPath, [CHILD, dir, r.id], { stdio: 'ignore' });
    for (let i = 0; i < 300 && !(fs.existsSync(pidFile) && readJournal(gitDir)?.running); i++) await sleep(25);
    const cmd = Number(fs.readFileSync(pidFile, 'utf8'));
    child.kill('SIGKILL');
    await new Promise((res) => child.on('exit', res));
    assert.equal(alive(cmd), true, 'the update command runs on in its own group');
    if (how.startsWith('forgotten')) forget(dir, 'live');
    else allow(dir, 'live', { ...live, verify: [['node', '-e', '1']] });
    const done = await finishCut(dir);
    assert.equal(done.outcome, 'not-confirmed', JSON.stringify(done));
    assert.match(done.why, /nothing more ran/);
    for (let i = 0; i < 40 && alive(cmd); i++) await sleep(25);
    assert.equal(alive(cmd), false, 'the command it left is ended');
    assert.deepEqual(order(), ['update1'], 'neither update2, verify nor back of the old block ran');
    assert.equal(readJournal(gitDir), null, 'the step is closed');
    assert.equal(readLast(dir).outcome, 'not-confirmed');
    assert.equal(await finishCut(dir), null, 'the next look finds nothing more');
    assert.match(activityText(), new RegExp(`${name}[^\\n]*not confirmed: nothing more ran`));
    assert.deepEqual(t.trapped(), []);
  });
}
