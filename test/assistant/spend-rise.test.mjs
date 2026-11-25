// A paid act of Tia's that went into a chat (src/assistant/spend.mjs detail): the chat's measured cost stands in for
// the act's $0.50 only when the chat's figure ROSE after the act. A turn seen running that ended at the same figure
// (its coding tool crashed, no cost reported) measured nothing, so the act stays counted until the day ends. The
// chats are made up; the ledger lives in memory; nothing is asked of a provider.
import assert from 'node:assert/strict';
import test from 'node:test';

const { SpendLedger, HOLD_USD, measureChats } = await import('../../src/assistant/spend.mjs');

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

// A new conversation in a chat starts its running cost again at nothing (src/chat/run.mjs). What was measured before
// it stays in the sum: the chat's measured figure never goes down, and the new running cost adds to it.
const card = (costTotal, working = false, sessionId = undefined) => [{ kind: 'chat', name: 'chat:made-up-older', costTotal, status: working ? 'working' : 'idle', ...(sessionId ? { sessionId } : {}) }];

test('a new conversation in a chat she wrote to: what ran before it stays counted, and its own cost adds to it', (t) => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  assert.equal(l.take(5, { id: 'act-1' }), null);
  l.bind('act-1', KEY, 1.0);
  measureChats(l, card(1.5)); // her turn: $0.50
  measureChats(l, card(0.2)); // a new conversation: $0.20 so far
  measureChats(l, card(1.2)); // …then $1.20 in all of it
  const d = l.detail();
  t.diagnostic(`FIG new-conversation detail=${JSON.stringify(d)}`);
  assert.equal(d.spent, 1.7, '$0.50 before the new conversation and $1.20 in it');
});

test('after a new conversation the chat\'s own measure at its process end (its figure less the base) lowers nothing; its later turns add', (t) => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  assert.equal(l.take(5, { id: 'act-1' }), null);
  l.bind('act-1', KEY, 1.0);
  measureChats(l, card(1.5));
  measureChats(l, card(0.2, true)); // a new conversation, a turn of it runs
  measureChats(l, card(1.2));
  l.measure(KEY, 0.2, false); // src/chat/feature.mjs settleChat: costTotal 1.2 less the base 1.0
  assert.equal(l.detail().spent, 1.7, 'the same figure again: nothing lost');
  measureChats(l, card(1.45, true));
  measureChats(l, card(1.6));
  const d = l.detail();
  t.diagnostic(`FIG new-conversation-later detail=${JSON.stringify(d)}`);
  assert.equal(Math.round(d.spent * 100) / 100, 2.1, 'its next turn adds $0.40');
  assert.deepEqual([d.held, d.unmeasured], [0, 0], 'her act was settled by the rise of its first turn');
});

// The chat card names its conversation (sessionId): a new one is told by that, not only by a lower running cost. A
// rewind (src/chat/chat.mjs #forkAt) shows no running cost until the fork's first turn reports its own, which may be
// above the old one; a new conversation's first turn may end between two looks above the old figure too.
const near2 = (v) => Math.round(v * 100) / 100;
test('a rewind, then the fork reports more than the chat had: what ran before stays, and the fork\'s whole cost adds', (t) => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  assert.equal(l.take(10, { id: 'act-1' }), null);
  l.bind('act-1', KEY, 1.0);
  measureChats(l, card(1.0, true, 'conv-a'));
  measureChats(l, card(1.5, false, 'conv-a')); // her turn: $0.50
  measureChats(l, card(null, false, 'conv-b')); // the rewind: no running cost yet
  measureChats(l, card(1.8, false, 'conv-b')); // the fork's first turn: $1.80 of its own
  const d = l.detail();
  t.diagnostic(`FIG rewind detail=${JSON.stringify(d)}`);
  assert.equal(near2(d.spent), 2.3, '$0.50 before the rewind and $1.80 after it');
  measureChats(l, card(2.0, false, 'conv-b')); // its next turn: $0.20
  assert.equal(near2(l.detail().spent), 2.5, 'a rise in the same conversation adds what it rose by');
});

