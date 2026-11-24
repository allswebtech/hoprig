// A provider that stopped a session, or an agent inside a session that still works: one item per session, named by
// the closed table, with the one step that recovers. Made-up names only; the gateway is the made-up "relay".
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectProviderStop } from '../../src/operator/detect/providerstop.mjs';
import { detectLimit } from '../../src/operator/detect/limit.mjs';
import { agentsOf, stopOf } from '../../src/operator/sources.mjs';
import { attention } from '../../src/operator/attention.mjs';
import { NOW, ago, session } from './fixtures/cases.mjs';

// What the hook keeps (src/hook.mjs: failure, agentStops), in the shapes Claude Code 2.1.328 sent.
const agentStop = (error, text, label = 'Check the shop page', min = 7) => ({ id: 'a6e1e6756ce2da8e7', label, at: NOW - min * 60_000, error, text });
const board = (over, gateways = []) => ({ sessions: [session({ name: 'shop', provider: 'relay-a', ...over })], gateways });

test('an agent that ended on an ambiguous model name, in a session that still works, is an item that says a step was lost', () => {
  const agents = agentsOf([agentStop('unknown', "API Error: 400 Ambiguous model 'relay-large': it matches more than one model of this gateway")]);
  const [it, ...rest] = detectProviderStop(board({ state: 'working', agents }), { now: NOW });
  assert.equal(rest.length, 0);
  assert.deepEqual([it.kind, it.class, it.subject], ['providerstop', 'stopped', 'session shop']);
  assert.ok(it.facts.includes('agent "Check the shop page" stopped: the endpoint refuses this model name, 7 min ago'), it.facts.join('|'));
  assert.ok(it.facts.some((f) => f.startsWith("it says: API Error: 400 Ambiguous model 'relay-large'")), it.facts.join('|'));
  assert.ok(it.facts.includes('the session goes on, but a step of it was lost'), it.facts.join('|'));
  assert.ok(it.facts.includes('provider relay-a'));
  // Until the provider check and the map for every session exist, the item says the mend that works today, and the
  // Providers page is only "see this provider".
  assert.deepEqual(it.acts, [{ id: 'open', label: 'Open the session', href: '#/s/shop' }, { id: 'open', label: 'See this provider', href: '#/providers' }]);
  assert.equal(it.why, 'Add a combo of this name at the gateway, or choose a model the endpoint lists.');
  assert.equal(it.since, ago(7));
});

test('each name gets its one step', () => {
  const relay = [{ name: 'relay', users: ['relay-a'] }];
  const step = (error, text, gateways = relay) => {
    const [it] = detectProviderStop(board({ state: 'attention', stop: stopOf({ at: NOW - 60_000, error, text }) }, gateways), { now: NOW });
    return [it.acts.map((a) => a.label || a.id), it.recommended];
  };
  assert.deepEqual(step('authentication_failed', 'Invalid API key · Fix external API key'), [['Open Providers to sign in'], 'open']);
  assert.deepEqual(step('model_not_found', "There's an issue with the selected model (relay-small)."), [['Open the session', 'See this provider'], 'open']);
  assert.deepEqual(step('server_error', 'Request timed out.'), [['restart-gateway', 'Open the session'], 'restart-gateway']);
  // With no gateway in front of the provider there is nothing to restart: the session is opened.
  assert.deepEqual(step('server_error', 'Request timed out.', []), [['Open the session'], 'open']);
  assert.deepEqual(step('server_error', 'API Error: 529 Overloaded'), [['Open the session'], 'open']);
  assert.deepEqual(step('unknown', 'API Error: 400 Image input is not supported for model relay-large'), [['Open the session'], 'open']);
});

test("a refusal is shown as a refusal, with the provider's words, and offers nothing that sends it again or elsewhere", () => {
  const text = "API Error: Haiku 4.5 can't help with this. Start a new session to continue.";
  const [it] = detectProviderStop(board({ state: 'attention', canSwitch: true, nextProvider: 'plan-b', stop: stopOf({ at: NOW - 60_000, error: 'invalid_request', text }) }), { now: NOW });
  assert.ok(it.facts.includes('the session stopped: the provider refused the request, 1 min ago'), it.facts.join('|'));
  assert.ok(it.facts.includes(`it says: ${text}`));
  assert.deepEqual(it.acts.map((a) => a.id), ['open']);
  assert.match(it.why, /does not send it again or elsewhere/);
});

