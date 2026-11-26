// A schedule whose run by itself may have left its coding tool running (Windows: src/work/alone.mjs) is switched off
// as the owner's own switch does it (changeSchedules "change"), only when it is on, and said in Activity. Every other
// schedule stays as it was; an unknown one changes nothing. The automations hand this to Work's runner when they start.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomation } from '../../src/automation/index.mjs';
import { automationFeature } from '../../src/automation/feature.mjs';
import { fakeCtx, fakeDeck, tmpDir } from './helpers.mjs';

const alone = (project, o = {}) => ({ enabled: true, when: { kind: 'daily', time: '02:00' }, action: { type: 'alone', project, prompt: 'Tidy the docs', provider: 'sub' }, ...o });
const WHY = 'a program of its last run may still be running in shop (it could not be ended: process 4242 could not be ended); switch it on again in Work → Schedules once that program has ended';
const LIST = [
  { ...alone('shop', { label: 'Nightly' }), id: 'night001', since: 1, hers: true },
  { ...alone('blog'), id: 'blog0001', since: 2 },
  { ...alone('shop', { label: 'Weekly', enabled: false }), id: 'week0001', since: 3 },
];
// The provider and the project it names are refused now: switching it off names nothing new, so it is still switched off.
const ctxOf = (dir) => fakeCtx({ deck: fakeDeck([]), automation: { schedules: { list: LIST } }, stateDir: dir, now: () => 5000, checks: { profileOk: () => false, projectOk: () => false } });

test('a schedule that is on is switched off on disk and said in Activity; one already off, an unknown one and the rest stay', async () => {
  const t = tmpDir('sched-off');
  const f = ctxOf(t.dir);
  const a = createAutomation(f.ctx);
  try {
    const saved = () => f.config().automation.schedules.list;
    assert.equal(a.api.switchOff('night001', WHY), 'Nightly');
    const [night, blog, week] = saved();
    assert.deepEqual(night, { ...LIST[0], enabled: false, since: 5000 }, 'only its switch, as the owner\'s switch saves it (hers stays hers)');
    assert.deepEqual(blog, LIST[1]);
    assert.deepEqual(week, LIST[2]);
    const said = a.activity.recent(10).filter((e) => e.automation === 'schedules');
    assert.equal(said.length, 1);
    assert.equal(said[0].did, 'switched off "Nightly"');
    assert.equal(said[0].outcome, `off: ${WHY}`);
    assert.ok(f.lines.some((l) => l.includes('switched off "Nightly"')), f.lines.join('\n'));

    const before = JSON.stringify(saved());
    assert.equal(a.api.switchOff('week0001', WHY), null, 'off already: left as it is');
    assert.equal(a.api.switchOff('night001', WHY), null, 'switched off once');
    assert.doesNotThrow(() => assert.equal(a.api.switchOff('gone0001', WHY), null), 'an unknown id');
    assert.equal(a.api.switchOff(undefined, WHY), null);
    assert.equal(JSON.stringify(saved()), before, 'nothing else changed');
    assert.equal(a.activity.recent(10).filter((e) => e.automation === 'schedules').length, 1, 'and nothing else said');

    // A schedule without a name is said in the words of the Schedules list.
    assert.equal(a.api.switchOff('blog0001', WHY), 'run by itself in blog for at most 30 minutes on sub');
    assert.equal(saved()[1].enabled, false);
    assert.deepEqual(saved()[0], night);
    assert.deepEqual(saved()[2], LIST[2]);
  } finally {
    await a.close();
    t.cleanup();
  }
});

test('the automations hand the switch-off to Work\'s runs when they start', async () => {
  const t = tmpDir('sched-off-feature');
  const f = ctxOf(t.dir);
  let handed = null;
  const feature = automationFeature(null, { ctx: f.ctx, tick: false, work: () => ({ setScheduleOff: (fn) => (handed = fn) }) });
  try {
    feature.start();
    assert.equal(typeof handed, 'function');
    assert.equal(await handed('night001', WHY), 'Nightly');
    assert.equal(f.config().automation.schedules.list[0].enabled, false);
  } finally {
    await feature.close();
    t.cleanup();
  }
});
