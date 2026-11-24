// "Take it back by itself" (src/ship/live.mjs): a step that ends not verified is taken back without a press, under the
// lock its own step holds, after the go-live itself and after the next look finished a step that was cut off.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempShip } from './helpers.mjs';

const t = tempShip('ship-autoback');
test.after(() => t.cleanup());
const { putTogether } = await import('../../src/ship/together.mjs');
const { runCheck } = await import('../../src/ship/check.mjs');
const { allow, setSwitches } = await import('../../src/ship/allow.mjs');
const { readCheck, readLive } = await import('../../src/ship/project.mjs');
const { goLive, finishCut, readLast, activity, journalPath } = await import('../../src/ship/live.mjs');
const { gitFolder } = await import('../../src/ship/lock.mjs');

const cafe = path.join(t.projects, 'cafe');
const marks = path.join(t.root, 'back.log');
const back = ['node', '-e', `require('node:fs').appendFileSync(${JSON.stringify(marks)}, 'back\\n')`];
t.repo(cafe, { 'project.json': JSON.stringify({ check: [['node', '-e', '0']], live: { update: [['node', '-e', '0']], verify: [['node', '-e', 'process.exit(3)']], back: [back] } }) });
t.branch(cafe, 'work/menu', { 'menu.txt': 'menu\n' }, 'A menu');
const idle = () => ({ over: false, why: null });
const backs = () => (fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8').split('\n').filter(Boolean).length : 0);

test('a go-live that is not verified is taken back by itself', async () => {
  const r = await putTogether(cafe, { name: 'one', branches: ['work/menu'] });
  allow(cafe, 'check', readCheck(r.dir).check);
  await runCheck(cafe, r.dir, { busy: idle });
  allow(cafe, 'live', readLive(r.dir).live);
  setSwitches(cafe, { autoBack: true });
  const j = await (await goLive(cafe, r)).done;
  assert.equal(j.outcome, 'taken-back', j.why);
  assert.equal(backs(), 1);
  assert.match(activity().recent(5)[0].did, /^one: taken back by itself$/);
});

test('a step cut off after its update and not verified at the next look is taken back by itself', async () => {
  const gitDir = await gitFolder(cafe);
  const head = t.git(cafe, 'rev-parse', 'HEAD');
  const id = '89abcdef01234567';
  const live = readLive(cafe).live;
  fs.writeFileSync(journalPath(gitDir), JSON.stringify({ v: 1, id, real: cafe, top: cafe, name: 'two', owner: 1, by: 'owner', live, values: { commit: head, tree: 'b'.repeat(40), before: head, branch: 'work/two-all' }, restarts: false, part: 'update', parts: [], pictures: {}, outcome: null }));
  const pics = path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'pictures');
  fs.mkdirSync(pics, { recursive: true });
  fs.writeFileSync(path.join(pics, `${id}-1.json`), JSON.stringify({ paths: [], files: {} }));
  const done = await finishCut(cafe);
  assert.equal(done.outcome, 'taken-back', done.why);
  assert.equal(backs(), 2);
  assert.equal(readLast(cafe).outcome, 'taken-back');
  assert.deepEqual(t.trapped(), []);
});

test('a step whose back restarts the dashboard is not taken back by itself: it says why and offers the press', async () => {
  const deli = path.join(t.projects, 'deli');
  t.repo(deli, { 'project.json': JSON.stringify({ check: [['node', '-e', '0']], live: { restarts: 'hoprig', waitSeconds: 5, update: [['node', '-e', '0']], verify: [['node', '-e', 'process.exit(3)']], back: [back] } }) });
  t.branch(deli, 'work/cake', { 'cake.txt': 'cake\n' }, 'A cake');
  const r = await putTogether(deli, { name: 'one', branches: ['work/cake'] });
  allow(deli, 'check', readCheck(r.dir).check);
  await runCheck(deli, r.dir, { busy: idle });
  allow(deli, 'live', readLive(r.dir).live);
  setSwitches(deli, { autoBack: true });
  const before = backs();
  const j = await (await goLive(deli, r, { beforeUpdate: async () => {} })).done;
  assert.equal(j.outcome, 'not-verified', j.why);
  assert.match(j.autoBackFailed, /restarts the dashboard/);
  assert.equal(backs(), before, 'its back did not run');
  assert.match(activity().recent(5)[0].did, /^one: it was not taken back by itself: its back restarts the dashboard/);
  assert.deepEqual(t.trapped(), []);
});
