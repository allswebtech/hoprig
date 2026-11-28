// A plan may wait for something on another computer (design own request: update all computers, wait until each answers):
// ONLY the wait its confirmed card showed (the fact, its computer, the value, the minutes) reads exactly that fact there, as
// her read with her mark, and only while that plan runs. Nothing else of her looks reaches another computer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { checkRoute } from '../../src/assistant/door.mjs';
import { runConfirmed, runAsLook } from '../../src/assistant/confirmed.mjs';
import { dashboardActs } from '../../src/assistant/actsrun.mjs';
import { checkPlan, runPlan } from '../../src/assistant/plans.mjs';
import { described, waitWords } from '../../src/assistant/plantool.mjs';

const stub = { config: () => ({}), settingsOf: () => null };
const WAIT = { fact: 'system.health', until: 'back', minutes: 5, args: { computer: 'box2' } };
const STEPS = [{ act: 'updates.run', args: { computer: 'box2' }, wait: WAIT }, { act: 'updates.run', args: {} }];
const card = (steps = STEPS) => ({ id: 'c_w', tool: 'plan_acts', input: { title: 't', steps } });

test('a wait on another computer is a plan the card can show (fact, computer, value, minutes)', () => {
  const adapter = dashboardActs({ routeCall: async () => ({}) });
  const r = checkPlan({ steps: STEPS }, adapter);
  assert.equal(r.problems, undefined, JSON.stringify(r.problems));
  assert.deepEqual(r.steps[0].wait, WAIT);
  assert.equal(described({ steps: STEPS }, adapter)[0].wait.args.computer, 'box2');
});

test('a wait on a fact that is no read act, or with a bad computer name, still refuses the plan', () => {
  const adapter = dashboardActs({ routeCall: async () => ({}) });
  const bad = (w) => checkPlan({ steps: [{ act: 'updates.run', args: {}, wait: { ...WAIT, ...w } }, STEPS[1]] }, adapter);
  assert.match(bad({ fact: 'updates.run' }).problems[0], /a wait watches a read act/);
  assert.ok(bad({ args: { computer: 'Bad Name' } }).problems);
});

test('the door lets that one read pass on the confirmed card, with her mark and not as his press', () => {
  const ok = runConfirmed(card(), () => checkRoute('GET', '/m/box2/api/health', undefined, stub));
  assert.equal(ok.computer, 'box2');
  assert.notEqual(ok.owner, true);
});

test('another computer, another fact, another query or no card: refused', () => {
  const refuses = (fn) => assert.throws(fn, /owner's own|not a route|403|own/);
  refuses(() => runConfirmed(card(), () => checkRoute('GET', '/m/box3/api/health', undefined, stub)));
  refuses(() => runConfirmed(card(), () => checkRoute('GET', '/m/box2/api/sessions', undefined, stub)));
  refuses(() => runConfirmed(card(), () => checkRoute('GET', '/m/box2/api/health?x=1', undefined, stub)));
  refuses(() => checkRoute('GET', '/m/box2/api/health', undefined, stub));
  // A look of hers still never reaches another computer, also while a card runs.
  refuses(() => runAsLook(() => checkRoute('GET', '/m/box2/api/health', undefined, stub)));
  // The same card without that wait does not open it.
  refuses(() => runConfirmed(card([STEPS[1], STEPS[1]]), () => checkRoute('GET', '/m/box2/api/health', undefined, stub)));
});

test('the runner reads the wait on its computer and the plan goes on when it answers', async () => {
  const calls = [];
  const adapter = dashboardActs({ routeCall: async (computer, method, url) => { calls.push([computer, method, url]); return method === 'GET' ? { ok: true } : {}; } });
  const steps = STEPS.map((s, i) => ({ n: i + 1, ...s, answer: 'card', state: 'waiting', note: '', undo: null }));
  const plan = { id: 'p_00000000000a', conversation: 'c', state: 'staged', steps, stop: false };
  await runConfirmed(card(), () => runPlan(plan, adapter, { sleep: async () => {}, pollMs: 1 }));
  assert.equal(plan.state, 'done');
  assert.deepEqual(calls.filter((c) => c[1] === 'GET'), [['box2', 'GET', '/api/health']]);
});

test('the card says where the wait looks', async () => {
  const { plan_acts: planTool } = await import('../../src/assistant/plantool.mjs');
  const adapter = dashboardActs({ routeCall: async () => ({}) });
  const b = { title: 't', steps: described({ steps: STEPS }, adapter) };
  const lines = planTool.cardLines({ title: 't', steps: STEPS }, b).join('\n');
  assert.match(lines, /5 min on box2 until system\.health shows back/);
  // The page's view says everything the door binds: the fact, the ids and the query values, the computer, the condition.
  const w = { fact: 'providers.health', until: 'done', minutes: 5, args: { computer: 'box2', target: 'abc', query: { lines: 500 } } };
  assert.equal(waitWords(w), '5 min on box2 until providers.health (target abc, lines 500) shows done');
  const view = planTool.cardView({ title: 't', steps: STEPS }, { title: 't', steps: [{ n: 1, what: 'w', changes: 'c', args: {}, wait: w }] });
  assert.equal(view.steps[0].wait, waitWords(w));
  assert.match(planTool.cardLines({ title: 't' }, { steps: [{ n: 1, what: 'w', changes: 'c', args: {}, wait: w }] }).join('\n'), /\(target abc, lines 500\)/);
});
