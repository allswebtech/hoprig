import assert from 'node:assert/strict';
import test from 'node:test';
import { detectAsks } from '../../src/operator/detect/asks.mjs';
import { NOW, agentUnansweredOk, ago, calm, mainQuestion, session } from './fixtures/cases.mjs';

test('an agent hung 52 minutes on an unanswered OK is one item that leads to the session', () => {
  const [it, ...rest] = detectAsks(agentUnansweredOk, { now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(it.kind, 'asks');
  assert.equal(it.class, 'waits');
  assert.ok(it.facts.includes('agent f00d1e waits for your OK'), it.facts.join('|'));
  assert.ok(it.facts.includes('waiting for 52 min'), it.facts.join('|'));
  assert.deepEqual(it.acts.map((a) => a.id), ['open']);
  assert.equal(it.acts[0].label, 'Open the session');
  assert.equal(it.acts[0].href, '#/s/review');
});

test('a question of the session itself', () => {
  const [it] = detectAsks(mainQuestion, { now: NOW });
  assert.ok(it.facts.includes('the session waits for your answer to its question'), it.facts.join('|'));
  assert.ok(it.facts.includes('waiting for 4 min'));
  assert.ok(!it.facts.some((f) => /holds up/.test(f)));
});

test('nothing waits, or no source: nothing', () => {
  assert.deepEqual(detectAsks(calm, { now: NOW }), []);
  assert.deepEqual(detectAsks({ sessions: null }, { now: NOW }), []);
});

test('the next question of the same session is a new rev; only time going by is not', () => {
  const rev = (askAt, now = NOW) => detectAsks({ sessions: [session({ name: 'docs', state: 'attention', asks: ['main'], askType: 'permission', askAt })] }, { now })[0].rev;
  assert.notEqual(rev(ago(52)), rev(ago(0)), 'a new OK');
  assert.equal(rev(ago(52)), rev(ago(52), NOW + 10 * 60_000));
});

test('an ask whose asker is not known is not said to be an agent that holds up work', () => {
  const [it] = detectAsks({ sessions: [session({ name: 'work', state: 'attention', asks: ['?'], askAt: ago(1) })] }, { now: NOW });
  assert.ok(it.facts.includes('someone in it waits for your answer'), it.facts.join('|'));
  assert.ok(!it.facts.some((f) => /agent/.test(f)), it.facts.join('|'));
  const [agent] = detectAsks({ sessions: [session({ name: 'work', state: 'attention', asks: ['a1b2c3'], askAt: ago(1) })] }, { now: NOW });
  assert.ok(agent.facts.includes('an agent that waits holds up the work that started it'), agent.facts.join('|'));
});
