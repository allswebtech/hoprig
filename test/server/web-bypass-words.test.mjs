// The bypass switch says beside its name what it means for him: the session never asks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('"Allow bypass permissions mode" has "(it never asks you)" beside it', () => {
  const s = fs.readFileSync(new URL('../../web/sessiondefaults.js', import.meta.url), 'utf8');
  assert.match(s, /h\('label\.toggle-line', box, h\('span', 'Allow bypass permissions mode ', h\('span\.muted', '\(it never asks you\)'\)\)\)/);
});
