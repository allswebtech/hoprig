// What nobody can explain: a run that failed for a reason no check knows, a task whose runs failed twice, a mission's
// check that failed the same way after a fix. Recorded cases in fixtures/cases.mjs, made-up names only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectUnknown, explained } from '../../src/operator/detect/unknown.mjs';
import { attention } from '../../src/operator/attention.mjs';
import { NOW, ago, calm, checkSameAfterFix, failedKnown, failedOddReason, failedTwice, run } from './fixtures/cases.mjs';

test('a run that failed for a reason no check knows is an item of the kind unknown', () => {
  const [it, ...rest] = detectUnknown(failedOddReason, { now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(it.kind, 'unknown');
  assert.equal(it.class, 'stopped');
  assert.equal(it.subject, 'Work run 20260310-133000-a1b2c3d4');
  assert.ok(it.facts.some((f) => /TypeError/.test(f)), it.facts.join('|'));
  assert.deepEqual(it.target, { case: 'reason', run: '20260310-133000-a1b2c3d4', item: 'fix-cart', project: 'shop' });
  // it is on the attention list too
  assert.ok(attention(failedOddReason, { now: NOW }).items.some((i) => i.kind === 'unknown'));
});

test('one card per failed run: a run the kind unknown reports is not also an ended card; a run with a known reason stays one', () => {
  const runs = [1, 2, 3, 4, 5].map((i) => run({ id: `20260310-13300${i}-a1b2c3d${i}`, item: `cart-${i}`, reason: `TypeError: Cannot read properties of undefined (${i})` }));
  const items = attention({ work: { runs, checks: [] } }, { now: NOW }).items.filter((i) => /^Work run /.test(i.subject) || /^task /.test(i.subject));
  assert.equal(items.length, 5, items.map((i) => `${i.kind} ${i.subject}`).join('|'));
  assert.ok(items.every((i) => i.kind === 'unknown'));
  const twice = attention(failedTwice, { now: NOW }).items;
  assert.equal(twice.filter((i) => i.kind === 'ended').length, 0, 'neither run of a task that failed twice is an ended card too');
  const known = attention(failedKnown, { now: NOW }).items;
  assert.ok(known.some((i) => i.kind === 'ended'), 'a failed run whose reason is known keeps its ended card');
});

test('a task whose runs ended in an error twice is one item, not two', () => {
  const items = detectUnknown(failedTwice, { now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].subject, 'task fix-cart');
  assert.equal(items[0].target.case, 'twice');
  assert.equal(items[0].target.run, '20260310-134000-0000beef', 'the newest run is the one looked into');
});

test('a mission\'s check that failed the same way after a fix is an item', () => {
  const [it] = detectUnknown(checkSameAfterFix, { now: NOW });
  assert.equal(it.subject, 'check of task cart-total in mission m-20260310-abc123');
  assert.equal(it.target.case, 'check');
  assert.deepEqual(it.target.words, ['npm test failed: cart.test.mjs total is 0']);
});

test('what is explained already (a limit, a sign-in, the time limit, the restricted mode) and a look\'s own run are no item', () => {
  assert.deepEqual(detectUnknown(failedKnown, { now: NOW }), []);
  assert.equal(explained('The provider reached its usage limit'), true);
  assert.equal(explained('TypeError: x is undefined'), false);
});

test('a stack trace that names billing, credit or a sign-in after the reason\'s start still leaves the run unknown', () => {
  const reason = 'The run ended in an error: TypeError: Cannot read properties of undefined (reading qty) at total (src/cart.mjs:3) at pay (src/billing.mjs:10)';
  assert.ok(reason.length > 80 && reason.indexOf('billing') > 80);
  assert.equal(explained(reason), false);
  const items = detectUnknown({ work: { runs: [run({ reason })] } }, { now: NOW });
  assert.equal(items.length, 1, 'the failed run is an unknown item');
  assert.equal(items[0].target.case, 'reason');
  // a known reason at the start stays explained, however long the rest
  assert.equal(explained(`The provider reached its usage limit ${'x'.repeat(200)}`), true);
});

test('what failed more than a day ago, or no source: nothing', () => {
  assert.deepEqual(detectUnknown({ work: { runs: [run({ endedAt: ago(25 * 60) })] } }, { now: NOW }), []);
  assert.deepEqual(detectUnknown(calm, { now: NOW }), []);
  assert.deepEqual(detectUnknown({ work: null }, { now: NOW }), []);
});
