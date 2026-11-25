// "Who did what" on a plan (src/work/pulse.mjs planParts, the plan route in planfeature.mjs): its tasks' runs that
// had helpers, read from Claude Code's own records in a made-up home through workUnits (the one reader a run's card
// uses too), summed per tier in the order fast, strong, strongest, other, and per task the models that worked on it.
// A plan none of whose runs had a helper gets no `parts`; no path is ever in the answer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-planparts');
test.after(() => t.cleanup());
const { newRunId, writeRun, writerId } = await import('../../src/work/runs.mjs');
const { projectDir } = await import('../../src/sessions.mjs');
const { resolvePlace } = await import('../../src/work/place.mjs');
const { writePlan } = await import('../../src/work/plans.mjs');
const { planParts } = await import('../../src/work/pulse.mjs');
const { workFeature } = await import('../../src/work/feature.mjs');

const shop = path.join(t.projects, 'shop');
fs.mkdirSync(shop, { recursive: true });
fs.mkdirSync(path.join(t.brain, 'work'), { recursive: true });
const place = resolvePlace({}, {});
const M = 60_000;
const NOW = Date.now();
const records = projectDir(fs.realpathSync(shop));

const made = { at: '2026-11-18T09:00:00.000Z', how: 'hand' };
const plan = (id, title) => ({ v: 1, id, title, goal: 'The home page loads in two seconds.', projects: ['shop'], milestones: [{ id: 'images', title: 'Images small', date: null }], note: null, made, status: 'active' });
writePlan(place, plan('faster-site', 'Make the site faster'), { projects: ['shop'] });
writePlan(place, plan('quiet-plan', 'A plan without helpers'), { projects: ['shop'] });
const item = (id, title, p, milestone = null) => ({ id, title, date: null, kind: 'task', status: 'open', project: 'shop', by: 'ai', created: '2026-11-18', plan: p, ...(milestone ? { milestone } : {}) });
fs.writeFileSync(place.file, `${JSON.stringify({ items: [
  item('shrink-images', 'Shrink the images', 'faster-site', 'images'),
  item('cache-pages', 'Cache the pages', 'faster-site'),
  item('measure-it', 'Measure it', 'faster-site'),
  item('plain-task', 'A plain task', 'quiet-plan'),
  item('other-task', 'Not in a plan', null),
] }, null, 2)}\n`);

