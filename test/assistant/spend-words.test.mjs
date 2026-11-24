// The refusal when the daily cap is reached says what is counted in plain words: starts whose cost Hoprig cannot
// measure count $0.50 each until the day ends; and what he can do. Never "held for work under way".
import assert from 'node:assert/strict';
import test from 'node:test';
import { SpendLedger } from '../../src/assistant/spend.mjs';

test('the cap reached by unmeasured starts: what counts, until when, and what he can do', () => {
  const l = new SpendLedger({ file: null });
  for (let i = 0; i < 10; i++) assert.equal(l.take(5), null);
  const why = l.take(5);
  assert.equal(why, "today's daily limit for paid use of $5.00 is reached ($0.00 spent, and $5.00 counted for 10 starts, moves or messages of sessions on a provider billed by use whose cost Hoprig could not measure, $0.50 each until the day ends); raise the limit, or wait for tomorrow");
  assert.doesNotMatch(why, /under way/);
  assert.doesNotMatch(why, /\bacts?\b/, 'not a word he knows here');
});

test('one unmeasured start has one figure and no "each", in the words Settings → Tia uses', () => {
  const l = new SpendLedger({ file: null });
  assert.equal(l.take(0.9), null);
  const why = l.take(0.9);
  assert.equal(why, "today's daily limit for paid use of $0.90 has no room for another $0.50 ($0.50 of $0.90 used: $0.00 spent, and $0.50 counted for one start, move or message of a session on a provider billed by use whose cost Hoprig could not measure, $0.50 until the day ends); raise the limit, or wait for tomorrow");
  assert.doesNotMatch(why, /\beach\b|\bacts?\b/);
});

test('the cap reached by measured spending alone names no unmeasured starts', () => {
  const l = new SpendLedger({ file: null });
  l.spent(1.2, 'her own turn');
  const why = l.take(1);
  assert.equal(why, "today's daily limit for paid use of $1.00 is reached ($1.20 spent); raise the limit, or wait for tomorrow");
});

test('a cap with less than $0.50 of room is not called reached: it says how much of it is used', () => {
  const l = new SpendLedger({ file: null });
  l.spent(0.01, 'her own turn');
  const why = l.take(0.5);
  assert.equal(why, "today's daily limit for paid use of $0.50 has no room for another $0.50 ($0.01 of $0.50 used: $0.01 spent); raise the limit, or wait for tomorrow");
  assert.doesNotMatch(why, /reached/);
});
