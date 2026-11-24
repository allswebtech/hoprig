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

test('(8) after a new conversation in the chat, a turn that began below the chat\'s base ends without dropping its hold', (t) => {
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
  end(c, 1.2); // her second message's turn: 0.3, but the measured figure holds only 0.2 of the day (1.2 - 1.0)
  tick(l, [c]);
  const d = l.detail();
  t.diagnostic(`detail=${JSON.stringify(d)} ends=${JSON.stringify(ends(l))}`);
  assert.ok(d.spent + d.held + 1e-9 >= 0.3, `act-2's turn cost 0.3 is not held: ${JSON.stringify(d)}`);
  assert.deepEqual(ends(l), [['act-1', 0.5], ['act-2', null]], 'act-2 ends without its cost: its hold stays for the day');
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
