// The Operator's board lists its sources by plain names a person reads: the computers part says "main computer",
// never "hub" (the source's id 'computers' keeps its name).
import assert from 'node:assert/strict';
import test from 'node:test';

const { SOURCES } = await import('../src/operator/board.mjs');

test('the board names the computers source "Computers of the main computer"', () => {
  const names = Object.fromEntries(SOURCES);
  assert.equal(names.computers, 'Computers of the main computer');
  for (const [, words] of SOURCES) assert.doesNotMatch(words, /\bhubs?\b/i, words);
});
