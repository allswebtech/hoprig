// A computer that no longer lets this dashboard in: the page gets the code computer-not-allowed beside the error,
// so it can add one button to the Computers page (web/errorways.js), and the sentence names a page that exists.
import assert from 'node:assert/strict';
import test from 'node:test';

const { classifyRefusal, errorBody } = await import('../../src/machines/relay.mjs');

test('a revoked token answers 403 with the code computer-not-allowed and names the Computers page', () => {
  const e = classifyRefusal('box', 401, { code: 'token' });
  const { status, body } = errorBody('box', e);
  assert.equal(status, 403);
  assert.equal(body.code, 'computer-not-allowed');
  assert.equal(body.machine, 'box');
  assert.equal(body.error, 'box no longer lets this dashboard in. Add it again here: Computers → Add a computer.');
  assert.doesNotMatch(body.error, /on that computer\'s/, 'the step is here, on this dashboard');
  assert.doesNotMatch(body.error, /Settings → Computers/);
});
