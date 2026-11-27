// The line under the computer's tabs for Setup (where the doctor's checks are now) is true everywhere: a Fix stands only on a check that has one
// (web/health.js), and the demo's checks have none, so the line never promises "a Fix for each".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

class FakeNode {}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: () => ({ dataset: {}, style: {}, append() {}, setAttribute() {}, addEventListener() {} }), createElementNS: () => ({}), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };

const { PARTS } = await import('../../web/pc.js');
const health = fs.readFileSync(new URL('../../web/health.js', import.meta.url), 'utf8');

test('the line for Setup never promises a Fix on each check, and a check gets a Fix only where one can run', () => {
  const text = PARTS.find((p) => p.id === 'setup').text;
  assert.doesNotMatch(text, /Fix for each/);
  // What makes it true: a check gets a Fix button only when it has a fixId.
  assert.match(health, /if \(c\.fixId\) return btn\('small primary', \{ label: 'Fix'/);
  assert.equal(health.split("label: 'Fix'").length, 2, 'the one Fix button of the page');
});
