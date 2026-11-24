// The list prices used only for estimates (src/operator/prices.mjs): a price that is not known gives no figure.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PRICES, estimate, familyOf } from '../../src/operator/prices.mjs';

test('an estimate is tokens times the list price per million; an unknown price gives no figure and says which', () => {
  assert.equal(familyOf('claude-opus-5-5'), 'opus');
  assert.equal(familyOf('haiku'), 'haiku');
  assert.equal(familyOf('gpt-x'), null);
  assert.deepEqual(estimate('opus', { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 0 }), { usd: 6.2, unknown: [] });
  assert.deepEqual(estimate('haiku', { input: 10, output: 0, cacheRead: 5, cacheWrite: 0 }), { usd: null, unknown: ['cacheRead'] });
  assert.equal(estimate('haiku', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }).usd, 0.1);
  assert.equal(PRICES.opus.cacheWrite, PRICES.opus.input * 1.25, 'a 5-minute cache write is 1.25 times the input price');
  assert.deepEqual(estimate('gpt', { input: 1 }), { usd: null, unknown: ['model'] });
});
