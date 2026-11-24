// The paid notice says first what happened and names the provider she would think on by its label (Auto mode: the
// paid providers its order can use), in words a person who is not a programmer knows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { paidNotice } from '../../src/assistant/feature.mjs';

const accounts = { profiles: [{ name: 'key', label: 'Shop key', kind: 'api' }, { name: 'one', label: 'Plan one', kind: 'subscription' }], autoSwitch: { enabled: true, order: ['one', 'key'] } };
const NO_CAP = 'no daily limit for paid use is set (Settings → Tia)';

test('no daily limit: what happened, the provider by its label, and that it costs money', () => {
  const n = paidNotice(NO_CAP, { cap: null, runsOn: 'key' }, accounts);
  assert.equal(n.code, 'paid-no-cap');
  assert.equal(n.text, 'Tia did not answer: to answer she would use Shop key, which costs money, and you have not set a daily limit for paid use yet.');
  const auto = paidNotice(NO_CAP, { cap: null, runsOn: 'auto' }, accounts);
  assert.equal(auto.text, 'Tia did not answer: to answer she would use Auto mode, which can use Shop key, which costs money, and you have not set a daily limit for paid use yet.');
  for (const t of [n.text, auto.text]) assert.doesNotMatch(t, /billed by use|does not answer on it|Settings|→/);
});

test('a reached limit: the same words as the other notices, "costs money", never "billed by use"', () => {
  const why = "today's daily limit for paid use of $1.00 is reached ($1.20 spent); raise the limit, or wait for tomorrow";
  const n = paidNotice(why, { cap: 1, runsOn: 'key' }, accounts);
  assert.equal(n.code, 'cap-reached');
  assert.equal(n.text, `Tia did not answer: to answer she would use Shop key, which costs money, and ${why}.`);
  assert.doesNotMatch(paidNotice(why, { cap: 1, runsOn: 'auto' }, accounts).text, /billed by use/);
});
