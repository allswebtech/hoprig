// Why is it slow: the cause of slow work from what the router already measured (no request of its own), through look.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { slowCause } from '../../src/assistant/slowcause.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const P = (name, extra = {}) => ({ name, label: name, kind: 'subscription', inUse: 0, limited: null, ...extra });

test('a provider with a slow median first byte is the cause, with its seconds', () => {
  const v = slowCause({ profiles: [P('main', { speed: { verdict: 'slow', seconds: 8.4 }, inUse: 2 }), P('spare', { speed: { verdict: 'fast', seconds: 1.2 } })] });
  assert.equal(v.cause, 'slow');
  assert.match(v.say, /main \(the first byte takes 8.4 s/);
  assert.deepEqual(v.answering.map((x) => x.provider), ['main', 'spare'], 'the one with sessions first');
  assert.ok(v.next);
});

test('refusals come first, then a limit, and what is not measured stays unknown', () => {
  assert.equal(slowCause({ profiles: [P('a', { speed: { verdict: 'refusing' } }), P('b', { speed: { verdict: 'slow', seconds: 9 } })] }).cause, 'refusing');
  const lim = slowCause({ profiles: [P('a', { limited: { until: 123, reason: 'five-hour' } }), P('b', { speed: { verdict: 'slow', seconds: 9 } })] });
  assert.equal(lim.cause, 'limit');
  assert.equal(lim.limited[0].until, 123);
  assert.equal(slowCause({ profiles: [P('a')] }).cause, 'unknown');
  assert.equal(slowCause({ profiles: [P('a', { speed: { verdict: 'fast', seconds: 1 } })] }).cause, 'fine');
  assert.equal(slowCause(null).cause, 'unknown');
});

test('look why-slow answers through her door with the cause, and asks nothing of a provider', async () => {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true, level: 'work' };
  s.profiles[0].speed = { verdict: 'slow', seconds: 7.5 };
  const ops = new FakeOps(s);
  const core = createAssistantCore({ ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }), jobs: new JobStore({ dir: null, now: Date.now }) });
  const r = await core.call('look', { facts: [{ id: 'why-slow' }] }, { conversation: 'c1' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /first byte takes 7.5 s/);
  assert.deepEqual(ops.calls, [], 'a read only: nothing was written or asked');
});
