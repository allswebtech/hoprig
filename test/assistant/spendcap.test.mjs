// Paid usage without the owner's tap only inside the daily cap he set (the contract's paid-cap). The stand-in
// dashboard counts every start, move and message that reaches it: none gets past the cap, none without a cap.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { HOLD_USD, PART_MIN_USD, SpendLedger, measureChats, partShare } from '../../src/assistant/spend.mjs';
import { cleanTiaPatch, resolveTia } from '../../src/assistant/tia.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const FOLDER = '/home/owner/projects/api';
const PAID = ['startSession', 'startChat', 'sendText', 'sendToChat', 'switchAccount', 'moveChat', 'pressKey'];

function setup({ cap = null, clock = { t: new Date(2026, 10, 18, 22, 0).getTime() }, ledgerFile = null } = {}) {
  const s = baseState();
  s.assistant = { enabled: true, actAlone: true, level: 'handsoff', accounts: ['sub', 'api'], ...(cap === null ? {} : { dailyCapUsd: cap }) };
  const ops = new FakeOps(s);
  const now = () => clock.t;
  const core = createAssistantCore({
    ops, now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }),
    spend: new SpendLedger({ file: ledgerFile, now }),
  });
  core.jobs.markStarted('this', 'web-ui', 1_700_000_002_000); // hers: a message into one of his is a card whatever the provider
  const call = (tool, args) => core.call(tool, args, { conversation: 'c1' });
  const reached = () => ops.calls.filter((c) => PAID.includes(c.op)).length;
  return { ops, core, call, reached, clock };
}

test('no cap set: every start on a paid provider is a card, nothing reaches the provider', async () => {
  const { call, reached } = setup();
  const r = await call('start_session', { folder: FOLDER, account: 'api', message: 'fix the failing test' });
  assert.ok(r.card, r.text);
  assert.match(r.card.lines.join('\n'), /no daily limit for paid use is set/);
  assert.equal(reached(), 0);
  // A subscription is no paid usage: it runs, cap or none.
  assert.ok(!(await call('start_session', { folder: FOLDER, account: 'sub', message: 'x' })).card);
  assert.equal(reached(), 1);
});

test('inside the cap a paid start runs; past it a card, also for two at once, until midnight', async () => {
  const { call, reached, clock } = setup({ cap: 2 * HOLD_USD });
  // Three different starts (the same one three times is one start: see the repeat test below).
  const both = await Promise.all([1, 2, 3].map((n) => call('start_chat', { folder: FOLDER, account: 'api', message: `x${n}` })));
  assert.equal(both.filter((r) => !r.card && !r.isError).length, 2, both.map((r) => r.text.slice(0, 80)).join('\n'));
  assert.equal(both.filter((r) => r.card).length, 1);
  assert.match(both.find((r) => r.card).card.lines.join('\n'), /limit for paid use of \$1\.00 is reached/);
  assert.equal(reached(), 2);
  clock.t += 3 * 3600_000; // past midnight: a new day, a new cap
  assert.ok(!(await call('start_session', { folder: FOLDER, account: 'api', message: 'y' })).card);
  assert.equal(reached(), 3);
});

test('a message into a session on a paid provider and a move onto one count against the cap too', async () => {
  const { ops, call, reached } = setup({ cap: HOLD_USD });
  const r1 = await call('start_chat', { folder: FOLDER, account: 'api', message: 'x' });
  assert.ok(!r1.card, r1.text);
  const chat = ops.s.sessions.find((c) => c.kind === 'chat' && c.cwd === FOLDER);
  chat.profile = { name: 'api', label: 'API key', kind: 'api' };
  chat.status = 'waiting';
  const r2 = await call('send_to_chat', { session: chat.name, text: 'run the tests' });
  assert.ok(r2.card, r2.text);
  assert.match(r2.card.lines.join('\n'), /limit for paid use of \$0\.50 is reached/);
  // Stopping spends nothing: never held back by the cap.
  assert.ok(!(await call('send_to_chat', { session: chat.name, stop: true })).card);
  assert.equal(reached(), 1);
});

