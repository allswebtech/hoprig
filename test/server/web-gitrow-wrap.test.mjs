// Setup's Git and GitHub part: the reason it could not look (a computer that refuses this dashboard says what to do
// in it) wraps whole on a phone instead of being cut after a few words.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
test('Setup: the Git and GitHub reason it could not look wraps whole on a phone', () => {
  const src = fs.readFileSync(new URL('../../web/gitsetup.js', import.meta.url), 'utf8');
  assert.match(src, /h\('div\.row\.static\.git-row', h\('span\.row-sub', `Could not look: \$\{e\.message\}`\)\)/);
  assert.match(fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8'), /\.git-row \.row-title, \.git-row \.row-sub \{ white-space: normal; overflow-wrap: anywhere; \}/);
});
