import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomation } from '../../src/automation/index.mjs';
import * as queue from '../../src/automation/queue.mjs';
import { claude, fakeCtx, fakeDeck, recorder, tmpDir } from './helpers.mjs';

const withItems = (texts, extra = {}) => {
  let q;
  texts.forEach((t, i) => { q = queue.add(q, t, { now: 1, id: `id${i}` }); });
  return { ...q, ...extra };
};
const sentTexts = (r) => r.actions.filter((a) => a.type === 'send').map((a) => a.item.text);

test('queue: one message per finished reply, exactly once', () => {
  let data = { w: withItems(['A', 'B'], { kick: false }) };
  const step = (card) => {
    const r = queue.decide({ cards: [card], data, now: 1000 });
    data = r.data;
    return sentTexts(r);
  };
  assert.deepEqual(step(claude('w', { status: 'working', stopAt: null })), [], 'working: wait');
  assert.deepEqual(step(claude('w', { status: 'waiting', stopAt: 100 })), ['A'], 'reply finished: next message');
  assert.deepEqual(step(claude('w', { status: 'waiting', stopAt: 100 })), [], 'same reply: never twice');
  assert.deepEqual(step(claude('w', { status: 'working', stopAt: 100 })), []);
  assert.deepEqual(step(claude('w', { status: 'waiting', stopAt: 200 })), ['B']);
  assert.deepEqual(step(claude('w', { status: 'waiting', stopAt: 300 })), [], 'empty');
  assert.equal(data.w.sentFor, 200, 'kept while the session lives, so a new message cannot go out for reply 200');
});

test('queue: never into attention, an error, a limit, or a busy session', () => {
  const data = { w: withItems(['A']) };
  const blocked = [
    claude('w', { status: 'attention', attentionKind: 'permission_prompt', stopAt: 5 }),
    claude('w', { status: 'attention', stopAt: 5 }),
    claude('w', { status: 'waiting', stopAt: 5, failure: { at: 5, error: 'server_error' } }),
    claude('w', { status: 'waiting', stopAt: 5, limit: { text: 'limit reached' } }),
    claude('w', { status: 'waiting', stopAt: 5, runLimit: { at: 5, error: 'rate_limit' } }),
    claude('w', { status: 'working', stopAt: 5 }),
    claude('w', { status: 'starting', stopAt: 5 }),
    { name: 'w', kind: 'shell', command: 'zsh' },
  ];
  for (const c of blocked) assert.deepEqual(sentTexts(queue.decide({ cards: [c], data, now: 1 })), [], JSON.stringify(c));
  const idleReminder = claude('w', { status: 'attention', attentionKind: 'idle_prompt', stopAt: 5 });
  assert.deepEqual(sentTexts(queue.decide({ cards: [idleReminder], data, now: 1 })), ['A'], 'the "waiting for your input" reminder is still idle');
});

test('queue: a message added to a waiting session goes at once; to a reopened run only after a reply', () => {
  // kick from add(): a fresh session (no reply yet) that waits gets it now.
  let r = queue.decide({ cards: [claude('w', { stopAt: null, runId: 'r1' })], data: { w: withItems(['A']) }, now: 1 });
  assert.deepEqual(sentTexts(r), ['A']);
  r = queue.decide({ cards: [claude('w', { stopAt: null, runId: 'r1' })], data: { w: { ...r.data.w, ...queue.add(r.data.w, 'B', { now: 2, id: 'b' }) } }, now: 2 });
  assert.deepEqual(sentTexts(r), [], 'one message per reply even with a kick: B waits for the reply to A');
  // A queue left over from before a restart: the run changed, the old kick does not fire.
  const old = { ...withItems(['C']), runId: 'r1', sentFor: 100 };
  r = queue.decide({ cards: [claude('w', { stopAt: null, runId: 'r2' })], data: { w: old }, now: 3 });
  assert.deepEqual(sentTexts(r), [], 'reopened session: nothing is typed until Claude finished a reply');
  r = queue.decide({ cards: [claude('w', { stopAt: 400, runId: 'r2' })], data: r.data, now: 4 });
  assert.deepEqual(sentTexts(r), ['C']);
});

