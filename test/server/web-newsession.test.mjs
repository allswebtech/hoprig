// New session's part for the coding tool (web/newsession-tools.js): another tool's terminal asks first unless chosen
// otherwise. The popup itself: web-newsession-popup.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

const T = await import('../../web/newsession-tools.js');

test('another tool\'s terminal asks first; its own defaults are only an explicit choice', () => {
  assert.equal(T.terminalMode(''), 'ask', 'nothing chosen: it asks first');
  assert.equal(T.terminalMode('ask'), 'ask');
  assert.equal(T.terminalMode('bypassPermissions'), 'bypassPermissions');
  assert.equal(T.terminalMode('own'), null, 'only when chosen: the tool\'s own rules');
});
