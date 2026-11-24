// The mission routes (src/mission/feature.mjs): every one is behind the owner's login (Tia's token and another
// program's token never reach them), takes only the keys it names, refuses a bad id, and the give/off/settings
// handlers do what they say. The handlers are driven directly, as feature tests drive the workspace routes.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { FAKE, missionHome } from './helpers.mjs';

const t = missionHome('mission-routes');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { aloneRunner } = await import('../../src/work/alone.mjs');
const { writeProposal } = await import('../../src/work/proposals.mjs');
const { newRunId } = await import('../../src/work/runs.mjs');
const { missionPart } = await import('../../src/mission/feature.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.arm();
const cfg = {
  work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
  missions: { on: false, projects: {}, capUsd: 5, providers: ['key'], atOnce: 2 },
  automation: { schedules: { atOnce: 2 } },
};
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 2 }), minuteMs: 600 });
const planner = {
  async start(c, { dryRun } = {}) {
    if (dryRun) return { dryRun: true, would: c };
    const rec = { v: 1, id: newRunId(new Date()), place: 'x', goal: c.goal, project: c.project, state: 'working', reason: null };
    writeProposal(rec);
    return { proposal: rec };
  },
};
const sctx = { readJson: async (req) => req.body ?? {}, saveConfig: (patch) => Object.assign(cfg, patch), caller: (req) => req.caller || 'page' };
const ownerOnly = (req) => {
  if (!req.owner) throw Object.assign(new Error('this needs the owner'), { status: 401 });
};
const part = missionPart({
  sctx, cfg: () => cfg, places: () => ({}), place, store, planner, runner,
  providers: () => [{ name: 'key', kind: 'api' }], ownerOnly, projects: () => projectNames(),
  accept: (id) => store().status(id, 'done'), reopen: (id) => store().status(id, 'open'),
  // No box on this computer, as the card is to show it (the run-tests routes below never reach a run).
  engine: { box: () => ({ check: async () => ({ ok: false, why: 'bubblewrap is not installed', step: 'install bubblewrap' }), run: () => assert.fail('nothing runs') }) },
});
test.after(() => part.close());

const call = (method, p, { owner = true, body = {}, caller } = {}) => {
  const u = new URL(p, 'http://x');
  for (const [m, re, fn] of part.routes) {
    const match = re.exec(u.pathname);
    if (match && m === method) return fn({ method, owner, body, ...(caller ? { caller } : {}) }, match, u.searchParams);
  }
  throw new Error(`no route ${method} ${p}`);
};
const rejects = (p, status, opts) => assert.rejects(() => Promise.resolve(call(p[0], p[1], opts)), (e) => e.status === status, `${p[0]} ${p[1]} wanted ${status}`);

const ALL = [
  ['GET', '/api/work/missions'],
  ['GET', '/api/work/missions/m-20261117-aaaaaa'],
  ['POST', '/api/work/missions'],
  ['POST', '/api/work/missions/settings'],
  ['POST', '/api/work/missions/off'],
  ['POST', '/api/work/missions/m-20261117-aaaaaa/stop'],
  ['POST', '/api/work/missions/m-20261117-aaaaaa/add'],
  ['POST', '/api/work/missions/m-20261117-aaaaaa/tasks/fix-the-cart/run-tests'],
];

test('every mission route is the owner\'s alone: Tia\'s token or another program\'s never reaches it', async () => {
  for (const r of ALL) await rejects(r, 401, { owner: false });
});

test('a bad id is refused before anything is done', async () => {
  await rejects(['POST', '/api/work/missions/m-bad/stop'], 400);
  await rejects(['POST', '/api/work/missions/m-bad/add'], 400, { body: { task: 'x' } });
});

test('a body key the route does not take is refused', async () => {
  await rejects(['POST', '/api/work/missions'], 400, { body: { goal: 'x', project: 'shop', surprise: 1 } });
  await rejects(['POST', '/api/work/missions/off'], 400, { body: { now: true } });
});

test('"Run the tests here" takes only { outside: true }: the press in the box sends nothing, anything else is refused', async () => {
  const p = '/api/work/missions/m-20261117-aaaaaa/tasks/fix-the-cart/run-tests';
  for (const body of [{ outside: false }, { outside: 'yes' }, { outside: 1 }, { here: true }]) await rejects(['POST', p], 400, { body });
  // Both well-formed bodies reach the engine (which finds no such mission).
  await rejects(['POST', p], 404, { body: {} });
  await rejects(['POST', p], 404, { body: { outside: true } });
});

