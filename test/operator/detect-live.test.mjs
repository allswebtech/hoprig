import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLive } from '../../src/operator/detect/live.mjs';
import { NOW, ago } from './fixtures/cases.mjs';

test('the public link answering 530 after a restart: restart it, with since when', () => {
  const [it, ...rest] = detectLive({ live: { local: { status: 200 }, link: { on: true, status: 530, since: ago(18), checkedAt: ago(1) } } }, { now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(it.subject, 'the public link');
  assert.deepEqual(it.facts, ['the public link answers 530', 'like this for 18 min', 'checked at 13:59 UTC']);
  assert.equal(it.recommended, 'restart-link');
});

test('the login page that does not answer at all', () => {
  const [it] = detectLive({ live: { local: { status: 0, since: ago(3) } } }, { now: NOW });
  assert.equal(it.subject, 'the login page');
  assert.equal(it.facts[0], 'the login page does not answer');
});

test('both answering 200, a link that is off, or no source: nothing', () => {
  assert.deepEqual(detectLive({ live: { local: { status: 200 }, link: { on: true, status: 200 } } }, { now: NOW }), []);
  assert.deepEqual(detectLive({ live: { link: { on: false, status: 0 } } }, { now: NOW }), []);
  assert.deepEqual(detectLive({ live: null }, { now: NOW }), []);
});
