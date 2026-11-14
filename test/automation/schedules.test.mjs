// Schedules run in local time; these tests fix the zone to one with summer time (US Eastern: clocks go forward
// on 2026-03-08 at 02:00 and back on 2026-11-01 at 02:00).
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import test from 'node:test';
import * as sch from '../../src/automation/schedules.mjs';
import { cleanSchedule } from '../../src/automation/settings.mjs';
import { fakeDeck, recorder } from './helpers.mjs';

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();
const make = (when, o = {}) => ({ id: 'abcd1', enabled: true, when, action: { type: 'start', dir: '/w', profile: 'sub' }, since: 0, ...o });

/** Tick every `stepMs` from `from` to `to`; returns the slots that ran (as local strings) and the skipped ones. */
function run(schedule, from, to, stepMs, { lateHours = 2, data = {} } = {}) {
  const ran = [];
  const skipped = [];
  schedule = { ...schedule, since: schedule.since || from - 1 }; // made just before the first tick
  for (let t = from; t <= to; t += stepMs) {
    const r = sch.decide({ schedules: [schedule], lateHours, data, now: t });
    data = r.data;
    for (const a of r.actions) (a.type === 'run' ? ran : skipped).push(new Date(a.slot).toString().slice(0, 21));
  }
  return { ran, skipped, data };
}

test('time zone is fixed for these tests', () => {
  assert.equal(new Date(at(2026, 1, 15, 12)).getTimezoneOffset(), 300);
  assert.equal(new Date(at(2026, 7, 15, 12)).getTimezoneOffset(), 240);
});

test('daily across midnight: once per day, at the minute', () => {
  const s = make({ kind: 'daily', time: '23:59' });
  const { ran, skipped } = run(s, at(2026, 6, 1, 23, 50), at(2026, 6, 3, 0, 10), 30_000);
  assert.deepEqual(ran, ['Mon Jun 01 2026 23:59', 'Tue Jun 02 2026 23:59']);
  assert.deepEqual(skipped, []);
});

test('weekly: only on the chosen weekdays', () => {
  const s = make({ kind: 'weekly', time: '09:00', days: [1, 3] }); // Monday, Wednesday
  const { ran } = run(s, at(2026, 6, 1, 0, 0), at(2026, 6, 8, 23, 0), 5 * 60_000);
  assert.deepEqual(ran, ['Mon Jun 01 2026 09:00', 'Wed Jun 03 2026 09:00', 'Mon Jun 08 2026 09:00']);
});

test('summer time starts: a time inside the skipped hour runs once, just after the jump', () => {
  const s = make({ kind: 'daily', time: '02:30' });
  const { ran } = run(s, at(2026, 3, 7, 0, 0), at(2026, 3, 9, 6, 0), 5 * 60_000);
  assert.deepEqual(ran, ['Sat Mar 07 2026 02:30', 'Sun Mar 08 2026 03:30', 'Mon Mar 09 2026 02:30']);
});

test('summer time ends: a time that happens twice runs once', () => {
  const s = make({ kind: 'daily', time: '01:30' });
  const { ran } = run(s, at(2026, 10, 31, 23, 0), at(2026, 11, 1, 6, 0), 5 * 60_000);
  assert.deepEqual(ran, ['Sun Nov 01 2026 01:30']);
});

test('across a clock change a daily 09:00 stays 09:00 local', () => {
  const s = make({ kind: 'daily', time: '09:00' });
  const { data } = run(s, at(2026, 3, 7, 8, 0), at(2026, 3, 7, 10, 0), 60_000);
  const before = data.abcd1.last;
  const after = run(s, at(2026, 3, 8, 8, 0), at(2026, 3, 8, 10, 0), 60_000, { data }).data.abcd1.last;
  assert.equal(new Date(before).getHours(), 9);
  assert.equal(new Date(after).getHours(), 9);
  assert.equal(after - before, 23 * 3600_000, 'the day of the jump is 23 hours long');
});

test('a run missed while the computer was off: inside the grace window it runs once, late', () => {
  const s = make({ kind: 'daily', time: '09:00' });
  const data = { abcd1: { last: at(2026, 6, 1, 9, 0) } };
  // Off from Jun 1 evening to Jun 4 10:30: three missed days, one run.
  const r = sch.decide({ schedules: [s], lateHours: 2, data, now: at(2026, 6, 4, 10, 30) });
  assert.deepEqual(r.actions.map((a) => [a.type, a.late]), [['run', 90 * 60_000]]);
  assert.equal(r.data.abcd1.last, at(2026, 6, 4, 9, 0));
  assert.deepEqual(sch.decide({ schedules: [s], lateHours: 2, data: r.data, now: at(2026, 6, 4, 10, 31) }).actions, []);
});

test('a run missed by more than the grace window is skipped, and logged', async () => {
  const s = make({ kind: 'daily', time: '09:00' });
  const r = sch.decide({ schedules: [s], lateHours: 2, data: { abcd1: { last: at(2026, 6, 1, 9) } }, now: at(2026, 6, 2, 11, 1) });
  assert.deepEqual(r.actions.map((a) => a.type), ['skip']);
  const rec = recorder();
  const deck = fakeDeck();
  await sch.apply(r.actions, { deck, record: rec.record, notify: rec.notify, enqueue: () => {} });
  assert.deepEqual(deck.started, []);
  assert.match(rec.entries[0].outcome, /^missed: 2(\.\d)? hours late/);
  // lateHours 0 still allows a normal, slightly late tick.
  assert.equal(sch.decide({ schedules: [s], lateHours: 0, data: {}, now: at(2026, 6, 2, 9, 0, 20) }).actions[0].type, 'run');
});

