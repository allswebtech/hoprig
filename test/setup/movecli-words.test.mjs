// The help of `hoprig move-to-user` (src/setup/movecli.mjs MOVE_USAGE) says "main computer" where it means the
// computer that runs the other computers' moves, as every joining and set-up sentence does (the --hub flag and code
// names keep "hub"; test/machines/main-computer-words.test.mjs holds the same rule for the other files).
import assert from 'node:assert/strict';
import test from 'node:test';

const { MOVE_USAGE } = await import('../../src/setup/movecli.mjs');

test('the move help says the main computer passes --new, never the hub', () => {
  assert.doesNotMatch(MOVE_USAGE.replace(/--hub\b/g, '--'), /\bhubs?\b/i, 'no "hub" in a sentence of the help');
  assert.match(MOVE_USAGE, /\(the main computer passes it when its look said the move makes the user\)/);
});
