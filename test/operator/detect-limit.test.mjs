import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLimit } from '../../src/operator/detect/limit.mjs';
import { NOW, agentWeeklyLimit, ago, calm, sessionLimitNoNext } from './fixtures/cases.mjs';

test('an agent stopped by a weekly limit is one item that offers the next provider', () => {
  const [it, ...rest] = detectLimit(agentWeeklyLimit, { now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(it.kind, 'limit');
  assert.equal(it.subject, 'session lane-build');
  assert.equal(it.recommended, 'switch');
  assert.ok(it.facts.some((f) => /agent a1b2c3 stopped at a usage limit 35 min ago/.test(f)), it.facts.join('|'));
  assert.ok(it.facts.some((f) => /resets at 2026-03-12 09:00 UTC/.test(f)), it.facts.join('|'));
  assert.deepEqual(it.target, { session: 'lane-build', to: 'plan-b', hook: false }, 'an agent\'s limit from no run record is not the hook\'s');
  assert.equal(it.since, new Date(NOW - 35 * 60_000).toISOString());
});

test('with no next provider the item offers only to look and to stop', () => {
  const [it] = detectLimit(sessionLimitNoNext, { now: NOW });
  assert.deepEqual(it.acts.map((a) => a.id), ['open', 'stop']);
  assert.equal(it.recommended, 'open');
  assert.equal(it.acts[0].href, '#/s/shop-fix');
});

test('nothing wrong gives nothing; a board without sessions (its source could not be read) gives nothing', () => {
  assert.deepEqual(detectLimit(calm, { now: NOW }), []);
  assert.deepEqual(detectLimit({ sessions: null }, { now: NOW }), []);
  assert.deepEqual(detectLimit({}, { now: NOW }), []);
});

test('the open act of a session says what it opens, as on every kind of item about a session', async () => {
  const { detectStuck } = await import('../../src/operator/detect/stuck.mjs');
  const { detectEnded } = await import('../../src/operator/detect/ended.mjs');
  const { session } = await import('./fixtures/cases.mjs');
  const items = [
    ...detectLimit({ sessions: [session({ name: 'a', limit: { at: ago(3) }, canSwitch: false })] }, { now: NOW }),
    ...detectStuck({ sessions: [session({ name: 'b', progressAt: ago(40) })] }, { now: NOW }),
    ...detectEnded({ sessions: [session({ name: 'c', state: 'ended', statusAt: ago(5) })] }, { now: NOW }),
  ];
  assert.equal(items.length, 3);
  for (const it of items) assert.equal(it.acts.find((x) => x.id === 'open').label, 'Open the session', it.kind);
});

test('a later stop at a limit is a new rev; only time going by is not', async () => {
  const { session } = await import('./fixtures/cases.mjs');
  const rev = (at, now = NOW) => detectLimit({ sessions: [session({ name: 'a', limit: { at, text: 'Usage limit reached' } })] }, { now })[0].rev;
  assert.notEqual(rev(ago(300)), rev(ago(2)));
  assert.equal(rev(ago(30)), rev(ago(30), NOW + 10 * 60_000));
});
