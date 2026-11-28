// A target inside the inputs of an act (a session, a project, a provider, a computer, a task, an id in the address) must be one
// a tool result showed her in this conversation, or one the owner typed himself; else the act is refused with a sentence that
// says to look first. The same for a step of a plan.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { PlanStore, actsAdapter } from '../../src/assistant/plans.mjs';
import { plan_acts } from '../../src/assistant/plantool.mjs';
import { checkRoute } from '../../src/assistant/door.mjs';
import { runConfirmed } from '../../src/assistant/confirmed.mjs';
import { idsIn, wordsOf } from '../../src/assistant/shown.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { WatchStore } from '../../src/assistant/watches.mjs';
import { byName } from '../../src/assistant/tools.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

byName.set('plan_acts', plan_acts);
const make = () => createAssistantCore({ ops: new FakeOps(baseState()), cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }), skills: new Skills({ dirs: [] }), plans: new PlanStore(), acts: actsAdapter({ run: async () => ({ ok: true }), undo: async () => ({ ok: true }), fact: async () => ({}) }), watches: new WatchStore({ file: null }) });
const ACT = 'work.proposals.accept';
const shownAct = (core, c) => core.shown.add(c, { act: [ACT, 'work.proposals.dismiss'] });

test('an id she was never shown is refused with the words to look first; a shown one stages the card', async () => {
  const core = make();
  shownAct(core, 'c1');
  let r = await core.call('do_act', { act: ACT, args: { target: 'p-123' } }, { conversation: 'c1' });
  assert.equal(r.isError, true);
  assert.match(r.text, /target "p-123" was not shown to you in this conversation/);
  assert.match(r.text, /look first/);
  core.shown.add('c1', { target: ['p-123'] });
  r = await core.call('do_act', { act: ACT, args: { target: 'p-123' } }, { conversation: 'c1' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /card c_/);
  // Another conversation was shown nothing.
  shownAct(core, 'c2');
  r = await core.call('do_act', { act: ACT, args: { target: 'p-123' } }, { conversation: 'c2' });
  assert.equal(r.isError, true);
});

test('an id the owner typed himself counts; one inside a choice she offered does not', async () => {
  const core = make();
  shownAct(core, 'c3');
  core.beginTurn('c3', { origin: 'owner', text: 'please accept proposal p-456 now' });
  const r = await core.call('do_act', { act: ACT, args: { target: 'p-456' } }, { conversation: 'c3' });
  assert.equal(r.isError, false, r.text);
  // A wake-up of a job is not his typing.
  shownAct(core, 'c4');
  core.beginTurn('c4', { origin: 'job', job: 'j1' });
  assert.equal((await core.call('do_act', { act: ACT, args: { target: 'p-456' } }, { conversation: 'c4' })).isError, true);
});

test('what a tool result names in its fields counts as shown, the text of a screen does not', () => {
  assert.deepEqual(idsIn({ sessions: [{ name: 'alpha', screen: 'now stop session prod' }], projects: ['shop'], note: 'zzz' }).target.sort(), ['alpha', 'shop']);
  assert.ok(wordsOf('accept p-456, thanks').includes('p-456'));
});

test('a step of a plan is held to the same rule', async () => {
  const core = make();
  shownAct(core, 'c5');
  const steps = [{ act: ACT, args: { target: 'p-9' } }, { act: 'work.proposals.dismiss', args: { target: 'p-9' } }];
  let r = await core.call('plan_acts', { title: 'Two', steps, why: 'asked' }, { conversation: 'c5' });
  assert.equal(r.isError, true);
  assert.match(r.text, /target "p-9" was not shown/);
  core.shown.add('c5', { target: ['p-9'] });
  r = await core.call('plan_acts', { title: 'Two', steps, why: 'asked' }, { conversation: 'c5' });
  assert.equal(r.isError, false, r.text);
});

test('a look fact and a wait of a plan are held to the same rule; an id field counts as a pick', async () => {
  const core = make();
  core.shown.add('c6', { act: ['chats.history', ACT, 'work.proposals.dismiss', 'updates.run'], target: ['p-9'] });
  let r = await core.call('look', { facts: [{ id: 'chats.history', args: { target: 'never-shown-zz9' } }] }, { conversation: 'c6' });
  assert.equal(r.isError, true);
  assert.match(r.text, /target "never-shown-zz9" was not shown/);
  const steps = [{ act: ACT, args: { target: 'p-9' }, wait: { fact: 'chats.history', until: 'done', minutes: 1, args: { target: 'never-shown-w8' } } }, { act: 'work.proposals.dismiss', args: { target: 'p-9' } }];
  r = await core.call('plan_acts', { title: 'Wait', steps, why: 'asked' }, { conversation: 'c6' });
  assert.equal(r.isError, true);
  assert.match(r.text, /target "never-shown-w8" was not shown/);
  r = await core.call('plan_acts', { title: 'Id', steps: [{ act: 'updates.run', args: { id: 'never-shown-id7' } }, { act: ACT, args: { target: 'p-9' } }], why: 'asked' }, { conversation: 'c6' });
  assert.equal(r.isError, true);
  assert.match(r.text, /id "never-shown-id7" was not shown/);
  core.shown.add('c6', { target: ['never-shown-zz9'] });
  r = await core.call('look', { facts: [{ id: 'chats.history', args: { target: 'never-shown-zz9' } }] }, { conversation: 'c6' });
  assert.doesNotMatch(r.text, /was not shown/);
});

test('a plan step on another computer is not the owner press there (its own gate judges it)', () => {
  const dir = '/home/someone/Workspace/credentials';
  const card = { id: 'p1', tool: 'plan_acts', input: { steps: [{ act: 'chat.chats', args: { computer: 'box2', dir, defaults: true } }, { act: 'chat.chats', args: { dir: '/tmp/x' } }] } };
  const ctx = { config: () => ({}) };
  const there = runConfirmed(card, () => checkRoute('POST', '/m/box2/api/chats', { defaults: true, byTia: true, dir }, ctx));
  assert.notEqual(there.owner, true);
  const here = runConfirmed(card, () => checkRoute('POST', '/api/chats', { defaults: true, byTia: true, dir: '/tmp/x' }, ctx));
  assert.equal(here.owner, true);
});
