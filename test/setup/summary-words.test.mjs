// The end of `hoprig setup --hub`: the join line is for each of your computers, in plain words (no PC, no hub).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('words: the main computer summary says each of your computers', () => {
  const src = fs.readFileSync(new URL('../../src/setup/setup.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Connect each PC|on the hub run|then on the PC/);
  assert.equal((src.match(/Connect each of your computers to it/g) || []).length, 2);
});