test('queue: pause holds it, resume sends at the next idle moment', () => {
  let q = queue.pause(withItems(['A'], { kick: false, sentFor: 100 }), true);
  let r = queue.decide({ cards: [claude('w', { stopAt: 200 })], data: { w: q }, now: 1 });
  assert.deepEqual(sentTexts(r), []);
  q = queue.pause(r.data.w, false);
  r = queue.decide({ cards: [claude('w', { stopAt: 200 })], data: { w: q }, now: 2 });
  assert.deepEqual(sentTexts(r), ['A']);
  assert.throws(() => queue.pause(q, 'yes'), /true or false/);
});

test('queue: owner operations and their refusals', () => {
  let q = withItems(['A', 'B', 'C']);
  q = queue.move(q, 'id2', 0);
  assert.deepEqual(q.items.map((x) => x.text), ['C', 'A', 'B']);
  q = queue.move(q, 'id2', 99);
  assert.deepEqual(q.items.map((x) => x.text), ['A', 'B', 'C']);
  q = queue.remove(q, 'id1');
  assert.deepEqual(q.items.map((x) => x.text), ['A', 'C']);
  q = queue.add(q, 'first', { now: 1, id: 'f', position: 0 });
  assert.equal(q.items[0].text, 'first');
  assert.throws(() => queue.remove(q, 'nope'), (e) => e.status === 404);
  assert.throws(() => queue.move(q, 'f', -1), /whole number/);
  assert.throws(() => queue.add(q, '   ', { id: 'x' }), /empty/);
  assert.throws(() => queue.add(q, 'a\0b', { id: 'x' }), /NUL/);
  assert.throws(() => queue.add(q, 'é'.repeat(16 * 1024 + 1), { id: 'x' }), /32 KiB/);
  assert.equal(queue.add(undefined, 'x'.repeat(32 * 1024), { id: 'x' }).items.length, 1, 'exactly 32 KiB is fine');
  let full;
  for (let i = 0; i < 100; i++) full = queue.add(full, `m${i}`, { id: `i${i}` });
  assert.throws(() => queue.add(full, 'one more', { id: 'z' }), /at most 100/);
  assert.equal(queue.add(undefined, 'a\r\nb', { id: 'x' }).items[0].text, 'a\nb');
});

test('queue: a gone session keeps its messages for a day, then they are dropped', () => {
  let r = queue.decide({ cards: [], data: { w: withItems(['A']) }, now: 1000 });
  assert.equal(r.data.w.goneAt, 1000);
  r = queue.decide({ cards: [], data: r.data, now: 1000 + queue.GONE_KEEP_MS });
  assert.ok(r.data.w, 'still kept at exactly a day');
  r = queue.decide({ cards: [], data: r.data, now: 1001 + queue.GONE_KEEP_MS });
  assert.equal(r.data.w, undefined);
  assert.deepEqual(r.actions, [{ type: 'drop', session: 'w', count: 1 }]);
  assert.deepEqual(queue.decide({ cards: [], data: { e: { items: [] } }, now: 1 }).data, {}, 'an empty queue of a gone session is not kept');
});

test('queue: a rename takes the queue along (same run, new name)', () => {
  const data = { old: { ...withItems(['A']), runId: 'r7', kick: false, sentFor: 100 } };
  const r = queue.decide({ cards: [claude('new', { runId: 'r7', stopAt: 200 })], data, now: 1 });
  assert.deepEqual(Object.keys(r.data), ['new']);
  assert.deepEqual(r.actions.map((a) => a.type), ['renamed', 'send']);
  assert.equal(r.actions[1].item.text, 'A');
  // The new name has messages of its own: nothing is merged or overwritten.
  const both = { old: { ...withItems(['A']), runId: 'r7' }, new: { ...withItems(['B']), runId: 'r7' } };
  assert.deepEqual(Object.keys(queue.decide({ cards: [claude('new', { runId: 'r7', status: 'working' })], data: both, now: 1 }).data).sort(), ['new', 'old']);
});

