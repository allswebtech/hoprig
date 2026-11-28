// What a check found in her tools of the catalog, one test each (they failed before the mend):
//   1 sign-in is never a card; 2 a do_act card shows every value whole; 3 a plan card shows the values of its steps;
//   4 a role, tenant or price field is refused; 5 an act id she was never shown is refused; 6 a read keeps only its pick.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { callOf, keep, rowById } from '../../src/assistant/catalog.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { PlanStore, actsAdapter } from '../../src/assistant/plans.mjs';
import { plan_acts } from '../../src/assistant/plantool.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { byName } from '../../src/assistant/tools.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

byName.set('plan_acts', plan_acts);

function setup({ answer = { ok: true } } = {}) {
  const state = baseState();
  state.assistant = { ...state.assistant, enabled: true, level: 'work' };
  const ops = new FakeOps(state);
  const routed = [];
  ops.routeCall = async (computer, method, p, body) => { routed.push({ method, p, body }); return answer; };
  const acts = actsAdapter({ run: async () => ({ ok: true, summary: 'did it' }), undo: async () => ({ ok: true }), fact: async () => ({}) });
  const core = createAssistantCore({ ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }), jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }), plans: new PlanStore(), acts });
  const show = (...ids) => core.shown.add('w1', { act: ids });
  const call = (name, args) => core.call(name, args, { conversation: 'w1' });
  call.core = core;
  return { core, routed, show, call };
}

test('1 sign-in: the Claude sign-in run is the owner\'s own, never a card of hers', async () => {
  const { call, show } = setup();
  show('onboarding.run');
  const r = await call('do_act', { act: 'onboarding.run', args: { run: 'claude-login' } });
  assert.ok(!r.card, 'no card for a sign-in');
  assert.equal(rowById('onboarding.run').facts.never, 'sign-in');
});

test('2 do_act: the card shows a long multi-line value whole, as the run sends it', async () => {
  const { call, show } = setup();
  show('code.file');
  const text = Array.from({ length: 60 }, (_, i) => `line ${i} of the file`).join('\n');
  assert.ok(text.length > 800 && text.length <= 2000);
  const r = await call('do_act', { act: 'code.file', args: { root: '/home/owner/p', path: 'a.txt', text } });
  assert.ok(r.card, r.text);
  const shown = r.card.lines.join('\n');
  assert.ok(shown.includes('line 0 of the file\nline 1 of the file'), 'line breaks kept');
  assert.ok(shown.includes('line 59 of the file'), 'the end of the value is on the card');
});

test('3 plan_acts: the card shows the values of every step', async () => {
  const { call, show } = setup();
  show('skillhub.undo', 'updates.run');
  call.core.shown.add('w1', { target: ['alpha-skill', 'shop-api'] }); // a tool result named them
  const r = await call('plan_acts', { title: 'Undo then update', steps: [{ act: 'skillhub.undo', args: { name: 'alpha-skill', project: 'shop-api' } }, { act: 'updates.run', args: {} }] });
  assert.equal(r.isError, false, r.text);
  const shown = r.card.lines.join('\n');
  assert.match(shown, /name: alpha-skill/);
  assert.match(shown, /project: shop-api/);
  assert.match(JSON.stringify(r.card.view || {}), /alpha-skill/);
});

test('4 a role, tenant, price or admin field is refused for a row with no schema, as a card and as a read', async () => {
  const row = rowById('work.settings');
  assert.ok(!row.input, 'a row with no input schema');
  for (const k of ['role', 'tenant', 'tenant_id', 'price', 'admin', 'isAdmin', 'total']) {
    assert.throws(() => callOf(row, { [k]: 'x' }), /not go through|refused|not a field|privilege/i, k);
  }
  const { call, show, routed } = setup();
  show('work.settings');
  const r = await call('do_act', { act: 'work.settings', args: { role: 'admin', tenant: 't1', price: 0 } });
  assert.equal(r.isError, true, r.text);
  assert.ok(!r.card);
  assert.deepEqual(routed, []);
  assert.doesNotThrow(() => callOf(row, { where: 'here' }));
});

test('5 an act id she was never shown by find_acts in this conversation is refused', async () => {
  const { call } = setup();
  const miss = await call('do_act', { act: 'work.settings', args: { where: 'here' } });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /find_acts/);
  const lookMiss = await call('look', { facts: [{ id: 'addons.job', args: { target: 'x' } }] });
  assert.match(lookMiss.text, /find_acts/);
  const planMiss = await call('plan_acts', { title: 'two', steps: [{ act: 'skillhub.undo', args: {} }, { act: 'updates.run', args: {} }] });
  assert.equal(planMiss.isError, true);
  assert.match(planMiss.text, /find_acts/);
  const found = await call('find_acts', { query: 'work settings' });
  assert.equal(found.isError, false, found.text);
  const ok = await call('do_act', { act: 'work.settings', args: { where: 'here' } });
  assert.ok(ok.card, ok.text);
});

test('6 a read keeps only its pick: addons.job gives running, next and result and nothing else', async () => {
  const row = rowById('addons.job');
  assert.deepEqual(row.pick, ['running', 'next', 'result']);
  const { data } = keep(row, { running: true, next: 'n', result: 'r', extra: 'must not pass', nested: { a: 1 } });
  assert.deepEqual(data, { running: true, next: 'n', result: 'r' });
  const { core, call, show, routed } = setup({ answer: { running: false, next: 'later', result: 'fine', extra: 'must not pass' } });
  show('addons.job');
  core.shown.add('w1', { target: ['trouteai'] });
  const r = await call('look', { facts: [{ id: 'addons.job', args: { target: 'trouteai' } }] });
  assert.equal(r.isError, false, r.text);
  assert.equal(routed.length, 1);
  assert.match(r.text, /later/);
  assert.doesNotMatch(r.text, /must not pass/);
});
