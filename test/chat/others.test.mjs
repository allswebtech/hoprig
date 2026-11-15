// How the rest of the dashboard sees an open chat (a session card of kind "chat"): Tia's tools, idle care, the
// Claude Code update, and the notifications when a chat is closed.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import * as idle from '../../src/automation/idle.mjs';
import * as updates from '../../src/automation/updates.mjs';
import { transitions } from '../../src/server/watcher.mjs';
import { FakeOps, baseState } from '../assistant/fake-dashboard.mjs';

const BUILTIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const ID = '44444444-4444-4444-8444-444444444444';
const chatCard = (o = {}) => ({
  computer: 'this', name: `chat:${ID}`, kind: 'chat', chatId: ID, display: 'Fix the footer', title: 'Fix the footer', status: 'attention',
  profile: { name: 'api', label: 'API key', kind: 'api' }, cwd: '/home/owner/projects/web', lastMessage: 'I will edit footer.css.',
  note: 'Allow Edit: footer.css?', limit: null, sessionId: ID, statusAt: Date.now() - 60_000, running: true, ...o,
});

function tia() {
  const s = baseState();
  s.sessions.push(chatCard());
  const ops = new FakeOps(s);
  const core = createAssistantCore({
    ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }),
    jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [{ dir: BUILTIN, source: 'built-in' }] }),
  });
  return { ops, call: (tool, args) => core.call(tool, args, { conversation: 'c1' }) };
}

test('Tia: a chat that waits for an OK needs the owner; her terminal tools say plainly to open it in the page', async () => {
  const { ops, call } = tia();
  const list = await call('list_sessions', { status: 'needs_owner' });
  assert.equal(list.isError, false);
  assert.match(list.text, new RegExp(`chat:${ID}`), 'listed with the sessions that need the owner');
  assert.match(list.text, /"status":\s*"needs_ok"/);
  assert.match(list.text, /"chat":\s*true/);
  const read = await call('read_session', { session: `chat:${ID}` });
  assert.equal(read.isError, false);
  assert.match(read.text, /a chat in the dashboard page/);
  for (const [tool, args] of [['send_to_session', { text: 'yes' }], ['press_key', { key: 'Enter' }], ['stop_session', {}], ['switch_account', { account: 'sub' }]]) {
    const r = await call(tool, { session: `chat:${ID}`, ...args });
    assert.equal(r.isError, true, tool);
    assert.match(r.text, /is a chat in the dashboard page, not a terminal session/, tool);
    assert.match(r.text, /open it on Home/, tool);
    assert.ok(!r.card, `${tool}: no card for something that cannot run`);
  }
  assert.equal(ops.calls.length, 0, 'nothing was typed or changed');
  assert.ok(!ops.reads.some((x) => x.op === 'capture' && x.args.session === `chat:${ID}`), 'a chat has no screen to read');
});

test('idle care: a gateway that an open chat runs on is kept; once the chat\'s process stops it is not', () => {
  const MIN = 60_000;
  const settings = { shells: false, gateway: true, gatewayMinutes: 30 };
  const addons = [{ id: 'trouteai', profile: 'api' }];
  let r = idle.decide({ cards: [chatCard()], data: {}, now: 0, settings, addons });
  r = idle.decide({ cards: [chatCard()], data: r.data, now: 61 * MIN, settings, addons });
  assert.deepEqual(r.actions, [], 'the chat\'s process uses it');
  r = idle.decide({ cards: [chatCard({ provider: 'x', profile: { name: 'auto' } })], data: r.data, now: 62 * MIN, settings, addons, autoOrder: ['api'] });
  assert.deepEqual(r.actions, [], 'an Auto chat may route to it');
  r = idle.decide({ cards: [chatCard({ running: false, status: 'waiting' })], data: r.data, now: 93 * MIN, settings, addons });
  assert.deepEqual(r.actions.map((a) => a.type), ['stop-gateway'], 'its next message runs the provider\'s start again');
});

test('updates: a working chat postpones a Claude Code update', () => {
  const on = { claude: 'auto' };
  assert.deepEqual(updates.decide({ cards: [chatCard({ status: 'working' })], data: {}, now: 10 * 3600_000, settings: on }).actions, []);
  assert.deepEqual(updates.decide({ cards: [chatCard({ status: 'waiting' })], data: {}, now: 10 * 3600_000, settings: on }).actions, [{ type: 'check' }]);
});

test('notifications: a chat closed on purpose sends no "ended"; a terminal session that goes does', () => {
  let { next } = transitions(new Map(), [chatCard({ status: 'waiting' }), { name: 'shop', kind: 'claude', status: 'waiting' }]);
  const { events } = transitions(next, []);
  assert.deepEqual(events.map((e) => [e.status, e.card.name]), [['ended', 'shop']]);
  // A chat's own states still notify, with its title.
  ({ next } = transitions(new Map(), [chatCard({ status: 'working' })]));
  const asks = transitions(next, [chatCard()]).events;
  assert.deepEqual(asks.map((e) => [e.status, e.card.display]), [['attention', 'Fix the footer']]);
});