test("a usage limit stays the limit item: an agent's limit fills agents[].limit, and no second item is made", () => {
  const agents = agentsOf([agentStop('rate_limit', "API Error: Request rejected (429) · This request would exceed your account's rate limit.")], NOW);
  const b = board({ state: 'working', agents });
  assert.deepEqual(detectProviderStop(b, { now: NOW }), []);
  const [lim] = detectLimit(b, { now: NOW });
  assert.ok(lim.facts.some((f) => f.startsWith('agent "Check the shop page" stopped at a usage limit')), lim.facts.join('|'));
  const l = attention(b, { now: NOW });
  assert.deepEqual(l.items.map((i) => i.kind), ['limit']);
});

test('ordinary runs make no item: no failure, an error the table does not call a stop, an old agent stop', () => {
  assert.deepEqual(detectProviderStop(board({}), { now: NOW }), []);
  assert.equal(stopOf(null), null);
  assert.equal(stopOf({ at: NOW, error: '', text: 'Error: 2 of 40 tests failed' }), null);
  assert.deepEqual(agentsOf([{ id: 'x', label: 'y' }, 'bad', null]), [], 'an entry with no error is no stop');
  const old = agentsOf([agentStop('server_error', 'API Error: 500 Internal server error', 'Review', 25 * 60)]);
  assert.deepEqual(detectProviderStop(board({ agents: old }), { now: NOW }), [], 'a day later it is gone');
  assert.deepEqual(detectProviderStop({ sessions: null }, { now: NOW }), []);
});

test('several agents of one session are one item; a later stop is a new item (its rev changes)', () => {
  const two = agentsOf([agentStop('server_error', 'API Error: 500 Internal server error', 'Review the cart', 9), { ...agentStop('unknown', 'API Error: 400 Image input is not supported for model relay-large', 'Read the picture', 3), id: 'a2' }]);
  const [it] = detectProviderStop(board({ agents: two.slice(0, 1) }), { now: NOW });
  const [both, ...rest] = detectProviderStop(board({ agents: two }), { now: NOW });
  assert.equal(rest.length, 0);
  assert.equal(both.id, it.id);
  assert.notEqual(both.rev, it.rev);
  assert.ok(both.facts.some((f) => f.startsWith('agent "Read the picture" stopped: the model does not take this kind of input')), both.facts.join('|'));
});

test('a gateway that lists the profile by its label still offers "Restart the gateway"', () => {
  const stop = stopOf({ at: NOW - 5 * 60_000, error: 'server_error', text: 'API Error: Request timed out.' });
  const b = { sessions: [session({ name: 'shop', provider: 'relay-a', providerLabel: 'Relay A', state: 'attention', stop })], gateways: [{ name: 'relay', users: ['Relay A'] }] };
  const [it] = detectProviderStop(b, { now: NOW });
  assert.equal(it.recommended, 'restart-gateway');
  assert.equal(it.target.addon, 'relay');
  // No gateway of this provider: the item does not promise a restart.
  const [alone] = detectProviderStop({ ...b, gateways: [] }, { now: NOW });
  assert.deepEqual(alone.acts.map((a) => a.id), ['open']);
  assert.doesNotMatch(alone.why, /restart/i);
});

test("an agent's usage limit is past after a day and is named by the agent's label", () => {
  const limitOf = (min) => agentsOf([{ id: 'a66afc7c2d490909c', label: 'Review the page', at: NOW - min * 60_000, error: 'rate_limit', text: 'API Error: 429 limit' }], NOW);
  const [it] = detectLimit({ sessions: [session({ name: 'shop', state: 'working', agents: limitOf(30) })] }, { now: NOW });
  assert.ok(it.facts.some((f) => f.startsWith('agent "Review the page" stopped at a usage limit')), it.facts.join('|'));
  assert.deepEqual(detectLimit({ sessions: [session({ name: 'shop', state: 'working', agents: limitOf(3 * 24 * 60) })] }, { now: NOW }), []);
});

