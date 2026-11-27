// The teller inside the dashboard (src/work/feature.mjs, tellwire.mjs): it sends through the product's own push
// channel (ctx.notify, forced past the events list: its own settings decide), nothing with today's settings, and
// the sample of his language is kept only while "Tia writes my digest" is on. With Tia off her provider is never asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { tempWork } from './helpers.mjs';
import { makeHistory } from './pulsehome.mjs';

const t = tempWork('work-tellwire');
test.after(() => t.cleanup());
const h = await makeHistory(t);
const { workFeature } = await import('../../src/work/feature.mjs');
const { ledgerFile } = await import('../../src/work/tell.mjs');
const { keepSample, sampleFile, tiaWorder } = await import('../../src/work/tellwire.mjs');

let cfg = { work: { timeZone: 'UTC' }, server: { notify: { url: 'http://127.0.0.1:8213/t' } } };
const got = [];
let NOW = h.NOW;
const f = workFeature({ config: () => cfg, readJson: async () => ({}), notify: async (ev) => (got.push(ev), { sent: true }) }, { now: () => new Date(NOW), alive: () => true });

test('today\'s settings: the dashboard tells nothing and writes no ledger', async () => {
  assert.deepEqual(await f.tell.tick(), { off: true });
  assert.equal(got.length, 0);
  assert.equal(fs.existsSync(ledgerFile()), false);
});

test('an item on: what waits for his look goes through the push channel, forced, as one message', async () => {
  cfg = { ...cfg, server: { notify: { ...cfg.server.notify, events: ['waiting'], work: { finished: true, gapMinutes: 0 } } } };
  await f.tell.tick(); // starts from now
  assert.equal(got.length, 0);
  // The task that waits for his look gets a newer run that finishes now.
  const { writeRun, newRunId, writerId } = await import('../../src/work/runs.mjs');
  NOW += 60_000;
  writeRun(h.place, {
    v: 1, id: newRunId(new Date(NOW - 600_000)), item: 'add-the-cart', title: 'Add the cart', writer: writerId(), by: 'owner', startedAt: new Date(NOW - 600_000).toISOString(),
    endedAt: new Date(NOW - 1000).toISOString(), project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: 'opus', effort: 'medium', session: null, conversation: null,
    message: null, brief: 'Do it', state: 'done', reason: null, answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null,
  });
  await f.tell.tick();
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { force: true, status: 'automation', session: 'work', title: 'Done: Add the cart', message: 'Open Work → Tasks to look at it and accept it.', url: '' });
});

test('the sample of his language is kept only while "Tia writes my digest" is on', () => {
  keepSample({ server: { notify: { url: 'x', work: { tiaWords: false } } } }, 'bhai kitna time lagega');
  assert.equal(fs.existsSync(sampleFile()), false);
  keepSample({ server: { notify: { url: 'x', work: { tiaWords: true } } } }, `bhai kitna time lagega ${'x'.repeat(500)}`);
  assert.equal(fs.readFileSync(sampleFile(), 'utf8').length, 200);
  keepSample({ server: { notify: { url: 'x', work: { tiaWords: false } } } }, 'again');
  assert.equal(fs.existsSync(sampleFile()), false, 'turned off: the sample goes');
});

test('with Tia off, her wording asks no provider and the plain digest goes', async () => {
  const w = tiaWorder({ cfg: () => ({ assistant: { enabled: false } }), log: () => {} });
  assert.equal(await w({ title: 'Work: {n1} done', lines: ['x'], values: { n1: '1' } }), null);
});

test('with an address of the dashboard set, a tap on the message opens Work (Activity for a failure)', async () => {
  const { writeRun, newRunId, writerId } = await import('../../src/work/runs.mjs');
  cfg = { ...cfg, server: { publicUrl: 'https://pc.example.invalid', notify: { url: 'http://127.0.0.1:8213/t', work: { finished: true, failed: true, gapMinutes: 0 } } } };
  got.length = 0;
  const run = (title, state) => {
    NOW += 60_000;
    writeRun(h.place, {
      v: 1, id: newRunId(new Date(NOW - 600_000)), item: state === 'done' ? 'add-the-cart' : `x-${state}`, title, writer: writerId(), by: 'owner', startedAt: new Date(NOW - 600_000).toISOString(),
      endedAt: new Date(NOW - 1000).toISOString(), project: 'shop', folder: '.', tool: 'claude', provider: 'sub', model: 'opus', effort: 'medium', session: null, conversation: null,
      message: null, brief: 'Do it', state, reason: state === 'done' ? null : 'The run ended in an error: the tests failed', answer: '', commits: [], changed: [], more: 0, was: 'open', statusError: null,
    });
  };
  run('Add the cart', 'done');
  await f.tell.tick();
  run('Broke it', 'failed');
  await f.tell.tick();
  assert.deepEqual(got.map((e) => [e.title, e.url]), [['Done: Add the cart', 'https://pc.example.invalid/#/work'], ['Failed: Broke it', 'https://pc.example.invalid/#/work/activity']]);
});
