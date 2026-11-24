// The Operator's Work source (src/operator/sources.mjs) on a real Work list: a run of a task another program added
// carries the Work token's name, a run of the owner's own task does not, and the ended item says it.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from '../work/helpers.mjs';

const t = tempWork('operator-workfrom');
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { writeRun, newRunId, writerId } = await import('../../src/work/runs.mjs');
const { defaultSources } = await import('../../src/operator/sources.mjs');
const { detectEnded } = await import('../../src/operator/detect/ended.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
function doneRun(item, offset) {
  const id = newRunId(new Date(Date.now() + offset));
  writeRun(place(), {
    v: 1, id, item: item.id, title: item.title, writer: writerId(), by: 'owner', startedAt: new Date(Date.now() + offset).toISOString(),
    endedAt: new Date(Date.now() + offset + 1000).toISOString(), project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: null, effort: null,
    session: null, conversation: null, message: null, brief: 'x', state: 'done', reason: null, answer: 'ok', commits: [], changed: [], more: 0, was: 'open', statusError: null,
  });
  return id;
}

test('a Work run of a token\'s task names the token on the Operator; the owner\'s own does not', async () => {
  const theirs = (await store().addFrom({ title: 'Check the prices' }, { token: 'a1b2c3d4e5f6', name: 'Shop script' })).item;
  const mine = (await store().add({ title: 'Write the notes' })).item;
  const r1 = doneRun(theirs, 1000);
  const r2 = doneRun(mine, 2000);
  const src = defaultSources({ config: () => cfg, state: async () => ({ sessions: [], profiles: [] }) }, { port: () => null });
  const runs = src.sources.work().runs;
  assert.equal(runs.find((r) => r.id === r1).from, 'Shop script');
  assert.equal('from' in runs.find((r) => r.id === r2), false);
  const items = detectEnded({ sessions: [], work: { runs } }, { now: Date.now() + 5000 });
  const facts = items.find((i) => i.subject === `Work run ${r1}`).facts;
  assert.ok(facts.includes('added by another program (the Work token "Shop script")'), facts.join('|'));
});

test('a long reason of a failed run is cut on its card with a mark, not mid-word with none', async () => {
  const { detectUnknown } = await import('../../src/operator/detect/unknown.mjs');
  const item = (await store().add({ title: 'Fix the cart' })).item;
  const id = doneRun(item, 3000);
  const reason = 'The run ended in an error: TypeError: Cannot read properties of undefined (reading qty) at total, expected 6, got 2';
  const p = place();
  const { readRun } = await import('../../src/work/runs.mjs');
  writeRun(p, { ...readRun(p, id), state: 'failed', reason });
  const src = defaultSources({ config: () => cfg, state: async () => ({ sessions: [], profiles: [] }) }, { port: () => null });
  const runs = src.sources.work().runs;
  const [it] = detectUnknown({ work: { runs, checks: [] } }, { now: Date.now() + 5000 });
  const fact = it.facts.find((f) => f.startsWith('reason: '));
  assert.ok(fact.endsWith('…'), fact);
  assert.ok(fact.length <= 100, String(fact.length));
  assert.ok(fact.includes('(reading qty)'), 'more than the first 80 characters of it');
});

test.after(() => t.cleanup());
