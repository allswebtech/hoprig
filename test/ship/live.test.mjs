// Going live (src/ship/live.mjs) once whole, with the made-up project "shop" (fixtures/shop.mjs: a web server on a
// loopback port, restarted by a deploy script): a put-together whose check passed goes live on the confirmed commands,
// is verified, and says "live since" in Activity. A second round whose update breaks the verify is "not verified" and
// taken back, the kept data as before. A step killed in the middle of its update is finished by the next look, after
// the update command that ran on has ended, and never as "live". Nothing
// goes live without the confirmed block, nor for a tree whose check did not pass.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempShip, write } from './helpers.mjs';
import { DEPLOY, SERVER, manifest } from './fixtures/shop.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'golive-child.mjs');
const t = tempShip('ship-live');
const shop = path.join(t.projects, 'shop');
const stopServer = () => {
  try {
    process.kill(Number(fs.readFileSync(path.join(shop, 'run', 'server.pid'), 'utf8')), 'SIGKILL');
  } catch {
    /* none */
  }
};
test.after(() => {
  stopServer();
  t.cleanup();
});
const { putTogether, readTogether: readT } = await import('../../src/ship/together.mjs');
const { runCheck } = await import('../../src/ship/check.mjs');
const { allow } = await import('../../src/ship/allow.mjs');
const { readCheck, readLive } = await import('../../src/ship/project.mjs');
const { goLive, takeBack, finishCut, readJournal, planLive, activity } = await import('../../src/ship/live.mjs');
const { gitFolder } = await import('../../src/ship/lock.mjs');

const port = await new Promise((res) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
t.repo(shop, { 'server.mjs': SERVER, 'deploy.mjs': DEPLOY, 'port.txt': String(port), 'project.json': manifest(port), '.gitignore': 'run/\ndata/\nnotes.txt\n' });
write(shop, { 'data/db.json': '{"orders":3}\n', 'notes.txt': 'the owner\'s own\n' });
const idle = () => ({ over: false, why: null });
/** The server's answer once it is up (a restart in the background takes a moment), or null after 5 s. */
const answerOf = async (want) => {
  let got = null;
  for (let i = 0; i < 50 && (got = await get()) !== want; i++) await new Promise((res) => setTimeout(res, 100));
  return got;
};
const get = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`)).status;
  } catch {
    return null;
  }
};

/** A finished put-together of `branches`, checked (and its check confirmed). */
async function ready(name, branches) {
  const r = await putTogether(shop, { name, branches });
  assert.equal(r.finished, true);
  allow(shop, 'check', readCheck(r.dir).check);
  await runCheck(shop, r.dir, { busy: idle });
  return r;
}

test('not confirmed, or not checked: nothing goes live', async () => {
  t.branch(shop, 'work/hello', { 'hello.txt': 'hello\n' }, 'Say hello');
  const r = await putTogether(shop, { name: 'early', branches: ['work/hello'] });
  await assert.rejects(goLive(shop, r), (e) => e.details.code === 'not-checked');
  allow(shop, 'check', readCheck(r.dir).check);
  await runCheck(shop, r.dir, { busy: idle });
  const plan = await planLive(shop, r);
  assert.equal(plan.confirmed, false);
  assert.match(plan.shown.update[0], /^node deploy\.mjs [0-9a-f]{40}$/);
  await assert.rejects(goLive(shop, r), (e) => e.details.code === 'not-confirmed');
  assert.equal(await get(), null, 'nothing was started');
});

test('round one: the tap, the update, the verify, "live since" in Activity', async () => {
  const r = await ready('one', ['work/hello']);
  allow(shop, 'live', readLive(r.dir).live);
  const step = await goLive(shop, r);
  const j = await step.done;
  assert.equal(j.outcome, 'live', j.why);
  assert.equal(await get(), 200);
  assert.equal(t.git(shop, 'rev-parse', 'HEAD'), t.git(shop, 'rev-parse', 'work/one-all'));
  assert.match(activity().recent(5)[0].did, /^one: live since \d\d:\d\d \(tree [0-9a-f]{12}\)$/);
  assert.equal(readJournal(await gitFolder(shop)), null, 'the journal is gone once the step ended');
});

test('round two: an update that breaks the verify is taken back, the data as before', async () => {
  t.branch(shop, 'work/break', { 'broken.txt': 'x\n' }, 'Break it');
  const r = await ready('two', ['work/break']);
  const before = t.git(shop, 'rev-parse', 'HEAD');
  const j = await (await goLive(shop, r)).done;
  assert.equal(j.outcome, 'not-verified');
  assert.match(j.why, /should answer 200/);
  assert.equal(await get(), 500);
  assert.match(activity().recent(5)[0].did, /^two: not live/);
  const b = await takeBack(shop);
  assert.equal(b.outcome, 'taken-back', b.why);
  assert.equal(b.keptSame, true);
  assert.equal(t.git(shop, 'rev-parse', 'HEAD'), before);
  assert.equal(await answerOf(200), 200);
  assert.equal(fs.readFileSync(path.join(shop, 'data', 'db.json'), 'utf8'), '{"orders":3}\n');
  assert.equal(fs.readFileSync(path.join(shop, 'notes.txt'), 'utf8'), 'the owner\'s own\n');
});

test('a step killed in the middle of its update: the next look waits for the update, and never says live', async () => {
  t.branch(shop, 'work/later', { 'later.txt': 'later\n' }, 'Later');
  const r = await ready('three', ['work/later']);
  const gitDir = await gitFolder(shop);
  const pidOf = (f) => {
    try {
      return Number(fs.readFileSync(path.join(shop, 'run', f), 'utf8'));
    } catch {
      return 0;
    }
  };
  const oldServer = pidOf('server.pid');
  fs.rmSync(path.join(shop, 'run', 'deploy.pid'), { force: true });
  const child = spawn(process.execPath, [CHILD, shop, r.id], { env: { ...process.env, SHOP_SLOW: '5' }, stdio: 'ignore' });
  const until = Date.now() + 15_000;
  for (;;) {
    const j = readJournal(gitDir);
    if (j && j.part === 'update' && j.running && pidOf('deploy.pid')) break;
    assert.ok(Date.now() < until, 'the update did not start');
    await new Promise((res) => setTimeout(res, 50));
  }
  // Wait until the deploy started a NEW server and it answers, then kill the dashboard (by its pid). The deploy runs on
  // in its own process group, as a real update would.
  for (let i = 0; i < 100 && !(pidOf('server.pid') && pidOf('server.pid') !== oldServer && (await get()) === 200); i++) await new Promise((res) => setTimeout(res, 100));
  assert.notEqual(pidOf('server.pid'), oldServer, 'the deploy restarted the server');
  child.kill('SIGKILL');
  await new Promise((res) => child.on('exit', res));
  const deploy = pidOf('deploy.pid');
  assert.equal(readJournal(gitDir).running.pid, deploy, 'the journal names the update command that runs');
  const waiting = await finishCut(shop);
  const deployLives = (() => { try { return process.kill(deploy, 0); } catch (e) { return e.code; } })();
  assert.equal(waiting.commandRunning, true, `the look waits for the update that still runs (the look said ${JSON.stringify(waiting).slice(0, 600)}; the update command ${deploy}: ${deployLives}; journal ${JSON.stringify(readJournal(gitDir)?.running)})`);
  assert.equal(readJournal(gitDir).part, 'update');
  const alive = () => {
    try {
      process.kill(deploy, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 150 && alive(); i++) await new Promise((res) => setTimeout(res, 100));
  assert.equal(alive(), false, 'the deploy ended by itself');
  const done = await finishCut(shop);
  assert.equal(done.outcome, 'update-cut', done.why);
  assert.match(done.why, /^the update was cut off while node deploy\.mjs [0-9a-f]{40} ran\. It answers as it should$/);
  assert.match(activity().recent(5)[0].did, /^three: not live: the update was cut off/);
  assert.equal(await finishCut(shop), null, 'nothing left for the look after');
  assert.deepEqual(t.trapped(), []);
});

test('a step cut before its update is closed as "did not start", nothing run', async () => {
  const gitDir = await gitFolder(shop);
  const j = { v: 1, id: '0123456789abcdef', real: shop, top: shop, name: 'four', part: 'picture', parts: [], pictures: {}, values: {} };
  fs.writeFileSync(path.join(gitDir, 'hoprig-ship.json'), JSON.stringify(j));
  const head = t.git(shop, 'rev-parse', 'HEAD');
  const done = await finishCut(shop);
  assert.equal(done.outcome, 'did-not-start');
  assert.equal(t.git(shop, 'rev-parse', 'HEAD'), head);
});

test('a journal changed by hand runs nothing it holds', async () => {
  const gitDir = await gitFolder(shop);
  const marker = path.join(t.root, 'ran-from-journal');
  const live = { update: [], verify: [{ run: ['node', '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1')`], minutes: 1 }], back: [], keep: [], restarts: false, waitSeconds: 120, turnSeconds: 300 };
  const j = { v: 1, id: 'fedcba9876543210', real: shop, top: shop, name: 'five', part: 'verify', parts: [], pictures: {}, values: {}, live };
  fs.writeFileSync(path.join(gitDir, 'hoprig-ship.json'), JSON.stringify(j));
  await assert.rejects(finishCut(shop), (e) => e.details.code === 'not-confirmed');
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(path.join(gitDir, 'hoprig-ship.json'));
});

