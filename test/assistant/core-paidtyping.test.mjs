// A message Tia types into a session on a stored sign-in that holds a Console account's key (src/routerstate.mjs
// billedLogin) is paid usage. The session's card carries the provider's public profile, without the sign-in check's
// mark, so her facts judge the provider by the accounts as the dashboard lists them (src/assistant/spend.mjs
// paidName): at Hands off with no daily limit it is a card and nothing is typed; inside a limit it is typed and held.
// The dashboard is a stand-in (fake-dashboard.mjs): nothing is typed into a real session, no provider is asked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { HOLD_USD, SpendLedger } from '../../src/assistant/spend.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function setup(cap = null) {
  const s = baseState();
  s.assistant = { enabled: true, actAlone: true, level: 'handsoff', accounts: ['sub', 'acct'], ...(cap === null ? {} : { dailyCapUsd: cap }) };
  // The list (/api/state) marks the sign-in billed by use; the session's card has only its public profile.
  s.profiles.push({ name: 'acct', label: 'Account', kind: 'login', paid: true, inUse: 1, limited: null, usage: null });
  s.sessions.find((x) => x.name === 'web-ui').profile = { name: 'acct', label: 'Account', kind: 'login', paid: false };
  const ops = new FakeOps(s);
  const core = createAssistantCore({ ops, cards: new CardStore(), audit: new AuditLog({ file: null }), jobs: new JobStore({ dir: null }), spend: new SpendLedger({ file: null }) });
  // the terminal is hers: typing into one of his is a card whatever the provider (it cannot be taken back)
  core.jobs.markStarted('this', 'web-ui', 1_700_000_002_000);
  const call = (tool, args) => core.call(tool, args, { conversation: 'c1' });
  const typed = () => ops.calls.filter((c) => c.op === 'sendText' || c.op === 'queue').length;
  return { core, call, typed };
}

test('Hands off with no daily limit: a message into a session on a Console sign-in is a card, nothing is typed', async () => {
  const { core, call, typed } = setup();
  await call('list_sessions', {});
  const send = await call('send_to_session', { session: 'web-ui', text: 'yes, update the screenshots' });
  assert.ok(send.card, send.text);
  assert.match(send.card.lines.join('\n'), /no daily limit for paid use is set/);
  const queued = await call('manage_automation', { action: 'queue_message', session: 'web-ui', text: 'run the tests' });
  assert.ok(queued.card, queued.text);
  assert.equal(typed(), 0);
  assert.deepEqual(core.spend.today(), { spent: 0, held: 0 });
});

test('inside the daily limit it is typed and held; past it a card', async () => {
  const { core, call, typed } = setup(HOLD_USD);
  await call('list_sessions', {});
  const r1 = await call('send_to_session', { session: 'web-ui', text: 'yes, update the screenshots' });
  assert.ok(!r1.card, r1.text);
  assert.equal(typed(), 1);
  assert.equal(core.spend.today().held, HOLD_USD);
  const r2 = await call('send_to_session', { session: 'web-ui', text: 'and the docs' });
  assert.ok(r2.card, r2.text);
  assert.equal(typed(), 1);
});
