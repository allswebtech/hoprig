// The schedule switch of a run by itself (src/work/alone.mjs: on Windows a schedule whose run may have left its coding
// tool running is switched off) reaches Work's runner in the real wiring: server.mjs passes `work: () => work.sched` to
// automationFeature, and workFeature returns `sched: sched.hooks`. The switch was beside `hooks`, not in it, so the
// automations found nothing to hand it to and no schedule was ever switched off; the other tests handed it in directly.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('schedoff-wiring');
test.after(() => t.cleanup());
const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { workFeature } = await import('../../src/work/feature.mjs');
const { automationFeature } = await import('../../src/automation/feature.mjs');
const { fakeCtx, fakeDeck } = await import('../automation/helpers.mjs');

test('the object the server hands the automations (workFeature().sched) takes the schedule switch', async () => {
  const wf = workFeature({ config: loadConfig, readJson: async () => ({}), saveConfig });
  try {
    assert.equal(typeof wf.sched.setScheduleOff, 'function', 'setScheduleOff is not on work.sched');
  } finally {
    await wf.close?.();
  }
});

test('the automations, wired as the server wires them, hand their switch to Work when they start', async () => {
  const wf = workFeature({ config: loadConfig, readJson: async () => ({}), saveConfig });
  const f = fakeCtx({ deck: fakeDeck([]), automation: { schedules: { list: [] } }, stateDir: t.root, now: () => 5000 });
  const handed = [];
  const sched = new Proxy(wf.sched, {
    get: (o, k) => (k === 'setScheduleOff' && typeof o[k] === 'function' ? (fn) => (handed.push(fn), o[k](fn)) : o[k]),
  });
  const af = automationFeature(null, { ctx: f.ctx, tick: false, work: () => sched });
  try {
    af.start();
    assert.equal(handed.length, 1, 'the switch was handed to Work once');
    assert.equal(typeof handed[0], 'function');
  } finally {
    await af.close();
    await wf.close?.();
  }
});
