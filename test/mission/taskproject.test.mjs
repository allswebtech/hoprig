// A task's choice point (here a usage limit) is decided for the task's OWN project, not the mission's. A mission in
// one project with a task in another asks the decision door with the TASK's project, so the Operator's per-project
// reasoning (a project Tia never acts in, the project's note, whether she may end a task there) reads the project the
// work is really in. finish() in src/mission/engine.mjs must carry the task's project into that ask, the way its gate
// already runs the task's own project's test command. Run through the mission engine with the stand-in coding tool.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { FAKE, missionHome, standInBox } from './helpers.mjs';

const t = missionHome('mission-taskproject');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { aloneRunner } = await import('../../src/work/alone.mjs');
const { writeProposal } = await import('../../src/work/proposals.mjs');
const { newRunId } = await import('../../src/work/runs.mjs');
const { missionEngine } = await import('../../src/mission/engine.mjs');
const { readMission } = await import('../../src/mission/file.mjs');

const shop = path.join(t.projects, 'shop');
const blog = path.join(t.projects, 'blog');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.repo(blog, { 'README.md': '# blog\n' });
t.arm();
const OK = [process.execPath, '-e', 'process.exit(0)'];
const cfg = {
  work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
  missions: { on: true, projects: { shop: { on: true, test: OK }, blog: { on: true, test: OK } }, capUsd: 5, providers: ['key', 'key2'], atOnce: 1 },
};
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
process.env.FAKE_TOOL_LOG = path.join(t.root, 'tool.log');
process.env.FAKE_VERDICTS = path.join(t.root, 'verdicts');
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 2 }), minuteMs: 600, killGraceMs: 200 });
const planner = {
  async start(c) {
    const rec = { v: 1, id: newRunId(new Date()), place: 'x', goal: c.goal, project: c.project, state: 'working', reason: null };
    writeProposal(rec);
    return { proposal: rec };
  },
};
// A door that keeps every item it is asked about and leaves each to him, so the task stops after one limit.
const asked = [];
const door = async (item) => {
  asked.push(item);
  return { ask: true, why: 'left to him for the test' };
};
const engine = missionEngine({
  config: () => cfg, runner, planner, providers: () => [{ name: 'key', kind: 'api' }, { name: 'key2', kind: 'api' }],
  slots: () => 1, machine: () => null, box: () => standInBox, reopen: (id) => store().status(id, 'open'),
  tickMs: 3_600_000, gateWaitMs: 1500, door,
});
test.after(async () => {
  await engine.close();
  await runner.close();
});

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

test('a cross-project task at a usage limit asks the door with the task\'s own project, not the mission\'s', { timeout: 120_000 }, async () => {
  const g = await engine.give({ goal: 'A shop mission with a blog task', project: 'shop' });
  assert.equal(g.plain, false, g.why);
  const blogTask = (await store().add({ title: 'Write the shop post', project: 'blog', by: 'developer', note: 'Files: post.js\nDO:limit' })).item.id;
  await engine.accepts.after(g.proposal.id, { plan: 'one-plan', tasks: [blogTask] });

  const m = await until(g.mission.id, (x) => x.tasks[0] && x.tasks[0].state === 'his');
  assert.equal(m.tasks[0].state, 'his', m.tasks[0].why);
  assert.match(m.tasks[0].why, /reached its usage limit/, m.tasks[0].why);

  const limit = asked.find((it) => it.kind === 'mission-limit');
  assert.ok(limit, 'the door was asked about the limit');
  assert.ok(limit.subject.includes(blogTask), `the choice is about the blog task (${limit.subject})`);
  assert.equal(limit.project, 'blog', 'the decision carries the task\'s own project (blog), not the mission\'s (shop)');
  assert.equal(t.trapped(), '', 'no push, no sudo, no npm');
});
