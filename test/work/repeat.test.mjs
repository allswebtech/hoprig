// Repeating items (src/work/repeat.mjs through the one writer, store.mjs): one open occurrence; done or dropped makes
// the next; a date that came round again moves on and keeps what it missed; every step is the same on two computers,
// so two clones of one server that take it write the same item and a save meets no conflict.
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-repeat');
test.after(() => t.cleanup());
const { workStore, readDoc } = await import('../../src/work/store.mjs');
const { savePlan, saveWork } = await import('../../src/work/save.mjs');
const { checkRepeat, checkRunAt, nextOccurrence, repeatText, rollRepeats } = await import('../../src/work/repeat.mjs');
const { itemChanges, mergeItems } = await import('../../src/work/merge.mjs');

const settings = { timeZone: '', ownerId: 'me', saveSubject: 'Update work items' };
const listText = (items) => `${JSON.stringify({ items }, null, 2)}\n`;
let n = 0;
/** A Work place in a fresh repository whose clock says `day` (noon, local). */
function placeOn(dir, day) {
  const place = { file: path.join(dir, 'work', 'tasks.json'), folder: path.join(dir, 'work'), base: dir, label: 'brain/work', fileName: 'tasks.json', kind: 'project', settings };
  let today = day;
  const store = workStore(place, { now: () => new Date(`${today}T12:00:00`) });
  return { place, store, setDay: (d) => (today = d), items: () => readDoc(place.file).doc.items };
}
function fresh(day, items = []) {
  const dir = path.join(t.root, `r${++n}`);
  const bare = t.repo(dir, { 'README.md': '# brain\n', 'work/tasks.json': listText(items) });
  return { dir, bare, ...placeOn(dir, day) };
}

test('a weekly item marked done makes ONE next occurrence on its next day, with a deterministic id', async () => {
  const c = fresh('2026-11-16'); // a Monday
  const a = await c.store.add({ title: 'Water the plants', repeat: { kind: 'weekly', days: [1, 4] } });
  assert.equal(a.item.date, '2026-11-16', 'a rule without a date: today, when today is one of its days');
  assert.deepEqual(a.item.repeat, { kind: 'weekly', days: [1, 4] });
  const r = await c.store.status('water-the-plants', 'done');
  assert.equal(r.next.id, 'water-the-plants-20261119');
  assert.equal(r.next.date, '2026-11-19', 'Thursday');
  assert.equal(r.next.status, 'open');
  assert.equal(r.next.repeat.series, 'water-the-plants');
  // done again: one more, never two open
  await c.store.status('water-the-plants', 'open').catch(() => {});
  const open = c.items().filter((x) => x.status === 'open');
  assert.equal(open.length, 1, 'opening the done one again makes no second open occurrence');
  await c.store.status('water-the-plants', 'done');
  assert.equal(c.items().filter((x) => x.status === 'open').length, 1);
});

test('dropped makes the next one too; done before its day counts from its own date', async () => {
  const c = fresh('2026-11-02');
  await c.store.add({ title: 'Pay the rent', date: '2026-11-30', repeat: { kind: 'monthly', day: 31 } });
  const r = await c.store.status('pay-the-rent', 'drop');
  assert.equal(r.next.date, '2026-12-31', 'done early: the day after its own date, not after today');
  c.setDay('2027-01-02');
  const r2 = await c.store.status(r.next.id, 'done');
  assert.equal(r2.next.date, '2027-01-31');
  assert.equal(r2.next.id, 'pay-the-rent-20270131', 'the series id stays the first item\'s');
  c.setDay('2027-02-01');
  assert.equal((await c.store.status(r2.next.id, 'done')).next.date, '2027-02-28', 'the 31st in February: its last day');
});

