// The census of her switch: with "Tia acts by herself" OFF, no call of hers changes anything without a card the owner
// confirms; with it ON, only the calls whose rule is "alone" run at once. Every tool of her array is called with every
// verb that can change something. A real model renamed a chat through steer_work with the switch off and no card.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { WatchStore } from '../../src/assistant/watches.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const CHAT = 'chat:55555555-5555-4555-8555-555555555501';

function setup(actAlone) {
  const state = baseState();
  state.assistant = { ...state.assistant, enabled: true, level: 'work', actAlone };
  // a chat she started herself, among the sessions
  state.sessions.push({ computer: 'this', name: CHAT, kind: 'chat', chatId: CHAT.slice(5), byTia: true, status: 'waiting', profile: { name: 'sub', label: 'Main', kind: 'subscription' }, cwd: '/home/owner/projects/api', title: 'Run the tests', lastMessage: '', note: '', limit: null, sessionId: CHAT.slice(5), statusAt: Date.now() - 60_000, created: 1_700_000_002_000 });
  const ops = new FakeOps(state);
  const cards = new CardStore({ now: Date.now });
  const watches = new WatchStore({ file: null, now: Date.now });
  const core = createAssistantCore({ ops, now: Date.now, cards, audit: new AuditLog({ file: null, now: Date.now }), jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }), watches });
  const call = (name, args) => core.call(name, args, { conversation: 'sw' });
  return { ops, cards, watches, call, core };
}

// Every call of hers that can change something, by a verb of a tool of her array. The sessions are shown first (look).
const CHANGES = [
  ['steer_work', { action: 'send', target: 'api-fix', text: 'go on' }],
  ['steer_work', { action: 'send', target: CHAT, text: 'run the tests' }],
  ['steer_work', { action: 'key', target: 'api-fix', key: 'Enter' }],
  ['steer_work', { action: 'answer', target: CHAT, answer: 'no' }],
  ['steer_work', { action: 'rename', target: CHAT, name: 'footer work' }],
  ['steer_work', { action: 'rename', target: 'api-fix', name: 'footer' }],
  ['steer_work', { action: 'continue', target: 'api-fix' }],
  ['steer_work', { action: 'to_chat', target: 'api-fix' }],
  ['steer_work', { action: 'to_terminal', target: CHAT }],
  ['steer_work', { action: 'close', target: CHAT }],
  ['steer_work', { action: 'stop', target: 'api-fix' }],
  ['steer_work', { action: 'stop', target: CHAT }],
  ['steer_work', { action: 'switch_provider', target: 'api-fix', provider: 'sub2' }],
  ['start_work', { folder: '/home/owner/projects/api', message: 'run the tests', provider: 'sub' }],
  ['start_work', { kind: 'terminal', folder: '/home/owner/projects/web', provider: 'sub' }],
  ['watch_work', { action: 'add', on: 'session', target: 'api-fix', when: 'needs-me' }],
];

test('switch off: no verb of hers changes anything without a card', async () => {
  const { call, ops, watches } = setup(false);
  await call('list_sessions', {});
  await call('list_projects', {});
  const refused = [];
  let staged = 0;
  for (const [name, args] of CHANGES) {
    const before = ops.calls.length;
    const r = await call(name, args);
    const label = `${name} ${args.action || args.kind || 'chat'}`;
    // a refusal on the input is fine (nothing ran); a call that did not fail must be a card
    if (r.isError) {
      refused.push(label);
      continue;
    }
    staged += 1;
    assert.ok(r.card, `${label}: no card (${String(r.text).slice(0, 120)})`);
    assert.equal(ops.calls.length, before, `${label}: wrote before a tap`);
  }
  assert.equal(watches.list().length, 0, 'no watch before a tap');
  assert.ok(staged >= CHANGES.length - 3, `most verbs reached the rule, refused on input: ${refused.join(', ')}`);
});

test('switch off: a watch is a card, and the tap makes it', async () => {
  const { call, watches, core } = setup(false);
  await call('list_sessions', {});
  const r = await call('watch_work', { action: 'add', on: 'session', target: 'api-fix', when: 'needs-me' });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.card, r.text);
  assert.equal(watches.list().length, 0);
  const tap = await core.confirm(r.card.id);
  assert.equal(tap.ok, true, JSON.stringify(tap));
  assert.equal(watches.list().length, 1, 'the tap made the watch');
  const done = await call('watch_work', { action: 'list' });
  assert.equal(done.isError, false);
  assert.equal(done.card, undefined, 'a list is a read');
});

test('switch on: the verbs of hers that are alone run at once (her own chat renamed)', async () => {
  const { call, ops } = setup(true);
  await call('list_sessions', {});
  const r = await call('steer_work', { action: 'rename', target: CHAT, name: 'footer work' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.card, undefined, 'alone with the switch on');
  assert.ok(ops.calls.length > 0);
  const w = await call('watch_work', { action: 'add', on: 'session', target: 'api-fix', when: 'needs-me' });
  assert.equal(w.card, undefined, w.text);
});

test('what only tells the owner stays free with the switch off: a note, a page, a look', async () => {
  const { call } = setup(false);
  const n = await call('notify_owner', { message: 'the tests failed' });
  assert.equal(n.isError, false, n.text);
  assert.equal(n.card, undefined);
  const o = await call('open_screen', { screen: 'providers' });
  assert.equal(o.card, undefined);
  const l = await call('list_sessions', {});
  assert.equal(l.card, undefined);
});
