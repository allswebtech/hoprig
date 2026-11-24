// The estimate (src/work/estimate.mjs): only from what was measured here, with its basis always said; fewer than two
// finished ones give no estimate; a duration below zero or over seven days does not count; a run past the longest
// one gets no new number.
import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_ESTIMATE, basisOf, clockText, durationText, etaOf, runKind, workKind } from '../../src/work/estimate.mjs';

const H = 3_600_000;
const M = 60_000;
const f = (kind, ms, day) => ({ kind, ms, endedAt: `2026-11-${String(day).padStart(2, '0')}T10:00:00.000Z` });

test('the range is shortest to longest of the finished ones of that kind, rounded to five minutes, with its count', () => {
  const list = [f('a', 5 * H + 31 * M, 1), f('a', 8 * H + 29 * M, 2), f('a', 6 * H, 3), f('a', 7 * H, 4), f('b', 1 * M, 5)];
  const b = basisOf('a', list);
  assert.equal(b.count, 4);
  assert.equal(b.shortestMs, 5 * H + 30 * M);
  assert.equal(b.longestMs, 8 * H + 30 * M);
  assert.equal(b.text, 'about 5 h 30 to 8 h 30, from 4 like it');
});

test('fewer than two finished ones: no estimate, and it says why', () => {
  assert.equal(basisOf('a', []).text, NO_ESTIMATE);
  assert.equal(basisOf('a', [f('a', H, 1)]).text, NO_ESTIMATE);
  assert.equal(basisOf('a', [f('a', H, 1)]).count, 1);
  assert.equal(etaOf(basisOf('a', [f('a', H, 1)]), Date.now(), Date.now()).text, NO_ESTIMATE);
});

test('a duration below zero or over seven days does not count; only the last ten count', () => {
  const list = [f('a', -5 * M, 1), f('a', 8 * 24 * H, 2), f('a', H, 3)];
  assert.equal(basisOf('a', list).count, 1, 'a clock set back and a lost end are left out');
  const many = Array.from({ length: 14 }, (_, i) => f('a', (i < 4 ? 10 : 1) * H, i + 1));
  const b = basisOf('a', many);
  assert.equal(b.count, 10);
  assert.equal(b.longestMs, H, 'the four oldest (ten hours) are past the last ten');
});

test('a running one: "done by about" in local time from its start; past the longest no new number', () => {
  const b = basisOf('a', [f('a', H, 1), f('a', 2 * H, 2)]);
  const start = Date.parse('2026-11-19T10:00:00Z');
  const e = etaOf(b, start, start + 30 * M, 'UTC');
  assert.equal(e.text, 'done by about 11:00 to 12:00');
  assert.equal(e.doneFrom, '2026-11-19T11:00:00.000Z');
  assert.equal(e.doneTo, '2026-11-19T12:00:00.000Z');
  assert.equal(etaOf(b, start, start + 30 * M, 'Asia/Kolkata').text, 'done by about 16:30 to 17:30', 'the same instant in another zone');
  const late = etaOf(b, start, start + 3 * H, 'UTC');
  assert.equal(late.text, 'longer than any like it (the longest took 2 h)');
  assert.equal(late.doneTo, null);
  const fut = etaOf(b, start + H, start, 'UTC');
  assert.equal(fut.text, 'done by about 11:00 to 12:00', 'a start in the future (clock set back) counts from now');
});

test('the kind of a run: its schedule, else its project and the kind of work its model and effort say', () => {
  assert.equal(workKind('opus', 'medium'), 'code');
  assert.equal(workKind('sonnet', 'low'), 'mechanical');
  assert.equal(workKind('opus', 'high'), 'unknown_cause');
  assert.equal(workKind(null, null), null);
  assert.equal(runKind({ schedule: 'nightly1', project: 'shop' }), 'schedule:nightly1');
  assert.equal(runKind({ schedule: null, project: 'shop', model: 'opus', effort: 'medium' }), 'project:shop:code');
  assert.equal(runKind({ schedule: null, project: 'shop', model: null, effort: null }), 'project:shop');
});

test('words: durations and clock times', () => {
  assert.equal(durationText(45 * M), '45 min');
  assert.equal(durationText(H), '1 h');
  assert.equal(durationText(5 * H + 5 * M), '5 h 05');
  assert.equal(clockText(Date.parse('2026-11-19T00:05:00Z'), 'UTC'), '00:05');
});

test('"longer than any like it" only past the real longest, and the done-by times are the measured ones', async () => {
  const { basisOf: b, etaOf: e } = await import('../../src/work/estimate.mjs');
  const MIN = 60_000;
  const fin = [{ kind: 'k', ms: 60 * MIN, endedAt: '2026-11-18T01:00:00Z' }, { kind: 'k', ms: 112 * MIN, endedAt: '2026-11-18T03:00:00Z' }];
  const basis = b('k', fin);
  assert.equal(basis.text, 'about 1 h to 1 h 50, from 2 like it', 'the words are rounded');
  const start = Date.parse('2026-11-19T08:00:00Z');
  const at111 = e(basis, start, start + 111 * MIN, 'UTC');
  assert.equal(at111.past, false, 'at 111 min the longest (112) is not passed yet');
  assert.equal(at111.doneTo, new Date(start + 112 * MIN).toISOString());
  const at113 = e(basis, start, start + 113 * MIN, 'UTC');
  assert.equal(at113.text, 'longer than any like it (the longest took 1 h 52)');
});
