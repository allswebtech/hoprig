// A task's tests in the REAL box, pressed on real dashboards (createServer, each in a process of its own, on one state
// folder of this test's temporary home): the dashboard gone in the middle of a run and started again; two dashboards
// pressing at once; a press and a gate of the same worktree at the same moment. The project is a throw-away one with
// one made-up dependency, and its task's worktree is a real git worktree. A computer without a box skips these.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { missionHome } from './helpers.mjs';

const DASH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dash.mjs');
const t = missionHome('mission-boxdash');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { treeFor } = await import('../../src/work/alonegit.mjs');
const { writeMission, newTask } = await import('../../src/mission/file.mjs');
const { writerId } = await import('../../src/work/runs.mjs');
const { gate } = await import('../../src/mission/gate.mjs');
const { box } = await import('../../src/mission/seam.mjs');
const { DEPS, recordedLinks } = await import('../../src/mission/boxed.mjs');
const { boxCheck } = await import('../../src/box/box.mjs');
const real = await boxCheck();
const skip = !real.ok && `no box here: ${real.why}`;

// The tests note that they started, wait as long as delay.txt says, then note that they finished. Neither file is the branch's (ignored); the
// dependencies' link is not ignored, so a link left behind is an uncommitted file to the gate.
const SLOW = "const fs = require('fs');\nconst add = require('tiny');\nfs.appendFileSync('started.txt', 'x');\nconst d = Number(fs.readFileSync('delay.txt', 'utf8'));\nsetTimeout(() => { fs.appendFileSync('finished.txt', 'x'); console.log('tiny says', add(2, 3)); }, d);\n";
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n', '.gitignore': 'delay.txt\nfinished.txt\nstarted.txt\n' });
fs.mkdirSync(path.join(shop, DEPS, 'tiny'), { recursive: true });
fs.writeFileSync(path.join(shop, DEPS, 'tiny', 'package.json'), '{ "name": "tiny", "main": "index.js" }\n');
fs.writeFileSync(path.join(shop, DEPS, 'tiny', 'index.js'), 'module.exports = (a, b) => a + b;\n');
fs.appendFileSync(path.join(shop, '.git', 'info', 'exclude'), 'node_modules\n'); // the main checkout's own, not the worktree's
const cfg = {
  server: { passwordHash: await hashPassword('pw'), roots: [t.home] },
  work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
  missions: { on: false, projects: { shop: { on: false, test: [process.execPath, 'slow.cjs'] } }, capUsd: 5, providers: [], atOnce: 2 },
};
saveConfig(cfg);
const base = t.git(shop, 'rev-parse', 'HEAD');

