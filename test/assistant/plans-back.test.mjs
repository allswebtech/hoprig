// A plan card says only what is true about taking back (design 2.3 plan-card, act-undo): a step is taken back by a REAL
// act (an inverse that the first act's own values make), or the card says before the tap that it cannot be.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadActs } from '../../src/assistant/acts.mjs';
import { callOf, rowById } from '../../src/assistant/catalog.mjs';
import { checkRoute } from '../../src/assistant/door.mjs';
import { runConfirmed } from '../../src/assistant/confirmed.mjs';
import { dashboardActs } from '../../src/assistant/actsrun.mjs';
import { INVERSE, inverseOf, backCensus } from '../../src/assistant/inverse.mjs';
import { PlanStore, argsProblem, checkPlan, runPlan } from '../../src/assistant/plans.mjs';

const LIVE = 'ship.p.live';
const fakeOps = (over = {}) => {
  const calls = [];
  return {
    calls,
    routeCall: async (computer, method, url, body) => {
      calls.push([computer, method, url, body]);
      if (over.fail && over.fail(method, url)) throw new Error('the computer said no');
      if (method === 'GET' && /^\/api\/ship\/p\/[^/]+$/.test(url)) return { last: { id: over.last === undefined ? 'live-1' : over.last } };
      if (url.endsWith('/live')) return { id: 'live-1' };
      return { ok: true };
    },
  };
};
const stub = { config: () => ({}), settingsOf: () => null };

test('every inverse is a row whose inputs the first act\'s own values make', () => {
  assert.ok(Object.keys(INVERSE).length >= 1);
  for (const [id, inv] of Object.entries(INVERSE)) {
    const row = rowById(id);
    const back = rowById(inv.act);
    assert.ok(row && back, `${id} -> ${inv.act} are rows`);
    assert.notEqual(row.id, back.id);
    const made = inverseOf(row, { target: 'shop' }, { id: 'c1' });
    assert.ok(made, `${id}: the back act can be made from what the first act had`);
    assert.equal(made.act, back.id);
    assert.equal(argsProblem(back, made.args), null, `${id}: its args fit the back act's own input`);
    assert.doesNotThrow(() => callOf(back, made.args));
  }
});

test('the census counts the rows that claim an undo: real, by her own tool, and none', () => {
  const c = backCensus(loadActs().rows);
  assert.ok(c.claims > 0);
  assert.equal(c.claims, c.real.length + c.byTool.length + c.none.length);
  assert.ok(c.real.includes(LIVE));
  // A row that claims an undo and has neither an inverse nor a tool of hers that records one is a false claim.
  assert.deepEqual(c.none, [], `false claims: ${c.none.join(', ')}`);
  console.log(`rows that claim an undo: ${c.claims}; real inverse for plans: ${c.real.length}; by her own tool: ${c.byTool.length}; none: ${c.none.length}`);
});

test('the card says Can be taken back only for a real inverse, and Cannot be taken back otherwise', () => {
  const adapter = dashboardActs(fakeOps());
  const r = checkPlan({ steps: [{ act: LIVE, args: { target: 'shop' } }, { act: 'sessions.rename', args: { target: 's1' } }] }, adapter);
  assert.equal(r.problems, undefined, JSON.stringify(r.problems));
  assert.match(r.steps[0].changes, /^Can be taken back: .*back/i);
  assert.match(r.steps[1].changes, /^Cannot be taken back/);
});