test('a new conversation whose first turn ended between two looks above the old figure: its whole cost adds', (t) => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  assert.equal(l.take(10, { id: 'act-1' }), null);
  l.bind('act-1', KEY, 1.0);
  measureChats(l, card(1.0, true, 'conv-a'));
  measureChats(l, card(1.5, false, 'conv-a'));
  measureChats(l, card(1.7, false, 'conv-b'));
  const d = l.detail();
  t.diagnostic(`FIG new-conversation-above detail=${JSON.stringify(d)}`);
  assert.equal(near2(d.spent), 2.2, '$0.50 before it and $1.70 in it');
  measureChats(l, card(1.7, false, 'conv-b'));
  assert.equal(near2(l.detail().spent), 2.2, 'the same look again counts nothing more');
});

// A message of hers whose turn ran in a new conversation below the chat's base: the measured figure holds that turn
// (the new conversation's running cost adds whole), so its own end settles its hold, and it is counted once.
test('a message whose turn ran below the chat\'s base after a new conversation: measured once, its own end settles its hold', (t) => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  const ends = { m1: { ended: true, cost: 0.5, total: 1.5 } };
  const me = (id, m) => ends[m] || null;
  assert.equal(l.take(10, { id: 'act-1' }), null);
  l.bind('act-1', KEY, 1.0, false, 'm1');
  measureChats(l, card(1.5, false, 'conv-a'), me); // her first turn: $0.50
  measureChats(l, card(0.6, false, 'conv-b'), me); // a new conversation: his turn, $0.60
  assert.equal(l.take(10, { id: 'act-2' }), null);
  l.bind('act-2', KEY, 0.6, false, 'm2');
  measureChats(l, card(0.9, false, 'conv-b'), me); // her second turn: $0.30, below the base of $1.00
  ends.m2 = { ended: true, cost: 0.3, total: 0.9 };
  measureChats(l, card(0.9, false, 'conv-b'), me);
  const d = l.detail();
  t.diagnostic(`FIG below-base detail=${JSON.stringify(d)} ends=${JSON.stringify(l.memory.filter((e) => e.kind === 'ended').map((e) => [e.hold, e.cost]))}`);
  assert.deepEqual([near2(d.spent), d.held, d.unmeasured], [1.4, 0, 0], '$0.50, $0.60 and $0.30 measured; no hold counts it again');
});

// Her turn ended between two looks, then a clear: the next look sees only the new conversation, so the measured figure
// never had her turn. The chat's total after it is of the old conversation, and the new one reaching that figure says
// nothing of it: her hold stays.
test('a message whose turn ended unseen before a new conversation keeps its hold, though the new one passes its total', (t) => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  const ends = {};
  const me = (id, m) => ends[m] || null;
  measureChats(l, card(1.0, false, 'conv-a'), me); // nothing bound yet: nothing written
  assert.equal(l.take(10, { id: 'act-1' }), null);
  l.bind('act-1', KEY, 1.0, false, 'm1');
  measureChats(l, card(1.0, false, 'conv-a'), me);
  ends.m1 = { ended: true, cost: 0.5, total: 1.5 }; // her turn, 1.0 -> 1.5, ended before a look saw it
  measureChats(l, card(0.2, false, 'conv-b'), me); // a clear, then his turn: $0.20
  measureChats(l, card(1.6, false, 'conv-b'), me); // …$1.60 in all of it
  const d = l.detail();
  t.diagnostic(`FIG unseen-then-clear detail=${JSON.stringify(d)} ends=${JSON.stringify(l.memory.filter((e) => e.kind === 'ended').map((e) => [e.hold, e.cost]))}`);
  assert.ok(d.spent + d.held + 1e-9 >= 2.1, `$0.50 of hers and $1.60 of the new conversation ran: ${JSON.stringify(d)}`);
  assert.deepEqual([near2(d.spent), d.held, d.unmeasured], [1.6, HOLD_USD, 1]);
});
