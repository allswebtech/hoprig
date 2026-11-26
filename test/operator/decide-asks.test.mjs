// The asks kind of "Tia decides" on a REAL card: a chat of the stand-in Claude Code asks a question; the adapter
// (src/operator/decide-asks.mjs) reads the chat's own exact card and Hands-off's switch, the table offers its options,
// and the answer goes through answerAsk with the card's key. A marked option, Hands-off off or not offered, two
// asks at once, or a terminal session: nothing is offered.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const box = sandbox('decideasks');
test.after(() => box.cleanup());

const { Chat } = await import('../../src/chat/chat.mjs');
const { chatQuestion } = await import('../../src/chat/feature.mjs');
const { hoprigVersion } = await import('../../src/handsoff.mjs');
const { asksAdapter } = await import('../../src/operator/decide-asks.mjs');
const { prepared } = await import('../../src/operator/decide-table.mjs');
const { makeItem } = await import('../../src/operator/item.mjs');
const V = hoprigVersion();

const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};
function newChat({ on = true, offered = true, note = '' } = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const config = () => ({ handsOff: { offered, projects: { [cwd]: { on, version: V, note } } } });
  return new Chat({ id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), handsOffConfig: config });
}
const call = (name, input) => `call ${Buffer.from(JSON.stringify({ name, input })).toString('base64')}`;
const question = (q, labels) => call('AskUserQuestion', { questions: [{ question: q, header: 'Choice', multiSelect: false, options: labels.map((label) => ({ label, description: `About ${label}` })) }] });
// The chat feature's two handles, over one real chat.
const featureOf = (c) => ({ question: (id) => (id === c.id ? chatQuestion(c) : null), answerQuestion: (id, request, a) => c.answer(request, a) });
const itemOf = (c) => makeItem({ kind: 'asks', cls: 'waits', subject: `session chat:${c.id}`, facts: ['the session waits for your answer'], acts: ['open'], target: { session: `chat:${c.id}` } });
const boardOf = (c) => ({ sessions: [{ name: `chat:${c.id}`, chatId: c.id, askType: 'question', asks: ['main'] }] });
const offeredOf = (c, adapter) => prepared(itemOf(c), boardOf(c), { card: (n) => adapter.card(n), alone: (t) => adapter.alone(t) }).map((s) => s.id);

// Hands-off is not offered on Windows (src/handsoff.mjs handsOffOffered: the wall's hold is a POSIX shell test).
test('a real question with three options and no mark, Hands-off on: offered, and answered through answerAsk with its label', { skip: process.platform === 'win32' && 'Hands-off is not offered on Windows' }, async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  const turn = new Promise((r) => c.once('turn', r));
  await c.send(question('Which database should the app use?', ['SQLite', 'Postgres', 'None yet']));
  await until('card', () => c.pending.size);
  const a = asksAdapter({ chat: featureOf(c) });
  const card = a.card(`chat:${c.id}`);
  assert.equal(card.handsOff, true);
  assert.equal(card.marked, null);
  assert.deepEqual(card.options.map((o) => o.label), ['SQLite', 'Postgres', 'None yet']);
  assert.deepEqual(offeredOf(c, a), ['answer-1', 'answer-2', 'answer-3']);
  await a.answer(`chat:${c.id}`, { option: 2 });
  await turn;
  assert.equal(c.pending.size, 0, 'answered');
  assert.equal(c.events.filter((e) => e.kind === 'ask-closed').at(-1).outcome, 'allowed');
  await assert.rejects(a.answer(`chat:${c.id}`, { option: 1 }), /not one Tia may answer/, 'the same answer twice is given once');
});

test('the tool\'s own recommended mark is never the model\'s: such a question is offered nothing', async (t) => {
  const c = newChat({ offered: false });
  t.after(() => c.stopAndWait());
  await c.send(question('Which test runner?', ['node:test (Recommended)', 'vitest']));
  await until('card', () => c.pending.size);
  const a = asksAdapter({ chat: featureOf(c) });
  assert.equal(a.card(`chat:${c.id}`).marked, 0);
  assert.deepEqual(offeredOf(c, a), [], 'Hands-off is not offered and the option is marked: his');
});

test('Hands-off off for the chat, Hands-off not offered, a question about a push, a terminal session: nothing offered', async (t) => {
  for (const [o, words, why] of [[{ on: false }, 'Which database?', 'off'], [{ offered: false }, 'Which database?', 'not offered'], [{}, 'Should I push the branch to origin now?', 'a push is his']]) {
    const c = newChat(o);
    t.after(() => c.stopAndWait());
    await c.send(question(words, ['Yes', 'No']));
    await until('card', () => c.pending.size);
    assert.deepEqual(offeredOf(c, asksAdapter({ chat: featureOf(c) })), [], why);
  }
  const a = asksAdapter({ chat: { question: () => { throw new Error('a terminal is never asked'); }, answerQuestion: () => {} } });
  assert.equal(a.card('build-1'), null, 'a terminal session\'s question is answered in its terminal');
  await assert.rejects(a.answer('build-1', { option: 1 }), /not one Tia may answer/);
  assert.equal(asksAdapter().card('chat:x'), null, 'no chat feature: nothing');
});