test('the day\'s sum survives a restart: a new ledger on the same file holds what the old one counted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'));
  try {
    const file = path.join(dir, 'spend.jsonl');
    const clock = { t: new Date(2026, 10, 18, 10, 0).getTime() };
    const a = setup({ cap: HOLD_USD, clock, ledgerFile: file });
    assert.ok(!(await a.call('start_session', { folder: FOLDER, account: 'api', message: 'x' })).card);
    const b = setup({ cap: HOLD_USD, clock, ledgerFile: file });
    assert.ok((await b.call('start_session', { folder: FOLDER, account: 'api', message: 'y' })).card);
    assert.equal(a.reached() + b.reached(), 1);
    // A cost settles only its own act's hold: another cost (her own turn) leaves the terminal start's hold counted, as
    // that session's cost is not measured.
    const l = new SpendLedger({ file, now: () => clock.t });
    l.spent(0.1);
    assert.deepEqual(l.today(), { spent: 0.1, held: HOLD_USD });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the cap is the owner\'s setting: bounded, shown with what she may do; she has no tool that sets it', async () => {
  assert.deepEqual(cleanTiaPatch({ dailyCapUsd: 5 }), { dailyCapUsd: 5 });
  assert.deepEqual(cleanTiaPatch({ dailyCapUsd: null }), { dailyCapUsd: null });
  for (const v of [0, -1, 20_000, '5', Infinity]) assert.throws(() => cleanTiaPatch({ dailyCapUsd: v }), /dailyCapUsd/, String(v));
  assert.equal(resolveTia({ dailyCapUsd: 3 }, { profiles: [] }).dailyCapUsd, 3);
  const { call } = setup();
  assert.match((await call('change_setting', { key: 'tia_daily_cap', value: 1000 })).text, /invalid input|must be one of/);
});

// A queued message is typed into the session when it next waits and cannot be taken back: it is a card, cap or none, and
// nothing is queued or held before his tap.
test('a queued message into a session on a paid provider is a card, with a cap or none, and holds nothing before his tap', async () => {
  for (const level of ['handsoff', 'work']) {
    const { ops, core, call } = setup();
    ops.s.assistant.level = level;
    const s = ops.s.sessions.find((x) => x.name === 'web-ui');
    s.profile = { name: 'api', label: 'API key', kind: 'api' };
    await call('list_sessions', {});
    const r = await call('manage_automation', { action: 'queue_message', session: 'web-ui', text: 'run the tests' });
    assert.ok(r.card, `${level}: ${r.text}`);
    assert.match(r.card.lines.join('\n'), /cannot be put back with one press/);
    assert.equal(ops.calls.filter((c) => c.op === 'queue').length, 0, `${level}: the queue was written with no cap`);
    assert.deepEqual(core.spend.today(), { spent: 0, held: 0 });
  }
  const { ops, core, call } = setup({ cap: HOLD_USD });
  ops.s.sessions.find((x) => x.name === 'web-ui').profile = { name: 'api', label: 'API key', kind: 'api' };
  await call('list_sessions', {});
  assert.ok((await call('manage_automation', { action: 'queue_message', session: 'web-ui', text: 'run the tests' })).card);
  assert.equal(core.spend.today().held, 0, 'nothing is held before his tap');
  assert.equal(ops.calls.filter((c) => c.op === 'queue').length, 0);
  // Clearing the queue spends nothing, and cannot be taken back: a card too.
  assert.ok((await call('manage_automation', { action: 'queue_clear', session: 'web-ui' })).card);
});

