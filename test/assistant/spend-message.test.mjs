// A paid message of Tia's into a chat she started is settled by its own turn: the bind writes down the chat's id of
// that message (send_to_chat's result data, message_id), which the chat keeps its turn's end by. The dashboard is a
// stand-in (fake-dashboard.mjs): nothing reaches a real chat or provider.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { HOLD_USD, SpendLedger, measureChats } from '../../src/assistant/spend.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const FOLDER = '/home/owner/projects/api';

function setup({ cap = 10, clock = { t: new Date(2026, 10, 18, 12, 0).getTime() } } = {}) {
  const s = baseState();
  s.assistant = { enabled: true, actAlone: true, level: 'handsoff', accounts: ['sub', 'api'], dailyCapUsd: cap };
  const ops = new FakeOps(s);
  const now = () => clock.t;
  const spend = new SpendLedger({ file: null, now });
  const core = createAssistantCore({ ops, now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }), spend });
  const call = (tool, args) => core.call(tool, args, { conversation: 'c1' });
  return { ops, core, call, spend, clock };
}

test('a message into a chat she started binds its hold with the chat\'s id of that message; a new chat\'s first does not', async () => {
  const { ops, call, spend } = setup();
  const r = await call('start_chat', { folder: FOLDER, account: 'api', message: 'fix it' });
  assert.ok(!r.card && !r.isError, r.text);
  const name = /Started chat (chat:[0-9a-f-]{36})/.exec(r.text)[1];
  ops.s.sessions.find((x) => x.name === name).profile = { name: 'api', label: 'API key', kind: 'api' };
  await call('list_sessions', {});
  const m = await call('send_to_chat', { session: name, text: 'and the docs' });
  assert.ok(!m.card && !m.isError, m.text);
  const binds = spend.memory.filter((e) => e.kind === 'bind');
  assert.equal(binds.length, 2, JSON.stringify(spend.memory));
  assert.equal(binds[0].message, undefined, 'a new chat\'s first message is bound as before');
  assert.equal(binds[0].fresh, true);
  assert.equal(binds[1].message, 'm1', 'the send\'s id of the message is in the bind');
  assert.equal(binds[1].session, `this|${name}`);
  assert.equal(spend.detail().held, 2 * HOLD_USD);
});

test('the bind keeps a message id, and leaves it out when none is given', () => {
  const spend = new SpendLedger({ file: null, now: () => new Date(2026, 10, 18, 12, 0).getTime() });
  spend.bind('a', 'this|chat:one', 0.2, false, 'msg-1');
  spend.bind('b', 'this|chat:one', 0.2);
  spend.bind('c', 'this|chat:one', 0.2, false, '');
  assert.deepEqual(spend.memory.map((e) => e.message), ['msg-1', undefined, undefined]);
  assert.ok(!('message' in spend.memory[1]) && !('message' in spend.memory[2]));
});

// The ledger at Tia's ticks: each tick has this computer's chat cards and the chat feature's messageEnd(chatId,
// messageId) (null: not ended or not known; { ended, cost, total }; { back: true }). A stand-in for the chat feature.
const ledger = () => new SpendLedger({ file: null, now: () => new Date(2026, 10, 18, 12, 0).getTime() });
function chatOf(chatId = 'one') {
  const ends = new Map();
  const asked = [];
  const messageEnd = (id, m) => {
    asked.push(`${id}/${m}`);
    return id === chatId ? ends.get(m) || null : null;
  };
  const tick = (l, costTotal, working) => measureChats(l, [{ kind: 'chat', name: `chat:${chatId}`, chatId, costTotal, status: working ? 'working' : 'idle' }], messageEnd);
  return { key: `this|chat:${chatId}`, ends, asked, tick };
}
const endsOf = (l) => l.memory.filter((e) => e.kind === 'ended');
const act = (l, id, key, base, message) => {
  assert.equal(l.take(5, { id }), null);
  l.bind(id, key, base, false, message);
};
const fig = (spent, held, unmeasured) => ({ spent, held, unmeasured, tapped: 0 });

test('(1) her message queued behind his running turn: his end settles nothing of hers; her own end with a cost does', () => {
  const l = ledger();
  const c = chatOf();
  act(l, 'act-1', c.key, 1, 'hers');
  c.tick(l, 1.05, true); // his turn runs
  c.tick(l, 1.2, false); // his turn ended and reported; hers has not run yet
  assert.deepEqual(l.detail(), fig(0.2, HOLD_USD, 1));
  c.tick(l, 1.25, true); // hers runs
  assert.deepEqual(l.detail(), fig(0.25, HOLD_USD, 1));
  c.ends.set('hers', { ended: true, cost: 0.3, total: 1.5 });
  c.tick(l, 1.5, false);
  assert.deepEqual(l.detail(), fig(0.5, 0, 0));
  assert.deepEqual(endsOf(l).map(({ at, ...e }) => e), [{ kind: 'ended', hold: 'act-1', message: 'hers', cost: 0.3 }]);
});

