// New session: a start that fails with a code (a provider that does not serve the coding tool) shows, in the
// popup's status line, the server's words and the button to the place (web/errorways.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('the popup passes the error to its status line, which adds the way of its code', () => {
  const src = fs.readFileSync(new URL('../../web/newsession-popup.js', import.meta.url), 'utf8');
  assert.match(src, /if \(alive\) say\(e\.message, true, e\);/);
  assert.match(src, /const way = err \? wayLink\(err\) : null;\s*fill\(status, text \|\| '', way \? \[' ', way\] : null\);/);
  // A provider that does not serve the tool is refused with that code (src/profiles.mjs assertServes).
  assert.match(fs.readFileSync(new URL('../../src/profiles.mjs', import.meta.url), 'utf8'), /details: \{ code: 'provider-not-served' \}/);
});
