// Where Tia's start_chat and start_session start (src/assistant/where-start.mjs, src/operator/where.mjs), through her
// real core and a stand-in dashboard with made-up computers (box2, box3). With Settings → Tia's computers absent she
// starts exactly where she did before; with them, where there is room, never on a computer he did not allow, never on
// one that lacks the project, and she says where and why.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { cleanTiaPatch, resolveTia } from '../../src/assistant/tia.mjs';
import { tapped } from './tapped.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const FOLDER = '/home/owner/projects/api';
const room = (name, r, o = {}) => ({ name, here: name === 'this', room: r, why: '', cpus: 8, load1: r === 'full' ? 14 : 1, memFreePct: 50, reached: true, seenAt: new Date().toISOString(), ...o });

function setup({ computers, rooms, foldersOn } = {}) {
  const s = baseState();
  s.computers.push({ name: 'box3', label: 'Box 3', online: true });
  if (computers !== undefined) s.assistant.computers = computers;
  if (rooms) s.rooms = { computers: rooms };
  if (foldersOn) s.foldersOn = foldersOn;
  const ops = new FakeOps(s);
  const audit = new AuditLog({ file: null });
  const core = createAssistantCore({ ops, cards: new CardStore(), audit, jobs: new JobStore({ dir: null }) });
  const call = (tool, args) => core.call(tool, args, { conversation: 'c1' });
  const started = () => ops.calls.filter((c) => c.op === 'startChat' || c.op === 'startSession').map((c) => c.args.computer);
  return { ops, core, call, started, audit };
}