test('(2) two sends inside one tick: one end settles only its own message', () => {
  const l = ledger();
  const c = chatOf();
  act(l, 'act-1', c.key, 0, 'm1');
  act(l, 'act-2', c.key, 0, 'm2');
  c.tick(l, 0.1, true);
  c.ends.set('m1', { ended: true, cost: 0.3, total: 0.3 });
  c.tick(l, 0.3, false);
  assert.deepEqual(l.detail(), fig(0.3, HOLD_USD, 1));
  c.tick(l, 0.35, true);
  c.ends.set('m2', { ended: true, cost: 0.2, total: 0.5 });
  c.tick(l, 0.5, false);
  assert.deepEqual(l.detail(), fig(0.5, 0, 0));
});

test('(3) a turn that crashed (no cost) before one that reported: the crashed act keeps HOLD_USD, the other settles', () => {
  const l = ledger();
  const c = chatOf();
  act(l, 'act-a', c.key, 0.1, 'a');
  act(l, 'act-b', c.key, 0.1, 'b');
  c.tick(l, 0.1, true);
  c.ends.set('a', { ended: true, cost: null, total: 0.1 });
  c.tick(l, 0.1, false);
  c.tick(l, 0.15, true);
  c.ends.set('b', { ended: true, cost: 0.3, total: 0.4 });
  c.tick(l, 0.4, false);
  assert.deepEqual(l.detail(), fig(0.3, HOLD_USD, 1));
  assert.deepEqual(endsOf(l).map((e) => [e.hold, e.cost]), [['act-a', null], ['act-b', 0.3]]);
});

test('(4) three queued, the last one crashed: only it keeps HOLD_USD', () => {
  for (const crash of [false, true]) {
    const l = ledger();
    const c = chatOf();
    act(l, 'act-1', c.key, 0, 'm1');
    act(l, 'act-2', c.key, 0, 'm2');
    act(l, 'act-3', c.key, 0, 'm3');
    c.tick(l, 0.1, true);
    c.ends.set('m1', { ended: true, cost: 0.3, total: 0.3 });
    c.tick(l, 0.3, false);
    c.tick(l, 0.35, true);
    c.ends.set('m2', { ended: true, cost: 0.2, total: 0.5 });
    c.tick(l, 0.5, false);
    c.tick(l, 0.55, true);
    c.ends.set('m3', crash ? { ended: true, cost: null, total: 0.55 } : { ended: true, cost: 0.2, total: 0.7 });
    c.tick(l, crash ? 0.55 : 0.7, false);
    assert.deepEqual(l.detail(), crash ? fig(0.55, HOLD_USD, 1) : fig(0.7, 0, 0), `crash=${crash}`);
  }
});

test('(5) taken back from the queue, or lost with the process: the hold is given back', () => {
  const l = ledger();
  const c = chatOf();
  act(l, 'act-1', c.key, 0, 'm1');
  act(l, 'act-2', c.key, 0, 'back');
  act(l, 'act-3', c.key, 0, 'lost');
  assert.deepEqual(l.detail(), fig(0, 3 * HOLD_USD, 3));
  c.ends.set('back', { back: true });
  c.tick(l, 0, true);
  assert.deepEqual(l.detail(), fig(0, 2 * HOLD_USD, 2), 'given back at once, nothing ran');
  c.ends.set('lost', { back: true });
  c.ends.set('m1', { ended: true, cost: 0.2, total: 0.2 });
  c.tick(l, 0.2, false);
  assert.deepEqual(l.detail(), fig(0.2, 0, 0));
  assert.deepEqual(endsOf(l).map((e) => [e.hold, e.back === true]), [['act-2', true], ['act-1', false], ['act-3', true]]);
});