test('queue apply: a failed send goes back to the front and is logged', async () => {
  const deck = fakeDeck();
  deck.failSend = true;
  const rec = recorder();
  const back = [];
  await queue.apply([{ type: 'send', session: 'w', item: { id: 'a', text: 'hello' } }], { deck, record: rec.record, putBack: (s, i) => back.push([s, i.id]) });
  assert.deepEqual(back, [['w', 'a']]);
  assert.match(rec.entries[0].outcome, /^failed: the terminal is gone/);
});

test('queue: the coding tool was not in front: the message stays first, says why once, and goes when a tool waits again', async () => {
  const t = tmpDir('queue-front');
  try {
    const deck = fakeDeck([claude('w', { stopAt: 500, runId: 'r1' })]);
    const a = createAutomation(fakeCtx({ deck, stateDir: t.dir, now: () => 1000 }).ctx);
    a.enqueue('w', 'A');
    a.enqueue('w', 'B');
    deck.notInFront = 'Nothing was typed: no coding tool runs in session "w" now';
    for (let i = 0; i < 4; i++) await a.tick();
    assert.deepEqual(a.api.queueOf('w').items.map((x) => x.text), ['A', 'B'], 'kept, in its order');
    assert.equal(a.api.queueOf('w').waits, queue.HELD_WHY, 'the sheet says why');
    assert.equal(a.api.status().queues.w.waits, queue.HELD_WHY, 'and so does the Queue page\'s row');
    const rows = a.activity.recent(20).filter((x) => x.automation === 'queue');
    assert.deepEqual(rows.map((x) => [x.did, x.outcome]), [['not delivered: A', `waits in the queue: ${deck.notInFront}`]], 'recorded once, not at every tick');
    assert.equal(a.api.queueOf('w').items[0].tries, undefined, 'not counted as a failed try');
    // A new run of the coding tool waits there, before any reply of its own ended: the held message goes now.
    deck.notInFront = null;
    deck.cards = [claude('w', { stopAt: null, runId: 'r2' })];
    await a.tick();
    assert.deepEqual(deck.sent, [['w', 'A']]);
    assert.equal(a.api.queueOf('w').waits, undefined, 'no longer waiting');
    assert.equal(a.api.status().queues.w.waits, undefined);
    await a.tick();
    assert.deepEqual(deck.sent, [['w', 'A']], 'the next one waits for a reply as always');
    await a.close();
  } finally {
    t.cleanup();
  }
});

test('queue: emptied by Clear all or by removing its last message, it no longer says why it waits', async () => {
  const t = tmpDir('queue-unheld');
  try {
    const deck = fakeDeck([claude('w', { stopAt: 500, runId: 'r1' })]);
    const a = createAutomation(fakeCtx({ deck, stateDir: t.dir, now: () => 1000 }).ctx);
    deck.notInFront = 'Nothing was typed: no coding tool runs in session "w" now';
    a.enqueue('w', 'A');
    await a.tick();
    assert.equal(a.api.queueOf('w').waits, queue.HELD_WHY);
    await a.api.changeQueue('w', 'clear', {});
    assert.equal(a.api.queueOf('w').waits, undefined, 'Clear all: no reason over an empty list');
    assert.equal(a.api.status().queues.w.waits, undefined);
    deck.cards = [claude('w', { stopAt: 600, runId: 'r1' })]; // another reply ended: the next message is tried
    a.enqueue('w', 'B');
    await a.tick();
    assert.equal(a.api.queueOf('w').waits, queue.HELD_WHY);
    await a.api.changeQueue('w', 'remove', { id: a.api.queueOf('w').items[0].id });
    assert.equal(a.api.queueOf('w').waits, undefined, 'its last message removed: the same');
    // A message added later waits for a finished reply again, as in any queue that holds nothing.
    deck.notInFront = null;
    a.enqueue('w', 'C');
    await a.tick();
    assert.deepEqual(deck.sent, [], 'not sent at once: the reply it waits for ended before it was added');
    await a.close();
  } finally {
    t.cleanup();
  }
  // The pure parts: removing one of two keeps the reason; an owner's own pause outlives an empty list.
  const held = { ...withItems(['A', 'B']), held: { why: 'x', at: 1 } };
  assert.deepEqual(queue.remove(held, 'id1').held, { why: 'x', at: 1 });
  assert.equal(queue.remove(queue.remove(held, 'id1'), 'id0').held, null);
  assert.equal(queue.unheld({ ...withItems([]), paused: true, held: { why: 'x', at: 1 } }).paused, true, 'the owner paused it');
  assert.equal(queue.unheld({ ...withItems([]), paused: true, held: { why: 'x', at: 1, paused: true } }).paused, false, 'it paused itself');
});

