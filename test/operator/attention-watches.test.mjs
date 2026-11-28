// The attention loop evaluates the owner's watches on the facts of each look: a push costs no model turn; a watch he asked to
// see as a row becomes a row of the list; a fired watch is not told twice.
import assert from 'node:assert/strict';
import test from 'node:test';
import { WatchStore } from '../../src/assistant/watches.mjs';
import { attention, publicAttention } from '../../src/operator/attention.mjs';

const board = (sessions) => ({ at: new Date(1_000_000).toISOString(), sessions, watched: [] });

test('a watch fires on the look that sees its condition: one push, then a row if he asked for one', () => {
  const pushed = [];
  const watches = new WatchStore({ file: null, now: () => 1_000_000, notify: (t) => pushed.push(t) });
  watches.add({ on: 'session', target: 'alpha', when: 'ends', tell: 'push' });
  watches.add({ on: 'session', target: 'beta', when: 'ends', tell: 'row' });
  const quiet = attention(board([{ name: 'alpha', state: 'working' }, { name: 'beta', state: 'working' }]), { now: 1_000_000, watches });
  assert.equal(quiet.items.filter((i) => i.subject.startsWith('Watch:')).length, 0);
  const l = attention(board([{ name: 'alpha', state: 'ended' }, { name: 'beta', state: 'ended' }]), { now: 1_000_000, watches });
  assert.deepEqual(pushed, ['session alpha ended.'], 'the push way, once, and none for a row');
  const rows = l.items.filter((i) => i.subject.startsWith('Watch:'));
  assert.equal(rows.length, 1);
  assert.match(rows[0].facts[0], /beta ended/);
  assert.equal(publicAttention(l).items.some((i) => i.subject === 'Watch: session beta'), true);
  attention(board([{ name: 'alpha', state: 'ended' }]), { now: 1_000_000, watches });
  assert.equal(pushed.length, 1, 'told once');
});

test('a list without watches is what it was', () => {
  const l = attention(board([{ name: 'a', state: 'ended', statusAt: new Date(999_000).toISOString() }]), { now: 1_000_000 });
  assert.equal(l.items.length, 1);
});
