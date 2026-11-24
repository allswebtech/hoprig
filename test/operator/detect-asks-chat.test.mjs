import assert from 'node:assert/strict';
import test from 'node:test';
import { detectAsks } from '../../src/operator/detect/asks.mjs';
import { NOW, ago, session } from './fixtures/cases.mjs';

// A chat's name on the board is its long id: the item names it by its title and the start of the id, as the
// other detectors do.
test('a chat that asks is named by its title, never by its full id', () => {
  const id = '3f2a9c1e-7b44-4d0e-9a51-0c6e2b8d1f00';
  const [it] = detectAsks({ sessions: [session({ name: `chat-${id}`, chatId: id, display: 'Fix the shop login', state: 'attention', asks: ['main'], askType: 'question', askAt: ago(3) })] }, { now: NOW });
  assert.equal(it.subject, 'chat "Fix the shop login" (3f2a9c1e)');
  assert.ok(!it.subject.includes(id), it.subject);
  assert.deepEqual(it.target, { session: `chat-${id}` }, 'the act still finds the session by its name');
  assert.equal(it.acts[0].label, 'Open the chat');
  const [term] = detectAsks({ sessions: [session({ name: 'docs', state: 'attention', asks: ['main'], askAt: ago(3) })] }, { now: NOW });
  assert.equal(term.subject, 'session docs');
});
