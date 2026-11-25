// The demo's Work (src/demo/work.mjs): a made-up plan whose finished Lead run had helpers, so a task's run and the
// plan's page show "Who did what" from the same reader the product uses (pulse.mjs workUnits). Made up, in a temp home.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from '../work/helpers.mjs';

const t = tempWork('demo-work');
test.after(() => t.cleanup());
fs.mkdirSync(path.join(t.projects, 'shop-frontend'), { recursive: true });
fs.mkdirSync(t.brain, { recursive: true });
const { demoWork } = await import('../../src/demo/work.mjs');
const { workFeature } = await import('../../src/work/feature.mjs');
const { partsByRun } = await import('../../src/work/pulse.mjs');
const { resolvePlace } = await import('../../src/work/place.mjs');

test('the demo seeds a plan and a Lead run with helpers: the run route and the plan route say who did what', async () => {
  await demoWork(t.projects);
  const f = workFeature({ config: () => ({ projectsDir: t.projects }), readJson: async () => ({}) });
  const call = async (p) => {
    const [, re, fn] = f.routes.find(([m, r]) => m === 'GET' && r.test(p));
    return fn({ headers: {} }, re.exec(p), new URLSearchParams());
  };
  // The runs route (only with the chat feature) hands on what partsByRun reads: that reader here.
  const byRun = await partsByRun({ place: resolvePlace({}), cfg: {} });
  const runs = [...byRun.values()].map((parts) => ({ parts }));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].parts.lead.model, 'claude-opus-5-5');
  assert.deepEqual(runs[0].parts.parts.map((p) => p.kind).sort(), ['Hard thinking', 'Running and recording', 'Writing and reviewing code']);
  const plan = await call('/api/work/plans/faster-checkout');
  assert.deepEqual(plan.parts.tiers.map((x) => x.tier), ['fast', 'strong', 'strongest']);
  assert.deepEqual(plan.parts.tasks.map((x) => [x.id, x.runs]), [['measure-the-checkout', 1]]);
  for (const said of [JSON.stringify(runs), JSON.stringify(plan)]) assert.equal(said.includes(t.root), false, 'no path');
  // What it used and saved (runuse.mjs), on the demo's subscription: 38 minutes, the saving in tokens of the helpers on
  // Haiku and Sonnet (not the one on Opus, the lead's own model), and no money.
  const { listRuns } = await import('../../src/work/runs.mjs');
  const { runUse } = await import('../../src/work/runuse.mjs');
  const [rec] = listRuns(resolvePlace({}));
  const used = runUse(rec, runs[0].parts, { kind: 'subscription', paid: false });
  assert.equal(used.ms, 38 * 60_000);
  assert.equal(used.saving.tokens, 9100 + 1400 + 14800 + 6200);
  assert.equal(used.saving.money, null);
  assert.equal(used.cost, null);
  // A second start leaves a list that is there alone.
  const before = fs.readdirSync(path.join(t.brain, 'work', 'runs'));
  await demoWork(t.projects);
  assert.deepEqual(fs.readdirSync(path.join(t.brain, 'work', 'runs')), before);
});

test('in the demo\'s order (the plan, then the history) the plan keeps its tasks and its who did what', async () => {
  await demoWork(t.projects);
  const { demoHistory } = await import('../../src/demo/history.mjs');
  await demoHistory({ projects: t.projects, brain: t.brain });
  const f = workFeature({ config: () => ({ projectsDir: t.projects }), readJson: async () => ({}) });
  const [, re, fn] = f.routes.find(([m, r]) => m === 'GET' && r.test('/api/work/plans/faster-checkout'));
  const plan = await fn({ headers: {} }, re.exec('/api/work/plans/faster-checkout'), new URLSearchParams());
  const ids = plan.plan.milestones.flatMap((x) => x.tasks.map((y) => y.id));
  assert.deepEqual(ids, ['measure-the-checkout', 'shrink-the-images', 'load-the-map-later']);
  assert.deepEqual(plan.parts.tiers.map((x) => x.tier), ['fast', 'strong', 'strongest']);
  // The history's own tasks are in the same list.
  const list = JSON.parse(fs.readFileSync(path.join(t.brain, 'work', 'tasks.json'), 'utf8')).items.map((x) => x.id);
  for (const id of ['cart-total-test', 'faster-images']) assert.ok(list.includes(id), id);
});
