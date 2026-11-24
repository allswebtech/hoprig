// What a run that ends by itself used (src/work/runs.mjs `used`, src/work/alone.mjs readStream): the tokens and cost
// the coding tool's own result line reports, kept as they are; a result line without usage and a run file of an
// earlier version say "not reported" (null), never 0.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-used');
test.after(() => t.cleanup());
const { checkRun, newRunId, readRun, tokensOf, usedOf, viewRun, writeRun, writerId } = await import('../../src/work/runs.mjs');
const { readStream } = await import('../../src/work/alone.mjs');

const place = { folder: path.join(t.root, 'workdata'), label: 'ai_brain/work' };
fs.mkdirSync(place.folder, { recursive: true });
const base = () => ({
  v: 1, id: newRunId(new Date('2026-11-17T10:00:00Z')), item: 'renew-the-domain', title: 'Renew the domain', writer: writerId(), by: 'schedule',
  startedAt: '2026-11-17T10:00:00.000Z', endedAt: '2026-11-17T10:40:00.000Z', project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: null, effort: null,
  session: null, conversation: null, message: null, brief: 'Renew the domain', state: 'done', reason: null, answer: 'Done.',
  commits: [], changed: [], more: 0, was: 'open', statusError: null, branch: 'work/renew-the-domain', schedule: null,
});

test('the result line\'s usage and cost are kept as the tool reported them', () => {
  const s = readStream([JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.4123, usage: { input_tokens: 1200, output_tokens: 3400, cache_read_input_tokens: 50000, cache_creation_input_tokens: 700 } })]);
  assert.deepEqual(s.result.used, { input: 1200, output: 3400, cacheRead: 50000, cacheWrite: 700, costUsd: 0.4123 });
  assert.equal(tokensOf(s.result.used), 55300);
  const none = readStream([JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })]);
  assert.equal(none.result.used, null, 'no usage reported: not reported, never zeros');
  assert.equal(usedOf({ input_tokens: 5 }, undefined).costUsd, null, 'no cost reported: null');
  for (const usage of [{}, { input_tokens: 'many' }, { service_tier: 'standard' }]) assert.equal(usedOf(usage, null), null, `${JSON.stringify(usage)}: not reported`);
  const empty = readStream([JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} })]);
  assert.equal(tokensOf(empty.result.used), null, 'a result line whose usage has no token counts: not reported');
});

test('a run file keeps `used`; one of an earlier version without it reads as not reported', () => {
  const r = { ...base(), used: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: null } };
  writeRun(place, r);
  assert.deepEqual(readRun(place, r.id).used, r.used);
  const old = { ...base(), id: newRunId(new Date('2026-11-16T10:00:00Z')) };
  writeRun(place, old);
  const back = readRun(place, old.id);
  assert.equal('used' in back, false);
  assert.equal(viewRun(back).used, null);
  assert.equal(tokensOf(back.used), null);
});

test('a bad `used` is refused: a negative, a fraction of a token, an unknown key, a string', () => {
  for (const used of [{ input: -1, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null }, { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null },
    { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, extra: 1 }, 'lots']) {
    assert.throws(() => checkRun({ ...base(), used }), /bad "used"/);
  }
});
