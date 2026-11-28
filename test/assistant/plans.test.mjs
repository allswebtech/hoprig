// Plans (design 2.3): several acts as one card. A step is an act of acts.json; the never list cannot be in a plan; the
// runner goes step by step with a wait that has a time limit; a failed step stops the plan and takes back what was done,
// in reverse; a plan never starts without its tap.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadActs } from '../../src/assistant/acts.mjs';
import { MAX_STEPS, PlanStore, actsAdapter, checkPlan, runPlan, waitMet } from '../../src/assistant/plans.mjs';

const ROWS = loadActs().rows;
const ALONE = 'sessions.rename'; // alone, with an undo
const CARD = 'updates.run'; // a card, no undo
const READ = 'session.state'; // a read row
const NEVER = ROWS.find((r) => r.kind !== 'not-an-act' && r.facts && r.facts.never === 'sign-in').id;

const fake = (over = {}) => {
  const calls = [];
  const adapter = actsAdapter({
    run: async (id, args, meta) => { calls.push(['run', id, meta.step]); if (over.fail === meta.step) throw new Error('the computer said no'); return { ok: true, summary: `did ${id}`, undo: over.noUndo?.includes(meta.step) ? null : `u${meta.step}` }; },
    undo: async (u) => { calls.push(['undo', u]); if (over.undoFail === u) return { ok: false, summary: 'it moved on' }; return { ok: true }; },
    fact: async () => { calls.push(['fact']); return over.fact ? over.fact(calls.filter((c) => c[0] === 'fact').length) : { state: 'ended' }; },
  });
  return { adapter, calls };
};
const three = (extra = {}) => ({ title: 'Update and check', steps: [{ act: ALONE, args: {} }, { act: ALONE, args: {}, ...extra }, { act: CARD, args: {} }] });

test('a plan of acts is accepted and every step shows its act in plain words and what it changes', () => {
  const { adapter } = fake();
  const r = checkPlan(three(), adapter);
  assert.equal(r.steps.length, 3);
  assert.match(r.steps[0].what, /\w/);
  assert.match(r.steps[0].changes, /taken back/);
  assert.match(r.steps[2].changes, /Cannot be taken back/);
});

test('a step of the never list refuses the whole plan with her words for it', () => {
  const { adapter } = fake();
  const r = checkPlan({ steps: [{ act: ALONE, args: {} }, { act: NEVER, args: {} }] }, adapter);
  assert.equal(r.steps, undefined);
  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0].n, 2);
  assert.match(r.refused[0].say, /yours alone/);
  assert.ok(r.refused[0].press);
});

test('a made-up act, a wait on a write row and a wait of 31 minutes are refused with the step to take', () => {
  const { adapter } = fake();
  assert.match(checkPlan({ steps: [{ act: 'no.such', args: {} }, { act: ALONE, args: {} }] }, adapter).problems[0], /find_acts/);
  assert.match(checkPlan({ steps: [{ act: ALONE, args: {}, wait: { fact: CARD, until: 'done', minutes: 5 } }, { act: ALONE, args: {} }] }, adapter).problems[0], /read act/);
  assert.match(checkPlan({ steps: [{ act: ALONE, args: {}, wait: { fact: READ, until: 'done', minutes: 31 } }, { act: ALONE, args: {} }] }, adapter).problems[0], /1 to 30/);
  assert.match(checkPlan({ steps: [{ act: ALONE, args: {} }] }, adapter).problems[0], /2 to 12/);
  assert.equal(MAX_STEPS, 12);
});

test('a plan runs its steps in order and ends done, with an audit line per step carrying the plan id', async () => {
  const { adapter, calls } = fake();
  const store = new PlanStore();
  const plan = store.create({ conversation: 'c', title: 't', steps: checkPlan(three(), adapter).steps });
  const lines = [];
  await runPlan(plan, adapter, { audit: { append: (l) => lines.push(l) } });
  assert.equal(plan.state, 'done');
  assert.deepEqual(plan.steps.map((s) => s.state), ['done', 'done', 'done']);
  assert.deepEqual(calls.map((c) => c[2]), [1, 2, 3]);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.input.plan === plan.id && l.outcome === 'done'));
});

test('a wait step holds until the fact is met, reading it again and again, and then goes on', async () => {
  const { adapter, calls } = fake({ fact: (n) => (n < 3 ? { state: 'working' } : { state: 'ended' }) });
  let t = 0;
  const plan = new PlanStore().create({ conversation: 'c', title: 't', steps: checkPlan(three({ wait: { fact: READ, until: 'done', minutes: 5 } }), adapter).steps });
  await runPlan(plan, adapter, { now: () => t, sleep: async (ms) => { t += ms; }, pollMs: 1000 });
  assert.equal(plan.state, 'done');
  assert.equal(calls.filter((c) => c[0] === 'fact').length, 3);
  assert.equal(calls.filter((c) => c[0] === 'run').length, 3);
});

