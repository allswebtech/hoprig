// Settings → Tia's help texts for "How far she may go" and the daily spending cap say what the Operator does at Hands
// off and what counts against the cap, word for word as written for them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HELP } from '../../src/assistant/tia.mjs';

test('"Hands off" in the level text says the cap and the Operator\'s part', () => {
  assert.ok(HELP.level.includes('"Hands off" — as "Do the work", and she may also use the paid API providers you allowed without asking, within the daily limit for paid use (none at first, so each of those still asks you); only at this level, and within the same limit, do her limit rule and "Tia decides" move a session onto such a provider, type into a session on one, or think on one.'), HELP.level);
});

test('the Hands off text begins with the cap and the Operator, and keeps its Work sentence', () => {
  assert.ok(HELP.levelHandsoff.startsWith('As "Do the work", and she may also start or move sessions on the paid API providers you allowed, without asking, within the daily limit for paid use (none at first: then each of those asks you). Only at this level, and within the same limit, do her limit rule and "Tia decides" move a session onto such a provider, type into a session on one, or think on one; each counts against the limit. '), HELP.levelHandsoff);
  assert.match(HELP.levelHandsoff, /On the Work page she always asks you first, at every level/);
});

test('the limit text says what the Operator counts, and what an empty cap means for both', () => {
  assert.ok(HELP.dailyCapUsd.includes('What you confirm on a card counts too. The Operator counts here too: a move of a session or a mission\'s task onto such a provider by the limit rule or "Tia decides", and a nudge or an answer typed into a session on one, count $0.50 each; a call of "Tia decides" or a look there holds $0.50 and then counts what it reported (a look that reported nothing counts its whole budget). Your own tap on "Continue on the next provider" is not counted.'), HELP.dailyCapUsd);
  assert.ok(HELP.dailyCapUsd.includes('Empty: no limit, so each of those asks you first or is left to you, and neither she nor the Operator thinks on such a provider at all.'), HELP.dailyCapUsd);
});

test('one name for the cap in what he reads: "daily limit for paid use", never "spending cap"', () => {
  for (const k of ['level', 'levelHandsoff', 'dailyCapUsd']) assert.doesNotMatch(HELP[k], /spending cap|no cap\b|the same cap|against the cap/, k);
});
