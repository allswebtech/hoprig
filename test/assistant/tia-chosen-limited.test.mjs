// "Use <subscription>" on a notice sets "Tia runs on" to it: from then on it is his own choice, and Automatic does not
// move her. When that subscription is at its limit, she says so in one plain line with the time it is usable again,
// and nothing moves to a provider billed by use.
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTia } from '../../src/assistant/tia.mjs';
import * as feature from '../../src/assistant/feature.mjs';

const HOUR = 3600_000;
const sub = (name, extra = {}) => ({ name, label: `Plan ${name}`, kind: 'subscription', tools: ['claude'], ...extra });
const key = { name: 'key', label: 'Key', kind: 'api', paid: true, tools: ['claude'] };

test('his chosen subscription at its limit: he stays on it, and the line names it with its time', () => {
  const now = Date.now();
  const acc = { profiles: [sub('max', { limited: { until: now + 2 * HOUR } }), sub('pro'), key], autoSwitch: { enabled: true, order: ['max', 'key'] } };
  const t = resolveTia({ runsOn: 'max' }, acc);
  assert.equal(t.runsOn, 'max', 'his choice was moved');
  assert.deepEqual(t.chosenLimited, { name: 'max', until: now + 2 * HOUR });
  assert.equal(typeof feature.chosenLimitedLine, 'function', 'no line for his chosen subscription at its limit');
  assert.match(feature.chosenLimitedLine(t.chosenLimited, acc, now), /^Plan max, which Tia runs on, has reached its limit, so she cannot answer now\. It can be used again at \d\d:\d\d( on \w{3},? \d{1,2} \w{3})?\. Tia does not move to a paid provider by herself\.$/);
  // Free again, or a key he chose: nothing to say.
  assert.equal(resolveTia({ runsOn: 'pro' }, acc).chosenLimited, null);
  assert.equal(resolveTia({ runsOn: 'key' }, acc).chosenLimited, null);
  assert.equal(resolveTia({ runsOn: 'auto' }, acc).chosenLimited, null);
});

// The clock here is fixed and built in this computer's own zone, so the answer is the same at every hour a suite
// runs. (The test above takes the real clock: late in the evening its two hours end on the next day.)
test('the time it can be used again carries the day only when that is not today', () => {
  const acc = { profiles: [sub('max')] };
  const at = (day, h, m = 0) => new Date(2026, 10, day, h, m).getTime();
  const noon = at(23, 12);
  assert.match(feature.chosenLimitedLine({ name: 'max', until: at(23, 14, 5) }, acc, noon), /It can be used again at 14:05\. Tia does not move/);
  assert.match(feature.chosenLimitedLine({ name: 'max', until: at(24, 9) }, acc, noon), /It can be used again at 09:00 on Tue,? 24 Nov\. Tia does not move/);
  // An hour before midnight, a limit of two hours ends tomorrow, and the line says so.
  const late = at(23, 23);
  assert.match(feature.chosenLimitedLine({ name: 'max', until: late + 2 * HOUR }, acc, late), /It can be used again at 01:00 on Tue,? 24 Nov\. Tia does not move/);
  // The line for every subscription at its limit writes its time the same way.
  assert.match(feature.subsLimitedLine({ names: ['max'], first: 'max', until: at(23, 14, 5) }, acc, noon), /Plan max can be used again at 14:05\. Tia does not move/);
  assert.match(feature.subsLimitedLine({ names: ['max'], first: 'max', until: late + 2 * HOUR }, acc, late), /Plan max can be used again at 01:00 on Tue,? 24 Nov\. Tia does not move/);
});