// A retry of the same start is answered from the first one: no second hold, no second start, also when both come at
// once, and a card staged for a repeat never starts a second session at his tap.
test('the same paid start twice: one hold, one start, also at once; a repeat near the cap is no card', async () => {
  const START = { folder: FOLDER, account: 'api', message: 'fix the test' };
  let { core, call, reached } = setup({ cap: 5 });
  const two = await Promise.all([call('start_session', START), call('start_session', START)]);
  assert.equal(reached(), 1, two.map((r) => r.text.slice(0, 90)).join('\n'));
  assert.equal(core.spend.today().held, HOLD_USD);
  ({ core, call, reached } = setup({ cap: 2 * HOLD_USD }));
  assert.ok(!(await call('start_session', START)).card);
  const again = await call('start_session', START);
  assert.ok(!again.card && /it was done once/.test(again.text), again.text);
  assert.equal(core.spend.today().held, HOLD_USD, 'a repeat took a hold');
  assert.ok(!(await call('start_session', { ...START, message: 'another' })).card, 'room was left for a different start');
  // At the cap: the repeat is answered from memory, not staged as a card whose tap would start it twice.
  ({ core, call, reached } = setup({ cap: HOLD_USD }));
  assert.ok(!(await call('start_session', START)).card);
  const third = await call('start_session', START);
  assert.ok(!third.card, third.text);
  assert.equal(reached(), 1);
});

test('two cards for the very same start, both tapped: one session starts', async () => {
  const { core, call, reached } = setup();
  const START = { folder: FOLDER, account: 'api', message: 'fix the test' };
  const a = await call('start_session', START);
  const b = await call('start_session', START);
  assert.ok(a.card && b.card, `${a.text}\n${b.text}`);
  assert.equal((await core.confirm(a.card.id)).ok, true);
  const second = await core.confirm(b.card.id);
  assert.equal(second.ok, false, JSON.stringify(second));
  assert.match(second.error, /the same start ran a moment ago/);
  assert.equal(reached(), 1);
});

// Auto mode whose order holds an API key: the router serves or moves the session with that key, so a start under Auto
// is paid usage (a card with no cap, a hold inside it) at every level; with only subscriptions in its order it is not.
test('a start under Auto mode counts as paid when its order holds a provider billed by use', async () => {
  for (const level of ['handsoff', 'work']) {
    const { ops, call, reached } = setup();
    ops.s.assistant = { ...ops.s.assistant, level, accounts: ['auto', 'sub', 'api'] };
    Object.assign(ops.s.autoSwitch, { enabled: true, order: ['api', 'sub'] });
    const r = await call('start_session', { folder: FOLDER, account: 'auto', message: 'fix the test' });
    assert.ok(r.card, `${level}: ${r.text}`);
    assert.equal(reached(), 0, `${level}: a start under Auto reached the provider`);
  }
  const { ops, core, call, reached } = setup({ cap: HOLD_USD });
  ops.s.assistant = { ...ops.s.assistant, accounts: ['auto', 'sub', 'api'] };
  Object.assign(ops.s.autoSwitch, { enabled: true, order: ['sub', 'api'] });
  assert.ok(!(await call('start_session', { folder: FOLDER, account: 'auto', message: 'one' })).card);
  assert.equal(core.spend.today().held, HOLD_USD);
  assert.ok((await call('start_session', { folder: FOLDER, account: 'auto', message: 'two' })).card, 'past the cap');
  assert.equal(reached(), 1);
  // Only subscriptions in the order: no paid usage, no hold.
  ops.s.autoSwitch.order = ['sub', 'sub2'];
  assert.ok(!(await call('start_session', { folder: FOLDER, account: 'auto', message: 'three' })).card);
  assert.equal(reached(), 2);
});

// A move of her session onto a paid provider spends from then on: it takes a hold, and past the cap it is a card.
test('switch_account onto a paid provider counts against the cap and is a card past it', async () => {
  const { ops, core, call, reached } = setup({ cap: HOLD_USD });
  // Two sessions of hers on a subscription (the ones her starts add, not the owner's own in that folder).
  const had = ops.s.sessions.length;
  assert.ok(!(await call('start_session', { folder: FOLDER, account: 'sub', message: 'one' })).card);
  assert.ok(!(await call('start_session', { folder: '/home/owner/projects/web', account: 'sub', message: 'two' })).card);
  const [a, b] = ops.s.sessions.slice(had).map((s) => s.name);
  await call('list_sessions', {});
  const first = await call('switch_account', { session: a, account: 'api' });
  assert.ok(!first.card && !first.isError, first.text);
  assert.equal(core.spend.today().held, HOLD_USD);
  const second = await call('switch_account', { session: b, account: 'api' });
  assert.ok(second.card, second.text);
  assert.match(second.card.lines.join('\n'), /limit for paid use of \$0\.50 is reached/);
  assert.equal(ops.calls.filter((c) => c.op === 'switchAccount').length, 1);
  assert.equal(reached(), 3);
});

