// The page's words for how soon a provider starts its answers (Providers page, a provider's row), and the New session
// popup's line when Auto mode is on but a new session starts elsewhere because Auto mode's provider is slow now.
import assert from 'node:assert/strict';
import test from 'node:test';

const { speedWords } = await import('../../web/lib.js');
const { autoSlowLine } = await import('../../web/newsession-words.js');

test('a provider\'s speed in plain words, nothing while it is not known', () => {
  assert.equal(speedWords({ verdict: 'fast', seconds: 2.2 }), 'Answers in about 2 seconds');
  assert.equal(speedWords({ verdict: 'fast', seconds: 0.4 }), 'Answers in about 1 second');
  assert.equal(speedWords({ verdict: 'slow', seconds: 9.1 }), 'Slow now: about 9 seconds to start an answer');
  assert.equal(speedWords({ verdict: 'refusing' }), 'Refusing now (too many requests)');
  assert.equal(speedWords(null), null);
});

test('the New session line names the provider the session starts on, only when Auto mode\'s is slow', () => {
  const profiles = [{ name: 'auto', label: 'Auto', virtual: true }, { name: 'sub', label: 'Claude account' }];
  assert.equal(autoSlowLine({ autoSlow: true, recommended: 'sub' }, profiles), 'Auto mode\'s provider is slow now; this session starts on Claude account.');
  assert.equal(autoSlowLine({ recommended: 'auto' }, profiles), null);
  assert.equal(autoSlowLine(null, profiles), null);
});
