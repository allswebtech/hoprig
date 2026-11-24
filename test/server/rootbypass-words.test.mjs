// The refusal of bypass as root names the dashboard's own place first (Settings → Runs as root, the page that moves
// Hoprig to an ordinary user and asks once before it changes anything), and the terminal command only after it.
import assert from 'node:assert/strict';
import test from 'node:test';

const { ROOT_BYPASS_LINE } = await import('../../src/bypassgate.mjs');
const { CLAUDE_ROOT_REFUSAL } = await import('../../src/setup/rootfacts.mjs');

test('the root bypass line sends him to Settings → Runs as root, with the command for a terminal after it', () => {
  assert.ok(ROOT_BYPASS_LINE.includes(CLAUDE_ROOT_REFUSAL), 'the coding tool\'s own words stay');
  const place = ROOT_BYPASS_LINE.indexOf('Settings → Runs as root');
  assert.ok(place > 0, 'the settings page is named');
  assert.ok(ROOT_BYPASS_LINE.indexOf('hoprig move-to-user') > place, 'the terminal command comes after the page');
  assert.match(ROOT_BYPASS_LINE, /Start in a mode that asks/);
});