// A cost settles only its own act's hold: a cheap turn of hers never frees the hold of a session she started.
test('a measured cost settles only the hold of its own act; what is left of the cap is a turn\'s budget', () => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  assert.equal(l.take(2), null); // a session she started: not measured
  assert.equal(l.take(2, { id: 'turn-a' }), null);
  assert.equal(l.left(2, 'turn-a'), 1.5, 'the turn may use what is left, its own hold counted back in');
  l.spent(0.02, 'her own turn', 'turn-a');
  assert.deepEqual(l.today(), { spent: 0.02, held: HOLD_USD }, 'the session\'s hold stays');
});

// The look-up of another computer's name (has the owner named it?) comes before the repeat check: two identical starts
// on another computer at the same moment start once and take one hold, as two on this computer do.
test('the same start twice at once on another computer the owner named: one start, one hold', async () => {
  for (const [level, account, cap] of [['work', 'sub', null], ['handsoff', 'api', 5]]) {
    const { ops, core, call } = setup({ cap });
    ops.s.assistant.level = level;
    core.beginTurn('c1', { origin: 'owner', text: 'Fix the cart on box2 in the blog folder.' });
    await call('get_computer_status', {});
    const START = { computer: 'box2', folder: '/home/owner/projects/blog', account, message: 'Fix the cart total.' };
    const two = await Promise.all([call('start_chat', START), call('start_chat', START)]);
    assert.ok(two.every((r) => !r.card && !r.isError), two.map((r) => r.text.slice(0, 90)).join('\n'));
    assert.equal(ops.calls.filter((c) => c.op === 'startChat').length, 1, `${level}: two chats started`);
    assert.match(two[1].text, /it was done once/);
    assert.equal(core.spend.today().held, cap ? HOLD_USD : 0, `${level}: holds`);
  }
});

// A session that runs under Auto spends by use when Auto's order holds a key billed by use: a message or a queued
// message into it is paid usage, as a start under Auto is.
test('a message and a queued message into a session under Auto with a paid key in its order: cards with no cap', async () => {
  const { ops, core, call } = setup();
  ops.s.assistant.accounts = ['auto', 'sub', 'api'];
  Object.assign(ops.s.autoSwitch, { enabled: true, order: ['api', 'sub'] });
  ops.s.sessions.find((x) => x.name === 'web-ui').profile = { name: 'auto', label: 'Auto', kind: 'auto' };
  await call('list_sessions', {});
  const send = await call('send_to_session', { session: 'web-ui', text: 'yes, update the screenshots' });
  assert.ok(send.card, send.text);
  assert.match(send.card.lines.join('\n'), /no daily limit for paid use is set/);
  const queued = await call('manage_automation', { action: 'queue_message', session: 'web-ui', text: 'run the tests' });
  assert.ok(queued.card, queued.text);
  assert.equal(ops.calls.filter((c) => c.op === 'sendText' || c.op === 'queue').length, 0);
  assert.deepEqual(core.spend.today(), { spent: 0, held: 0 });
  // Only subscriptions in Auto's order: no paid usage, the message runs.
  ops.s.autoSwitch.order = ['sub', 'sub2'];
  assert.ok(!(await call('send_to_session', { session: 'web-ui', text: 'and the docs' })).card);
  assert.equal(ops.calls.filter((c) => c.op === 'sendText').length, 1);
});

