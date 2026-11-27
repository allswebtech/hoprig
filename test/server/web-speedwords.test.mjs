// The page's words for how soon a provider starts its answers (Providers page, a provider's row).
import assert from 'node:assert/strict';
import test from 'node:test';

const { speedWords } = await import('../../web/lib.js');

test('a provider\'s speed in plain words, nothing while it is not known', () => {
  assert.equal(speedWords({ verdict: 'fast', seconds: 2.2 }), 'Answers in about 2 seconds');
  assert.equal(speedWords({ verdict: 'fast', seconds: 0.4 }), 'Answers in about 1 second');
  assert.equal(speedWords({ verdict: 'slow', seconds: 9.1 }), 'Slow now: about 9 seconds to start an answer');
  assert.equal(speedWords({ verdict: 'refusing' }), 'Refusing now (too many requests)');
  assert.equal(speedWords(null), null);
});