test('a date that comes round while it is open moves on and keeps what it missed; a restart changes nothing more', async () => {
  const c = fresh('2026-11-02');
  await c.store.add({ title: 'Back up the photos', date: '2026-11-02', repeat: { kind: 'daily' } });
  assert.deepEqual((await c.store.roll()).moved, [], 'nothing to move on the same day');
  c.setDay('2026-11-06'); // four days away
  const r = await c.store.roll();
  assert.deepEqual(r.moved, [{ id: 'back-up-the-photos', from: '2026-11-02', to: '2026-11-06' }]);
  const it = c.items()[0];
  assert.equal(it.date, '2026-11-06');
  assert.deepEqual(it.repeat.missed, ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
  assert.equal(c.items().length, 1, 'no copies');
  // a restart (a new store on the same file) on the same day: nothing to do, the file not written
  const before = fs.readFileSync(c.place.file);
  assert.equal((await placeOn(c.dir, '2026-11-06').store.roll()).written, false);
  assert.deepEqual(fs.readFileSync(c.place.file), before);
  // a month away: only the last 10 days are kept
  c.setDay('2026-12-06');
  await c.store.roll();
  assert.equal(c.items()[0].repeat.missed.length, 10);
  assert.equal(c.items()[0].repeat.missed.at(-1), '2026-12-05');
});

test('a repeat across both clock changes and a year end moves day by day', async () => {
  const doc = { items: [{ id: 'x', date: '2026-03-07', title: 'Daily x', status: 'open', repeat: { kind: 'daily' } }] };
  assert.deepEqual(rollRepeats(doc, '2026-03-09'), [{ id: 'x', from: '2026-03-07', to: '2026-03-09' }]);
  assert.deepEqual(doc.items[0].repeat.missed, ['2026-03-07', '2026-03-08']);
  const fall = { items: [{ id: 'y', date: '2026-10-31', title: 'Daily y', status: 'done', repeat: { kind: 'daily' } }] };
  assert.equal(nextOccurrence(fall, fall.items[0], '2026-10-31').date, '2026-11-01');
  const ye = { items: [{ id: 'z', date: '2026-12-31', title: 'Daily z', status: 'done', repeat: { kind: 'weekly', days: [5] } }] };
  assert.equal(nextOccurrence(ye, ye.items[0], '2026-12-31').date, '2027-01-01', 'Friday 1 January');
});

test('a doing or review item is not moved; a closed one is not rolled', () => {
  const doc = { items: ['doing', 'review', 'done'].map((s) => ({ id: s, date: '2026-01-01', title: `Item ${s}`, status: s, repeat: { kind: 'daily' } })) };
  assert.deepEqual(rollRepeats(doc, '2026-01-05'), []);
});

test('the save plan says "next time made" and "date moved on"', async () => {
  const base = { items: [{ id: 'a', date: '2026-01-01', title: 'Daily a', status: 'open', repeat: { kind: 'daily' } }] };
  const after = structuredClone(base);
  rollRepeats(after, '2026-01-03');
  assert.deepEqual(itemChanges(base, after).map((x) => x.what), ['date moved on']);
  const done = structuredClone(after);
  done.items[0].status = 'done';
  nextOccurrence(done, done.items[0], '2026-01-03');
  assert.deepEqual(itemChanges(after, done).map((x) => [x.id, x.what]), [['a', 'done'], ['a-20260104', 'next time made']]);
});

test('two computers take the same step on two clones: identical items, a save with no conflict', async () => {
  const items = [{ id: 'standup', date: '2026-11-16', approx: false, title: 'Write the standup', kind: 'task', by: 'me', status: 'open', source: 'me', repeat: { kind: 'weekly', days: [1, 3, 5] } }];
  const a = fresh('2026-11-20', items);
  const otherDir = t.otherClone(a.bare);
  const b = placeOn(otherDir, '2026-11-20');
  // both computers were away: each moves the date on, then marks it done
  for (const c of [a, b]) {
    await c.store.roll();
    await c.store.status('standup', 'done');
  }
  assert.deepEqual(a.items().map(({ doneAt, ...x }) => x), b.items().map(({ doneAt, ...x }) => x));
  assert.equal(fs.readFileSync(a.place.file, 'utf8'), fs.readFileSync(b.place.file, 'utf8'), 'byte for byte the same file');
  // B saves first; A's save then merges: the same change on both sides is no conflict
  const sb = await saveWork(b.place, { subject: 'Update work items' });
  assert.equal(sb.ok, true, JSON.stringify(sb));
  const plan = await savePlan(a.place, { fetch: true });
  assert.equal((plan.conflicts || []).length, 0, JSON.stringify(plan.conflicts));
  const sa = await saveWork(a.place, { subject: 'Update work items' });
  assert.equal(sa.ok, true, JSON.stringify(sa));
  assert.deepEqual(a.items().map((x) => x.id), ['standup', 'standup-20261123']);
});

test('the checks: plain refusals, strict keys, words', () => {
  assert.deepEqual(checkRepeat({ kind: 'weekly', days: [4, 1, 1] }), { kind: 'weekly', days: [1, 4] });
  for (const [v, re] of [[{ kind: 'hourly' }, /daily", "weekly" or "monthly/], [{ kind: 'weekly', days: [] }, /weekday/], [{ kind: 'monthly', day: 32 }, /day of the month/], [{ kind: 'daily', time: '07:00' }, /"time" is not part/], ['daily', /rule/]]) assert.throws(() => checkRepeat(v), re);
  assert.deepEqual(checkRunAt({ time: '07:30' }), { time: '07:30', computer: null });
  assert.throws(() => checkRunAt({ time: '7:30' }), /07:30/);
  assert.throws(() => checkRunAt({ time: '07:30', computer: 'box2' }), /computer/);
  assert.equal(repeatText({ kind: 'weekly', days: [1, 4] }), 'every Monday and Thursday');
  assert.equal(repeatText({ kind: 'monthly', day: 31 }), 'every month on the 31st (the last day in a shorter month)');
  assert.equal(repeatText({ kind: 'monthly', day: 2 }), 'every month on the 2nd');
});

/** Two clones of one server whose list holds `items`, both on `day`. */
function pairOn(day, items) {
  const a = fresh(day, items);
  return { a, b: placeOn(t.otherClone(a.bare), day) };
}
const standup = (rule, date) => [{ id: 'standup', date, approx: false, title: 'Write the standup', kind: 'task', by: 'me', status: 'open', source: 'me', repeat: rule }];
const openOf = (c) => c.items().filter((x) => x.status === 'open').map((x) => [x.id, x.date]);

test('done on two computers on different days: one close and one open occurrence, a save with no conflict', async () => {
  const { a, b } = pairOn('2026-11-16', standup({ kind: 'weekly', days: [1, 4] }, '2026-11-16'));
  await a.store.status('standup', 'done');
  b.setDay('2026-11-17');
  await b.store.status('standup', 'done');
  assert.equal((await saveWork(a.place, { subject: 'Update work items' })).ok, true);
  const sb = await saveWork(b.place, { subject: 'Update work items' });
  assert.equal(sb.ok, true, JSON.stringify(sb.code));
  assert.deepEqual(openOf(b), [['standup-20261119', '2026-11-19']], 'one open occurrence');
  assert.equal(b.items().length, 2);
});

test('daily, done on the 16th here and the 17th there: the merge keeps one open occurrence, whichever side is the server', () => {
  const base = { items: [{ id: 's', date: '2026-11-16', title: 'S', status: 'open', repeat: { kind: 'daily' } }] };
  const close = (day) => {
    const d = structuredClone(base);
    Object.assign(d.items[0], { status: 'done', doneAt: day });
    nextOccurrence(d, d.items[0], day);
    return d;
  };
  for (const [m, th] of [[close('2026-11-17'), close('2026-11-16')], [close('2026-11-16'), close('2026-11-17')]]) {
    const r = mergeItems(base, m, th);
    assert.equal(r.conflicts.length, 0);
    assert.equal(r.doc.items.filter((x) => x.status === 'open').length, 1, JSON.stringify(r.doc.items.map((x) => x.id)));
  }
});

test('done on one computer, the date moved on by the other: the close and its next occurrence, no conflict, nothing done counted as missed', async () => {
  const { a, b } = pairOn('2026-11-16', standup({ kind: 'daily' }, '2026-11-16'));
  await a.store.status('standup', 'done');
  assert.equal((await saveWork(a.place, { subject: 'Update work items' })).ok, true);
  b.setDay('2026-11-19');
  await b.store.roll();
  const sb = await saveWork(b.place, { subject: 'Update work items' });
  assert.equal(sb.ok, true, JSON.stringify(sb.code));
  assert.equal(b.items().find((x) => x.id === 'standup').status, 'done');
  assert.equal(openOf(b).length, 1, JSON.stringify(openOf(b)));
  assert.ok(!b.items().some((x) => x.repeat && (x.repeat.missed || []).includes('2026-11-16')), 'the 16th was done, not missed');
});

test('the date moved on by both computers on different days: the later date with the missed days of both, no conflict', async () => {
  const { a, b } = pairOn('2026-11-13', standup({ kind: 'daily' }, '2026-11-13'));
  b.setDay('2026-11-16');
  await b.store.roll();
  assert.equal((await saveWork(b.place, { subject: 'Update work items' })).ok, true);
  a.setDay('2026-11-17');
  await a.store.roll();
  const sa = await saveWork(a.place, { subject: 'Update work items' });
  assert.equal(sa.ok, true, JSON.stringify(sa.code));
  const it = a.items();
  assert.equal(it.length, 1);
  assert.equal(it[0].date, '2026-11-17');
  assert.deepEqual(it[0].repeat.missed, ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16']);
});

test('a 70-character series whose next id another series holds: the id still fits the id pattern', async () => {
  const { ID_RE } = await import('../../src/work/model.mjs');
  const { occurrenceId } = await import('../../src/work/repeat.mjs');
  const long = 'x'.repeat(70);
  const d = { items: [{ id: long, date: '2026-11-16', title: 'L', status: 'done', repeat: { kind: 'daily' } }, { id: occurrenceId(long, '2026-11-17'), title: 'other', status: 'open' }] };
  const made = nextOccurrence(d, d.items[0], '2026-11-16');
  assert.ok(ID_RE.test(made.id), `${made.id.length} characters`);
  assert.match(made.id, /-r$/);
});