// A paid act he confirmed on a card is counted in today's sum (his tap is the approval: it never blocks it), with no
// cap and past the cap alike.
test('a paid act from his tap on a card is counted in today\'s sum and never blocks his tap', async () => {
  const { core, call, reached } = setup();
  const a = await call('start_session', { folder: FOLDER, account: 'api', message: 'fix the failing test' });
  assert.ok(a.card, a.text);
  assert.equal((await core.confirm(a.card.id)).ok, true);
  assert.equal(reached(), 1);
  assert.deepEqual(core.spend.detail(), { spent: 0, held: HOLD_USD, unmeasured: 1, tapped: 1 });
  // Past the cap: her own act is a card, and his tap on it still runs and is counted.
  const b = setup({ cap: HOLD_USD });
  assert.ok(!(await b.call('start_chat', { folder: FOLDER, account: 'api', message: 'one' })).card);
  const c = await b.call('start_chat', { folder: FOLDER, account: 'api', message: 'two' });
  assert.ok(c.card, c.text);
  assert.equal((await b.core.confirm(c.card.id)).ok, true);
  assert.equal(b.reached(), 2);
  assert.equal(b.core.spend.detail().tapped, 1);
  assert.equal(b.core.spend.today().held, 2 * HOLD_USD);
  // A subscription is not paid usage: nothing is counted for his tap there.
  const d = setup();
  d.ops.s.assistant.level = 'ask';
  const e = await d.call('start_session', { folder: FOLDER, account: 'sub', message: 'x' });
  assert.equal((await d.core.confirm(e.card.id)).ok, true);
  assert.deepEqual(d.core.spend.detail(), { spent: 0, held: 0, unmeasured: 0, tapped: 0 });
});

// A chat she started on a paid provider reports what it cost (its costTotal on the session card): once a turn of it
// was seen and ended after the act, that figure takes the place of the act's fixed hold. A terminal stays at the hold.
test('what a chat she started really cost takes the place of its act\'s $0.50; a terminal\'s act stays counted', async () => {
  const { ops, core, call } = setup({ cap: 10 });
  const r = await call('start_chat', { folder: FOLDER, account: 'api', message: 'fix it' });
  assert.ok(!r.card && !r.isError, r.text);
  const name = /Started chat (chat:[0-9a-f-]{36})/.exec(r.text)[1];
  assert.ok(!(await call('start_session', { folder: FOLDER, account: 'api', message: 'a terminal' })).card);
  const chat = () => ops.s.sessions.find((x) => x.name === name);
  chat().profile = { name: 'api', label: 'API key', kind: 'api' }; // as the dashboard shows it (the stand-in says subscription)
  assert.deepEqual(core.spend.detail(), { spent: 0, held: 2 * HOLD_USD, unmeasured: 2, tapped: 0 });
  // Its turn runs: the hold stays on top of what it reported so far.
  Object.assign(chat(), { status: 'working', costTotal: 0.01 });
  measureChats(core.spend, ops.s.sessions);
  assert.deepEqual(core.spend.today(), { spent: 0.01, held: 2 * HOLD_USD });
  // It ended: its measured cost stands in the hold's place; the terminal's hold stays.
  Object.assign(chat(), { status: 'waiting', costTotal: 0.03 });
  measureChats(core.spend, ops.s.sessions);
  assert.deepEqual(core.spend.detail(), { spent: 0.03, held: HOLD_USD, unmeasured: 1, tapped: 0 });
  // A second message into it: a hold again until its turn ran, then the cost since its first act of the day.
  await call('list_sessions', {});
  assert.ok(!(await call('send_to_chat', { session: name, text: 'and the docs' })).card);
  assert.equal(core.spend.today().held, 2 * HOLD_USD);
  Object.assign(chat(), { status: 'working', costTotal: 0.05 });
  measureChats(core.spend, ops.s.sessions);
  Object.assign(chat(), { status: 'waiting', costTotal: 0.08 });
  measureChats(core.spend, ops.s.sessions);
  // That send is bound with its message id (m1): only its own turn's end, as the chat tells it, settles it.
  assert.deepEqual(core.spend.today(), { spent: 0.08, held: 2 * HOLD_USD }, 'the chat has not told its end');
  measureChats(core.spend, ops.s.sessions, (id, m) => (`chat:${id}` === name && m === 'm1' ? { ended: true, cost: 0.05, total: 0.08 } : null));
  assert.deepEqual(core.spend.today(), { spent: 0.08, held: HOLD_USD });
  // Nothing is written when no paid act went into a chat today.
  const quiet = setup({ cap: 10 });
  measureChats(quiet.core.spend, quiet.ops.s.sessions);
  assert.deepEqual(quiet.core.spend.detail(), { spent: 0, held: 0, unmeasured: 0, tapped: 0 });
});

