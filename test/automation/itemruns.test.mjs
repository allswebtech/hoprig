// An item's run time ("run by AI at 07:30") as a schedule of the computer it names (src/automation/itemruns.mjs), and
// a schedule's run that ends by itself on a computer (schedules.mjs apply with ctx.alone): only the computer named
// runs it; an unreachable one is a missed slot with its reason, never a run elsewhere.
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import test from 'node:test';
import * as items from '../../src/automation/itemruns.mjs';
import * as sch from '../../src/automation/schedules.mjs';
import { cleanAlone, cleanSchedule, cleanSettingsPatch } from '../../src/automation/settings.mjs';
import { recorder } from './helpers.mjs';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const ME = 'a1a1a1a1a1a1a1a1';
const OTHER = 'b2b2b2b2b2b2b2b2';
const item = (o = {}) => ({ id: 'check-the-shop', title: 'Check the shop', status: 'open', date: null, at: { time: '07:30', computer: ME }, ...o });

/** Tick from `from` to `to`: the items' slots that ran, as local strings. */
function run(list, from, to, stepMs, me = ME) {
  let data = {};
  const ran = [];
  for (let t = from; t <= to; t += stepMs) {
    const r = items.decide({ items: list, me, lateHours: 2, data, now: t });
    data = r.data;
    for (const a of r.actions) if (a.type === 'run') ran.push(`${a.item.id} ${new Date(a.slot).toString().slice(0, 21)}`);
  }
  return ran;
}

test('the run time fires only on the computer it names; one with no computer runs nowhere', () => {
  const list = [item(), item({ id: 'elsewhere', at: { time: '07:30', computer: OTHER } }), item({ id: 'nowhere', at: { time: '07:30', computer: null } })];
  assert.deepEqual(run(list, at(2026, 6, 1, 7), at(2026, 6, 2, 8), 5 * 60_000), ['check-the-shop Mon Jun 01 2026 07:30', 'check-the-shop Tue Jun 02 2026 07:30']);
  assert.deepEqual(run(list, at(2026, 6, 1, 7), at(2026, 6, 2, 8), 5 * 60_000, OTHER), ['elsewhere Mon Jun 01 2026 07:30', 'elsewhere Tue Jun 02 2026 07:30']);
});

test('a dated item runs on its date only; a closed, doing or review item never; a time set after its slot waits for the next', () => {
  assert.deepEqual(run([item({ date: '2026-06-02' })], at(2026, 6, 1, 7), at(2026, 6, 3, 8), 5 * 60_000), ['check-the-shop Tue Jun 02 2026 07:30']);
  for (const status of ['done', 'dropped', 'doing', 'review']) assert.deepEqual(run([item({ status })], at(2026, 6, 1, 7), at(2026, 6, 2, 8), 5 * 60_000), [], status);
  assert.deepEqual(run([item()], at(2026, 6, 1, 9), at(2026, 6, 2, 8), 5 * 60_000), ['check-the-shop Tue Jun 02 2026 07:30'], 'first seen at 09:00: not today');
});

test('across both clock changes and a restart: once per day; a slot missed by more than lateHours is skipped and logged', async () => {
  assert.deepEqual(run([item({ at: { time: '02:30', computer: ME } })], at(2026, 3, 7, 3), at(2026, 3, 9, 3), 5 * 60_000), ['check-the-shop Sun Mar 08 2026 03:30', 'check-the-shop Mon Mar 09 2026 02:30']);
  assert.deepEqual(run([item({ at: { time: '01:30', computer: ME } })], at(2026, 10, 31, 23), at(2026, 11, 1, 6), 5 * 60_000), ['check-the-shop Sun Nov 01 2026 01:30']);
  const key = 'check-the-shop@07:30';
  const r = items.decide({ items: [item()], me: ME, lateHours: 2, data: { [key]: { seen: at(2026, 5, 1), last: at(2026, 6, 1, 7, 30) } }, now: at(2026, 6, 4, 12) });
  assert.deepEqual(r.actions.map((a) => a.type), ['skip']);
  const rec = recorder();
  await items.apply(r.actions, { startItem: () => assert.fail('a skipped slot starts nothing'), record: rec.record, notify: rec.notify });
  assert.match(rec.entries[0].outcome, /^missed: /);
});