test('(6) binds without a message id are read as before (the check\'s figures Q1 to Q6), and the chat is never asked', () => {
  const run = (base, steps) => {
    const l = ledger();
    const c = chatOf();
    for (const s of steps) {
      if (typeof s === 'string') {
        assert.equal(l.take(5, { id: s }), null);
        l.bind(s, c.key, base);
      } else c.tick(l, base + s[0], s[1]);
    }
    assert.deepEqual(c.asked, [], 'no message id: nothing to ask');
    return l.detail();
  };
  assert.deepEqual(run(2, ['act-1', [0.05, true], [0.2, false]]), fig(0.2, 0, 0), 'Q1');
  assert.deepEqual(run(0, ['act-0', [0.05, true], [0.1, false], 'act-1', [0.15, true], [0.3, false]]), fig(0.3, 0, 0), 'Q2');
  assert.deepEqual(run(0, ['act-0', [0.05, true], [0.1, false], 'act-a', [0.1, true], [0.1, false], 'act-b', [0.15, true], [0.4, false]]), fig(0.4, 0, 0), 'Q3');
  assert.deepEqual(run(0, ['act-1', [0.1, true], 'act-2', [0.3, false]]), fig(0.3, HOLD_USD, 1), 'Q4');
  for (const crash of [false, true]) {
    assert.deepEqual(run(0, ['act-1', [0.1, true], 'act-2', 'act-3', [0.3, false], [0.35, true], [0.5, false], [0.55, true], [crash ? 0.55 : 0.7, false]]), fig(crash ? 0.55 : 0.7, 0, 0), `Q5 crash=${crash}`);
  }
  assert.deepEqual(run(0, ['act-1', 'act-2', [0.1, true], [0.3, false]]), fig(0.3, 0, 0), 'Q6');
});

test('(7) her message taken inside the running turn: settled by that turn\'s reported end, held when that turn crashed', () => {
  for (const crash of [false, true]) {
    const l = ledger();
    const c = chatOf();
    act(l, 'act-1', c.key, 1, 'hers');
    c.tick(l, 1.05, true); // his turn runs; it takes her message
    c.ends.set('hers', crash ? { ended: true, cost: null, total: 1.05 } : { ended: true, cost: 0.5, total: 1.5 });
    c.tick(l, crash ? 1.05 : 1.5, false);
    assert.deepEqual(l.detail(), crash ? fig(0.05, HOLD_USD, 1) : fig(0.5, 0, 0), `crash=${crash}`);
  }
});

test('(8) never zero in between: an end the tick\'s card does not hold yet writes nothing until a card holds it', () => {
  const l = ledger();
  const c = chatOf();
  act(l, 'act-1', c.key, 0, 'm1');
  c.tick(l, 0.1, true);
  c.ends.set('m1', { ended: true, cost: 0.3, total: 0.3 }); // the chat knows the end; the tick's card is older
  c.tick(l, 0.1, true);
  assert.deepEqual(endsOf(l), [], 'not yet: the measured figure does not hold that turn\'s cost');
  assert.deepEqual(l.detail(), fig(0.1, HOLD_USD, 1));
  c.tick(l, 0.3, false);
  assert.equal(endsOf(l).length, 1);
  assert.deepEqual(l.detail(), fig(0.3, 0, 0));
});

test('(9) measureChats with the chat\'s function: one end entry per hold, never twice; only her open acts are asked', () => {
  const l = ledger();
  const c = chatOf();
  act(l, 'act-1', c.key, 0, 'm1');
  act(l, 'act-2', c.key, 0, 'm2');
  assert.equal(l.take(5, { id: 'act-new' }), null);
  l.bind('act-new', 'this|chat:two', 0, true); // a new chat's first message: no message id
  assert.equal(l.take(5, { id: 'act-far' }), null);
  l.bind('act-far', 'far|chat:three', 0, false, 'm9'); // a chat on another computer: not seen here
  c.ends.set('m1', { ended: true, cost: 0.2, total: 0.2 });
  c.ends.set('m2', { back: true });
  for (let i = 0; i < 3; i++) c.tick(l, 0.2, false);
  assert.deepEqual(endsOf(l).map((e) => e.hold).sort(), ['act-1', 'act-2'], 'one each');
  assert.deepEqual([...new Set(c.asked)].sort(), ['one/m1', 'one/m2'], 'only open acts with a message id, on this computer');
  assert.equal(c.asked.length, 2, 'an act with its end written is not asked again');
  l.ended('act-1', 'm1', { cost: 0.2 });
  assert.equal(endsOf(l).length, 2, 'written once per hold');
  assert.deepEqual(l.detail(), fig(0.2, 2 * HOLD_USD, 2));
});

