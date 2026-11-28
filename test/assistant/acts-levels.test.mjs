// The answer of an act (read, alone, card, open) comes from seven facts by ONE function. The core's reference for it is
// pinned for every combination in acts/level-table.json (taken from the shared core with tia-core.lock.json): Hoprig's
// function must give the same answer for each of the 672 combinations, and for the one that changes when she is spoken to.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ANSWERS, NEVER_CLASSES, answerOf, levelFor } from '../../src/assistant/acts.mjs';

const TABLE = JSON.parse(fs.readFileSync(new URL('../../acts/level-table.json', import.meta.url), 'utf8'));
const factsOf = ([reads, own, undo, spends, seen, other, never]) => ({ reads, own, undo, spends, seen, other, never });

test('the table is the whole of it: 672 combinations of the seven facts, and the never classes are the core\'s', () => {
  assert.equal(TABLE.rows.length, 2 * 2 * 3 * 2 * 2 * 2 * 7);
  assert.equal(TABLE.rows.length, 672);
  assert.deepEqual(new Set(TABLE.rows.map((r) => r[6])), new Set(['none', ...Object.keys(NEVER_CLASSES)]));
  assert.deepEqual(new Set(TABLE.rows.map((r) => r[7])), new Set(ANSWERS));
});

test('answerOf gives the core\'s answer for every combination of the facts', () => {
  const wrong = TABLE.rows.filter((r) => answerOf(factsOf(r)) !== r[7]).map((r) => `${JSON.stringify(r.slice(0, 7))}: ${answerOf(factsOf(r))}, the core says ${r[7]}`);
  assert.deepEqual(wrong, []);
});

test('spoken changes only the combinations the table lists, and only to a card', () => {
  const differs = new Map(TABLE.spoken_differs.map((r) => [JSON.stringify(r.slice(0, 7)), r[7]]));
  assert.ok(differs.size >= 1);
  for (const r of TABLE.rows) {
    const key = JSON.stringify(r.slice(0, 7));
    const want = differs.has(key) ? differs.get(key) : r[7];
    assert.equal(answerOf(factsOf(r), { spoken: true }), want, key);
  }
  assert.ok([...differs.values()].every((a) => a === 'card'));
});

test('levelFor (the names L0, L1, L2, N the tools and the inventory use) is the same function under its old names', () => {
  const names = { read: 'L0', alone: 'L1', card: 'L2', open: 'N' };
  for (const r of TABLE.rows) assert.equal(levelFor(factsOf(r)), names[r[7]], JSON.stringify(r));
});
