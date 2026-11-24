// The new bgCommands field (a background command still running while a session waits) must change NOTHING for the
// readers that ACT on a session's status: the queue's ready test (busy), the stuck detector and a computer's working
// count. They key on the status, which stays 'waiting'; none reads bgCommands. (The "it waits for you" notification is
// status-driven too — src/server/notify.mjs reads the 'waiting' status, not this field.)
import assert from 'node:assert/strict';
import test from 'node:test';

const { busy } = await import('../../src/automation/cards.mjs');
const { detectStuck, STUCK_MS } = await import('../../src/operator/detect/stuck.mjs');
const { ownFacts } = await import('../../src/operator/rooms.mjs');

test('the queue\'s ready test (busy) ignores bgCommands: a waiting chat with a background command is not busy', () => {
  assert.equal(busy({ kind: 'chat', status: 'waiting' }), false);
  assert.equal(busy({ kind: 'chat', status: 'waiting', bgCommands: 3 }), false, 'a background command does not make a waiting session busy');
  assert.equal(busy({ kind: 'chat', status: 'working' }), true, 'only a working (or starting) session is busy');
});

test('the stuck detector ignores bgCommands: a waiting session with a background command is never a stuck item', () => {
  const now = 10 * STUCK_MS;
  const base = { name: 'shop', progressAt: now - STUCK_MS - 1000, toolNow: null };
  // A working session with no progress for 20 min IS stuck; the same facts as a waiting session (with a background
  // command) are NOT — a waiting session waits for a reason already said, and the command is not "no progress".
  assert.equal(detectStuck({ sessions: [{ ...base, state: 'working' }] }, { now }).length, 1);
  assert.equal(detectStuck({ sessions: [{ ...base, state: 'waiting', bgCommands: 2 }] }, { now }).length, 0, 'waiting is never stuck, whatever bgCommands says');
});

test('a computer\'s working count ignores bgCommands: a waiting session with a background command is not counted busy', () => {
  const sessions = [{ status: 'working' }, { status: 'waiting', bgCommands: 5 }, { status: 'waiting' }];
  assert.equal(ownFacts({ sessions }).working, 1, 'only the truly working session counts toward "Busy"');
});
