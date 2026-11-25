// What a chat knows of each message's end, for Tia's spending ledger (spend.mjs measureChats): the turn of a message
// ended with the cost it reported (or none: a crash, a failed start, a stop), a message taken inside a running turn
// ends with the turn that took it, and a message taken back (or lost with the process) never ran. No process runs:
// the coding tool's events are heard as they would arrive.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('msgend');
test.after(() => box.cleanup());
const { Chat } = await import('../../src/chat/chat.mjs');
const { hear } = await import('../../src/chat/hear.mjs');
const { SpendLedger, measureChats } = await import('../../src/assistant/spend.mjs');

function newChat(o = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const argsFile = path.join(cwd, '..', `${path.basename(cwd)}.args`);
  return new Chat({ id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }), ...o });
}
const session = { kind: 'session', version: '9', tools: [], commands: [], skills: [], agents: [], model: 'm', mode: 'default' };
const queued = (c, id) => c.queue.items.push({ id, text: `text of ${id}`, attachments: [], state: 'sent', at: 0 });
const end = (c, costUsd, ok = costUsd !== null) => hear(c, { kind: 'turn-end', ok, subtype: ok ? 'success' : 'error_during_execution', error: ok ? null : 'it broke', costUsd, usage: null, durationMs: 1 });
// Claude Code starts the queued message `id` after the turn: it says a turn starts, then whose it is.
const runs = (c, id) => {
  hear(c, session);
  hear(c, { kind: 'user', messageId: id, text: `text of ${id}`, attachments: [] });
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

test('(1) a message queued behind his running turn: his end tells nothing of hers; hers ends with its own cost', () => {
  const c = newChat({ costTotal: 1 });
  c.turn = { messageId: 'his', auto: false, at: 0 };
  queued(c, 'hers');
  assert.equal(c.messageEnd('hers'), null, 'not ended yet');
  end(c, 1.2);
  assert.equal(c.messageEnd('hers'), null, 'his turn ended, hers has not run');
  assert.ok(near(c.messageEnd('his').cost, 0.2), 'his own turn ended with what it cost');
  runs(c, 'hers');
  assert.equal(c.messageEnd('hers'), null, 'hers runs');
  end(c, 1.5);
  const e = c.messageEnd('hers');
  assert.equal(e.ended, true);
  assert.ok(near(e.cost, 0.3) && near(e.total, 1.5), JSON.stringify(e));
});

test('(2) two messages sent inside one tick: the first one\'s end is only its own', () => {
  const c = newChat({ costTotal: 0 });
  c.turn = { messageId: 'm1', auto: false, at: 0 };
  queued(c, 'm2');
  end(c, 0.1);
  assert.ok(near(c.messageEnd('m1').cost, 0.1));
  assert.equal(c.messageEnd('m2'), null);
  runs(c, 'm2');
  end(c, 0.3);
  assert.ok(near(c.messageEnd('m2').cost, 0.2) && near(c.messageEnd('m2').total, 0.3));
});

test('(3) a turn that ended without a cost (a crash), then one that reported: the first has no cost, the other its own', () => {
  const c = newChat({ costTotal: 0.1 });
  c.turn = { messageId: 'a', auto: false, at: 0 };
  queued(c, 'b');
  end(c, null, false);
  assert.deepEqual(c.messageEnd('a'), { ended: true, cost: null, total: 0.1 });
  runs(c, 'b');
  end(c, 0.4);
  assert.ok(near(c.messageEnd('b').cost, 0.3));
  assert.equal(c.messageEnd('a').cost, null, 'the later cost is not the crashed one\'s');
});

test('(4) three queued, the last one\'s process gone inside its turn: only it ends without a cost', () => {
  const c = newChat({ costTotal: 0 });
  c.turn = { messageId: 'm1', auto: false, at: 0 };
  queued(c, 'm2');
  queued(c, 'm3');
  end(c, 0.1);
  runs(c, 'm2');
  end(c, 0.3);
  runs(c, 'm3');
  hear(c, { kind: 'exit', code: 1 });
  assert.ok(near(c.messageEnd('m1').cost, 0.1));
  assert.ok(near(c.messageEnd('m2').cost, 0.2));
  assert.deepEqual(c.messageEnd('m3'), { ended: true, cost: null, total: 0.3 });
});

test('(5) taken back from the queue, cancelled by the coding tool, or lost with the process: given back', async () => {
  const c = newChat({ costTotal: 0 });
  c.turn = { messageId: 'm1', auto: false, at: 0 };
  queued(c, 'mine');
  queued(c, 'its');
  queued(c, 'lost');
  await c.unqueue('mine');
  assert.deepEqual(c.messageEnd('mine'), { back: true });
  hear(c, { kind: 'queue-state', state: 'cancelled', messageId: 'its' });
  assert.deepEqual(c.messageEnd('its'), { back: true });
  assert.equal(c.messageEnd('lost'), null, 'still waiting');
  hear(c, { kind: 'exit', code: 1 });
  assert.deepEqual(c.messageEnd('lost'), { back: true });
  assert.deepEqual(c.messageEnd('m1'), { ended: true, cost: null, total: 0 }, 'the running turn ended with the process');
  const d = newChat({ costTotal: 0 });
  d.turn = { messageId: 'x', auto: false, at: 0 };
  queued(d, 'all');
  await d.takeBack();
  assert.deepEqual(d.messageEnd('all'), { back: true }, 'Stop takes back what waits: never ran');
});

test('(7) a queued message taken inside the running turn ends with the turn that took it', () => {
  for (const crash of [false, true]) {
    const c = newChat({ costTotal: 1 });
    c.turn = { messageId: 'his', auto: false, at: 0 };
    queued(c, 'hers');
    hear(c, { kind: 'queue-state', state: 'started', messageId: 'hers' });
    hear(c, { kind: 'user', messageId: 'hers', text: 'text of hers', attachments: [] });
    assert.equal(c.turn.messageId, 'his', 'the turn stays his (its end is kept with his message)');
    assert.deepEqual(c.turn.took, ['hers'], 'once, though it was said twice');
    assert.equal(c.messageEnd('hers'), null, 'that turn runs');
    end(c, crash ? null : 1.5, !crash);
    const e = c.messageEnd('hers');
    assert.equal(e.ended, true);
    if (crash) assert.equal(e.cost, null, 'that turn crashed: no cost');
    else assert.ok(near(e.cost, 0.5) && near(e.total, 1.5), JSON.stringify(e));
  }
  // A turn the coding tool went on with by itself that takes her queued message: it is that turn's too.
  const c = newChat({ costTotal: 0 });
  hear(c, session);
  assert.equal(c.turn.auto, true);
  queued(c, 'late');
  hear(c, { kind: 'user', messageId: 'late', text: 'text of late', attachments: [] });
  end(c, 0.2);
  assert.ok(near(c.messageEnd('late').cost, 0.2));
});

// Tia's tick over real chats: measureChats with each chat's own messageEnd.
const cardOf = (c) => ({ kind: 'chat', name: `chat:${c.id}`, chatId: c.id, costTotal: Number.isFinite(c.costTotal) ? c.costTotal : null, status: c.status() });
const ledger = () => new SpendLedger({ file: null, now: () => new Date(2026, 10, 23, 12, 0).getTime() });
const tick = (l, chats) => measureChats(l, chats.map(cardOf), (id, m) => chats.find((x) => x.id === id)?.messageEnd(m) ?? null);
const act = (l, c, hold, message) => {
  assert.equal(l.take(5, { id: hold }), null);
  l.bind(hold, `this|chat:${c.id}`, Number.isFinite(c.costTotal) && c.costTotal > 0 ? c.costTotal : 0, false, message);
};
const ends = (l) => l.memory.filter((e) => e.kind === 'ended').map((e) => [e.hold, e.back ? 'back' : e.cost]);

test('(8) after a new conversation in the chat, a turn that began below the chat\'s base is measured once: its own end settles its hold', (t) => {
  const c = newChat({ costTotal: 1.0 });
  const l = ledger();
  c.turn = { messageId: 'm1', auto: false, at: 0 };
  act(l, c, 'act-1', 'm1');
  tick(l, [c]);
  end(c, 1.5); // her first message's turn: 0.5
  tick(l, [c]);
  // A new conversation: its running cost starts again; his turn brings it to 0.9, below the ledger's base of 1.0.
  c.costTotal = null;
  c.turn = { messageId: 'his', auto: false, at: 0 };
  end(c, 0.9);
  tick(l, [c]);
  act(l, c, 'act-2', 'm2'); // bound at 0.9; the chat's base stays 1.0 (its first bind)
  c.turn = { messageId: 'm2', auto: false, at: 0 };
  tick(l, [c]);
  end(c, 1.2); // her second message's turn: 0.3, from 0.9 to 1.2 (the new conversation's running cost adds whole)
  tick(l, [c]);
  const d = l.detail();
  t.diagnostic(`detail=${JSON.stringify(d)} ends=${JSON.stringify(ends(l))}`);
  // What ran: 0.5 of hers, 0.9 of his in the new conversation, 0.3 of hers: all of it measured, nothing held again.
  assert.ok(near(d.spent, 1.7) && d.held === 0, `act-2's turn cost 0.3 is measured once: ${JSON.stringify(d)}`);
  assert.deepEqual(ends(l), [['act-1', 0.5], ['act-2', 0.3]], 'act-2 ends with its cost: the measured figure holds it');
});

test('(10) a new conversation, her turn below the base, then a dashboard restart: the kept end settles her hold once', async (t) => {
  const { loadConfig } = await import('../../src/config.mjs');
  const { chatFeature } = await import('../../src/chat/feature.mjs');
  const { rememberTurn } = await import('../../src/chat/turns.mjs');
  const proj = path.join(box.root, 'proj', 'shop');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(box.root, 'restart', 'chats.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const turnsDir = path.join(path.dirname(file), 'chat-turns');
  const id = crypto.randomUUID();
  const conv2 = crypto.randomUUID(); // the new conversation
  const key = `this|chat:${id}`;
  const l = ledger();
  const card = (costTotal) => [{ kind: 'chat', name: `chat:${id}`, chatId: id, costTotal, status: 'waiting' }];
  // act-1 at base 1.0, its turn 0.5, settled by its own end.
  assert.equal(l.take(5, { id: 'act-1' }), null);
  l.bind('act-1', key, 1.0, false, 'm1');
  measureChats(l, card(1.5), (x, m) => (m === 'm1' ? { ended: true, cost: 0.5, total: 1.5 } : null));
  // A new conversation: his turn to 0.6 (below the base; its running cost adds whole to the measured figure); act-2 bound at 0.6.
  measureChats(l, card(0.6), () => null);
  assert.equal(l.take(5, { id: 'act-2' }), null);
  l.bind('act-2', key, 0.6, false, 'm2');
  // Her turn, 0.6 -> 0.9, heard by the chat before the restart: its end is kept beside the chats.
  const c = newChat({ id, conversationId: conv2, costTotal: 0.6, turnsDir });
  c.turn = { messageId: 'm2', auto: false, at: 0 };
  end(c, 0.9);
  // A turn end kept by an earlier version: no total of the chat.
  rememberTurn(turnsDir, conv2, 'm0', { kind: 'turn-end', ok: true, subtype: 'success', turnCostUsd: 0.1 });
  // The dashboard restarts before a tick saw her end; his next turn then brings the chat to 1.5.
  fs.writeFileSync(file, JSON.stringify([{ id, conversationId: conv2, cwd: proj, profile: 'p', title: 'shop', openedAt: 1, costTotal: 1.5 }]));
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  const f = chatFeature({ HttpError, config: () => loadConfig(), readJson: async () => ({}) }, { file });
  t.after(() => f.close());
  const seen = f.messageEnd(id, 'm2');
  measureChats(l, card(1.5), (x, m) => f.messageEnd(x, m));
  const d = l.detail();
  t.diagnostic(`fallback=${JSON.stringify(seen)} detail=${JSON.stringify(d)} ends=${JSON.stringify(ends(l))}`);
  // Her 0.3 ran from 0.6 to 0.9, below the base, and his next turn to 1.5: the measured figure holds 0.5 + 0.6 + 0.9,
  // so her hold goes by its kept end (its total, 0.9, is under the card's 1.5), and nothing is counted twice.
  assert.ok(near(d.spent, 2) && d.held === 0, `all that ran is measured once: ${JSON.stringify(d)}`);
  assert.ok(seen && near(seen.cost, 0.3) && near(seen.total, 0.9), `the kept end says the chat's total after her turn: ${JSON.stringify(seen)}`);
  assert.deepEqual(ends(l), [['act-1', 0.5], ['act-2', 0.3]]);
  assert.deepEqual(f.messageEnd(id, 'm0'), { ended: true, cost: 0.1, total: null }, 'no total kept: not known (its hold stays)');
});

test('(11) Stop: a queued message the coding tool refused to give back (it took it) keeps its hold when the process ends', async (t) => {
  for (const heard of [false, true]) {
    const c = newChat({ costTotal: 1, stopGraceMs: 10 });
    const l = ledger();
    c.turn = { messageId: 'his', auto: false, at: 0 };
    queued(c, 'hers');
    act(l, c, 'act-1', 'hers');
    c.queue.items.push({ id: 'held-one', text: 'text of held-one', attachments: [], state: 'held', at: 0 });
    act(l, c, 'act-2', 'held-one');
    c.session = { cancel: async () => false, send() {}, interrupt() {}, close: async () => {}, hold: null };
    const back = await c.takeBack(); // the Stop route: hers is refused (already taken), the held one comes back
    assert.equal(back.length, 1, 'the held one is taken back');
    if (heard) hear(c, { kind: 'queue-state', state: 'started', messageId: 'hers' });
    assert.equal(c.interrupt(), true);
    await new Promise((r) => setTimeout(r, 60)); // the grace: the coding tool did not end the turn, the process is stopped
    tick(l, [c]);
    t.diagnostic(`startedHeard=${heard} hers=${JSON.stringify(c.messageEnd('hers'))} detail=${JSON.stringify(l.detail())} ends=${JSON.stringify(ends(l))}`);
    // Hers was started by the coding tool, then stopped: no cost, its hold stays for the day.
    assert.deepEqual(c.messageEnd('hers'), { ended: true, cost: null, total: 1 }, `startedHeard=${heard}`);
    assert.deepEqual(c.messageEnd('held-one'), { back: true });
    assert.deepEqual(ends(l).sort(), [['act-1', null], ['act-2', 'back']]);
    assert.ok(l.detail().held >= 0.5 - 1e-9, 'act-1 keeps its $0.50');
  }
});

test('(12) a take-back whose cancel fails (an error, not a no): never said taken, and its hold stays when the process ends', async (t) => {
  const c = newChat({ costTotal: 1, stopGraceMs: 10 });
  const l = ledger();
  c.turn = { messageId: 'his', auto: false, at: 0 };
  queued(c, 'hers');
  act(l, c, 'act-1', 'hers');
  c.session = { cancel: async () => { throw new Error('the process is going'); }, send() {}, interrupt() {}, close: async () => {}, hold: null };
  // The answer says what is true: the cancel failed and the message may still run, not that the tool took it.
  await assert.rejects(c.unqueue('hers'), (e) => {
    assert.equal(e.status, 409);
    assert.doesNotMatch(e.message, /has already taken/);
    assert.match(e.message, /could not take that message back/);
    assert.match(e.message, /may still run/);
    return true;
  });
  const q = c.queue.find('hers');
  assert.ok(q, 'it still waits in the queue');
  assert.notEqual(q.taken, true, 'only a no from the coding tool marks it taken');
  assert.equal(c.messageEnd('hers'), null, 'not given back: it may still run');
  assert.equal((await c.takeBack()).length, 0, 'Stop does not hand it back to the composer either');
  assert.equal(c.interrupt(), true);
  await new Promise((r) => setTimeout(r, 60)); // the grace: the process is stopped with the message in it
  tick(l, [c]);
  t.diagnostic(`hers=${JSON.stringify(c.messageEnd('hers'))} detail=${JSON.stringify(l.detail())} ends=${JSON.stringify(ends(l))}`);
  // Not known whether the tool had it: the safe side, its hold stays for the day.
  assert.deepEqual(c.messageEnd('hers'), { ended: true, cost: null, total: 1 });
  assert.deepEqual(ends(l), [['act-1', null]]);
  assert.ok(l.detail().held >= 0.5 - 1e-9, 'act-1 keeps its $0.50');
});

test('(9) Stop while the chat starts: the running message ends without a cost, the queued ones are given back', (t) => {
  const c = newChat({ costTotal: 0 });
  const l = ledger();
  c.turn = { messageId: 'm1', auto: false, at: 0 }; // send() began the turn; the process is not there yet
  act(l, c, 'act-1', 'm1');
  queued(c, 'm2');
  act(l, c, 'act-2', 'm2');
  c.queue.items.push({ id: 'm3', text: 'text of m3', attachments: [], state: 'held', at: 0 }); // written while it started
  act(l, c, 'act-3', 'm3');
  c.stop();
  tick(l, [c]);
  const d = l.detail();
  t.diagnostic(`m1=${JSON.stringify(c.messageEnd('m1'))} m2=${JSON.stringify(c.messageEnd('m2'))} m3=${JSON.stringify(c.messageEnd('m3'))} detail=${JSON.stringify(d)} ends=${JSON.stringify(ends(l))}`);
  assert.deepEqual(c.messageEnd('m1'), { ended: true, cost: null, total: 0 }, 'stopped: no cost, its hold stays for the day');
  assert.deepEqual(c.messageEnd('m2'), { back: true });
  assert.deepEqual(c.messageEnd('m3'), { back: true }, 'm3 never ran: its hold is given back');
  assert.deepEqual(ends(l), [['act-1', null], ['act-2', 'back'], ['act-3', 'back']]);
});
