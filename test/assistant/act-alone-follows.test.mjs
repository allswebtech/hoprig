// "Tia acts by herself" (the Operator page, What Tia does by herself) is the ONE switch for her small acts on Hoprig itself
// too: the server reads it as her "act alone" right, there is no second switch, and the sentence that sends the owner
// to a switch names words that the page has.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { checkRoute } from '../../src/assistant/door.mjs';
import { decide } from '../../src/assistant/hoprigact.mjs';
import { createOps } from '../../src/assistant/ops.mjs';
import { cleanTiaPatch } from '../../src/assistant/tia.mjs';

const page = fs.readFileSync(new URL('../../web/operator-tia.js', import.meta.url), 'utf8');
const opsFor = (config) => createOps({ ctx: { config: () => config } });

test('her act-alone right follows the one switch Tia acts by herself', async () => {
  assert.equal((await opsFor({ assistant: { enabled: true }, operator: { acts: true } }).assistantSettings()).actAlone, true);
  assert.equal((await opsFor({ assistant: { enabled: true }, operator: { acts: false } }).assistantSettings()).actAlone, false);
  assert.equal((await opsFor({ assistant: { enabled: true } }).assistantSettings()).actAlone, false);
  assert.equal((await opsFor({ assistant: { enabled: true, actAlone: true }, operator: { acts: false } }).assistantSettings()).actAlone, false, 'no second switch');
});

test('the sentence names words the page has, and no key she could send herself', () => {
  const why = decide({ act: 'hold-starts', value: true }, {}, { actAlone: false, level: 'work' }).why;
  assert.match(why, /the Operator page, What Tia does by herself, Tia acts by herself/);
  assert.ok(page.includes("'What Tia does by herself'"), 'the fold is on the page');
  assert.ok(page.includes("'Tia acts by herself'"), 'the switch is on the page');
});

test('she cannot raise her own right: the switch and the old key are the owner own', () => {
  const stub = { config: () => ({ server: {} }), settingsOf: async () => ({}) };
  for (const [p, b] of [['/api/operator/settings', { acts: true }], ['/api/assistant/settings', { actAlone: true }]]) {
    assert.throws(() => checkRoute('POST', p, b, stub), (e) => e.status === 403, p);
  }
  assert.throws(() => cleanTiaPatch({ actAlone: true }, [], []), /not a Tia setting/);
});
