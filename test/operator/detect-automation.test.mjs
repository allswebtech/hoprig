import assert from 'node:assert/strict';
import test from 'node:test';
import { detectAutomation } from '../../src/operator/detect/automation.mjs';
import { NOW, ago } from './fixtures/cases.mjs';

test("an automation's commit that changed the map is shown, with a way to open it", () => {
  const board = { lastLook: ago(120), changes: [{ where: 'brain', commit: 'a1b2c3d4e5f6', at: ago(40), by: 'the upkeep', files: 1, subject: 'Map: two projects renamed back' }] };
  const [it, ...rest] = detectAutomation(board, { now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(it.subject, 'brain commit a1b2c3d');
  assert.deepEqual(it.facts, ['the upkeep changed brain at 13:20 UTC', 'its message: Map: two projects renamed back', '1 file changed']);
  assert.equal(it.recommended, 'open-commit');
  assert.equal(it.acts[0].href, '#/code?repo=brain&commit=a1b2c3d4e5f6');
});

test('what he has seen already, or a commit id that is not one, is left out', () => {
  const board = { lastLook: ago(10), changes: [{ where: 'brain', commit: 'a1b2c3d', at: ago(40) }, { where: 'brain', commit: 'x; rm', at: ago(1) }] };
  assert.deepEqual(detectAutomation(board, { now: NOW }), []);
});

test('no source gives nothing', () => {
  assert.deepEqual(detectAutomation({ changes: null }, { now: NOW }), []);
});

test('the same commit a day later is the same item, though its clock time turned into a date', () => {
  const board = { lastLook: ago(120), changes: [{ where: 'brain', commit: 'a1b2c3d4e5f6', at: ago(40), by: 'the upkeep', files: 1, subject: 'Map' }] };
  assert.equal(detectAutomation(board, { now: NOW })[0].rev, detectAutomation(board, { now: NOW + 21 * 3600_000 })[0].rev);
});