test('a wait that runs out fails the step and takes back the steps before it, in reverse', async () => {
  const { adapter, calls } = fake({ fact: () => ({ state: 'working' }) });
  let t = 0;
  const plan = new PlanStore().create({ conversation: 'c', title: 't', steps: checkPlan(three({ wait: { fact: READ, until: 'done', minutes: 2 } }), adapter).steps });
  await runPlan(plan, adapter, { now: () => t, sleep: async (ms) => { t += ms; }, pollMs: 30_000 });
  assert.equal(plan.state, 'failed');
  assert.match(plan.steps[1].note, /within 2 minutes/);
  assert.equal(plan.steps[2].state, 'skipped');
  assert.deepEqual(calls.filter((c) => c[0] === 'undo').map((c) => c[1]), ['u2', 'u1'], 'newest first');
  assert.equal(plan.steps[0].state, 'undone');
});

test('a step that fails stops the plan: later steps do not run, earlier ones are taken back in reverse', async () => {
  const { adapter, calls } = fake({ fail: 3 });
  const plan = new PlanStore().create({ conversation: 'c', title: 't', steps: checkPlan({ steps: [{ act: ALONE, args: {} }, { act: ALONE, args: {} }, { act: ALONE, args: {} }, { act: ALONE, args: {} }] }, adapter).steps });
  await runPlan(plan, adapter);
  assert.equal(plan.state, 'failed');
  assert.deepEqual(plan.steps.map((s) => s.state), ['undone', 'undone', 'failed', 'skipped']);
  assert.deepEqual(calls.filter((c) => c[0] === 'undo').map((c) => c[1]), ['u2', 'u1']);
  assert.equal(calls.filter((c) => c[0] === 'run').length, 3, 'step 4 never ran');
  assert.match(plan.note, /the computer said no/);
});

test('what cannot be taken back is said: a step with no undo stays done and is counted', async () => {
  const { adapter } = fake({ fail: 3, noUndo: [1] });
  const plan = new PlanStore().create({ conversation: 'c', title: 't', steps: checkPlan({ steps: [{ act: ALONE, args: {} }, { act: ALONE, args: {} }, { act: ALONE, args: {} }] }, adapter).steps });
  await runPlan(plan, adapter);
  assert.equal(plan.steps[0].state, 'done');
  assert.equal(plan.steps[1].state, 'undone');
  assert.match(plan.note, /1 step could not be taken back/);
});

test('an undo that is refused is reported as not taken back, and the others are still taken back', async () => {
  const { adapter } = fake({ fail: 3, undoFail: 'u2' });
  const plan = new PlanStore().create({ conversation: 'c', title: 't', steps: checkPlan({ steps: [{ act: ALONE, args: {} }, { act: ALONE, args: {} }, { act: ALONE, args: {} }] }, adapter).steps });
  await runPlan(plan, adapter);
  assert.deepEqual(plan.steps.map((s) => s.state), ['undone', 'undo-failed', 'failed']);
});

test('a step that became the owner\'s own at run time is not done: the server decides again at every step', async () => {
  const { adapter, calls } = fake();
  const plan = new PlanStore().create({ conversation: 'c', title: 't', steps: checkPlan(three(), adapter).steps });
  const row2 = adapter.row(plan.steps[1].act);
  let n = 0;
  const original = adapter.answer;
  adapter.answer = (row, args) => (row === row2 && ++n === 2 ? 'open' : original(row, args));
  await runPlan(plan, adapter);
  assert.equal(plan.state, 'failed');
  assert.equal(calls.filter((c) => c[0] === 'run').length, 1);
  assert.match(plan.steps[1].note, /owner's own/);
});

test('the owner stopping a running plan ends it after the running step and takes back what was done', async () => {
  const { adapter, calls } = fake();
  const store = new PlanStore();
  const plan = store.create({ conversation: 'c', title: 't', steps: checkPlan(three(), adapter).steps });
  const run = runPlan(plan, adapter, { sleep: async () => {} });
  assert.equal(store.stop(plan.id), true, 'a running plan can be stopped');
  await run;
  assert.equal(plan.state, 'stopped');
  assert.ok(calls.filter((c) => c[0] === 'undo').length >= 0);
  assert.ok(plan.steps.every((s) => s.state !== 'running'));
});

test('one plan runs per computer and three at once', () => {
  const { adapter } = fake();
  const store = new PlanStore();
  const mk = (computer) => store.create({ conversation: 'c', title: 't', steps: checkPlan({ steps: [{ act: ALONE, args: computer ? { computer } : {} }, { act: ALONE, args: computer ? { computer } : {} }] }, adapter).steps });
  const a = mk(null);
  assert.equal(store.busy(a), null);
  a.state = 'running';
  assert.match(store.busy(mk(null)), /this computer already/);
  assert.equal(store.busy(mk('alpha')), null, 'another computer is free');
  mk('alpha').state = 'running';
  mk('beta').state = 'running';
  assert.match(store.busy(mk('gamma')), /3 plans/);
});

test('waitMet reads plain data only', () => {
  assert.equal(waitMet('done', { state: 'ended' }), true);
  assert.equal(waitMet('done', { state: 'working' }), false);
  assert.equal(waitMet('back', { online: true }), true);
  assert.equal(waitMet('idle', null), false);
  assert.equal(waitMet('answers', { items: [1] }), true);
});