let n = 0;
/** A mission of one tester task waiting in review with its tests not run, and its real worktree. → { mid, tid, tree } */
async function task() {
  n += 1;
  // A task of the Work list, in review: a dashboard's start drops a mission's task that is not in the list.
  const store = workStore(resolvePlace(cfg), { projects: projectNames() });
  const tid = (await store.add({ title: `Slow tests ${n}`, project: 'shop', by: 'tester' })).item.id;
  await store.status(tid, 'review');
  const { dir: tree } = await treeFor(shop, `work/${tid}`);
  fs.writeFileSync(path.join(tree, 'slow.cjs'), SLOW);
  t.git(tree, 'add', '-A');
  t.git(tree, 'commit', '-q', '-m', 'The task');
  const mid = `m-20261120-0000${String(n).padStart(2, '0')}`;
  const t1 = { ...newTask(tid, 'Slow tests', 'tester'), state: 'review', branch: `work/${tid}`, base, gate: { ok: true, words: ['tests not run: yours to check (x)'], testsNotRun: true } };
  writeMission(resolvePlace(cfg), { v: 1, id: mid, writer: writerId(), goal: 'A goal', project: 'shop', proposal: null, plan: null, state: 'waits', why: null, createdAt: '2026-11-20T08:00:00.000Z', endedAt: null, tasks: [t1], line: [] });
  return { mid, tid, tree };
}
const delay = (tree, ms) => fs.writeFileSync(path.join(tree, 'delay.txt'), String(ms));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLink = (f) => {
  try {
    return fs.lstatSync(f).isSymbolicLink();
  } catch {
    return false;
  }
};
// `answer`: a press whose answer, when it came first, says why the wait was in vain.
const until = async (what, fn, ms = 20_000, answer = null) => {
  const end = Date.now() + ms;
  let got = null;
  if (answer) answer.then((r) => (got = r), (e) => (got = { error: e.message }));
  while (Date.now() < end) {
    if (fn()) return;
    if (got) throw new Error(`the press answered before ${what}: ${JSON.stringify(got).slice(0, 400)}`);
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const started = [];
test.after(() => {
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});
/** A dashboard in a process of its own, signed in. → { child, press(task) → { status, body } } */
async function dashboard() {
  const child = spawn(process.execPath, [DASH], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  started.push(child);
  const first = await new Promise((resolve, reject) => {
    readline.createInterface({ input: child.stdout }).once('line', resolve);
    child.once('exit', (c) => reject(new Error(`the dashboard ended with ${c}`)));
  });
  const { port } = JSON.parse(first);
  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'signed in');
  const press = async (x) => {
    const r = await fetch(`${origin}/api/work/missions/${x.mid}/tasks/${x.tid}/run-tests`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: '{}' });
    return { status: r.status, body: await r.json() };
  };
  const end = () => new Promise((r) => {
    if (child.exitCode !== null || child.signalCode !== null) return r();
    child.once('exit', r);
    child.kill('SIGTERM');
  });
  return { child, press, end };
}

test('the dashboard dies in the middle of a run in the box: the box ends with it, and the next dashboard runs the tests and cleans up', { skip, timeout: 90_000 }, async () => {
  const x = await task();
  delay(x.tree, 3000);
  const a = await dashboard();
  const lost = a.press(x); // its answer never comes: the dashboard is ended below
  lost.catch(() => {});
  // Ended once the tests run inside the box (not while the box is being started: that is another case).
  await until('the tests running in the box', () => fs.existsSync(path.join(x.tree, 'started.txt')), 20_000, lost);
  a.child.kill('SIGKILL');
  await new Promise((r) => a.child.once('exit', r));
  await sleep(4000);
  assert.equal(fs.existsSync(path.join(x.tree, 'finished.txt')), false, 'the tests in the box ended with the dashboard that started them');
  assert.ok(isLink(path.join(x.tree, DEPS)), 'its link is left behind (nobody took it away)');
  const b = await dashboard();
  try {
    delay(x.tree, 0);
    const r = await b.press(x);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.here.boxed, true);
    assert.equal(r.body.here.ok, true, r.body.here.out);
    assert.match(r.body.here.out, /tiny says 5/);
    assert.equal(isLink(path.join(x.tree, DEPS)), false, 'the link is gone after the run');
    assert.equal(recordedLinks()[x.tree], undefined, 'and its record');
  } finally {
    await b.end();
  }
});

test('two dashboards on one state folder: a press while the other\'s run of the same worktree goes on is told so, and nothing more runs', { skip, timeout: 90_000 }, async () => {
  const x = await task();
  delay(x.tree, 2500);
  const a = await dashboard();
  const b = await dashboard();
  try {
    const first = a.press(x);
    await until('the first run in the box', () => isLink(path.join(x.tree, DEPS)), 20_000, first);
    const second = await b.press(x);
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.match(second.body.error, /run in the box now/);
    const r = await first;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.here.ok, true, r.body.here.out);
    assert.equal(fs.readFileSync(path.join(x.tree, 'finished.txt'), 'utf8'), 'x', 'the tests ran once');
    assert.equal(isLink(path.join(x.tree, DEPS)), false);
  } finally {
    await Promise.all([a.end(), b.end()]);
  }
});

test('his press and a gate of the same worktree at the same moment: the gate waits for the press\'s run, and never counts its link as the session\'s file', { skip, timeout: 90_000 }, async () => {
  const x = await task();
  delay(x.tree, 2000);
  const a = await dashboard();
  try {
    const pressed = a.press(x);
    await until('the press\'s run in the box', () => isLink(path.join(x.tree, DEPS)), 20_000, pressed);
    const g = await gate({ check: 'tests', top: shop, tree: x.tree, base, branch: `work/${x.tid}`, brief: 'Files: slow.cjs', test: [process.execPath, 'slow.cjs'], box: box() });
    const r = await pressed;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(g.testsNotRun, undefined, g.words.join('; '));
    assert.equal(g.ok, true, g.words.join('; '));
    assert.match(g.words.join('; '), /the tests passed/);
    assert.equal(fs.readFileSync(path.join(x.tree, 'finished.txt'), 'utf8'), 'xx', 'the press\'s run and the gate\'s, one after the other');
    assert.equal(isLink(path.join(x.tree, DEPS)), false);
  } finally {
    await a.end();
  }
});