test('a chat makes the same items, opened by its own address, and is never ended from here', () => {
  const chat = (over) => session({ name: 'chat:7f3a9c21-0000-4000-8000-000000000001', chatId: '7f3a9c21-0000-4000-8000-000000000001', display: 'Fix the shop page', provider: 'relay-a', ...over });
  const agents = agentsOf([agentStop('unknown', "API Error: 400 Ambiguous model 'relay-large'")], NOW);
  const [it] = detectProviderStop({ sessions: [chat({ state: 'working', agents })] }, { now: NOW });
  assert.equal(it.subject, 'chat "Fix the shop page" (7f3a9c21)');
  assert.deepEqual(it.acts[0], { id: 'open', label: 'Open the chat', href: '#/chat/7f3a9c21-0000-4000-8000-000000000001' });
  const lim = agentsOf([agentStop('rate_limit', 'API Error: 429 limit')], NOW);
  const [l] = detectLimit({ sessions: [chat({ state: 'working', canSwitch: false, nextProvider: null, agents: lim })] }, { now: NOW });
  assert.deepEqual(l.acts.map((a) => a.label || a.id), ['Open the chat'], 'no "End the session" for a chat');
});

test("with a gateway's long line and several agents, who stopped and the step are whole; only the tool's words are cut", () => {
  const long = "API Error: 400 Ambiguous model 'relay-large': it matches more than one model of this gateway (key ***, account ***";
  for (const n of [1, 3]) for (const chat of [{}, { chatId: '7f3a9c21-0000-4000-8000-000000000001', display: 'Fix the shop page' }]) {
    const agents = agentsOf(Array.from({ length: n }, (_, i) => agentStop('unknown', long, 'Check the shop page', 1 + i)), NOW);
    const [it] = detectProviderStop({ sessions: [session({ name: 'shop-review', provider: 'relay-a', state: 'working', agents, ...chat })] }, { now: NOW });
    assert.equal(it.why, 'Add a combo of this name at the gateway, or choose a model the endpoint lists.');
    assert.ok(it.facts[0].startsWith('agent "Check the shop page" stopped: the endpoint refuses this model name, 1 min ago'), it.facts[0]);
    assert.ok(it.facts.filter((f) => !f.startsWith('it says:')).every((f) => !f.endsWith('…')), it.facts.join('|'));
  }
});

test("the model-name item says a MODELS mend needs the switch while it is off", async () => {
  const { gapsOf } = await import('../../src/providers/check.mjs');
  const mend = { combo: 'Add a combo named "claude-opus-5" at the gateway', models: 'MODELS=claude-opus-5=claude-opus-5-5' };
  mend.line = `${mend.combo}, or set ${mend.models}`;
  const result = { rows: [{ verdict: 'refused', sends: 'claude-opus-5', asks: 'claude-opus-5', mend }] };
  const stop = stopOf({ at: NOW - 60_000, error: 'unknown', text: "API Error: 400 Ambiguous model 'claude-opus-5'", own: true });
  const why = (on) => detectProviderStop({ sessions: [session({ name: 'shop', provider: 'relay-a', state: 'attention', stop })], providers: [{ name: 'relay-a', checkable: true, check: { at: NOW, gaps: gapsOf(result, { on }) } }] }, { now: NOW })[0].why;
  // Whole, or in the short form when the whole line has no room: either way it says the map must be on for sessions.
  assert.match(why(false), /turn on "Use these names for every session on this provider"|with its map turned on for sessions/);
  assert.doesNotMatch(why(true), /turn(ed)? on/);
});

test('a long MODELS mend that has no room in the reason still says that it needs the switch', async () => {
  const { gapsOf } = await import('../../src/providers/check.mjs');
  const models = `MODELS=${['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5'].map((n) => `${n}=claude-opus-5-5`).join(',')},relay-x=relay-y`;
  const mend = { combo: 'Add a combo named "claude-opus-5" at the gateway', models };
  mend.line = `${mend.combo}, or set ${mend.models}`;
  const result = { rows: [{ verdict: 'refused', sends: 'claude-opus-5', asks: 'claude-opus-5', mend }] };
  const stop = stopOf({ at: NOW - 60_000, error: 'unknown', text: "API Error: 400 Ambiguous model 'claude-opus-5'", own: true });
  const why = (on) => detectProviderStop({ sessions: [session({ name: 'shop', provider: 'relay-a', state: 'attention', stop })], providers: [{ name: 'relay-a', checkable: true, check: { at: NOW, gaps: gapsOf(result, { on }) } }] }, { now: NOW })[0].why;
  assert.equal(why(false), 'Add a combo named "claude-opus-5" at the gateway, or use the MODELS line on its page with its map turned on for sessions.');
  assert.equal(why(true), 'Add a combo named "claude-opus-5" at the gateway, or use the MODELS line on its page.');
});
