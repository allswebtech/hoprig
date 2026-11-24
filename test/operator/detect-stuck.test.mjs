import assert from 'node:assert/strict';
import test from 'node:test';
import { detectStuck } from '../../src/operator/detect/stuck.mjs';
import { NOW, agentUnansweredOk, agentWeeklyLimit, ago, calm, neverEndingWait, session } from './fixtures/cases.mjs';

test('a waiting loop that can never end shows as stuck, named by its tool, without its command', () => {
  const [it, ...rest] = detectStuck(neverEndingWait, { now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(it.subject, 'session fixer');
  assert.equal(it.class, 'stopped');
  assert.ok(it.facts.includes('working, with no progress for 40 min'), it.facts.join('|'));
  assert.ok(it.facts.includes('one Bash call has run for 40 min'), it.facts.join('|'));
  assert.equal(it.recommended, 'open');
  assert.equal(it.acts[0].href, '#/s/fixer');
});

test('20 minutes is the default; a shorter quiet is not stuck; the limit can be set', () => {
  const b = { sessions: [session({ name: 'slow', progressAt: ago(19) })] };
  assert.deepEqual(detectStuck(b, { now: NOW }), []);
  assert.equal(detectStuck({ sessions: [session({ name: 'slow', progressAt: ago(21) })] }, { now: NOW }).length, 1);
  assert.equal(detectStuck(b, { now: NOW, stuckMs: 10 * 60_000 }).length, 1);
});

test('a session waiting at a limit or for an answer is not called stuck (it has its own item)', () => {
  assert.deepEqual(detectStuck(agentUnansweredOk, { now: NOW }), []);
  const lim = { sessions: [session({ name: 'x', progressAt: ago(50), limit: { at: ago(50) } })] };
  assert.deepEqual(detectStuck(lim, { now: NOW }), []);
  assert.deepEqual(detectStuck(agentWeeklyLimit, { now: NOW }), []);
});

test('nothing wrong, or no source, gives nothing', () => {
  assert.deepEqual(detectStuck(calm, { now: NOW }), []);
  assert.deepEqual(detectStuck({ sessions: null }, { now: NOW }), []);
});

test('a session whose background tasks are quiet too says that they run, so it is not stopped by mistake', () => {
  const [it] = detectStuck({ sessions: [session({ name: 'lane', progressAt: ago(30), background: 2 })] }, { now: NOW });
  assert.ok(it.facts.includes('2 background tasks run, quiet too'), it.facts.join('|'));
});
