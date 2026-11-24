// A mission that waits because no spend cap is set names the place of that field, Work → Team, as its neighbours of
// the same list do ("no provider is allowed yet (Work → Team)"): the report turns those words into the code
// `work-team` of the page's table of places (web/errorways.js), and the mission's screen draws "Open Team" from it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { whyNot } from '../../src/mission/limits.mjs';
import { missionSettings } from '../../src/mission/settings.mjs';
import { missionReport } from '../../src/mission/report.mjs';
import { WAYS } from '../../web/errorways.js';

const ON = missionSettings({ missions: { on: true, projects: { shop: { on: true } }, capUsd: 1, providers: ['key'], atOnce: 2 } });
const free = { s: ON, project: 'shop', running: 0, slots: 4, clock: '10:00', spent: { usd: 0, tokens: 0, unknown: 0 }, machine: null };
const mission = (why) => ({
  v: 1, id: 'm-20261123-abcdef', writer: 'aaaaaaaaaaaaaaaa', goal: 'A goal', project: 'shop', proposal: null, plan: null, state: 'running', why,
  createdAt: '2026-11-23T08:00:00.000Z', endedAt: null, tasks: [], line: [],
});

test('no spend cap set: the why names Work → Team, and the report carries its code, which the page knows', () => {
  const why = whyNot({ ...free, s: { ...ON, capUsd: 0 } });
  assert.match(why, /Work → Team/);
  assert.deepEqual(missionReport(mission(why)).ways, ['work-team']);
  assert.equal(WAYS['work-team'].href, '#/work/team');
});
