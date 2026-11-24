// "Context" stays the label; its tooltip and its accessible name say what it is in plain words.
import assert from 'node:assert/strict';
import test from 'node:test';
import { byClass } from './fakedom.mjs';

test('Context: the label stays, its tooltip and accessible name say how full the chat\'s memory is', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {} };
  const W = await import('../../web/chat/words.js');
  const r = W.ringOf({ profile: { kind: 'api' }, usage: { contextPercent: 12 } });
  assert.equal(r.text, 'Context 12%', 'the label stays');
  assert.equal(r.said, 'Context: how full the chat\'s memory is (12%)');
  // The side panel's Context card: its head carries the same words.
  const R = await import('../../web/chat/rail.js');
  const rail = R.createRail({ A: '/x', view: () => 'normal', computer: () => 'This computer' });
  const head = byClass(rail.el, 'chat-rcard-head').find((n) => n.tag === 'summary');
  assert.ok(head, 'the Context card has its head');
  assert.equal(head.attrs.title, 'Context: how full the chat\'s memory is');
  assert.equal(head.attrs['aria-label'], 'Context: how full the chat\'s memory is');
});
