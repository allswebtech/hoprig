// A start under Auto mode whose order has no subscription before its providers billed by use spends from the first
// request (the router serves it with that key), so the card's reason says that, never "when ... reaches its limit".
// The facts: order.first is the subscription the session starts on, null when none comes before the paid ones.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { decideLevel } from '../../src/assistant/policy.mjs';
import { byName } from '../../src/assistant/tools.mjs';
import { pick } from '../../src/router.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const start = (order) => decideLevel(byName.get('start_session'), { folder: '/home/owner/projects/api', account: 'auto', message: 'fix the test' },
  { session: null, mine: false, account: { name: 'auto', kind: 'auto', paid: true, label: null, allowed: true, order } }, { level: 'work', allowed: ['auto'] });

test('the router serves the first request of order [API key, Main] with the API key: the premise of the words below', () => {
  const profiles = [{ name: 'api', kind: 'api' }, { name: 'sub', kind: 'subscription' }];
  assert.equal(pick(['api', 'sub'], profiles, profiles[1], {}).next.name, 'api');
  assert.equal(pick(['sub', 'api'], profiles, profiles[1], {}).next.name, 'sub');
});

test('no subscription the session starts on: "Auto mode runs this session on API key first, which costs money"', () => {
  const d = start({ first: null, paid: ['API key', 'Spare key'] });
  assert.equal(d.level, 'L2');
  assert.equal(d.why, 'Auto mode runs this session on API key first, which costs money');
});

test('a subscription before every paid provider keeps the limit sentence', () => {
  assert.equal(start({ first: 'Main', paid: ['API key'] }).why, 'when Main reaches its limit, Auto mode may move this session to API key, which costs money');
});

test('an order of only a paid key, end to end: the card says the key runs it first', async () => {
  const s = baseState();
  s.assistant = { enabled: true, level: 'work', accounts: ['auto', 'sub', 'api'] };
  Object.assign(s.autoSwitch, { enabled: true, order: ['api'] });
  const now = Date.now;
  const core = createAssistantCore({ ops: new FakeOps(s), now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }) });
  const r = await core.call('start_session', { folder: '/home/owner/projects/api', account: 'auto', message: 'fix the test' }, { conversation: 'c1' });
  assert.ok(r.card, r.text);
  const lines = r.card.lines.join('\n');
  assert.match(lines, /^Why a card: Auto mode runs this session on API key first, which costs money$/m);
  assert.doesNotMatch(lines, /reaches its limit/);
});

const autoCard = async (order, change = () => {}) => {
  const s = baseState();
  s.assistant = { enabled: true, level: 'work', accounts: ['auto', 'sub', 'sub2', 'api'] };
  Object.assign(s.autoSwitch, { enabled: true, order });
  change(s);
  const now = Date.now;
  const core = createAssistantCore({ ops: new FakeOps(s), now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }) });
  const r = await core.call('start_session', { folder: '/home/owner/projects/api', account: 'auto', message: 'fix the test' }, { conversation: 'c1' });
  assert.ok(r.card, r.text);
  return r.card.lines.join('\n');
};

test('the paid key first and a subscription behind it, end to end: the card says the key runs it first', async () => {
  const lines = await autoCard(['api', 'sub']);
  assert.match(lines, /^Why a card: Auto mode runs this session on API key first, which costs money$/m);
  assert.doesNotMatch(lines, /reaches its limit/);
});

test('a subscription first, the paid key and another subscription behind it: the card keeps the limit sentence for the first', async () => {
  const lines = await autoCard(['sub2', 'api', 'sub']);
  assert.match(lines, /^Why a card: when Second reaches its limit, Auto mode may move this session to API key, which costs money$/m);
});

test('the router passes over a subscription at its limit: with only the paid key behind it, the card says the key runs it first', () => {
  const profiles = [{ name: 'sub', kind: 'subscription' }, { name: 'api', kind: 'api' }, { name: 'sub2', kind: 'subscription' }];
  const limited = { sub: { until: Date.now() + 3_600_000 } };
  assert.equal(pick(['sub', 'api', 'sub2'], profiles, profiles[2], limited).next.name, 'api');
});

test('a subscription at its limit before the paid key, end to end: the card does not name it', async () => {
  const lines = await autoCard(['sub', 'api', 'sub2'], (s) => { s.profiles[0].limited = { until: Date.now() + 3_600_000, exact: true, reason: 'limit', text: '' }; });
  assert.match(lines, /^Why a card: Auto mode runs this session on API key first, which costs money$/m);
  assert.doesNotMatch(lines, /reaches its limit/);
});

test('the first subscription at its limit and another before the paid key: the card names the one that serves', async () => {
  const lines = await autoCard(['sub', 'sub2', 'api'], (s) => { s.profiles[0].limited = { until: Date.now() + 3_600_000, exact: true, reason: 'limit', text: '' }; });
  assert.match(lines, /^Why a card: when Second reaches its limit, Auto mode may move this session to API key, which costs money$/m);
});