test('a later failure takes a go-live back by the real back act, on the same computer', async () => {
  const ops = fakeOps({ fail: (m, u) => u.endsWith('/api/updates/run') });
  const adapter = dashboardActs(ops);
  const steps = [{ n: 1, act: LIVE, args: { target: 'shop', computer: 'box2' }, answer: 'card' }, { n: 2, act: 'updates.run', args: { computer: 'box2' }, answer: 'card' }]
    .map((s) => ({ ...s, state: 'waiting', note: '', undo: null }));
  const plan = { id: 'p_000000000001', conversation: 'c', state: 'staged', steps, stop: false };
  const card = { id: 'c1', tool: 'plan_acts', input: { steps: steps.map(({ act, args }) => ({ act, args })) } };
  await runConfirmed(card, () => runPlan(plan, adapter, { sleep: async () => {} }));
  assert.equal(plan.steps[0].state, 'undone');
  const back = ops.calls.filter((c) => c[2].endsWith('/back'));
  assert.equal(back.length, 1);
  assert.equal(back[0][0], 'box2');
  assert.equal(back[0][1], 'POST');
  assert.match(back[0][2], /^\/api\/ship\/p\/shop\/back/);
});

const backTest = async (over) => {
  const ops = fakeOps({ fail: (m, u) => u.endsWith('/api/updates/run'), ...over });
  const adapter = dashboardActs(ops);
  const steps = [{ n: 1, act: LIVE, args: { target: 'shop' }, answer: 'card' }, { n: 2, act: 'updates.run', args: {}, answer: 'card' }]
    .map((s) => ({ ...s, state: 'waiting', note: '', undo: null }));
  const plan = { id: 'p_000000000003', conversation: 'c', state: 'staged', steps, stop: false };
  const card = { id: 'c4', tool: 'plan_acts', input: { steps: steps.map(({ act, args }) => ({ act, args })) } };
  await runConfirmed(card, () => runPlan(plan, adapter, { sleep: async () => {} }));
  return { ops, plan };
};

test('the way back takes back the go-live this plan started, and not a newer one of his', async () => {
  const mine = await backTest({});
  assert.equal(mine.ops.calls.filter((c) => c[2].endsWith('/back')).length, 1);
  const his = await backTest({ last: 'live-2' });
  assert.equal(his.ops.calls.filter((c) => c[2].endsWith('/back')).length, 0, 'his own newer go-live is left alone');
  assert.match(his.plan.note, /could not be taken back|not this plan/);
});

test('a go-live whose record is still the earlier one (it never finished) is not taken back either', async () => {
  const r = await backTest({ last: 'earlier-one' });
  assert.equal(r.ops.calls.filter((c) => c[2].endsWith('/back')).length, 0);
  const none = await backTest({ last: null });
  assert.equal(none.ops.calls.filter((c) => c[2].endsWith('/back')).length, 0);
});

test('a step with no real inverse is not taken back, and the plan says so', async () => {
  const ops = fakeOps({ fail: (m, u) => u.endsWith('/api/updates/run') });
  const adapter = dashboardActs(ops);
  const steps = [{ n: 1, act: 'sessions.rename', args: { target: 's1' }, answer: 'alone' }, { n: 2, act: 'updates.run', args: {}, answer: 'card' }]
    .map((s) => ({ ...s, state: 'waiting', note: '', undo: null }));
  const plan = { id: 'p_000000000002', conversation: 'c', state: 'staged', steps, stop: false };
  const card = { id: 'c2', tool: 'plan_acts', input: { steps: steps.map(({ act, args }) => ({ act, args })) } };
  await runConfirmed(card, () => runPlan(plan, adapter, { sleep: async () => {} }));
  assert.equal(plan.steps[0].state, 'done');
  assert.match(plan.note, /1 step could not be taken back/);
});

test('the door lets the back act pass only on the plan card that went live with the same project', () => {
  const card = { id: 'c3', tool: 'plan_acts', input: { steps: [{ act: LIVE, args: { target: 'shop' } }, { act: 'updates.run', args: {} }] } };
  const ok = runConfirmed(card, () => checkRoute('POST', '/api/ship/p/shop/back', {}, stub));
  assert.equal(ok.owner, true);
  assert.throws(() => runConfirmed(card, () => checkRoute('POST', '/api/ship/p/other/back', {}, stub)), /owner's own/);
  assert.throws(() => checkRoute('POST', '/api/ship/p/shop/back', {}, stub), /owner's own|not a route/);
});

test('the store is still a store', () => { assert.ok(new PlanStore()); });
