// start_work carries what the design lists: a model, an effort, a worktree and a watch. A model, effort or worktree that is
// not his defaults is a card that shows it; the watch is the store's own (watches.mjs) and tells by a push when it fails.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { checkRoute } from '../../src/assistant/door.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { WatchStore, factsOf } from '../../src/assistant/watches.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

function setup() {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true, level: 'work' };
  const ops = new FakeOps(s);
  const watches = new WatchStore({ file: null });
  const core = createAssistantCore({ ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }), jobs: new JobStore({ dir: null, now: Date.now }), watches });
  return { ops, core, watches, call: (tool, args) => core.call(tool, args, { conversation: 'c1' }) };
}
const FOLDER = '/home/owner/projects/api';

test('a model, an effort and a worktree make a card that shows them, and reach the start once he confirms', async () => {
  const { call, ops, core } = setup();
  await call('list_projects', {});
  const r = await call('start_work', { folder: FOLDER, provider: 'sub', message: 'fix the failing test', model: 'opus', effort: 'high', worktree: true });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Waiting for the owner's OK \(card c_/);
  assert.ok(!ops.calls.some((c) => c.op === 'startChat'), 'nothing started before his tap');
  const card = core.cards.pending()[0];
  assert.match(JSON.stringify(card), /Model: opus/);
  assert.match(JSON.stringify(card), /Effort: high/);
  assert.match(JSON.stringify(card), /worktree/i);
  const done = await core.confirm(card.id);
  assert.ok(done.ok !== false, JSON.stringify(done));
  const start = ops.calls.find((c) => c.op === 'startChat');
  assert.equal(start.args.model, 'opus');
  assert.equal(start.args.effort, 'high');
  assert.equal(start.args.worktree, true);
});

test('a watch of a started chat is the store\'s own and tells when it fails', async () => {
  const { call, watches } = setup();
  await call('list_projects', {});
  const r = await call('start_work', { folder: FOLDER, provider: 'sub', message: 'run the tests', watch: 'fails' });
  assert.equal(r.isError, false, r.text);
  const [w] = watches.list();
  assert.ok(w, 'a watch was added');
  assert.equal(w.on, 'chat');
  assert.equal(w.when, 'fails');
  assert.match(r.text, new RegExp(w.id));
  const f = (s) => factsOf({ sessions: [{ name: w.target, ...s }] });
  assert.equal(watches.evaluate(f({ state: 'working' })).length, 0);
  assert.equal(watches.evaluate(f({ state: 'ended', limit: { until: 1 } })).length, 1);
});

test('a terminal takes none of them, and a chat without them stays as it was', async () => {
  const { call, ops } = setup();
  await call('list_projects', {});
  const t = await call('start_work', { kind: 'terminal', folder: FOLDER, provider: 'sub', model: 'opus' });
  assert.equal(t.isError, true);
  assert.match(t.text, /model goes only with a chat/);
  const r = await call('start_work', { folder: FOLDER, provider: 'sub', message: 'hello' });
  assert.equal(r.isError, false, r.text);
  const start = ops.calls.find((c) => c.op === 'startChat');
  assert.equal(start.args.model, undefined);
});

test('the door takes the three fields in a chat start, checked', () => {
  const stub = { config: () => ({}), settingsOf: () => null };
  const body = { dir: FOLDER, defaults: true, byTia: true, model: 'opus', effort: 'high', worktree: true };
  assert.equal(checkRoute('POST', '/api/chats', body, stub).tool, 'start_chat');
  for (const bad of [{ model: 'a b' }, { effort: 'huge' }, { worktree: 'yes' }]) assert.throws(() => checkRoute('POST', '/api/chats', { ...body, ...bad }, stub), /model is|effort is|worktree is/);
});