test('queue: a message typed but not sent pauses the queue with it first; resuming clears the reason', async () => {
  const t = tmpDir('queue-typed');
  try {
    const deck = fakeDeck([claude('w', { stopAt: 500, runId: 'r1' })]);
    const a = createAutomation(fakeCtx({ deck, stateDir: t.dir, now: () => 1000 }).ctx);
    a.enqueue('w', 'A');
    a.enqueue('w', 'B');
    deck.typedNotSent = 'The text was typed into session "w" but not sent';
    await a.tick();
    deck.typedNotSent = null;
    for (let i = 0; i < 3; i++) await a.tick();
    assert.deepEqual(deck.sent, [], 'not typed a second time by itself');
    const q = a.api.queueOf('w');
    assert.equal(q.paused, true);
    assert.deepEqual(q.items.map((x) => x.text), ['A', 'B']);
    assert.equal(q.waits, queue.TYPED_WHY);
    assert.equal(q.items[0].tries, undefined, 'not a failed try');
    const rows = a.activity.recent(20).filter((x) => x.automation === 'queue');
    assert.deepEqual(rows.map((x) => x.did), ['typed but not sent: A']);
    assert.match(rows[0].outcome, /^the queue is paused: The text was typed/);
    await a.api.changeQueue('w', 'pause', { paused: false });
    assert.equal(a.api.queueOf('w').waits, undefined);
    assert.equal(a.api.queueOf('w').paused, false);
    await a.tick();
    assert.deepEqual(deck.sent, [['w', 'A']], 'the owner resumed: it goes');
    await a.close();
  } finally {
    t.cleanup();
  }
});

test('queue: survives a restart of the service without sending twice', async () => {
  const t = tmpDir('queue');
  try {
    const deck = fakeDeck([claude('w', { status: 'working', stopAt: null })]);
    let a = createAutomation(fakeCtx({ deck, stateDir: t.dir, now: () => 1000 }).ctx);
    a.enqueue('w', 'A');
    a.enqueue('w', 'B');
    await a.tick();
    assert.deepEqual(deck.sent, []);
    deck.cards = [claude('w', { status: 'waiting', stopAt: 500 })];
    await a.tick();
    assert.deepEqual(deck.sent, [['w', 'A']]);
    await a.close();
    // The service restarts while Claude still shows the same finished reply.
    a = createAutomation(fakeCtx({ deck, stateDir: t.dir, now: () => 2000 }).ctx);
    await a.tick();
    await a.tick();
    assert.deepEqual(deck.sent, [['w', 'A']], 'no second message for reply 500');
    deck.cards = [claude('w', { status: 'waiting', stopAt: 900 })];
    await a.tick();
    assert.deepEqual(deck.sent, [['w', 'A'], ['w', 'B']]);
    await a.close();
  } finally {
    t.cleanup();
  }
});

test('queue: a failed send is tried again, then waits for the next reply', async () => {
  const t = tmpDir('queue-fail');
  try {
    const deck = fakeDeck([claude('w', { stopAt: 500 })]);
    const a = createAutomation(fakeCtx({ deck, stateDir: t.dir, now: () => 1000 }).ctx);
    a.enqueue('w', 'A');
    deck.failSend = true;
    for (let i = 0; i < 5; i++) await a.tick();
    assert.equal(a.api.queueOf('w').items.length, 1, 'never lost');
    deck.failSend = false;
    await a.tick();
    assert.deepEqual(deck.sent, [], 'after three failures it waits for the next reply');
    deck.cards = [claude('w', { stopAt: 600 })];
    await a.tick();
    assert.deepEqual(deck.sent, [['w', 'A']]);
    await a.close();
  } finally {
    t.cleanup();
  }
});
