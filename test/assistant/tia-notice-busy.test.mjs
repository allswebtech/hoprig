// The code of her paid notice follows the reason take() gave, not whether a cap is set: a spending record another
// dashboard is writing just now is "busy" (the cap may still have room, so no "Raise the daily limit" button and no
// "Use …" offer); only a cap without room is "cap-reached".
import assert from 'node:assert/strict';
import test from 'node:test';
import * as feature from '../../src/assistant/feature.mjs';
import { BUSY, SpendLedger } from '../../src/assistant/spend.mjs';

test('a busy record is its own code, with a cap of $5 and room left', () => {
  assert.equal(typeof feature.paidNotice, 'function', 'no notice maker');
  const n = feature.paidNotice(BUSY, { cap: 5, runsOn: 'api' });
  assert.equal(n.code, 'busy');
  assert.doesNotMatch(n.text, /reached|raise/i);
  const l = new SpendLedger({ file: null });
  l.spent(5, 'turn');
  assert.equal(feature.paidNotice(l.take(5), { cap: 5, runsOn: 'api' }).code, 'cap-reached');
  assert.equal(feature.paidNotice(l.take(null), { cap: null, runsOn: 'api' }).code, 'paid-no-cap');
});