test('the setting absent: she starts here even when this computer is full and box2 has room, and asks no room', async () => {
  const { ops, call, started } = setup({ rooms: [room('this', 'full'), room('box2', 'free')] });
  const r = await call('start_chat', { folder: FOLDER, account: 'sub', message: 'fix the failing test' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(started(), ['this']);
  assert.ok(!/Where:/.test(r.text), 'nothing said about where: as before');
  assert.equal(ops.reads.filter((x) => x.op === 'rooms').length, 0, 'no room read at all');
});

test('he allowed box2, this computer is full and box2 has room: started there, with why in the answer and the audit', async () => {
  const { call, started, audit } = setup({ computers: ['box2'], rooms: [room('this', 'full'), room('box2', 'free')] });
  const r = await call('start_chat', { folder: FOLDER, account: 'sub', message: 'fix the failing test' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(started(), ['box2']);
  assert.match(r.text, /Where: Build box, because this computer is full and Build box has room/);
  const line = audit.recent(5).find((e) => e.tool === 'start_chat' && e.outcome === 'done');
  assert.equal(line.result.computer, 'box2');
  assert.match(line.result.where, /this computer is full/);
});

test('this computer has room: here, though box2 has room too', async () => {
  const { call, started } = setup({ computers: ['box2'], rooms: [room('this', 'free'), room('box2', 'free')] });
  await call('start_session', { folder: FOLDER, account: 'sub', message: 'go' });
  assert.deepEqual(started(), ['this']);
});

test('box2 has room but not the project: she starts here and says why; the project is never brought there', async () => {
  const { ops, call, started } = setup({ computers: ['box2'], rooms: [room('this', 'full'), room('box2', 'free')], foldersOn: { box2: ['/home/owner/projects/web'] } });
  const r = await call('start_chat', { folder: FOLDER, account: 'sub', message: 'go' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(started(), ['this']);
  assert.match(r.text, /Build box cannot take it: the project is not there/);
  assert.ok(!ops.calls.some((c) => /^project|workspace/.test(c.op)), 'no project, sync or setup on box2');
});

test('a computer he did not allow is refused, also when she names it; one he allowed may be named', async () => {
  const a = setup({ computers: ['box2'], rooms: [room('this', 'free'), room('box2', 'free'), room('box3', 'free')] });
  await a.call('get_computer_status', {});
  const r = await a.call('start_chat', { folder: FOLDER, account: 'sub', message: 'go', computer: 'box3' });
  assert.equal(r.isError, true);
  assert.match(r.text, /not allowed you to start work on box3/);
  assert.deepEqual(a.started(), []);
  const ok = await a.call('start_chat', { folder: FOLDER, account: 'sub', message: 'go', computer: 'box2' });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(a.started(), ['box2']);
});

test('a room not known never has room: full here and box2 unknown stays here', async () => {
  const { call, started } = setup({ computers: ['box2'], rooms: [room('this', 'full'), room('box2', 'unknown', { reached: false })] });
  await call('start_chat', { folder: FOLDER, account: 'sub', message: 'go' });
  assert.deepEqual(started(), ['this']);
});

test('the setting: only his computers, this one always in it; absent or empty is none chosen', () => {
  assert.deepEqual(cleanTiaPatch({ computers: ['box2'] }, [], [], ['box2', 'box3']), { computers: ['this', 'box2'] });
  assert.deepEqual(cleanTiaPatch({ computers: [] }, [], [], ['box2']), { computers: null });
  assert.throws(() => cleanTiaPatch({ computers: ['box9'] }, [], [], ['box2']), /your computers/);
  assert.throws(() => cleanTiaPatch({ computers: 'box2' }, [], [], ['box2']));
  assert.equal(resolveTia({}, { profiles: [] }).computers, null);
  assert.deepEqual(resolveTia({ computers: ['box2'] }, { profiles: [] }).computers, ['this', 'box2']);
});

test('while "Start new work on box2 until this computer is calm" stands: her new starts go there even when this computer has room', async () => {
  const { ops, call, started } = setup({ computers: ['box2', 'box3'], rooms: [room('this', 'free'), room('box2', 'free'), room('box3', 'free', { load1: 0 })] });
  ops.s.rooms.elsewhere = { to: 'box2', label: 'box2', since: new Date().toISOString() };
  const r = await call('start_chat', { folder: FOLDER, account: 'sub', message: 'go' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(started(), ['box2']);
  // a hold that names a computer he no longer chose counts for nothing
  const b = setup({ computers: ['box3'], rooms: [room('this', 'free'), room('box3', 'free')] });
  b.ops.s.rooms.elsewhere = { to: 'box2', label: 'box2', since: new Date().toISOString() };
  await b.call('start_chat', { folder: FOLDER, account: 'sub', message: 'go' });
  assert.deepEqual(b.started(), ['this']);
});

test('ten starts at the same moment, in ten conversations: each sees the ones placed before it, so they spread', async () => {
  const { core, started } = setup({ computers: ['box2', 'box3'], rooms: [room('this', 'full'), room('box2', 'free', { load1: 11 }), room('box3', 'free', { load1: 11 })] });
  const all = await Promise.all(Array.from({ length: 10 }, (_, i) => core.call('start_chat', { folder: FOLDER, account: 'sub', message: `task ${i}` }, { conversation: `c${i}` })));
  assert.ok(all.every((r) => r.isError === false), all.map((r) => r.text).join('\n'));
  const where = started();
  const n = (x) => where.filter((w) => w === x).length;
  assert.equal(where.length, 10);
  assert.ok(n('box2') <= 3 && n('box3') <= 3, `spread, never all on one: ${where}`);
  assert.ok(n('box2') >= 1 && n('box3') >= 1, where.join(','));
});

test('a continue or a resume is no new work: it starts where its conversation is, never moved to a computer with room', async () => {
  const a = setup({ computers: ['box2'], rooms: [room('this', 'full'), room('box2', 'free')] });
  const r = await tapped(a.core, a.call)('start_session', { folder: FOLDER, account: 'sub', mode: 'continue', message: 'go on with it' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(a.started(), ['this']);
  assert.ok(!/Where:/.test(r.text));
  const b = setup({ computers: ['box2'], rooms: [room('this', 'full'), room('box2', 'free')] });
  await b.call('list_projects', { folder: FOLDER });
  const c = await tapped(b.core, b.call)('start_chat', { folder: FOLDER, account: 'sub', conversation: '33333333-3333-4333-8333-333333333333', message: 'go on' });
  assert.equal(c.isError, false, c.text);
  assert.deepEqual(b.started(), ['this']);
});

test('a computer he allowed and she names is asked what it has: one without the project is refused with the clause', async () => {
  const { ops, call, started } = setup({ computers: ['box2'], rooms: [room('this', 'free'), room('box2', 'free')], foldersOn: { box2: ['/home/owner/projects/web'] } });
  await call('get_computer_status', {});
  const r = await call('start_chat', { folder: FOLDER, account: 'sub', message: 'go', computer: 'box2' });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /Build box \(box2\) cannot take it: the project is not there/);
  assert.deepEqual(started(), []);
  assert.ok(!ops.calls.some((c) => /^project|workspace/.test(c.op)), 'nothing brought there');
});

test('while the hold stands on box2 and box2 is full, she starts here and says why in true words: this computer is not full', async () => {
  const { ops, call, started } = setup({ computers: ['box2'], rooms: [room('this', 'free'), room('box2', 'full')] });
  ops.s.rooms.elsewhere = { to: 'box2', label: 'box2', since: new Date().toISOString() };
  const r = await call('start_chat', { folder: FOLDER, account: 'sub', message: 'go' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(started(), ['this']);
  assert.ok(!/this computer is full/.test(r.text), r.text);
  assert.match(r.text, /new work is held off this computer until it is calm, but Build box is full, so it starts here/);
});

test('her card and her answer name a computer by his label, and this one as "this computer"; the inner name stays in the data', async () => {
  const a = setup({ computers: ['box2'], rooms: [room('this', 'full'), room('box2', 'free')] });
  a.ops.s.assistant.level = 'ask';
  await a.call('start_chat', { folder: FOLDER, account: 'sub', message: 'fix the failing test' });
  const [card] = a.core.cards.pending();
  assert.ok(card, 'at "Ask me" the start is a card');
  assert.ok(card.lines.includes('Where: Build box, because this computer is full and Build box has room'), card.lines.join('\n'));
  assert.ok(!card.lines.some((l) => /^Where: box2\b/.test(l)));
  const b = setup({ computers: ['box2'], rooms: [room('this', 'free'), room('box2', 'free')] });
  const h = await b.call('start_chat', { folder: FOLDER, account: 'sub', message: 'go' });
  assert.equal(h.isError, false, h.text);
  assert.match(h.text, /Where: this computer, because this computer has room/);
  assert.ok(!/Where: this,/.test(h.text));
});

test('a continue or a resume on a computer he did not allow is refused like any start there; on one he allowed it starts where it names', async () => {
  const a = setup({ computers: ['box2'], rooms: [room('this', 'free'), room('box2', 'free'), room('box3', 'free')] });
  await a.call('get_computer_status', {});
  const r = await a.call('start_session', { folder: FOLDER, account: 'sub', mode: 'continue', message: 'go on', computer: 'box3' });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /not allowed you to start work on box3/);
  const s = await a.call('start_session', { folder: FOLDER, account: 'sub', mode: 'resume', message: 'go on', computer: 'box3' });
  assert.equal(s.isError, true, s.text);
  await a.call('list_projects', { folder: FOLDER });
  const c = await a.call('start_chat', { folder: FOLDER, account: 'sub', conversation: '33333333-3333-4333-8333-333333333333', message: 'go on', computer: 'box3' });
  assert.equal(c.isError, true, c.text);
  assert.match(c.text, /not allowed you to start work on box3/);
  assert.deepEqual(a.started(), []);
  // On a computer he allowed, a continue still starts where it names, with no room read and nothing asked there.
  const ok = await tapped(a.core, a.call)('start_session', { folder: FOLDER, account: 'sub', mode: 'continue', message: 'go on', computer: 'box2' });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(a.started(), ['box2']);
  assert.ok(!/Where:/.test(ok.text), ok.text);
});

test('a slow lookup on box2 for one start does not hold back a start in another conversation that names this computer', async () => {
  const { ops, core, started } = setup({ computers: ['box2'], rooms: [room('this', 'full'), room('box2', 'free')] });
  let release;
  const gate = new Promise((r) => (release = r));
  const browse = ops.browse.bind(ops);
  ops.browse = async (a) => {
    if (a.computer === 'box2') await gate; // box2's link hangs until the test lets it answer
    return browse(a);
  };
  const first = core.call('start_chat', { folder: FOLDER, account: 'sub', message: 'task one' }, { conversation: 'c1' });
  await new Promise((r) => setTimeout(r, 20));
  const second = core.call('start_chat', { folder: FOLDER, account: 'sub', message: 'task two', computer: 'this' }, { conversation: 'c2' });
  const won = await Promise.race([second.then(() => 'named'), new Promise((r) => setTimeout(() => r('held back'), 1000))]);
  assert.equal(won, 'named', 'the start named for this computer waited for the lookup on box2');
  assert.deepEqual(started(), ['this']);
  release();
  const r = await first;
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(started(), ['this', 'box2']);
});

// In his turn, a start on another computer he did not name is a card (core.mjs); a start placed by room on a computer
// he chose under Settings → Tia is not: that list is his choice. One she names herself, though allowed, stays a card.
test('in his turn: placed by room on a computer he chose starts at once; one she names herself waits for his tap', async () => {
  const a = setup({ computers: ['box2'], rooms: [room('this', 'full'), room('box2', 'free')] });
  a.core.beginTurn('c1', { origin: 'owner', text: 'Get the failing router test fixed.' });
  const r = await a.call('start_chat', { folder: FOLDER, account: 'sub', message: 'fix the failing test' });
  assert.equal(r.isError, false, r.text);
  assert.ok(!/Waiting for the owner's OK/.test(r.text), r.text);
  assert.deepEqual(a.started(), ['box2']);
  const b = setup({ computers: ['box2'], rooms: [room('this', 'free'), room('box2', 'free')] });
  b.core.beginTurn('c1', { origin: 'owner', text: 'Get the failing router test fixed.' });
  await b.call('get_computer_status', {});
  const s = await b.call('start_chat', { folder: FOLDER, account: 'sub', message: 'fix the failing test', computer: 'box2' });
  assert.match(s.text, /Waiting for the owner's OK/);
  assert.deepEqual(b.started(), []);
});
