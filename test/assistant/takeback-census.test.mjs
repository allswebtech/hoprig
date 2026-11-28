// The census of what she does ALONE (the owner's switch on). The rule: an act runs without a card only when it can be taken
// back with one press (the value before is kept, the act that restores it is known, Activity shows ONE Undo that the person
// presses, that really restores the state, once) or changes nothing of his. An act that cannot be taken back (a message sent
// into a session, a stop, a close, a start of work, a provider switch) is a card even with the switch on.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { ALONE_ROWS, BACKS, FREE, aloneOf } from '../../src/assistant/takeback.mjs';
import { WatchStore } from '../../src/assistant/watches.mjs';
import { answerFor } from '../../src/assistant/catalogtools.mjs';
import { loadActs, rowAnswer } from '../../src/assistant/acts.mjs';
import { toolOf } from '../../src/assistant/catalog.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const CHAT = 'chat:55555555-5555-4555-8555-555555555501';
const BARE = 'chat:55555555-5555-4555-8555-555555555502';
const HIS = 'chat:55555555-5555-4555-8555-555555555503';

function setup(actAlone = true) {
  const state = baseState();
  state.assistant = { ...state.assistant, enabled: true, level: 'work', actAlone };
  const chat = (name, title, byTia = true) => ({ computer: 'this', name, kind: 'chat', chatId: name.slice(5), byTia, status: 'waiting', profile: { name: 'sub', label: 'Main', kind: 'subscription' }, cwd: '/home/owner/projects/api', title, lastMessage: '', note: '', limit: null, sessionId: name.slice(5), statusAt: Date.now() - 60_000, created: 1_700_000_002_000 });
  state.sessions.push(chat(CHAT, 'Run the tests'), chat(BARE, ''), chat(HIS, 'His chat', false));
  const ops = new FakeOps(state);
  // the fake keeps no label of a computer: it does, for this test
  ops.renameComputer = async (a) => {
    ops.calls.push({ op: 'renameComputer', args: a });
    ops.s.computers.find((c) => c.name === a.computer).label = a.label;
    return { label: a.label };
  };
  const audit = new AuditLog({ file: null, now: Date.now });
  const watches = new WatchStore({ file: null, now: Date.now });
  const core = createAssistantCore({ ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit, jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }), watches });
  const call = (name, args) => core.call(name, args, { conversation: 'tb' });
  return { ops, audit, watches, core, call };
}

const titleOf = (ops, name) => ops.s.sessions.find((c) => c.name === name).title;
const entryOf = (audit, tool) => audit.recent(50).filter((e) => e.tool === tool && e.outcome === 'done').at(-1);

// What she may NOT do alone, with the switch on: acts on HIS sessions (not started by her) and acts with no way back. Every one is a card.
const CARDS = [
  ['steer_work', { action: 'send', target: 'api-fix', text: 'go on' }],
  ['steer_work', { action: 'send', target: HIS, text: 'run the tests' }],
  ['steer_work', { action: 'key', target: 'api-fix', key: 'Enter' }],
  ['steer_work', { action: 'answer', target: HIS, answer: 'no' }],
  ['steer_work', { action: 'continue', target: 'api-fix' }],
  ['steer_work', { action: 'to_chat', target: 'api-fix' }],
  ['steer_work', { action: 'to_terminal', target: HIS }],
  ['steer_work', { action: 'close', target: HIS }],
  ['steer_work', { action: 'stop', target: 'api-fix' }],
  ['steer_work', { action: 'stop', target: HIS }],
  ['steer_work', { action: 'switch_provider', target: 'api-fix', provider: 'sub2' }],
  // a chat that has no name of its own cannot be given back that state, hers or not
  ['steer_work', { action: 'rename', target: BARE, name: 'footer work' }],
  ['hoprig_act', { act: 'continue-session', session: 'api-fix' }],
  ['hoprig_act', { act: 'reopen-session', session: 'api-fix' }],
  ['hoprig_act', { act: 'change-plan', value: { title: 'A new plan', goal: 'Go live' } }],
  ['hoprig_act', { act: 'undo-act', item: '1795888550599' }],
  ['manage_automation', { action: 'queue_message', session: 'api-fix', text: 'run the tests' }],
  ['manage_automation', { action: 'queue_clear', session: 'api-fix' }],
  ['manage_project', { action: 'sync', project: 'shop' }],
  ['manage_computer', { action: 'public_link', turn: 'off' }],
  ['watch_session', { session: 'api-fix', job: 'j_0000000000' }],
  // going on in one of his earlier conversations is not new work of hers
  ['start_chat', { folder: '/home/owner/projects/api', conversation: '33333333-3333-4333-8333-333333333333', message: 'go on' }],
  ['start_chat', { folder: '/home/owner/projects/api', fork_of: HIS, message: 'go on' }],
  ['start_work', { folder: '/home/owner/projects/api', kind: 'terminal', mode: 'continue', message: 'go on and push' }],
  ['start_work', { folder: '/home/owner/projects/api', kind: 'terminal', mode: 'resume', conversation: '33333333-3333-4333-8333-333333333333', message: 'go on' }],
];