test('once: runs on its day and never again', () => {
  const s = make({ kind: 'once', time: '10:00', date: '2026-06-10' });
  const { ran } = run(s, at(2026, 6, 9, 9, 0), at(2026, 6, 12, 12, 0), 10 * 60_000);
  assert.deepEqual(ran, ['Wed Jun 10 2026 10:00']);
  assert.equal(sch.nextSlot(s.when, at(2026, 6, 10, 9, 0)), at(2026, 6, 10, 10, 0));
  assert.equal(sch.nextSlot(s.when, at(2026, 6, 10, 10, 0)), null, 'nothing next once past');
});

test('a schedule made after today\'s time starts tomorrow; a disabled one never runs', () => {
  const s = make({ kind: 'daily', time: '09:00' }, { since: at(2026, 6, 1, 10, 0) });
  const { ran } = run(s, at(2026, 6, 1, 10, 0), at(2026, 6, 2, 10, 0), 10 * 60_000);
  assert.deepEqual(ran, ['Tue Jun 02 2026 09:00']);
  assert.deepEqual(run({ ...s, enabled: false }, at(2026, 6, 1, 10), at(2026, 6, 3, 10), 3600_000).ran, []);
});

test('next run shown for daily and weekly', () => {
  assert.equal(sch.nextSlot({ kind: 'daily', time: '08:00' }, at(2026, 6, 1, 9)), at(2026, 6, 2, 8));
  assert.equal(sch.nextSlot({ kind: 'weekly', time: '08:00', days: [0] }, at(2026, 6, 1, 9)), at(2026, 6, 7, 8));
  assert.equal(sch.lastSlot({ kind: 'weekly', time: '08:00', days: [0] }, at(2026, 6, 1, 9)), at(2026, 5, 31, 8));
});

test('apply: start (first message goes to the queue) and send (to an existing session only)', async () => {
  const deck = fakeDeck([{ name: 'live', kind: 'claude' }]);
  deck.has = async (n) => deck.cards.some((c) => c.name === n);
  const rec = recorder();
  const queued = [];
  const start = make({ kind: 'daily', time: '07:00' }, { label: 'Morning', action: { type: 'start', dir: '/w', profile: 'auto', prompt: 'check the build' } });
  const send = make({ kind: 'daily', time: '07:00' }, { id: 'abcd2', action: { type: 'send', session: 'live', text: 'status?' } });
  const lost = make({ kind: 'daily', time: '07:00' }, { id: 'abcd3', label: 'Lost', action: { type: 'send', session: 'gone', text: 'x' } });
  const actions = [start, send, lost].map((schedule) => ({ type: 'run', schedule, slot: 1, late: 0 }));
  await sch.apply(actions, { deck, record: rec.record, notify: rec.notify, enqueue: (s, t) => queued.push([s, t]) });
  assert.deepEqual(deck.started, [{ dir: '/w', profile: 'auto', mode: 'new' }]);
  assert.deepEqual(queued, [['s1', 'check the build'], ['live', 'status?']]);
  assert.deepEqual(rec.entries.map((e) => e.outcome), ['ok', 'ok', 'failed: there is no session "gone"']);
  assert.equal(rec.notes.length, 1);
  assert.match(rec.notes[0].title, /Lost/);
});

test('schedule validation: plain refusals, strict keys', () => {
  const ok = { when: { kind: 'weekly', time: '07:05', days: [5, 1, 1] }, action: { type: 'start', dir: '/w', profile: 'auto' } };
  assert.deepEqual(cleanSchedule(ok), { enabled: true, when: { kind: 'weekly', time: '07:05', days: [1, 5] }, action: { type: 'start', dir: '/w', profile: 'auto' } });
  const bad = [
    [{ ...ok, cron: '* * * * *' }, /"cron" is not part/],
    [{ ...ok, when: { kind: 'daily', time: '7:05' } }, /09:30/],
    [{ ...ok, when: { kind: 'daily', time: '24:00' } }, /09:30/],
    [{ ...ok, when: { kind: 'weekly', time: '07:00', days: [] } }, /weekday/],
    [{ ...ok, when: { kind: 'weekly', time: '07:00', days: [7] } }, /weekday/],
    [{ ...ok, when: { kind: 'daily', time: '07:00', days: [1] } }, /"days" is not part/],
    [{ ...ok, when: { kind: 'once', time: '07:00', date: '2026-02-30' } }, /real day/],
    [{ ...ok, when: { kind: 'hourly', time: '07:00' } }, /once", "daily" or "weekly/],
    [{ ...ok, action: { type: 'start', dir: 'relative', profile: 'sub' } }, /folder/],
    [{ ...ok, action: { type: 'start', dir: '/w', profile: 'Bad Name' } }, /provider/],
    [{ ...ok, action: { type: 'start', dir: '/w', profile: 'sub', prompt: 'x'.repeat(32 * 1024 + 1) } }, /32 KiB/],
    [{ ...ok, action: { type: 'send', session: '-x', text: 'hi' } }, /session/],
    [{ ...ok, action: { type: 'send', session: 'w', text: '' } }, /empty/],
    [{ ...ok, action: { type: 'exec', cmd: 'rm' } }, /starts a session or sends/],
    [{ ...ok, label: 'two\nlines' }, /one line/],
  ];
  for (const [s, re] of bad) assert.throws(() => cleanSchedule(s), re, JSON.stringify(s));
  assert.throws(() => cleanSchedule(ok, { dirOk: () => false }), /not a folder the dashboard may use/);
  assert.throws(() => cleanSchedule(ok, { profileOk: () => false }), /no provider "auto"/);
});