// What the chat really cost can pass the cap although its fixed hold did not: the next message into a paid session is
// a card, and nothing reaches the provider.
test('a message into a paid session once today\'s counted sum has passed the cap is a card; nothing reaches the provider', async () => {
  const { ops, core, call } = setup({ cap: 2 * HOLD_USD });
  const r = await call('start_chat', { folder: FOLDER, account: 'api', message: 'fix it' });
  const name = /Started chat (chat:[0-9a-f-]{36})/.exec(r.text)[1];
  const chat = ops.s.sessions.find((x) => x.name === name);
  chat.profile = { name: 'api', label: 'API key', kind: 'api' }; // as the dashboard shows it (the stand-in says subscription)
  Object.assign(chat, { status: 'working', costTotal: 0.4 });
  measureChats(core.spend, ops.s.sessions);
  Object.assign(chat, { status: 'waiting', costTotal: 1.2 });
  measureChats(core.spend, ops.s.sessions);
  assert.deepEqual(core.spend.today(), { spent: 1.2, held: 0 });
  await call('list_sessions', {});
  const sent = ops.calls.filter((c) => c.op === 'sendToChat').length;
  const m = await call('send_to_chat', { session: name, text: 'one more thing' });
  assert.ok(m.card, m.text);
  assert.match(m.card.lines.join('\n'), /limit for paid use of \$1\.00 is reached \(\$1\.20 spent/);
  assert.equal(ops.calls.filter((c) => c.op === 'sendToChat').length, sent, 'a message reached the paid session past the cap');
});

// A chat she just started whose first turn ended between two looks (never seen working): any cost it reports while
// idle is that act's own, so its hold goes. A message into an older chat keeps its hold until a turn was seen.
test('a new chat\'s cost replaces its hold even when its turn was too short to be seen working', async () => {
  const { ops, core, call } = setup({ cap: 10 });
  const r = await call('start_chat', { folder: FOLDER, account: 'api', message: 'fix it' });
  const name = /Started chat (chat:[0-9a-f-]{36})/.exec(r.text)[1];
  const chat = ops.s.sessions.find((x) => x.name === name);
  chat.profile = { name: 'api', label: 'API key', kind: 'api' };
  Object.assign(chat, { status: 'waiting', costTotal: 0 });
  measureChats(core.spend, ops.s.sessions);
  assert.deepEqual(core.spend.today(), { spent: 0, held: HOLD_USD }, 'no cost yet: the hold stays');
  Object.assign(chat, { costTotal: 0.02 });
  measureChats(core.spend, ops.s.sessions);
  assert.deepEqual(core.spend.detail(), { spent: 0.02, held: 0, unmeasured: 0, tapped: 0 });
  await call('list_sessions', {});
  assert.ok(!(await call('send_to_chat', { session: name, text: 'and the docs' })).card);
  Object.assign(chat, { costTotal: 0.05 });
  measureChats(core.spend, ops.s.sessions);
  assert.deepEqual(core.spend.today(), { spent: 0.05, held: HOLD_USD }, 'a message into it keeps its hold until a turn was seen');
});

// A part's budget (src/models/partdoor.mjs, src/chat/feature.mjs): while its process runs it counts the larger of its
// budget and what its chat was measured to cost; once its process ended, what it cost. The chats are made up.
test('a part\'s budget of $1 with $0.40 measured while it runs counts $1; ended, it counts $0.40 and the rest is free', () => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  assert.equal(l.take(3, { id: 'part-a', amount: 1 }), null);
  l.bind('part-a', 'this|chat:part-one', 0, true);
  assert.deepEqual(l.detail(), { spent: 0, held: 1, unmeasured: 0, tapped: 0, parts: 1, partsHeld: 1 });
  l.measure('this|chat:part-one', 0.4, true);
  assert.deepEqual(l.today(), { spent: 0.4, held: 0.6 }, '$1 in all while it runs, never $1.40');
  l.measure('this|chat:part-one', 1.3, false);
  assert.deepEqual(l.today(), { spent: 1.3, held: 0 }, 'past its budget: what it cost');
  // The same chat, a lower figure: a new conversation in it (its running cost starts again), which adds to what ran.
  l.measure('this|chat:part-one', 0.4, false);
  assert.deepEqual(l.today(), { spent: 1.7, held: 0 }, 'a lower figure never lowers the sum');
  assert.equal(l.settleParts('this|chat:part-one'), 1);
  assert.deepEqual(l.today(), { spent: 1.7, held: 0 }, 'ended: what it cost, nothing of its budget held any more');
  assert.equal(l.left(3), 1.3);
  assert.equal(l.settleParts('this|chat:part-one'), 0, 'twice: nothing more');
  assert.equal(l.settleParts(), 0);
});

