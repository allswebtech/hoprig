// The monthly kind of a schedule (and of a repeating item: src/work/repeat.mjs uses runsOn, nextDay and dayAtOrBefore):
// a day of the month, in a shorter month its last day. Local time in a zone with summer time (US Eastern: clocks go
// forward on 2026-03-08 at 02:00 and back on 2026-11-01 at 02:00).
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import test from 'node:test';
import * as sch from '../../src/automation/schedules.mjs';
import { cleanSchedule, cleanWhen } from '../../src/automation/settings.mjs';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const make = (when) => ({ id: 'mon1', enabled: true, when, action: { type: 'start', dir: '/w', profile: 'sub' }, since: 0 });
const local = (ms) => new Date(ms).toString().slice(0, 21);

/** Tick every `stepMs` from `from` to `to`: the slots that ran, as local strings. */
function run(schedule, from, to, stepMs, data = {}) {
  const ran = [];
  schedule = { ...schedule, since: from - 1 };
  for (let t = from; t <= to; t += stepMs) {
    const r = sch.decide({ schedules: [schedule], lateHours: 2, data, now: t });
    data = r.data;
    for (const a of r.actions) if (a.type === 'run') ran.push(local(a.slot));
  }
  return { ran, data };
}

test('monthly on the 31st: the last day of every shorter month, February in a leap year too', () => {
  const s = make({ kind: 'monthly', time: '09:00', day: 31 });
  const { ran } = run(s, at(2028, 1, 1), at(2028, 5, 1), 30 * 60_000);
  assert.deepEqual(ran, ['Mon Jan 31 2028 09:00', 'Tue Feb 29 2028 09:00', 'Fri Mar 31 2028 09:00', 'Sun Apr 30 2028 09:00']);
  assert.equal(sch.nextSlot(s.when, at(2027, 2, 1)), at(2027, 2, 28, 9), 'February of a common year: the 28th');
  assert.equal(sch.nextSlot({ kind: 'monthly', time: '09:00', day: 30 }, at(2028, 2, 1)), at(2028, 2, 29, 9));
  assert.equal(sch.nextSlot({ kind: 'monthly', time: '09:00', day: 15 }, at(2026, 6, 15, 9, 1)), at(2026, 7, 15, 9), 'past this month\'s: next month');
});

test('monthly: from the 31st to the 30th across a month change, once each', () => {
  const s = make({ kind: 'monthly', time: '23:30', day: 31 });
  const { ran } = run(s, at(2026, 8, 31, 23, 0), at(2026, 9, 30, 23, 59), 15 * 60_000);
  assert.deepEqual(ran, ['Mon Aug 31 2026 23:30', 'Wed Sep 30 2026 23:30']);
});

test('monthly across both clock changes: a time in the skipped hour runs after the jump; a doubled hour runs once', () => {
  const spring = run(make({ kind: 'monthly', time: '02:30', day: 8 }), at(2026, 3, 7), at(2026, 3, 9), 5 * 60_000).ran;
  assert.deepEqual(spring, ['Sun Mar 08 2026 03:30']);
  const fall = run(make({ kind: 'monthly', time: '01:30', day: 1 }), at(2026, 10, 31, 22), at(2026, 11, 1, 6), 5 * 60_000).ran;
  assert.deepEqual(fall, ['Sun Nov 01 2026 01:30']);
});

test('monthly after a restart: only the newest missed slot counts, within lateHours', () => {
  const s = make({ kind: 'monthly', time: '09:00', day: 1 });
  // Handled on May 1; the computer was off until Jul 1 10:00: May and June missed, July 1 is an hour late: one run.
  const r = sch.decide({ schedules: [s], lateHours: 2, data: { mon1: { last: at(2026, 5, 1, 9) } }, now: at(2026, 7, 1, 10) });
  assert.deepEqual(r.actions.map((a) => [a.type, local(a.slot)]), [['run', 'Wed Jul 01 2026 09:00']]);
  // Off until Jul 2: the newest slot (Jul 1) is a day late: skipped, not run.
  const late = sch.decide({ schedules: [s], lateHours: 2, data: { mon1: { last: at(2026, 5, 1, 9) } }, now: at(2026, 7, 2, 10) });
  assert.deepEqual(late.actions.map((a) => a.type), ['skip']);
  assert.equal(sch.lastSlot(s.when, at(2026, 7, 31, 23)), at(2026, 7, 1, 9), 'a slot 30 days back is still found');
});

test('day helpers: the next day a rule runs on and the last one at or before a day', () => {
  const m31 = { kind: 'monthly', day: 31 };
  assert.equal(sch.nextDay(m31, '2026-01-31'), '2026-02-28');
  assert.equal(sch.nextDay(m31, '2028-01-31'), '2028-02-29');
  assert.equal(sch.nextDay(m31, '2026-04-29'), '2026-04-30');
  assert.equal(sch.nextDay({ kind: 'daily' }, '2026-12-31'), '2027-01-01');
  assert.equal(sch.nextDay({ kind: 'weekly', days: [1] }, '2026-11-16'), '2026-11-23', 'Monday to the next Monday');
  assert.equal(sch.dayAtOrBefore({ kind: 'weekly', days: [1] }, '2026-11-22'), '2026-11-16');
  assert.equal(sch.dayAtOrBefore(m31, '2026-03-15'), '2026-02-28');
  // the days of the clock changes are plain days here
  assert.equal(sch.nextDay({ kind: 'daily' }, '2026-03-07'), '2026-03-08');
  assert.equal(sch.nextDay({ kind: 'daily' }, '2026-11-01'), '2026-11-02');
});

test('monthly validation: a day of 1 to 31, strict keys; old kinds unchanged', () => {
  assert.deepEqual(cleanWhen({ kind: 'monthly', time: '07:00', day: 31 }), { kind: 'monthly', time: '07:00', day: 31 });
  for (const day of [0, 32, 1.5, '3', undefined]) assert.throws(() => cleanWhen({ kind: 'monthly', time: '07:00', day }), /day of the month/);
  assert.throws(() => cleanWhen({ kind: 'monthly', time: '07:00', day: 3, days: [1] }), /"days" is not part/);
  const ok = cleanSchedule({ when: { kind: 'monthly', time: '07:05', day: 3 }, action: { type: 'start', dir: '/w', profile: 'sub' } });
  assert.deepEqual(ok.when, { kind: 'monthly', time: '07:05', day: 3 });
});
