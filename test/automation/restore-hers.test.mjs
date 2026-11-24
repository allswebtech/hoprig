// A session of Tia's that a restart took away comes back as hers: the restore's own record keeps that the run was
// marked hers (the mark of the old run goes with that run), and its reopen asks the deck for a start as hers. A
// session of the owner's comes back as his.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as restore from '../../src/automation/restore.mjs';
import { claude } from './helpers.mjs';

const HERS = '22222222-2222-4222-8222-222222222222';
const HIS = '33333333-3333-4333-8333-333333333333';

test('a session of hers is reopened as hers after a restart; his is reopened as his', async () => {
  let r = restore.decide({ cards: [claude('alpha', { sessionId: HERS, hers: true }), claude('beta', { sessionId: HIS })], data: null, now: 1000, boot: false, enabled: true });
  assert.equal(r.data.sessions.alpha.hers, true, 'kept in the restore record');
  assert.equal(r.data.sessions.beta.hers, undefined);
  r = restore.decide({ cards: [], data: r.data, now: 2000, boot: true, enabled: true });
  const started = [];
  await restore.apply(r.actions, {
    deck: { start: async (o) => { started.push(o); return o.name; } },
    conversationExists: () => true,
    record: () => {},
  });
  const by = Object.fromEntries(started.map((o) => [o.name, o]));
  assert.equal(by.alpha.hers, true, 'hers is started as hers');
  assert.equal(by.beta.hers, undefined, 'his is started as his');
});