test('a tree that failed once and passed once goes live on the tap only, never by itself', async () => {
  const counter = path.join(t.root, 'mixed-count');
  t.branch(shop, 'work/mixed', { 'mixed.txt': 'm\n' }, 'Mixed');
  const r = await putTogether(shop, { name: 'six', branches: ['work/mixed'] });
  const { cleanCheck } = await import('../../src/ship/project.mjs');
  const { runCheck: run2 } = await import('../../src/ship/check.mjs');
  // The tree's own check, made to fail at its first run (its project.json in the tree is the shop's: one more block).
  const flaky = cleanCheck([{ run: ['node', '-e', `const f=${JSON.stringify(counter)},fs=require('node:fs');const n=fs.existsSync(f)?1:0;fs.writeFileSync(f,'1');process.exit(n?0:1)`], minutes: 1 }]).check;
  const pj = JSON.parse(fs.readFileSync(path.join(r.dir, 'project.json'), 'utf8'));
  fs.writeFileSync(path.join(r.dir, 'project.json'), JSON.stringify({ ...pj, check: flaky }));
  t.git(r.dir, 'commit', '-q', '-am', 'A flaky check');
  allow(shop, 'check', flaky);
  await run2(shop, r.dir, { busy: idle });
  await assert.rejects(planLive(shop, readT(r.id)), (e) => e.details.code === 'not-checked', 'the last run failed');
  await run2(shop, r.dir, { busy: idle });
  await assert.rejects(planLive(shop, readT(r.id), { by: 'auto' }), /not go live by itself/);
  const plan = await planLive(shop, readT(r.id));
  assert.equal(plan.checked, 'mixed');
});
