// The Health part's line under the computer's tabs is true everywhere: a Fix stands only on a check that has one
// (web/health.js), and the demo's checks have none, so the line never promises "a Fix for each".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

class FakeNode {}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: () => ({ dataset: {}, style: {}, append() {}, setAttribute() {}, addEventListener() {} }), createElementNS: () => ({}), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { PARTS } = await import('../../web/pc.js');
const health = fs.readFileSync(new URL('../../web/health.js', import.meta.url), 'utf8');

test('Health\'s line says a Fix stands where one can run, not on each check', () => {
  const text = PARTS.find((p) => p.id === 'health').text;
  assert.doesNotMatch(text, /Fix for each/);
  assert.match(text, /Fix where one can run/);
  // What makes it true: a check gets a Fix button only when it has a fixId.
  assert.match(health, /c\.fixId \? btn\('small primary', \{ label: 'Fix'/);
});
