// Rule 7 at run time (src/assistant/answercheck.mjs): a figure in her answer that no tool gave makes the page show
// the progress lines only. The Hinglish case is the one an eval run saw: she worked out "0 se 40 minute baaki".
import assert from 'node:assert/strict';
import test from 'node:test';
import { progressState, PROGRESS_NOW } from './fake-work.mjs';

const { foreignFigures, progressAnswer } = await import('../../src/assistant/answercheck.mjs');
const { progress, progressLines } = await import('../../src/work/pulse.mjs');

const p = progress({ ...progressState(PROGRESS_NOW), items: [], now: PROGRESS_NOW, tz: 'UTC' });
const lines = progressLines(p);
const cart = p.running.find((u) => u.item === 'fix-the-cart-total');

test('the Hinglish answer that worked out "0 se 40 minute baaki" by itself shows the lines only', () => {
  const said = [{ i: 7, text: 'Cart fix mein abhi 0 se 40 minute baaki hain, nightly tidy ka koi estimate nahi.' }];
  const a = progressAnswer({ texts: said, results: [lines.join('\n')], lines });
  assert.equal(a.replaced, true);
  assert.deepEqual(a.hides, [7]);
  assert.ok(a.foreign.includes('40'), a.foreign.join());
  assert.deepEqual(a.lines, lines, 'the lines are the tool\'s, as it gave them');
});

test('an answer with only the tool\'s figures keeps her words above the lines', () => {
  const from = new Date(cart.eta.doneFrom).toISOString().slice(11, 16);
  const to = new Date(cart.eta.doneTo).toISOString().slice(11, 16);
  const said = [{ i: 3, text: `Cart fix ${from} se ${to} tak ho jayega (${cart.basis.count} jaise kaam se).` }];
  const a = progressAnswer({ texts: said, results: [lines.join('\n')], lines });
  assert.equal(a.replaced, false, a.foreign.join());
  assert.deepEqual(a.hides, []);
});

test('a time the tool gave counts in its 12-hour form too; a figure of another tool she read counts', () => {
  assert.deepEqual(foreignFigures('done by 11:40', ['done by about 23:40']), []);
  assert.deepEqual(foreignFigures('3 sessions, 1,200 tokens', ['Sessions: 3', 'used 1200 tokens']), []);
  assert.deepEqual(foreignFigures('about 45 minutes left', ['about 1 h to 2 h']), ['45']);
});
