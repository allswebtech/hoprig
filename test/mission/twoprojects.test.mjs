// A mission whose tasks fall in two projects of a temporary workspace (docs/WORK.md, "Missions"), run through the
// mission's own engine with the stand-in coding tool and the stand-in box: each task works on a branch of its own in
// ITS project's repository, is checked with ITS project's test command, obeys ITS project's switch, and two sessions
// of one project never run at once while the other project's may. Neither default branch nor server moves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FAKE, missionHome, standInBox } from './helpers.mjs';

const t = missionHome('mission-twoprojects');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { aloneRunner } = await import('../../src/work/alone.mjs');
const { writeProposal } = await import('../../src/work/proposals.mjs');
const { newRunId, readRun } = await import('../../src/work/runs.mjs');
const { missionEngine } = await import('../../src/mission/engine.mjs');
const { readMission } = await import('../../src/mission/file.mjs');

const shop = path.join(t.projects, 'shop');
const blog = path.join(t.projects, 'blog');
const shopBare = t.repo(shop, { 'README.md': '# shop\n', 'SHOP.md': 'the shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
const blogBare = t.repo(blog, { 'README.md': '# blog\n', 'BLOG.md': 'the blog\n' });
t.arm();
// Each project's own test command passes only in its own repository: a check run with the other project's command fails.
const needs = (file) => [process.execPath, '-e', `process.exit(require('fs').existsSync(${JSON.stringify(file)}) ? 0 : 1)`];
const cfg = {
  work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
  missions: { on: true, projects: { shop: { on: true, test: needs('SHOP.md') }, blog: { on: false, test: needs('BLOG.md') } }, capUsd: 5, providers: ['key'], atOnce: 2 },
};
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const verdicts = path.join(t.root, 'verdicts');
fs.writeFileSync(verdicts, ''); // no verdict left: every review passes
process.env.FAKE_VERDICTS = verdicts;
process.env.FAKE_TOOL_LOG = path.join(t.root, 'tool.log');
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 2 }), minuteMs: 600, killGraceMs: 200 });
const planner = {
  async start(c, { dryRun } = {}) {
    if (dryRun) return { dryRun: true, would: c };
    const rec = { v: 1, id: newRunId(new Date()), place: 'x', goal: c.goal, project: c.project, state: 'working', reason: null };
    writeProposal(rec);
    return { proposal: rec };
  },
};
const logged = [];
const engine = missionEngine({ log: (x) => logged.push(x),
  config: () => cfg, runner, planner, providers: () => [{ name: 'key', kind: 'api' }], slots: () => 2, machine: () => null, box: () => standInBox,
  reopen: (id) => store().status(id, 'open'), accept: (id) => store().status(id, 'done'), tickMs: 3_600_000, gateWaitMs: 1500, regateMs: 300,
});
test.after(async () => {
  await engine.close();
  await runner.close();
});

/** Tick until `ok(mission)` holds (or the time is up). */
async function until(id, ok, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    await engine.tick();
    const m = readMission(place(), id);
    if (m && ok(m)) return m;
    if (Date.now() > end) return m;
    await new Promise((r) => setTimeout(r, 150));
  }
}

