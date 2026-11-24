// A schedule Tia adds (manage_automation add_schedule, through her door) starts what is hers when it runs: the
// schedule keeps that it is hers, from the route, never from the body, and its start asks for a session of hers. A
// schedule of the owner's starts a session of his, also when its body says "hers".
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomation } from '../../src/automation/index.mjs';
import * as sch from '../../src/automation/schedules.mjs';
import { fakeCtx, fakeDeck, recorder, tmpDir } from './helpers.mjs';

const start = (dir) => ({ enabled: true, when: { kind: 'daily', time: '09:00' }, action: { type: 'start', dir, profile: 'sub' } });

test('a schedule added through her door is hers; one of his is his, whatever its body says', async () => {
  const t = tmpDir('sched-hers');
  const f = fakeCtx({ deck: fakeDeck([]), automation: {}, stateDir: t.dir });
  const a = createAutomation(f.ctx);
  try {
    a.api.changeSchedules('add', { op: 'add', schedule: start('/w/alpha') }, { hers: true });
    a.api.changeSchedules('add', { op: 'add', schedule: { ...start('/w/beta'), hers: true } });
    const list = f.ctx.config().automation.schedules.list;
    assert.equal(list.find((s) => s.action.dir === '/w/alpha').hers, true, 'hers, from the route');
    assert.equal(list.find((s) => s.action.dir === '/w/beta').hers, undefined, 'the body cannot say it');
    // The owner changing her schedule does not make it his (it only ever adds his card).
    const id = list.find((s) => s.action.dir === '/w/alpha').id;
    a.api.changeSchedules('change', { op: 'change', id, schedule: start('/w/alpha2') });
    assert.equal(f.ctx.config().automation.schedules.list.find((s) => s.id === id).hers, true);
  } finally {
    await a.close();
    t.cleanup?.();
  }
});

test('when it runs, a schedule of hers starts a terminal or a chat of hers; his starts his', async () => {
  const started = [];
  const chats = [];
  const deck = { start: async (o) => { started.push(o); return 'alpha'; }, startChat: async (o) => { chats.push(o); return 'c1'; } };
  const rec = recorder();
  const run = (schedule) => ({ type: 'run', schedule: { id: 's', ...schedule }, slot: 1, late: 0 });
  await sch.apply([
    run({ ...start('/w/a'), hers: true }),
    run(start('/w/b')),
    run({ ...start('/w/c'), action: { ...start('/w/c').action, in: 'chat' }, hers: true }),
    run({ ...start('/w/d'), action: { ...start('/w/d').action, in: 'chat' } }),
  ], { deck, record: rec.record, notify: rec.notify, enqueue: () => {} });
  assert.deepEqual(started.map((o) => o.hers === true), [true, false]);
  assert.deepEqual(chats.map((o) => o.hers === true), [true, false]);
});
