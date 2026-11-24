// A paid act of Tia's that went into a chat (src/assistant/spend.mjs detail): the chat's measured cost stands in for
// the act's $0.50 only when the chat's figure ROSE after the act. A turn seen running that ended at the same figure
// (its coding tool crashed, no cost reported) measured nothing, so the act stays counted until the day ends. The
// chats are made up; the ledger lives in memory; nothing is asked of a provider.
import assert from 'node:assert/strict';
import test from 'node:test';

const { SpendLedger, HOLD_USD } = await import('../../src/assistant/spend.mjs');

const KEY = 'this|chat:made-up-older';
/** A $5 limit; an older chat that had cost $0.30 today before her act went into it. */
function older() {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  // Her first act into it today, measured: its figure rose to $0.30 (that act's turn ended and reported).
  assert.equal(l.take(5, { id: 'act-1' }), null);
  l.bind('act-1', KEY, 1.0);
  l.measure(KEY, 0.1, true);
  l.measure(KEY, 0.3, false);
  // Her second act into it (a message she typed there).
  assert.equal(l.take(5, { id: 'act-2' }), null);
  l.bind('act-2', KEY, 1.0);
  return l;
}

test('an act of hers into a chat whose figure did not rise after it stays counted at $0.50', (t) => {
  const l = older();
  l.measure(KEY, 0.3, true);
  l.measure(KEY, 0.3, false);
  const d = l.detail();
  t.diagnostic(`FIG flat detail=${JSON.stringify(d)}`);
  assert.deepEqual(d, { spent: 0.3, held: HOLD_USD, unmeasured: 1, tapped: 0 }, 'the first act measured, the second still counted');
});

test('an act of hers into a chat whose figure rose after it: the measured cost stands in its place', (t) => {
  const l = older();
  l.measure(KEY, 0.35, true);
  l.measure(KEY, 0.42, false);
  const d = l.detail();
  t.diagnostic(`FIG rose detail=${JSON.stringify(d)}`);
  assert.deepEqual(d, { spent: 0.42, held: 0, unmeasured: 0, tapped: 0 });
});

test('a chat she just started whose turn ended at $0 is no measure: its act stays counted; a rise later settles it', (t) => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  assert.equal(l.take(5, { id: 'act-new' }), null);
  l.bind('act-new', 'this|chat:made-up-new', 0, true);
  l.measure('this|chat:made-up-new', 0, true);
  l.measure('this|chat:made-up-new', 0, false);
  assert.deepEqual(l.detail(), { spent: 0, held: HOLD_USD, unmeasured: 1, tapped: 0 });
  l.measure('this|chat:made-up-new', 0.02, false);
  assert.deepEqual(l.detail(), { spent: 0.02, held: 0, unmeasured: 0, tapped: 0 });
});

/** An older chat where her first act's turn still runs when her second act goes in (its message waits in the queue). */
function queued() {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  assert.equal(l.take(5, { id: 'act-1' }), null);
  l.bind('act-1', KEY, 0);
  l.measure(KEY, 0.1, true); // act-1's turn runs
  assert.equal(l.take(5, { id: 'act-2' }), null);
  l.bind('act-2', KEY, 0);
  return l;
}

test('an act queued behind a turn that ran before it: that turn ending at a higher figure is not this act\'s cost', (t) => {
  const l = queued();
  l.measure(KEY, 0.2, true); // still act-1's turn
  l.measure(KEY, 0.3, false); // act-1's turn ended; act-2's message has not run yet
  const d = l.detail();
  t.diagnostic(`FIG queued detail=${JSON.stringify(d)}`);
  assert.deepEqual(d, { spent: 0.3, held: HOLD_USD, unmeasured: 1, tapped: 0 });
});

test('a queued act whose own turn then runs and ends at the same figure (no cost reported) stays counted at $0.50', (t) => {
  const l = queued();
  l.measure(KEY, 0.3, false); // act-1's turn ended and reported
  l.measure(KEY, 0.3, true); // act-2's own turn runs now
  l.measure(KEY, 0.3, false); // and ends at the same figure: its coding tool crashed
  const d = l.detail();
  t.diagnostic(`FIG queued-crash detail=${JSON.stringify(d)}`);
  assert.deepEqual(d, { spent: 0.3, held: HOLD_USD, unmeasured: 1, tapped: 0 });
});

test('a queued act whose own turn then runs and ends higher: the measured cost stands in its place', (t) => {
  const l = queued();
  l.measure(KEY, 0.3, false); // act-1's turn ended and reported
  l.measure(KEY, 0.35, true); // act-2's own turn runs now
  l.measure(KEY, 0.5, false); // and ends higher: it reported its cost
  const d = l.detail();
  t.diagnostic(`FIG queued-rose detail=${JSON.stringify(d)}`);
  assert.deepEqual(d, { spent: 0.5, held: 0, unmeasured: 0, tapped: 0 });
});
