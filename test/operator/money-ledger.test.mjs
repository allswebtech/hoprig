// The Operator's ledger (src/operator/money.mjs ledger): one object per state folder, so a lock left behind by a
// process that ended inside it keeps the Operator's writes waiting once, not a second for every write. Made-up
// amounts in a temporary state folder: nothing here spends anything.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-money-ledger');
test.after(() => box.cleanup());
const { spendFile } = await import('../../src/assistant/spend.mjs');
const { ledger, settle } = await import('../../src/operator/money.mjs');

test('one ledger for one state folder', () => {
  assert.equal(ledger(), ledger());
  assert.equal(ledger().file, spendFile());
});

test('a lock left behind: the first write waits for it, the writes after it do not', () => {
  fs.mkdirSync(new URL('.', `file://${spendFile()}`).pathname, { recursive: true });
  // A lock from a process that ended inside it, younger than the age at which it is taken over.
  fs.writeFileSync(`${spendFile()}.lock`, '');
  const t0 = Date.now();
  settle(0.01, 'a look', 'look-1');
  const first = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 2; i <= 5; i++) settle(0.01, 'a look', `look-${i}`);
  const rest = Date.now() - t1;
  assert.ok(first >= 500, `the first write waited for the lock (${first} ms)`);
  assert.ok(rest < 500, `four more writes did not wait a second each (${rest} ms)`);
  const lines = fs.readFileSync(spendFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => e.hold), ['look-1', 'look-2', 'look-3', 'look-4', 'look-5'], 'every write is there');
  fs.rmSync(`${spendFile()}.lock`, { force: true });
});
