// plan_acts and watch_work through the core: a plan is ONE card, staged for his tap; it never starts without the tap; the
// card follows the run; a never step is refused with her words; a plan of reads only runs at once. A watch costs nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { PlanStore, actsAdapter } from '../../src/assistant/plans.mjs';
import { plan_acts } from '../../src/assistant/plantool.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { WatchStore } from '../../src/assistant/watches.mjs';
import { watch_work } from '../../src/assistant/watchtool.mjs';
import { byName } from '../../src/assistant/tools.mjs';
import { loadActs } from '../../src/assistant/acts.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

byName.set('plan_acts', plan_acts); // H2 puts it in the array; until then the test makes it known to the core
byName.set('watch_work', watch_work);

// She was shown every act (find_acts does that in a conversation): these tests are about the plan, not about showing.
const NEVER = loadActs().rows.find((r) => r.kind !== 'not-an-act' && r.facts && r.facts.never === 'sign-in').id;
const showAll = (c) => { c.shown.add('page-1', { act: ['no.such', 'sessions.rename', 'session.state', 'system.usage', 'updates.run', NEVER] }); return c; };
function setup() {
  const calls = [];
  const acts = actsAdapter({
    run: async (id, args, meta) => { calls.push(['run', id, meta.step]); return { ok: true, summary: `did ${id}`, undo: `u${meta.step}` }; },
    undo: async (u) => { calls.push(['undo', u]); return { ok: true }; },
    fact: async () => ({ state: 'ended' }),
  });
  const core = showAll(createAssistantCore({ ops: new FakeOps(baseState()), cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }), skills: new Skills({ dirs: [] }), plans: new PlanStore(), acts, watches: new WatchStore({ file: null }) }));
  return { core, calls, call: (t, a) => core.call(t, a, { conversation: 'page-1' }) };
}
const plan = (extra = {}) => ({ title: 'Rename then update', steps: [{ act: 'sessions.rename', args: {} }, { act: 'updates.run', args: {} }], why: 'he asked for both', ...extra });
const settle = () => new Promise((r) => setTimeout(r, 20));

test('a plan that changes things is ONE card with every step; nothing runs before his tap', async () => {
  const { core, call, calls } = setup();
  const r = await call('plan_acts', plan());
  assert.equal(r.isError, false, r.text);
  assert.ok(r.card, 'a card is staged');
  assert.equal(r.card.tool, 'plan_acts');
  assert.equal(r.card.lines.filter((l) => /^Step \d/.test(l)).length, 2);
  assert.deepEqual(calls, [], 'no step ran');
  assert.equal(core.plans.list().length, 0, 'no plan record before the tap');
});

test('his one tap runs the steps; the plan card follows each step and ends done', async () => {
  const { core, call, calls } = setup();
  const staged = await call('plan_acts', plan());
  const done = await core.confirm(staged.card.id);
  assert.equal(done.ok, true);
  assert.equal(done.view.kind, 'plan');
  await settle();
  assert.deepEqual(calls.filter((c) => c[0] === 'run').map((c) => c[2]), [1, 2]);
  const seen = (await core.refreshViews([done.view.id]))[done.view.id];
  assert.equal(seen.state, 'done');
  assert.deepEqual(seen.steps.map((s) => s.state), ['done', 'done']);
});

test('a failed step is on the card with its note, the earlier step is taken back', async () => {
  const { core, call, calls } = setup();
  const acts = actsAdapter({ run: async (id, a, m) => { calls.push(['run', m.step]); if (m.step === 2) throw new Error('no space left'); return { ok: true, summary: 'ok', undo: 'u1' }; }, undo: async (u) => { calls.push(['undo', u]); return { ok: true }; }, fact: async () => ({}) });
  const c2 = showAll(createAssistantCore({ ops: new FakeOps(baseState()), cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }), skills: new Skills({ dirs: [] }), acts }));
  const staged = await c2.call('plan_acts', plan(), { conversation: 'page-1' });
  const done = await c2.confirm(staged.card.id);
  await settle();
  const seen = (await c2.refreshViews([done.view.id]))[done.view.id];
  assert.equal(seen.state, 'failed');
  assert.deepEqual(seen.steps.map((s) => s.state), ['undone', 'failed']);
  assert.match(seen.steps[1].note, /no space left/);
  assert.deepEqual(calls.filter((c) => c[0] === 'undo'), [['undo', 'u1']]);
  assert.equal(core.plans.list().length, 0);
});

test('a step of the never list refuses the plan with her words and no card is made', async () => {
  const { call } = setup();
  const r = await call('plan_acts', { title: 'Sign in', steps: [{ act: 'sessions.rename', args: {} }, { act: NEVER, args: {} }] });
  assert.equal(r.isError, true);
  assert.equal(r.card, undefined);
  assert.match(r.text, /yours alone/);
});

test('a made-up act and a stray field are refused by the strict input', async () => {
  const { call } = setup();
  assert.match((await call('plan_acts', plan({ steps: [{ act: 'no.such', args: {} }, { act: 'sessions.rename', args: {} }] }))).text, /find_acts/);
  assert.match((await call('plan_acts', plan({ role: 'admin' }))).text, /unknown field/);
  assert.match((await call('plan_acts', plan({ steps: [{ act: 'sessions.rename', args: { evil: 1 } }, { act: 'updates.run', args: {} }] }))).text, /does not go with/);
});

test('a card is never confirmed by voice or by itself: run refuses a changing plan with no confirmed card', async () => {
  const { core } = setup();
  await assert.rejects(() => plan_acts.run(core, plan(), { conversation: 'c', now: Date.now, acts: actsAdapter() }), /owner's tap on its card/);
});

test('a plan of reads only runs at once, with no card', async () => {
  const { call, calls } = setup();
  const r = await call('plan_acts', { title: 'Look', steps: [{ act: 'session.state', args: {} }, { act: 'system.usage', args: {} }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.card, undefined);
  assert.equal(calls.filter((c) => c[0] === 'run').length, 2);
  assert.match(r.text, /done/);
});

test('a plan whose step changed since the card was made is stale', async () => {
  const { core, call } = setup();
  let rests = 'a';
  const acts = actsAdapter({ run: async () => ({ ok: true }), undo: async () => ({ ok: true }), fact: async () => ({}), before: async () => rests });
  const c2 = showAll(createAssistantCore({ ops: new FakeOps(baseState()), cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }), skills: new Skills({ dirs: [] }), acts }));
  const staged = await c2.call('plan_acts', plan(), { conversation: 'page-1' });
  rests = 'b';
  const r = await c2.confirm(staged.card.id);
  assert.equal(r.code, 'stale');
  assert.ok(core && call);
});

test('watch_work adds, lists and removes; it is the owner\'s own state and costs no model turn', async () => {
  const { core, call } = setup();
  const a = await call('watch_work', { action: 'add', on: 'session', target: 'alpha', when: 'needs-me' });
  assert.equal(a.isError, false, a.text);
  assert.equal(a.card, undefined, 'no card');
  assert.equal(core.watches.list().length, 1);
  assert.match((await call('watch_work', { action: 'list' })).text, /alpha/);
  const id = core.watches.list()[0].id;
  assert.match((await call('watch_work', { action: 'remove', id })).text, /removed/);
  assert.equal(core.watches.list().length, 0);
  assert.match((await call('watch_work', { action: 'add', on: 'session', target: 'alpha', when: 'back' })).text, /can be watched for/);
});