test('settleParts settles only budget holds, of the chat named or of every chat, once', () => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  assert.equal(l.take(5, { id: 'turn-x' }), null); // her own act: not a part, never settled here
  assert.equal(l.take(5, { id: 'part-a', amount: 1 }), null);
  assert.equal(l.take(5, { id: 'part-b', amount: 1 }), null);
  assert.equal(l.take(5, { id: 'part-c', amount: 0.5 }), null); // not bound to any chat (yet)
  l.bind('part-a', 'this|chat:one', 0, true);
  l.bind('part-b', 'this|chat:two', 0, true);
  assert.equal(l.settleParts('this|chat:one'), 1);
  assert.deepEqual(l.detail(), { spent: 0, held: 2, unmeasured: 1, tapped: 0, parts: 2, partsHeld: 1.5 });
  assert.equal(l.settleParts(), 2, 'every one left, bound or not');
  assert.deepEqual(l.today(), { spent: 0, held: HOLD_USD }, 'her own act stays counted');
  assert.equal(l.settleParts(), 0);
});

test('parts that start at one moment share what is left; a share under a cent is refused with a sentence', () => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  const share = (atOnce) => (t) => partShare(2, t, atOnce);
  assert.equal(l.take(2, { id: 'part-a', amount: share(2) }), null);
  assert.equal(l.take(2, { id: 'part-b', amount: share(2) }), null);
  assert.equal(l.heldFor('part-a') + l.heldFor('part-b'), 2, 'two at once under $2: $1 each, never more than 2');
  assert.match(l.take(2, { id: 'part-c', amount: share(2) }), /too little left for another part \(\$0\.00 spent and \$2\.00 held by 2 parts that run now\); raise the limit in Settings → Tia, or wait until a part ends/);
  const m = new SpendLedger({ file: null, now: () => clock.t });
  m.spent(2.995, 'her own turn');
  assert.ok(partShare(3, m.detail(), 1) < PART_MIN_USD);
  assert.match(m.take(3, { id: 'part-d', amount: (t) => partShare(3, t, 1) }), /too little left for another part/);
  assert.equal(m.heldFor('part-d'), 0, 'nothing held');
});

test('a part\'s process that ended inside a turn whose cost it never reported: the rest of its budget counts for the day as not measured, never as spent', () => {
  const clock = { t: new Date(2026, 10, 18, 12, 0).getTime() };
  const l = new SpendLedger({ file: null, now: () => clock.t });
  assert.equal(l.take(3, { id: 'part-a', amount: 1 }), null);
  l.bind('part-a', 'this|chat:part-one', 0, true);
  l.measure('this|chat:part-one', 0.3, true);
  assert.equal(l.settleParts('this|chat:part-one', { cut: true }), 1);
  assert.deepEqual(l.today(), { spent: 0.3, held: 0.7 }, 'its whole budget counts: what the cut turn cost is not known');
  assert.deepEqual(l.detail(), { spent: 0.3, held: 0.7, unmeasured: 0, tapped: 0, cuts: 1, cutHeld: 0.7 }, 'the rest is counted apart from what was spent');
  assert.equal(l.left(3), 2);
});

