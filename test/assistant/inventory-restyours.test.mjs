// An act that is only partly hers has a `why` for the rest, which the docs' section reads in the middle of a sentence
// ("does it (the rest is yours: <why>)", tools/tia-acts-doc.mjs): it starts with a small letter there.
import assert from 'node:assert/strict';
import test from 'node:test';

const { loadInventory } = await import('../../src/assistant/acts.mjs');
const D = await import('../../tools/tia-acts-doc.mjs');

test('the rest of a partly-hers act reads on in the sentence, with a small first letter', () => {
  const partly = loadInventory().rows.filter((r) => r.hers && r.not);
  assert.ok(partly.length > 0, 'there are such rows');
  for (const r of partly) assert.match(r.why, /^[a-z]/, `${r.act}: "${r.why}"`);
  const text = D.section();
  assert.doesNotMatch(text, /the rest is yours: [A-Z]/, 'no capital after "the rest is yours:"');
  assert.match(text, /the rest is yours: what needs the administrator password stays yours to type on Setup\)/);
});

// The section speaks to the reader: its "why" texts and group words say "you" and "yours", never "he" or "his".
test('the section says you and yours to the reader, not he and his', () => {
  const text = D.section();
  const left = text.split('\n').filter((l) => /\b(he|him|his|himself)\b/i.test(l));
  assert.deepEqual(left, []);
  assert.match(text, /changes the main computer's login there\./, 'the move of another computer names the main computer');
});

// policy.mjs decideLevel: at Full an administrator command of run_command runs with no card (L1), at Off it is refused.
// So her command tool asks "when the facts say so", not "always", and the row says why.
test('run_command asks you when the facts say so, with the administrator rule beside it', () => {
  const row = loadInventory().rows.find((r) => r.act === 'POST /api/assistant/run');
  assert.equal(row.hers[0].card, 'maybe');
  const line = D.section().split('\n').find((l) => l.startsWith('| `POST /api/assistant/run` |'));
  assert.equal(line, '| `POST /api/assistant/run` | run_command | asks you when the facts say so (an administrator command runs with no card at Full and is refused at Off) |');
});