test('apply: a run starts, a wait is recorded, a refusal is told', async () => {
  const rec = recorder();
  const got = [];
  const acts = ['a1', 'a2', 'a3'].map((id) => ({ type: 'run', item: item({ id }), slot: 1, late: 0 }));
  await items.apply(acts, { startItem: async (id) => (got.push(id), id === 'a1' ? { run: { branch: 'work/a1' } } : id === 'a2' ? { waiting: true, why: 'another run of shop works now' } : Promise.reject(new Error('shop is not a git repository'))), record: rec.record, notify: rec.notify });
  assert.deepEqual(got, ['a1', 'a2', 'a3']);
  assert.deepEqual(rec.entries.map((e) => e.outcome), ['ok', 'waits: another run of shop works now', 'failed: shop is not a git repository']);
  assert.equal(rec.notes.length, 1);
});

const alone = { type: 'alone', project: 'shop', prompt: 'Check the build', provider: 'sub' };
test('a schedule that runs by itself: on this computer, or the one it names; unreachable is missed, never run elsewhere', async () => {
  const here = { id: 'sched1', enabled: true, label: 'Nightly', when: { kind: 'daily', time: '02:00' }, action: alone };
  const there = { ...here, id: 'sched2', computer: OTHER };
  const rec = recorder();
  const asked = [];
  const ctx = { record: rec.record, notify: rec.notify, deck: {}, alone: async (s) => {
    asked.push(s.computer || 'here');
    if (s.computer === OTHER) throw Object.assign(new Error('Box B cannot be reached, so it did not run (and not anywhere else): offline'), { missed: true });
    return { run: { branch: 'work/sched1' } };
  } };
  await sch.apply([here, there].map((schedule) => ({ type: 'run', schedule, slot: at(2026, 6, 1, 2), late: 0 })), ctx);
  assert.deepEqual(asked, ['here', OTHER], 'each only where it names, once');
  assert.match(rec.entries[0].did, /started "Nightly" on the branch work\/sched1/);
  assert.match(rec.entries[1].did, /^missed "Nightly"/);
  assert.match(rec.entries[1].outcome, /^missed: Box B cannot be reached/);
  assert.equal(rec.notes.length, 1, 'he is told');
});

test('validation: a run by itself, its limits, the computer, the at-once setting; old schedules unchanged', () => {
  assert.deepEqual(cleanAlone({ ...alone, minutes: 45, tell: 'always', mode: 'bypassPermissions' }), { ...alone, minutes: 45, tell: 'always', mode: 'bypassPermissions' });
  assert.deepEqual(cleanAlone({ ...alone, mode: 'manual', tell: 'news' }), alone, 'the defaults are left out');
  for (const [v, re] of [[{ ...alone, minutes: 0 }, /1 to 240/], [{ ...alone, minutes: 241 }, /1 to 240/], [{ ...alone, project: '../x' }, /project/], [{ ...alone, prompt: '' }, /what it should do/], [{ ...alone, mode: 'yolo' }, /permission mode/], [{ ...alone, folder: '/etc' }, /folder/], [{ ...alone, cmd: 'rm' }, /"cmd" is not part/]]) assert.throws(() => cleanAlone(v), re, JSON.stringify(v));
  const when = { kind: 'daily', time: '02:00' };
  assert.equal(cleanSchedule({ when, action: alone, computer: OTHER }).computer, OTHER);
  assert.throws(() => cleanSchedule({ when, action: alone, computer: 'box2' }), /computer/);
  assert.throws(() => cleanSchedule({ when, action: { type: 'send', session: 'x', text: 'hi' }, computer: OTHER }), /only a run that ends by itself/);
  assert.throws(() => cleanAlone(alone, { projectOk: () => false }), /not a project/);
  assert.equal(cleanSettingsPatch({ schedules: { atOnce: 4 } }).schedules.atOnce, 4);
  assert.throws(() => cleanSettingsPatch({ schedules: { atOnce: 5 } }), /1 to 4/);
  assert.equal(sch.describeAction(alone), 'run by itself in shop for at most 30 minutes on sub');
});

test('a missed slot names its time as the page writes times, not in the server\'s locale format', async () => {
  const { apply } = await import('../../src/automation/itemruns.mjs');
  const rec = [];
  const slot = new Date(2026, 10, 18, 17, 45).getTime();
  await apply([{ type: 'skip', item: { id: 'x', title: 'Water' }, slot, late: 5 * 3600_000 }], { record: (e) => rec.push(e), notify: () => {}, startItem: async () => ({}) });
  assert.match(rec[0].did, /\(due Wed 18 Nov, 17:45\)/);
});
