// How much is left (src/providers/left.mjs): only what was measured. A pace line needs two readings of the same window
// at least 30 minutes apart within the last hour, and says its basis; the stops of the last day are counted from the
// board's sessions, held in memory; the advice comes only when more than half of them were limits.
import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetLeft, leftOf, noteStops } from '../../src/providers/left.mjs';

const NOW = Date.parse('2026-11-19T05:00:00Z');
const MIN = 60_000;
const use = (pct, minAgo, resetsAt = NOW + 3 * 3600_000) => ({ at: NOW - minAgo * MIN, fiveHour: { pct, resetsAt } });

test('a window is said with its reset and when it was reported', () => {
  forgetLeft();
  const l = leftOf('relay-a', use(12, 5), NOW);
  assert.deepEqual(l.windows.map((w) => w.line), ['the 5-hour limit: 12% used, resets at 08:00 UTC (reported by the provider at 04:55 UTC)']);
  assert.deepEqual(l.paces, []);
  assert.equal(l.stops.line, null);
  assert.equal(l.advice, null);
  assert.deepEqual(leftOf('none', null, NOW).windows, []);
  // A reset days away is said with its date: a time of day alone reads as today.
  const week = leftOf('relay-a', { at: NOW - MIN, week: { pct: 3.5, resetsAt: NOW + 4 * 24 * 3600_000 } }, NOW);
  assert.equal(week.windows[0].line, 'the weekly limit: 3.5% used, resets at 2026-11-23 05:00 UTC (reported by the provider at 04:59 UTC)');
});

test('the pace needs two readings at least 30 minutes apart within the last hour, and names its basis', () => {
  forgetLeft();
  // The window resets in 5 hours: after the 3 hours this pace leaves it.
  const later = NOW + 5 * 3600_000;
  leftOf('relay-a', use(12, 50, later), NOW);
  // 20 minutes later: not yet 30 apart.
  assert.deepEqual(leftOf('relay-a', use(20, 30, later), NOW).paces, []);
  const l = leftOf('relay-a', use(30, 2, later), NOW);
  assert.equal(l.paces.length, 1);
  assert.equal(l.paces[0].basis, 'from 12% to 30% used in 48 minutes');
  assert.match(l.paces[0].line, /^At the pace of the last hour the 5-hour limit is used up in about 3 hours \(from 12% to 30% used in 48 minutes\)\.$/);
});

test('a fast pace says "in less than an hour", and a window that resets first is not used up', () => {
  forgetLeft();
  leftOf('relay-a', use(40, 45), NOW);
  assert.equal(leftOf('relay-a', use(80, 0), NOW).paces[0].line, 'At the pace of the last hour the 5-hour limit is used up in less than an hour (from 40% to 80% used in 45 minutes).');
  forgetLeft();
  const soon = NOW + 30 * MIN;
  leftOf('relay-a', use(20, 40, soon), NOW);
  const l = leftOf('relay-a', use(30, 0, soon), NOW);
  assert.equal(l.paces[0].line, 'At the pace of the last hour the 5-hour limit is not used up before it resets at 05:30 UTC (from 20% to 30% used in 40 minutes).');
  assert.equal(l.paces[0].hours, null);
});

test('no pace from a reading older than an hour, from a falling use, or from another window', () => {
  forgetLeft();
  leftOf('relay-a', use(10, 90), NOW);
  assert.deepEqual(leftOf('relay-a', use(40, 1), NOW).paces, [], 'the first reading is older than the last hour');
  forgetLeft();
  leftOf('relay-a', use(50, 45), NOW);
  assert.deepEqual(leftOf('relay-a', use(5, 1, NOW + 5 * 3600_000), NOW).paces, [], 'a new window after a reset');
  forgetLeft();
  leftOf('relay-a', use(30, 45), NOW);
  assert.deepEqual(leftOf('relay-a', use(30, 1), NOW).paces, [], 'nothing used: no pace');
});

test("the day's stops are counted once each, and the advice comes when more than half were limits", () => {
  forgetLeft();
  const at = (m) => new Date(NOW - m * MIN).toISOString();
  const board = [
    { name: 'shop', provider: 'relay-a', limit: { at: at(30) }, agents: [{ id: 'a1', stop: { at: at(20), reason: 'limit' } }] },
    { name: 'blog', provider: 'relay-a', stop: { at: at(10), reason: 'model' }, agents: [] },
    { name: 'old', provider: 'relay-a', stop: { at: at(25 * 60), reason: 'model' }, agents: [] },
  ];
  noteStops(board, NOW);
  noteStops(board, NOW); // the same stops on the next look
  const l = leftOf('relay-a', null, NOW);
  assert.equal(l.stops.day, 3);
  assert.equal(l.stops.limits, 2);
  assert.match(l.stops.line, /^It stopped the work 3 times in the last day, 2 of them at a usage limit/);
  assert.equal(l.advice, 'Another account would have avoided 2 stops: more than half of the day\'s stops were limits.');
  forgetLeft();
  noteStops([board[1], { name: 'x', provider: 'relay-a', limit: { at: at(5) }, agents: [] }], NOW);
  assert.equal(leftOf('relay-a', null, NOW).advice, null, 'half is not more than half');
});
