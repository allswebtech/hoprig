// A schedule in few requests. A real model needed eleven for one schedule: it guessed the inputs (the action add and not
// add_schedule, days as text, no provider) and was refused four times, because what find_acts showed of an act did not say
// them. Now find_acts names each act's inputs with type, whether needed and the allowed values, and a wrong input is refused
// with the right shape in one line.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function setup() {
  const ops = new FakeOps(baseState());
  const core = createAssistantCore({ ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }), jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }) });
  return { ops, call: (name, args) => core.call(name, args, { conversation: 'ai' }) };
}
const data = (r) => JSON.parse(/<untrusted_data[^>]*>(.*)<\/untrusted_data>/s.exec(r.text)[1]);

test('find_acts: a schedule is found by how it is said, and its inputs are named with type, need and values', async () => {
  const { call } = setup();
  const r = await call('find_acts', { query: 'run the tests every night at two' });
  const list = data(r).acts;
  const sched = list.find((x) => x.id === 'automation.schedules');
  assert.ok(sched, `automation.schedules among ${list.map((x) => x.id).join(', ')}`);
  assert.ok(list.indexOf(sched) < 3, 'among the first three');
  const input = sched.input;
  assert.match(input, /time\*/, 'time is needed');
  assert.match(input, /days: list of sun\|mon\|tue\|wed\|thu\|fri\|sat/, 'days is a list, with the allowed values');
  assert.match(input, /account/);
  assert.match(input, /folder/);
  assert.match(input, /HH:MM/);
  assert.doesNotMatch(input, /action/, 'the action is the act own: she does not send one');
  assert.ok(input.length < 420, `short: ${input.length} ${input}`);
});

test('do_act: the act own action wins over a guess (add for add_schedule): a card, not a refusal', async () => {
  const { call } = setup();
  await call('find_acts', { query: 'run the tests every night at two' });
  await call('list_projects', {});
  await call('get_computer_status', { providers: true });
  const r = await call('do_act', { act: 'automation.schedules', args: { action: 'add', label: 'Nightly tests', time: '02:00', days: ['mon', 'tue'], folder: '/home/owner/projects/api', account: 'sub', text: 'Run the tests.' } });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.card, r.text);
});

test('a wrong input is refused with the right shape in one line', async () => {
  const { call } = setup();
  await call('find_acts', { query: 'run the tests every night at two' });
  await call('list_projects', {});
  await call('get_computer_status', { providers: true });
  const r = await call('do_act', { act: 'automation.schedules', args: { time: '02:00', days: 'mon-fri', folder: '/home/owner/projects/api', account: 'sub' } });
  assert.equal(r.isError, true);
  assert.match(r.text, /days: must be a list/);
  assert.match(r.text, /send days as a list of sun\|mon\|tue\|wed\|thu\|fri\|sat, for example \["sun","mon"\]/);
  const t = await call('do_act', { act: 'automation.schedules', args: { time: '2am', folder: '/home/owner/projects/api', account: 'sub' } });
  assert.equal(t.isError, true);
  assert.match(t.text, /time/);
  assert.match(t.text, /HH:MM/, 'the form of a time is said');
});

test('look of a list needs no action: the read row answers by itself', async () => {
  const { call } = setup();
  await call('find_acts', { query: 'schedules automation page' });
  const r = await call('look', { facts: [{ id: 'automation.page' }] });
  assert.equal(r.isError, false, r.text);
  assert.doesNotMatch(r.text, /action/i);
});

test('a catalog route row shows its fields with type and need', async () => {
  const { call } = setup();
  const r = await call('find_acts', { query: 'send text to a session', limit: 8 });
  const row = data(r).acts.find((x) => /^sessions\.send$/.test(x.id));
  assert.ok(row, 'sessions.send is found');
  assert.match(row.input, /text/);
  assert.match(row.input, /text: text/);
});
