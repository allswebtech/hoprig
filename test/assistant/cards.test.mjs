import assert from 'node:assert/strict';
import test from 'node:test';
import { CARD_TTL_MS, CardError, CardStore, stateHash } from '../../src/assistant/cards.mjs';

const clock = (t = 1_000_000) => {
  const f = () => f.t;
  f.t = t;
  return f;
};
const code = (fn, c) => assert.throws(fn, (e) => e instanceof CardError && e.code === c);

test('stateHash ignores key order and sees every value', () => {
  assert.equal(stateHash({ a: 1, b: [1, { c: 2, d: 3 }] }), stateHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notEqual(stateHash({ a: 1 }), stateHash({ a: 2 }));
});

test('a staged card runs once, only with the same before-state', () => {
  const s = new CardStore({ now: clock() });
  const c = s.stage({ tool: 'stop_session', input: { session: 'x' }, lines: ['Stop x'], before: { id: 1 } });
  assert.equal(c.status, 'pending');
  assert.equal(s.pending().length, 1);
  const taken = s.take(c.id, { id: 1 });
  assert.equal(taken.status, 'running');
  code(() => s.take(c.id, { id: 1 }), 'used');
  assert.equal(s.finish(c.id, { ok: true }).status, 'done');
  code(() => s.take(c.id, { id: 1 }), 'used');
});

test('a changed before-state makes the card stale for good', () => {
  const s = new CardStore({ now: clock() });
  const c = s.stage({ tool: 't', input: {}, lines: [], before: { profile: 'sub' } });
  code(() => s.take(c.id, { profile: 'api' }), 'stale');
  code(() => s.take(c.id, { profile: 'sub' }), 'used');
  assert.equal(s.get(c.id).status, 'stale');
});

test('cards expire after 10 minutes', () => {
  const now = clock();
  const s = new CardStore({ now });
  const c = s.stage({ tool: 't', input: {}, lines: [], before: {} });
  assert.equal(c.expiresAt - c.createdAt, CARD_TTL_MS);
  now.t += CARD_TTL_MS - 1;
  assert.equal(s.get(c.id).status, 'pending');
  now.t += 1;
  code(() => s.take(c.id, {}), 'expired');
  assert.equal(s.pending().length, 0);
});

test('declined and unknown cards never run', () => {
  const s = new CardStore({ now: clock() });
  const c = s.stage({ tool: 't', input: {}, lines: [], before: {} });
  assert.equal(s.reject(c.id).status, 'rejected');
  code(() => s.take(c.id, {}), 'rejected');
  code(() => s.reject(c.id), 'used');
  code(() => s.take('c_nope', {}), 'unknown');
  const d = s.stage({ tool: 't', input: {}, lines: [], before: {} });
  assert.equal(s.markStale(d.id).status, 'stale');
  code(() => s.take(d.id, {}), 'used');
});

test('the public card carries no before-state, only a short hash', () => {
  const s = new CardStore({ now: clock() });
  const c = s.stage({ tool: 't', input: {}, lines: [], before: { secretish: 'value' } });
  assert.ok(!JSON.stringify(c).includes('value'));
  assert.equal(c.beforeHash.length, 12);
});
