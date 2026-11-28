// One conversation, one card (src/server/onecard.mjs): every card of /api/state carries its key (tool:conversation,
// or term:name for a terminal with none) and where the conversation is (app or terminal), and a key is listed once.
import assert from 'node:assert/strict';
import test from 'node:test';
import { keyOf, oneCard } from '../../src/server/onecard.mjs';

const X = '11111111-1111-4111-8111-111111111111';
const Y = '22222222-2222-4222-8222-222222222222';
const chat = (id, o = {}) => ({ name: `chat:${id}`, kind: 'chat', chatId: id, sessionId: id, tool: 'claude', running: false, title: 'Same title', ...o });
const term = (name, o = {}) => ({ name, kind: 'claude', tool: 'claude', sessionId: null, title: 'Same title', ...o });
const shell = (name, o = {}) => ({ name, kind: 'shell', command: 'bash', ...o });
const view = (list) => oneCard(list).map((c) => [c.name, c.key, c.where, c.readAlong === true]);

test('a conversation in the App and in a terminal is one card: the terminal, read along', () => {
  assert.deepEqual(view([term('proj', { sessionId: X }), chat(X)]), [['proj', `claude:${X}`, 'terminal', true]]);
});

test('a chat whose conversation no terminal runs is one card in the App', () => {
  assert.deepEqual(view([chat(X)]), [[`chat:${X}`, `claude:${X}`, 'app', false]]);
});

test('a terminal before its tool reported the id is keyed by the conversation its launcher named', () => {
  assert.deepEqual(view([term('proj', { conversation: X }), chat(X)]), [['proj', `claude:${X}`, 'terminal', true]]);
  // Before the launcher wrote its record at all: the Deck's note of the start (deck.mjs launching).
  assert.deepEqual(view([shell('proj', { launching: { tool: 'claude', conversation: X } }), chat(X)]), [['proj', `claude:${X}`, 'terminal', true]]);
});

test('two conversations with one title stay two cards', () => {
  assert.deepEqual(view([term('proj', { sessionId: X }), chat(Y)]), [['proj', `claude:${X}`, 'terminal', false], [`chat:${Y}`, `claude:${Y}`, 'app', false]]);
});

test('the plain shell Continue here left behind is not listed, until a coding tool runs there again', () => {
  assert.deepEqual(view([shell('proj', { shellLeft: true }), chat(X, { running: true })]), [[`chat:${X}`, `claude:${X}`, 'app', false]]);
  assert.deepEqual(view([shell('proj', { shellLeft: true, command: 'vim' })]), [['proj', 'term:proj', 'terminal', false]], 'another program in it: his');
  assert.deepEqual(view([term('proj', { sessionId: X, shellLeft: true })]), [['proj', `claude:${X}`, 'terminal', false]]);
});

test('a running chat and a terminal on the same conversation: one card, the terminal', () => {
  assert.deepEqual(view([term('proj', { sessionId: X }), chat(X, { running: true })]), [['proj', `claude:${X}`, 'terminal', false]]);
});

test('a shell the owner opened is keyed by its name; another tool keys by its own name', () => {
  assert.deepEqual(view([shell('notes')]), [['notes', 'term:notes', 'terminal', false]]);
  assert.equal(keyOf(term('c', { tool: 'codex', kind: 'claude', sessionId: Y })), `codex:${Y}`);
  assert.equal(keyOf(term('c', { sessionId: null })), 'term:c', 'a new conversation whose id nobody knows yet');
});

test('a terminal with no title of its own keeps the title the chat of that conversation had', () => {
  const [c] = oneCard([term('proj', { sessionId: X, title: '' }), chat(X, { display: 'Limit the cart requests' })]);
  assert.equal(c.display, 'Limit the cart requests');
  const [own] = oneCard([term('proj', { sessionId: X, display: 'Its own title' }), chat(X, { display: 'Limit the cart requests' })]);
  assert.equal(own.display, 'Its own title', 'a title the terminal has is kept');
  const [plain] = oneCard([term('proj', { sessionId: X, title: '' }), chat(X, { display: 'New session' })]);
  assert.equal(plain.display, undefined, 'the chat placeholder is no title');
});