let blogTask = null;
test('a goal whose tasks fall in two projects: each task in its own project, by that project\'s switch and test command', { timeout: 120_000 }, async () => {
  const before = { shop: t.git(shop, 'rev-parse', 'main'), blog: t.git(blog, 'rev-parse', 'main'), shopServer: t.git(shopBare, 'for-each-ref'), blogServer: t.git(blogBare, 'for-each-ref') };
  const g = await engine.give({ goal: 'Tell the shop on the blog', project: 'shop' });
  assert.equal(g.plain, false, 'the mission\'s own project is on: it is a mission');
  const add = async (title, project, files) => (await store().add({ title, project, by: 'developer', note: `Files: ${files}\nDO:slow` })).item.id;
  const a = await add('Add the price list', 'shop', 'prices.js');
  const b = await add('Add the order form', 'shop', 'order.js');
  const c = await add('Write the shop post', 'blog', 'post.js');
  await engine.accepts.after(g.proposal.id, { plan: 'two-plan', tasks: [a, b, c] });
  const task = (m, id) => m.tasks.find((x) => x.id === id);

  // The blog's own switch is off: its task does not start, though the mission's project (shop) is on.
  let m = await until(g.mission.id, (x) => task(x, a).state === 'review' && task(x, b).state === 'review' && /does not work on blog/.test(x.why || ''));
  assert.equal(task(m, a).state, 'review', task(m, a).why);
  assert.equal(task(m, b).state, 'review', task(m, b).why);
  assert.equal(task(m, c).state, 'queued', 'the blog\'s task waits for the blog\'s switch');
  assert.equal(task(m, c).runs.length, 0, 'no session of the blog ran');
  assert.match(m.why, /Tia does not work on blog by herself/);

  // Its switch on: the blog's task runs in the blog's repository and is checked with the blog's test command.
  cfg.missions.projects.blog.on = true;
  saveConfig(cfg);
  m = await until(g.mission.id, (x) => ['review', 'his'].includes(task(x, c).state));
  blogTask = task(m, c);
  assert.ok(blogTask.runs.some((r) => r.kind === 'work'), 'the blog\'s task ran once its switch was on');

  // Each branch lies in its task's own project, and only there.
  for (const id of [a, b]) {
    assert.equal(t.git(shop, 'log', '-1', '--format=%s', `work/${id}`), task(m, id).title);
    assert.throws(() => t.git(blog, 'rev-parse', '--verify', `work/${id}`), 'a shop task has no branch in the blog');
  }
  assert.equal(t.git(blog, 'log', '-1', '--format=%s', `work/${c}`), 'Write the shop post');
  assert.match(t.git(blog, 'show', '--name-only', '--format=', `work/${c}`), /^post\.js$/m);
  assert.throws(() => t.git(shop, 'rev-parse', '--verify', `work/${c}`), 'the blog task has no branch in the shop');

  // Never two sessions of one project at once: the shop's two work sessions ran one after another.
  const span = (id) => {
    const w = task(m, id).runs.find((r) => r.kind === 'work');
    const r = readRun(place(), w.id);
    return [Date.parse(r.startedAt), Date.parse(r.endedAt)];
  };
  const [sa, sb] = [span(a), span(b)];
  assert.ok(sa[1] <= sb[0] || sb[1] <= sa[0], `the shop's sessions did not overlap (${sa} and ${sb})`);

  // Nothing merged or pushed in either project.
  assert.equal(t.git(shop, 'rev-parse', 'main'), before.shop, 'the shop\'s default branch did not move');
  assert.equal(t.git(blog, 'rev-parse', 'main'), before.blog, 'the blog\'s default branch did not move');
  assert.equal(t.git(shopBare, 'for-each-ref'), before.shopServer);
  assert.equal(t.git(blogBare, 'for-each-ref'), before.blogServer);
  assert.equal(t.trapped(), '', 'no push, no sudo, no npm');
  assert.deepEqual(logged, [], 'the engine logged no failure');
});

// The check after a session runs the test command of the task's OWN project, as its start and its re-check do. The
// blog's task is checked with the blog's command (BLOG.md), not the shop's (SHOP.md), so it passes; finish() reading
// the mission's project instead would check the blog with the shop's command and fail it.
test('the blog\'s task is checked with the blog\'s own test command', () => {
  assert.ok(blogTask, 'the first test ran');
  assert.equal(blogTask.state, 'review', blogTask.why);
  assert.equal(blogTask.gate.ok, true);
});

test('a shop session and a blog session may run at the same time', { timeout: 120_000 }, async () => {
  const g = await engine.give({ goal: 'Two at once', project: 'shop' });
  const add = async (title, project, files) => (await store().add({ title, project, by: 'developer', note: `Files: ${files}\nDO:slow` })).item.id;
  const a = await add('Add the basket', 'shop', 'basket.js');
  const c = await add('Write the basket post', 'blog', 'basket-post.js');
  await engine.accepts.after(g.proposal.id, { plan: 'two-plan-2', tasks: [a, c] });
  const m = await until(g.mission.id, (x) => x.tasks.every((y) => ['review', 'his'].includes(y.state)));
  const span = (id) => {
    const r = readRun(place(), m.tasks.find((x) => x.id === id).runs.find((y) => y.kind === 'work').id);
    return [Date.parse(r.startedAt), Date.parse(r.endedAt)];
  };
  const [sa, sc] = [span(a), span(c)];
  assert.ok(sa[0] < sc[1] && sc[0] < sa[1], `the two projects' sessions overlapped (${sa} and ${sc})`);
  assert.equal(t.trapped(), '');
  assert.deepEqual(logged, []);
});