test('switch on: every act that cannot be taken back is a card, and nothing is written before a tap', async () => {
  const { call, ops } = setup(true);
  await call('list_sessions', {});
  await call('list_projects', {});
  const ran = [];
  for (const [name, args] of CARDS) {
    const before = ops.calls.length;
    const r = await call(name, args);
    const label = `${name} ${args.action || args.act || args.kind || 'chat'}`;
    if (r.isError) continue; // refused on its input: nothing ran
    if (!r.card) ran.push(label);
    assert.equal(ops.calls.length, before, `${label}: wrote before a tap`);
  }
  assert.deepEqual(ran, [], 'these ran alone with no way back');
});

test('her own work stays alone on the sessions she started (by the owner\'s level), with no Undo; switch off, it is a card', async () => {
  const on = setup(true);
  await on.call('list_sessions', {});
  await on.call('list_projects', {});
  const send = await on.call('steer_work', { action: 'send', target: CHAT, text: 'run the tests' });
  assert.equal(send.card, undefined, send.text);
  const start = await on.call('start_work', { folder: '/home/owner/projects/api', message: 'run the tests', provider: 'sub' });
  assert.equal(start.card, undefined, start.text);
  assert.ok(on.audit.recent(50).filter((e) => e.outcome === 'done' && e.level === 'L1').every((e) => !e.result || !e.result.undo), 'no way back is offered for what cannot be taken back');
  assert.equal(on.core.undoMarks(on.audit.recent(50)).filter((e) => e.undo).length, 0);
  const off = setup(false);
  await off.call('list_sessions', {});
  assert.ok((await off.call('steer_work', { action: 'send', target: CHAT, text: 'run the tests' })).card);
});

