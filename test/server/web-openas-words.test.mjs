// New session's More options names the way to open with the same words as Home's cards: "Terminal" (web/newsession-options.js
// summaryOf), the App being the plain start that needs no words.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.document = { createElement: () => ({}), createElementNS: () => ({}), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const { summaryOf } = await import('../../web/newsession-options.js');

test('the summary beside More options says only what is not the plain start, never "as a chat"', () => {
  assert.equal(summaryOf({ openAs: 'app', tool: 'claude' }), '', 'the plain start: nothing');
  assert.equal(summaryOf({ openAs: 'terminal', tool: 'claude' }), 'Terminal');
  assert.equal(summaryOf({ openAs: 'terminal', tool: 'opencode' }, [{ id: 'opencode', name: 'OpenCode' }]), 'Terminal · OpenCode');
  assert.equal(summaryOf({ openAs: 'app', tool: 'opencode' }, [{ id: 'opencode', name: 'OpenCode' }]), 'OpenCode');
  assert.doesNotMatch(summaryOf({ openAs: 'terminal', tool: 'claude' }), /as a chat/);
});
