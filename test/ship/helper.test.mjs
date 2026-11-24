// The helper of a go-live whose update restarts the dashboard (src/ship/helper.mjs): when the dashboard that ran the
// step is gone and nobody claims the step within the wait, it runs the confirmed "back" and writes the outcome. A step
// a dashboard has claimed is left alone (never both), and a journal whose block is not the confirmed one runs nothing.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempShip } from './helpers.mjs';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'ship', 'helper.mjs');
const t = tempShip('ship-helper');
test.after(() => t.cleanup());
const { allow } = await import('../../src/ship/allow.mjs');
const { cleanLive } = await import('../../src/ship/project.mjs');
const { readLast, journalPath, claimStep, claimHeld } = await import('../../src/ship/live.mjs');
const { gitFolder } = await import('../../src/ship/lock.mjs');
const shop = path.join(t.projects, 'shop');
t.repo(shop);
const gitDir = await gitFolder(shop);
const head = t.git(shop, 'rev-parse', 'HEAD'); // the commits a journal names are in its repository
const marker = path.join(t.root, 'back-ran');
const live = cleanLive({
  update: [{ run: ['node', '-e', '0'], minutes: 1 }],
  verify: [{ url: 'http://127.0.0.1:9/', seconds: 1 }],
  back: [{ run: ['node', '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'back\\n')`], minutes: 1 }],
  restarts: 'hoprig',
  waitSeconds: 5,
}).live;
const hex = (c) => c.repeat(40);
const deadPid = await new Promise((res) => {
  const c = spawn(process.execPath, ['-e', '0']);
  c.on('exit', () => res(c.pid));
});

/** A journal of a step cut in its update, its dashboard gone. */
function journal(id, block = live, extra = {}) {
  const j = { v: 1, id, real: shop, top: shop, name: 'self', owner: deadPid, restarts: true, live: block, part: 'update', updateAt: new Date().toISOString(), parts: [], pictures: {}, values: { commit: head, tree: hex('b'), before: head, branch: 'work/self-all' }, ...extra };
  fs.writeFileSync(journalPath(gitDir), JSON.stringify(j));
  return j;
}
const runHelper = () => new Promise((res) => spawn(process.execPath, [HELPER, gitDir], { stdio: 'ignore' }).on('exit', res));

test('nobody claims the step within the wait: the helper takes it back', async () => {
  allow(shop, 'live', live);
  journal('1111111111111111');
  const t0 = Date.now();
  await runHelper();
  assert.ok(Date.now() - t0 >= 4500, 'it waited');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'back\n');
  const last = readLast(shop);
  assert.equal(last.outcome, 'taken-back');
  assert.match(last.why, /helper/);
  assert.equal(fs.existsSync(journalPath(gitDir)), false);
});

test('a step a dashboard claimed is left alone', async () => {
  journal('2222222222222222');
  claimStep(gitDir, '2222222222222222', 'dashboard');
  await runHelper();
  assert.equal(fs.readFileSync(marker, 'utf8'), 'back\n', 'back did not run again');
  fs.rmSync(journalPath(gitDir));
});

test('a journal with another back than the confirmed one runs nothing', async () => {
  const other = { ...live, back: [{ run: ['node', '-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'other\\n')`], minutes: 1 }] };
  journal('3333333333333333', other);
  await runHelper();
  assert.equal(fs.readFileSync(marker, 'utf8'), 'back\n');
  fs.rmSync(journalPath(gitDir), { force: true });
  assert.deepEqual(t.trapped(), []);
});

test('a claim left by a dashboard that is gone holds nothing: the helper still takes it back', async () => {
  journal('4444444444444444');
  // The dashboard that ran the step claimed it after its update, then the restart ended it.
  fs.writeFileSync(path.join(gitDir, 'hoprig-ship-4444444444444444.claim'), JSON.stringify({ who: 'dashboard', pid: deadPid, at: new Date().toISOString() }));
  assert.equal(claimHeld(gitDir, '4444444444444444'), false);
  await runHelper();
  assert.equal(fs.readFileSync(marker, 'utf8'), 'back\nback\n', 'back ran');
  assert.equal(readLast(shop).outcome, 'taken-back');
});

test('two takers of a claim of a process that is gone: exactly one gets it', () => {
  const id = '5555555555555555';
  fs.writeFileSync(path.join(gitDir, `hoprig-ship-${id}.claim`), JSON.stringify({ who: 'dashboard', pid: deadPid }));
  assert.equal(claimStep(gitDir, id, 'dashboard'), true);
  // Another living process holds it now (a stand-in identity that is never "gone"): a second taker is refused.
  const other = { self: () => 'L:x:1', of: (pids) => new Map(pids.map((p) => [p, 'L:x:2'])), bootAt: () => 0 };
  const c = JSON.parse(fs.readFileSync(path.join(gitDir, `hoprig-ship-${id}.claim`), 'utf8'));
  fs.writeFileSync(path.join(gitDir, `hoprig-ship-${id}.claim`), JSON.stringify({ ...c, pid: process.ppid, proc: null }));
  assert.equal(claimStep(gitDir, id, 'helper', { ident: other }), false);
  fs.rmSync(path.join(gitDir, `hoprig-ship-${id}.claim`));
});

test('a journal that names another project, or a commit not in the repository, runs nothing', async () => {
  // Another project with a confirmed live block of its own: a journal put into shop's git folder must not run its back.
  const cafe = path.join(t.projects, 'cafe');
  t.repo(cafe);
  const cafeMark = path.join(t.root, 'cafe-back-ran');
  const cafeLive = { ...live, back: [{ run: ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(cafeMark)}, '1')`], minutes: 1 }] };
  allow(cafe, 'live', cafeLive);
  const cafeHead = t.git(cafe, 'rev-parse', 'HEAD');
  journal('6666666666666666', cafeLive, { real: cafe, top: cafe, values: { commit: cafeHead, tree: hex('b'), before: cafeHead, branch: 'work/self-all' } });
  await runHelper();
  assert.equal(fs.existsSync(cafeMark), false, "cafe's back did not run");
  fs.rmSync(journalPath(gitDir), { force: true });
  // Shop's own confirmed back, with a commit id that is not in shop's repository.
  const before = fs.readFileSync(marker, 'utf8');
  journal('7777777777777777', live, { values: { commit: head, tree: hex('b'), before: hex('c'), branch: 'work/self-all' } });
  await runHelper();
  assert.equal(fs.readFileSync(marker, 'utf8'), before, 'back did not run');
  fs.rmSync(journalPath(gitDir), { force: true });
  assert.deepEqual(t.trapped(), []);
});