const line = (agent, id, model, i, o, cached = 0) => JSON.stringify({ type: 'assistant', ...(agent ? { attributionAgent: agent, isSidechain: true } : {}), message: { id, model, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'done' }] } });
let n = 0;
/** A finished Do it run of `itemId`, with the lead's own conversation and the helpers given ([[agent, model, in, out]]). */
const runOf = (itemId, ago, lead, helpers = []) => {
  n += 1;
  const conv = `aaaaaaaa-bbbb-cccc-dddd-${String(n).padStart(12, '0')}`;
  const r = { v: 1, id: newRunId(new Date(NOW - ago)), item: itemId, title: itemId, writer: writerId(), by: 'owner', startedAt: new Date(NOW - ago).toISOString(), endedAt: new Date(NOW - ago + 10 * M).toISOString(),
    project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: lead, effort: 'medium', session: null, conversation: conv, message: null, brief: 'Do it',
    state: 'done', reason: null, answer: 'Done.', commits: [], changed: [], more: 0, was: 'open', statusError: null };
  writeRun(place, r);
  fs.mkdirSync(records, { recursive: true });
  fs.writeFileSync(path.join(records, `${conv}.jsonl`), `${line(null, `l${n}`, lead, 40, 60, 900)}\n`);
  if (helpers.length) {
    const sub = path.join(records, conv, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    helpers.forEach(([agent, model, i, o], k) => fs.writeFileSync(path.join(sub, `agent-h${n}${k}.jsonl`), `${line(agent, `h${n}${k}`, model, i, o)}\n`));
  }
  return r;
};
// Shrink the images: an older run with a fast and a strong helper, a newer one with a strongest helper.
runOf('shrink-images', 120 * M, 'claude-opus-5-5', [['hoprig-runner', 'claude-haiku-5-5', 100, 20], ['hoprig-coder', 'claude-sonnet-5-5', 300, 90]]);
runOf('shrink-images', 60 * M, 'claude-sonnet-5-5', [['hoprig-thinker', 'claude-opus-5-5', 500, 50]]);
// Cache the pages: one run with a strong helper. Measure it: a run without any helper.
runOf('cache-pages', 90 * M, 'claude-opus-5-5', [['hoprig-coder', 'claude-sonnet-5-5', 200, 10]]);
runOf('measure-it', 80 * M, 'claude-opus-5-5');
// The quiet plan's task: no helper. A task in no plan: helpers, never counted for a plan.
runOf('plain-task', 70 * M, 'claude-opus-5-5');
runOf('other-task', 50 * M, 'claude-opus-5-5', [['hoprig-runner', 'claude-haiku-5-5', 7000, 7000]]);

const feature = workFeature({ config: () => ({}), readJson: async () => ({}) });
const planRoute = feature.routes.find(([m, re]) => m === 'GET' && re.test('/api/work/plans/faster-site'));
const getPlan = (id) => planRoute[2]({ headers: {} }, planRoute[1].exec(`/api/work/plans/${id}`), new URLSearchParams());

test('a plan\'s route gives who did what: its tasks\' runs per tier, and per task its models and its count of runs', async () => {
  const got = await getPlan('faster-site');
  assert.ok(got.parts, 'the plan has its parts');
  // The chat page's shape, so its card draws it: no lead and no single parts in a sum of runs, only the tiers.
  assert.equal(got.parts.lead, null);
  assert.deepEqual(got.parts.parts, []);
  assert.deepEqual(got.parts.tiers.map((x) => [x.tier, x.parts, x.tokens, x.models, x.use]), [
    ['fast', 1, 120, ['claude-haiku-5-5'], { in: 100, out: 20, cached: 0 }],
    ['strong', 2, 600, ['claude-sonnet-5-5'], { in: 500, out: 100, cached: 0 }],
    ['strongest', 1, 550, ['claude-opus-5-5'], { in: 500, out: 50, cached: 0 }],
  ]);
  // Per task, in the plan's order (its milestones' tasks, then the loose ones); a task without a helper run is not
  // listed. Its models: the newest run's lead first, each model once.
  assert.deepEqual(got.parts.tasks, [
    { id: 'shrink-images', title: 'Shrink the images', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], runs: 2 },
    { id: 'cache-pages', title: 'Cache the pages', models: ['claude-opus-5-5', 'claude-sonnet-5-5'], runs: 1 },
  ]);
  // Never a path: neither the home, nor the coding tool's records, nor the project folder.
  const said = JSON.stringify(got);
  for (const p of [t.root, fs.realpathSync(shop), records, 'subagents', '.jsonl']) assert.equal(said.includes(p), false, p);
});

test('a plan none of whose runs had a helper gets no parts', async () => {
  const got = await getPlan('quiet-plan');
  assert.equal(got.plan.id, 'quiet-plan');
  assert.equal('parts' in got, false);
});

test('planParts: tiers summed across tasks in the order fast, strong, strongest, other; nothing without a card', () => {
  const card = (lead, tiers, parts = []) => ({ lead: lead ? { model: lead, tokens: 1, use: { in: 1, out: 0, cached: 0 } } : null, parts, tiers });
  const tier = (name, models, tokens, k = 1) => ({ tier: name, models, tokens, use: { in: tokens, out: 0, cached: 0 }, parts: k });
  const byItem = new Map([
    ['a', [card('m-lead', [tier('other', ['m-x'], 5), tier('strongest', ['m-big'], 30)], [{ model: 'm-x' }, { model: 'm-big' }])]],
    ['b', [card(null, [tier('fast', ['m-small'], 2, 2), tier('other', ['m-y'], 4)], [{ model: 'm-small' }, { model: 'm-y' }])]],
  ]);
  const got = planParts([{ id: 'a', title: 'A' }, { id: 'none', title: 'None' }, { id: 'b', title: 'B' }], byItem);
  assert.deepEqual(got.tiers.map((x) => [x.tier, x.parts, x.tokens, x.models]), [['fast', 2, 2, ['m-small']], ['strongest', 1, 30, ['m-big']], ['other', 2, 9, ['m-x', 'm-y']]]);
  assert.deepEqual(got.tasks, [{ id: 'a', title: 'A', models: ['m-lead', 'm-x', 'm-big'], runs: 1 }, { id: 'b', title: 'B', models: ['m-small', 'm-y'], runs: 1 }]);
  assert.equal(planParts([{ id: 'none', title: 'None' }], byItem), null);
  assert.equal(planParts([], new Map()), null);
});
