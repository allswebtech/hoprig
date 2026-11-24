import assert from 'node:assert/strict';
import test from 'node:test';
import { detectEnded } from '../../src/operator/detect/ended.mjs';
import { NOW, ago, calm, session } from './fixtures/cases.mjs';

test('a session whose tool ended and a failed Work run are items; the failed run counts as stopped work', () => {
  const board = {
    sessions: [session({ name: 'docs', state: 'ended', statusAt: ago(15) })],
    work: { runs: [
      { id: 'r-20260310-a1', title: 'Fix the login page', state: 'failed', endedAt: ago(30), reason: 'the tests failed', project: 'shop' },
      { id: 'r-20260310-a2', title: 'Write the notes', state: 'done', endedAt: ago(5) },
      { id: 'r-20260310-a3', title: 'Still going', state: 'running', endedAt: null },
    ] },
  };
  const items = detectEnded(board, { now: NOW });
  assert.deepEqual(items.map((i) => i.subject), ['session docs', 'Work run r-20260310-a1', 'Work run r-20260310-a2']);
  assert.equal(items[0].acts[0].href, '#/s/docs');
  assert.equal(items[1].class, 'stopped');
  assert.ok(items[1].facts.includes('"Fix the login page" failed 30 min ago'), items[1].facts.join('|'));
  assert.ok(items[1].facts.includes('reason: the tests failed'));
  assert.equal(items[2].class, 'info');
});

test('what ended more than a day ago is not shown again', () => {
  const board = { sessions: [session({ state: 'ended', statusAt: ago(25 * 60) })], work: { runs: [{ id: 'r1', title: 'Old', state: 'failed', endedAt: ago(30 * 60) }] } };
  assert.deepEqual(detectEnded(board, { now: NOW }), []);
});

test('nothing ended, or no source: nothing', () => {
  assert.deepEqual(detectEnded(calm, { now: NOW }), []);
  assert.deepEqual(detectEnded({ sessions: null, work: null }, { now: NOW }), []);
});

test('a session that ended again later is a new rev', async () => {
  const { session } = await import('./fixtures/cases.mjs');
  const rev = (at) => detectEnded({ sessions: [session({ name: 'c', state: 'ended', statusAt: at })] }, { now: NOW })[0].rev;
  assert.notEqual(rev(ago(300)), rev(ago(5)));
});

test('a Work run of a task another program added names its Work token among the facts', () => {
  const board = { sessions: [], work: { runs: [{ id: 'r-20260310-b1', title: 'Check the prices', state: 'done', endedAt: ago(5), from: 'Shop script' }, { id: 'r-20260310-b2', title: 'Mine', state: 'done', endedAt: ago(6) }] } };
  const [theirs, mine] = detectEnded(board, { now: NOW });
  assert.ok(theirs.facts.includes('added by another program (the Work token "Shop script")'), theirs.facts.join('|'));
  assert.ok(!mine.facts.some((f) => /Work token/.test(f)));
});