test('switch on: a rename of a named chat runs alone, Activity offers Undo, one press puts the name back, once', async () => {
  const { call, ops, audit, core } = setup(true);
  await call('list_sessions', {});
  const r = await call('steer_work', { action: 'rename', target: CHAT, name: 'Cart fix' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.card, undefined, 'alone');
  assert.equal(titleOf(ops, CHAT), 'Cart fix');
  const e = entryOf(audit, 'send_to_chat');
  assert.equal(e.level, 'L1');
  assert.deepEqual([e.result.undo.kind, e.result.undo.value], ['rename-chat', 'Run the tests']);
  const [marked] = core.undoMarks([e]);
  assert.equal(marked.undo, 'press');
  const u = await core.undoAct(e.at);
  assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(titleOf(ops, CHAT), 'Run the tests', 'the state is back');
  assert.equal(core.undoMarks([e])[0].undo, 'done');
  const again = await core.undoAct(e.at);
  assert.deepEqual([again.ok, again.code], [false, 'used']);
  assert.ok(audit.recent(50).some((x) => x.tool === 'undo' && x.actor === 'owner' && x.result.undid === e.at), 'the press is in the log');
});

test('switch on: Undo does not overwrite a name the owner gave after her rename', async () => {
  const { call, ops, audit, core } = setup(true);
  await call('list_sessions', {});
  await call('steer_work', { action: 'rename', target: CHAT, name: 'Cart fix' });
  const e = entryOf(audit, 'send_to_chat');
  ops.s.sessions.find((c) => c.name === CHAT).title = 'His own name';
  const u = await core.undoAct(e.at);
  assert.equal(u.ok, false);
  assert.match(u.error, /renamed again/);
  assert.equal(titleOf(ops, CHAT), 'His own name');
});

test('switch on: a terminal session rename and a computer rename are taken back', async () => {
  const { call, ops, audit, core } = setup(true);
  await call('list_sessions', {});
  await call('get_computer_status', {});
  await call('steer_work', { action: 'rename', target: 'api-fix', name: 'footer' });
  assert.ok(ops.s.sessions.some((c) => c.name === 'footer'));
  const t = entryOf(audit, 'send_to_session');
  assert.equal((await core.undoAct(t.at)).ok, true);
  assert.ok(ops.s.sessions.some((c) => c.name === 'api-fix') && !ops.s.sessions.some((c) => c.name === 'footer'));
  const r = await call('manage_computer', { action: 'rename', label: 'Desk' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.card, undefined);
  assert.equal(ops.s.computers[0].label, 'Desk');
  const c = entryOf(audit, 'manage_computer');
  assert.equal((await core.undoAct(c.at)).ok, true);
  assert.equal(ops.s.computers[0].label, 'Laptop');
});

test('switch on: a watch added and a watch removed are taken back; one that was there already has nothing to take back', async () => {
  const { call, watches, audit, core } = setup(true);
  await call('list_sessions', {});
  const add = await call('watch_work', { action: 'add', on: 'session', target: 'api-fix', when: 'needs-me' });
  assert.equal(add.card, undefined, add.text);
  assert.equal(watches.list().length, 1);
  const a = entryOf(audit, 'watch_work');
  assert.equal(a.result.undo.kind, 'watch-add');
  assert.equal((await core.undoAct(a.at)).ok, true);
  assert.equal(watches.list().length, 0, 'the watch is gone again');
  // add once more, then add the same: the second changed nothing
  await call('watch_work', { action: 'add', on: 'session', target: 'api-fix', when: 'needs-me' });
  const id = watches.list()[0].id;
  const same = await call('watch_work', { action: 'add', on: 'session', target: 'api-fix', when: 'needs-me' });
  assert.equal(same.card, undefined);
  assert.equal(entryOf(audit, 'watch_work').result.undo, undefined, 'nothing was added, nothing to take back');
  // remove it: the press puts it back as it was
  const rem = await call('watch_work', { action: 'remove', id });
  assert.equal(rem.card, undefined, rem.text);
  assert.equal(watches.list().length, 0);
  const r = entryOf(audit, 'watch_work');
  assert.equal(r.result.undo.kind, 'watch-remove');
  assert.equal((await core.undoAct(r.at)).ok, true);
  assert.deepEqual(watches.list().map((w) => w.id), [id]);
});

test('switch on: a held start is taken back from Activity (the act records its own way)', async () => {
  const { call, ops, audit, core } = setup(true);
  const r = await call('hoprig_act', { act: 'hold-starts', value: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.card, undefined);
  const e = entryOf(audit, 'hoprig_act');
  assert.equal(core.undoMarks([e])[0].undo, 'press');
  assert.equal((await core.undoAct(e.at)).ok, true);
  assert.deepEqual(ops.calls.filter((c) => c.op.startsWith('mends.')).map((c) => c.op), ['mends.hold', 'mends.release']);
  assert.equal((await core.undoAct(e.at)).code, 'used');
});

test('what changes nothing of his stays free: a note, a page, a check for updates', async () => {
  const { call } = setup(true);
  for (const [name, args] of [['notify_owner', { message: 'tests failed' }], ['open_screen', { screen: 'providers' }]]) {
    const r = await call(name, args);
    assert.equal(r.card, undefined, name);
  }
});

test('with the switch off every one of them is a card (nothing changed there)', async () => {
  const { call, watches } = setup(false);
  await call('list_sessions', {});
  const r = await call('steer_work', { action: 'rename', target: CHAT, name: 'Cart fix' });
  assert.ok(r.card, r.text);
  const w = await call('watch_work', { action: 'add', on: 'session', target: 'api-fix', when: 'needs-me' });
  assert.ok(w.card);
  assert.equal(watches.list().length, 0);
});

test('the table: every entry can be pressed, and the rows of the acts file answer "alone" only where a way back or a free act is', () => {
  for (const [k, b] of Object.entries(BACKS)) {
    assert.equal(typeof b.capture, 'function', k);
    assert.equal(typeof b.record, 'function', k);
    if (!b.own) assert.equal(typeof b.restore, 'function', `${k} has no way back`);
  }
  const doc = loadActs();
  const ids = new Set(doc.rows.map((r) => r.id));
  for (const id of ALONE_ROWS) assert.ok(ids.has(id), `${id} is not a row`);
  const withTool = doc.rows.filter((r) => toolOf(r));
  const alone = withTool.filter((r) => rowAnswer(r) === 'alone');
  const kept = alone.filter((r) => answerFor(r) === 'alone');
  const demoted = alone.filter((r) => answerFor(r) === 'card');
  assert.equal(kept.length + demoted.length, alone.length);
  for (const r of kept) assert.ok(ALONE_ROWS.has(r.id), r.id);
  for (const r of demoted) assert.ok(!ALONE_ROWS.has(r.id), r.id);
  console.log(`CENSUS alone rows with a tool: ${alone.length}; alone with a way back or free: ${kept.length}; now a card: ${demoted.length}`);
  assert.ok(kept.length >= 8 && demoted.length >= 15, `${kept.length} kept, ${demoted.length} demoted`);
  // the free ones are named
  assert.deepEqual(Object.keys(FREE).sort(), ['finish_job', 'manage_computer.check_updates', 'notify_owner', 'open_screen']);
  // his session: no way back, a card; hers: her own work; a start is new work of hers
  assert.equal(aloneOf('send_to_chat', { text: 'hi' }, { mine: false }), null);
  assert.equal(aloneOf('stop_session', {}, { mine: false }), null);
  assert.deepEqual(aloneOf('send_to_chat', { text: 'hi' }, { mine: true }), { kind: 'work' });
  assert.deepEqual(aloneOf('start_chat', {}), { kind: 'work' });
});

test('switch on: Undo of a terminal rename leaves another session that now has the name alone', async () => {
  const { call, ops, audit, core } = setup(true);
  await call('list_sessions', {});
  await call('steer_work', { action: 'rename', target: 'api-fix', name: 'footer' });
  const e = entryOf(audit, 'send_to_session');
  // the owner renamed hers again, then gave the name to another of his sessions
  ops.s.sessions.find((c) => c.name === 'footer').name = 'moved';
  ops.s.sessions.push({ ...ops.s.sessions.find((c) => c.name === 'moved'), name: 'footer', created: 1_700_000_009_000 });
  const u = await core.undoAct(e.at);
  assert.equal(u.ok, false);
  assert.match(u.error, /another session/);
  assert.ok(ops.s.sessions.some((c) => c.name === 'footer') && !ops.s.sessions.some((c) => c.name === 'api-fix'));
});

test('switch on: Undo of a plan change leaves a later change of the owner alone', async () => {
  const { withPlan } = await import('./fake-work.mjs');
  const { call, ops, audit, core } = setup(true);
  withPlan(ops.s);
  const plan = ops.s.work.plans[0];
  // the dashboard applies the change the route is given (the stand-in only records it)
  ops.route = async (a) => {
    ops.calls.push({ op: 'route', args: a });
    if (a.method === 'POST' && a.path.startsWith('/api/work/plans/')) Object.assign(plan, ...['title', 'goal'].filter((k) => a.body[k] !== undefined).map((k) => ({ [k]: a.body[k] })));
    return { ok: true };
  };
  await call('list_sessions', {});
  const r = await call('hoprig_act', { act: 'change-plan', item: plan.id, value: { title: 'Launch the new shop' } });
  assert.equal(r.card, undefined, r.text);
  assert.equal(plan.title, 'Launch the new shop');
  const e = entryOf(audit, 'hoprig_act');
  plan.title = 'His own title';
  const u = await core.undoAct(e.at);
  assert.equal(u.ok, false);
  assert.match(u.error, /changed since/);
  assert.equal(plan.title, 'His own title');
  // untouched since: the press puts the old title back
  plan.title = 'Launch the new shop';
  assert.equal((await core.undoAct(e.at)).ok, true);
  assert.equal(plan.title, 'Launch the shop');
});