test('"Run them outside the box" comes only from his page: another computer\'s token or Tia\'s door is refused', async () => {
  const p = '/api/work/missions/m-20261117-aaaaaa/tasks/fix-the-cart/run-tests';
  await rejects(['POST', p], 403, { body: { outside: true }, caller: 'computer' });
  await rejects(['POST', p], 403, { body: { outside: true }, caller: 'self' });
  // The press in the box stays open to them as before (it reaches the engine, which finds no such mission).
  await rejects(['POST', p], 404, { body: {}, caller: 'computer' });
  await rejects(['POST', p], 404, { body: { outside: true }, caller: 'page' });
});

test('a goal with both switches off is a plain Plan with AI proposal, not a mission', async () => {
  const r = await call('POST', '/api/work/missions', { body: { goal: 'Make the shop fast on a phone', project: 'shop' } });
  assert.equal(r.plain, true, JSON.stringify(r));
  assert.ok(r.proposal && !r.mission, 'a proposal, no mission');
});

test('Tia OFF and settings save through the owner\'s route', async () => {
  cfg.missions.on = true;
  const off = await call('POST', '/api/work/missions/off', { body: {} });
  assert.equal(off.settings.on, false, 'Tia OFF turned the master switch off');
  const set = await call('POST', '/api/work/missions/settings', { body: { capUsd: 9 } });
  assert.equal(set.settings.capUsd, 9);
});

test('the overview is the owner\'s and reads the settings, team and brief', async () => {
  const o = await call('GET', '/api/work/missions');
  assert.ok(o.settings && Array.isArray(o.missions) && o.team && o.brief, Object.keys(o).join(', '));
});

test('a mission whose task waits for his tests says whether this computer has a box, and what would give it one', async () => {
  const { writeMission, newTask } = await import('../../src/mission/file.mjs');
  const { writerId } = await import('../../src/work/runs.mjs');
  const id = 'm-20261119-b0b0b0';
  const t1 = { ...newTask('wait-for-tests', 'Wait for tests', 'tester'), state: 'review', gate: { ok: true, words: ['tests not run: yours to check (x)'], testsNotRun: true } };
  writeMission(place(), { v: 1, id, writer: writerId(), goal: 'A goal', project: 'shop', proposal: null, plan: null, state: 'waits', why: null, createdAt: '2026-11-19T08:00:00.000Z', endedAt: null, tasks: [t1], line: [] });
  // The first read does not wait for the box's check: it says "checking"; the answer comes with a later read.
  const first = await call('GET', `/api/work/missions/${id}`);
  assert.deepEqual(first.mission.box, { checking: true });
  await new Promise((r) => setTimeout(r, 20));
  const r = await call('GET', `/api/work/missions/${id}`);
  assert.deepEqual(r.mission.box, { ok: false, why: 'no box on this computer: bubblewrap is not installed', step: 'install bubblewrap' });
});

test('the mission\'s read never waits for the box\'s check: it answers at once, and the check\'s answer comes later', async () => {
  const { writeMission, newTask } = await import('../../src/mission/file.mjs');
  const { writerId } = await import('../../src/work/runs.mjs');
  let answer;
  let checks = 0;
  const slow = new Promise((r) => {
    answer = r;
  });
  const p2 = missionPart({
    sctx, cfg: () => cfg, places: () => ({}), place, store, planner, runner,
    providers: () => [{ name: 'key', kind: 'api' }], ownerOnly, projects: () => projectNames(),
    engine: { box: () => ({ check: () => {
      checks += 1;
      return slow;
    }, run: () => assert.fail('nothing runs') }) },
  });
  test.after(() => p2.close());
  const id = 'm-20261119-c0c0c0';
  const t1 = { ...newTask('wait-for-tests-2', 'Wait for tests', 'tester'), state: 'review', gate: { ok: true, words: ['tests not run: yours to check (x)'], testsNotRun: true } };
  writeMission(place(), { v: 1, id, writer: writerId(), goal: 'A goal', project: 'shop', proposal: null, plan: null, state: 'waits', why: null, createdAt: '2026-11-19T08:00:00.000Z', endedAt: null, tasks: [t1], line: [] });
  const route = p2.routes.find(([m, re]) => m === 'GET' && re.test(`/api/work/missions/${id}`));
  const read = () => route[2]({ method: 'GET', owner: true, body: {} }, route[1].exec(`/api/work/missions/${id}`));
  const late = (ms) => new Promise((r) => setTimeout(() => r('late'), ms));
  // The check has not answered: each read answers at once with "checking", and only one check is under way.
  for (let i = 0; i < 3; i += 1) {
    const r = await Promise.race([read(), late(500)]);
    assert.notEqual(r, 'late', 'the read waited for the box\'s check');
    assert.deepEqual(r.mission.box, { checking: true });
  }
  assert.equal(checks, 1, 'one check at a time');
  answer({ ok: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual((await read()).mission.box, { ok: true });
});
