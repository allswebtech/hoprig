// The offline line of a computer ("Cannot be reached · open it to see what to check") is whole at 390 px: it wraps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('an offline row lets its line wrap', () => {
  const css = fs.readFileSync(new URL('../../web/page-computers.css', import.meta.url), 'utf8');
  assert.match(css, /\.cp-row\.cp-off \.row-sub \{ white-space: normal; overflow-wrap: anywhere; \}/);
  assert.match(fs.readFileSync(new URL('../../web/computers.js', import.meta.url), 'utf8'), /h\(`div\.row\.cp-row\.cp-rowwrap\$\{l\.online \? '' : '\.cp-off'\}`/);
});