// An act just before midnight whose turn ends after it: the day before counts its $0.50 (its cost was not measured
// then), and what the chat cost after midnight counts in the new day. Only a chat whose act was still counted at
// midnight goes on being measured, and only for the one day after.
function lateAct() {
  const clock = { t: new Date(2026, 10, 18, 23, 59).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  const tick = (costTotal, working = false) => measureChats(l, [{ kind: 'chat', name: 'chat:late', chatId: 'late', costTotal, status: working ? 'working' : 'idle' }]);
  act(l, 'act-late', 'this|chat:late', 1.0);
  tick(1.0, true); // its turn runs at 23:59
  return { l, clock, tick };
}

test('(10) an act at 23:59 whose turn ends after midnight: what it cost after midnight counts in the new day', (t) => {
  const { l, clock, tick } = lateAct();
  assert.deepEqual(l.detail(), fig(0, HOLD_USD, 1), 'before midnight: its $0.50');
  clock.t = new Date(2026, 10, 19, 0, 1).getTime();
  tick(1.4);
  const d = l.detail();
  t.diagnostic(`FIG midnight detail=${JSON.stringify(d)}`);
  assert.equal(d.spent, 0.4, 'its turn ended at $1.40: $0.40 after its base of $1.00');
  // The day after that, nothing of the day before is measured any more.
  clock.t = new Date(2026, 10, 20, 0, 1).getTime();
  tick(2.0);
  assert.deepEqual(l.detail(), fig(0, 0, 0), 'one day carried, no more');
});

test('(11) an act settled before midnight is not carried: the chat\'s later turns are not counted in the new day', () => {
  const { l, clock, tick } = lateAct();
  tick(1.3); // its turn ended and reported before midnight
  assert.deepEqual(l.detail(), fig(0.3, 0, 0));
  clock.t = new Date(2026, 10, 19, 0, 1).getTime();
  tick(1.9);
  assert.deepEqual(l.detail(), fig(0, 0, 0), 'nothing of hers was counted at midnight: nothing is measured');
});

// Only a turn that may still run at midnight is carried into the new day. An act whose turn ended before it, with no
// reported cost, keeps its $0.50 on the day before and no more: the chat's cost the next day is his own.
const lateClock = () => {
  const clock = { t: new Date(2026, 10, 18, 23, 40).getTime() };
  return { clock, l: new SpendLedger({ file: null, now: () => clock.t }) };
};

test('(12) a message whose turn ended before midnight without a cost is not carried: his next day is not hers', () => {
  const { clock, l } = lateClock();
  const c = chatOf('late');
  act(l, 'act-1', c.key, 1.0, 'm1');
  c.tick(l, 1.0, true);
  c.ends.set('m1', { ended: true, cost: null, total: 1.0 }); // its coding tool crashed at 23:45
  clock.t = new Date(2026, 10, 18, 23, 45).getTime();
  c.tick(l, 1.0, false);
  assert.deepEqual(l.detail(), fig(0, HOLD_USD, 1), 'its $0.50 for the day before');
  clock.t = new Date(2026, 10, 19, 10, 0).getTime();
  c.tick(l, 3.0, false); // his own work in that chat the next morning
  assert.deepEqual(l.detail(), fig(0, 0, 0));
});

test('(13) an act into an older chat whose short turn ended unseen before midnight is not carried', () => {
  const { clock, l } = lateClock();
  const c = chatOf('late');
  act(l, 'act-1', c.key, 1.0);
  c.tick(l, 1.0, false);
  clock.t = new Date(2026, 10, 18, 23, 41).getTime();
  c.tick(l, 1.2, false); // a turn too short to be seen working: its hold stays for the day
  assert.deepEqual(l.detail(), fig(0.2, HOLD_USD, 1));
  clock.t = new Date(2026, 10, 19, 10, 0).getTime();
  c.tick(l, 3.0, false);
  assert.deepEqual(l.detail(), fig(0, 0, 0));
});

test('(14) a message whose turn still runs at midnight is carried: what the chat costs after it counts in the new day', () => {
  const { clock, l } = lateClock();
  const c = chatOf('late');
  act(l, 'act-1', c.key, 1.0, 'm1');
  c.tick(l, 1.0, true);
  clock.t = new Date(2026, 10, 19, 0, 1).getTime();
  c.tick(l, 1.4, false);
  assert.deepEqual(l.detail(), fig(0.4, 0, 0));
});

test('(15) an act into an older chat seen idle before its turn began, which then runs past midnight, is carried', () => {
  const { clock, l } = lateClock();
  const c = chatOf('late');
  act(l, 'act-1', c.key, 1.0);
  c.tick(l, 1.0, false); // its message waits to begin: nothing ran yet
  clock.t = new Date(2026, 10, 19, 0, 1).getTime();
  c.tick(l, 1.4, false); // its turn ran across midnight between two looks
  assert.deepEqual(l.detail(), fig(0.4, 0, 0));
});
