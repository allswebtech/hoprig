// Taking a terminal's conversation back into a chat (chat/handoff.mjs take) sets the chat to a reset, so a
// conversation started again outside the dashboard's own move is the owner's until he turns it on — only while
// Hands-off is offered. The /take route is driven with stand-ins (no dashboard).
import assert from 'node:assert/strict';
import test from 'node:test';

const { handoffRoutes } = await import('../../src/chat/handoff.mjs');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
// Hands-off is not offered on Windows (src/handsoff.mjs handsOffOffered: the wall's hold is a POSIX shell test), so a
// test that switches it on and expects an answer or a hold has nothing to see there.
const OFFERED = { skip: process.platform === 'win32' && 'Hands-off is not offered on Windows' };

function harness({ offered }) {
  const c = { conversationId: 'c0ffee00-0000-4000-8000-000000000000', engine: { id: 'claude' }, cwd: '/w/shop', handsOffStop: null, dropMark: () => false, refresh() {}, load() {}, emit() {} };
  let seen = 0;
  const terminalOf = async () => (seen++ === 0 ? { name: 'shop', termId: 'pty-1', cwd: '/w/shop', run: null } : null); // the terminal runs it, then it is gone
  const ctx = { HttpError, config: () => (offered ? { handsOff: { offered: true } } : { handsOff: { offered: false } }), deck: { respawn: async () => {} }, backend: { list: async () => [] }, readJson: async () => ({}), poke() {} };
  const o = { chats: new Map(), make() {}, save() {}, chatOr404: () => c, terminalOf, claim: () => {}, serial: (id, fn) => fn(), forget() {}, auto: { name: 'auto', on: () => false } };
  const routes = handoffRoutes(ctx, o);
  const url = `/api/chats/${c.conversationId}/take`;
  const take = routes.find(([m, re]) => m === 'POST' && re.test(url));
  return { c, run: () => take[2]({}, take[1].exec(url)) };
}

test('terminal to chat: taking a conversation back sets the chat to a reset (Hands-off offered)', OFFERED, async () => {
  const { c, run } = harness({ offered: true });
  const r = await run();
  assert.deepEqual(r, { ok: true });
  assert.equal(c.handsOffStop, 'reset', 'the chat is the owner\'s until he turns it on for it');
});

test('terminal to chat: with Hands-off not offered, no reset is set', async () => {
  const { c, run } = harness({ offered: false });
  await run();
  assert.equal(c.handsOffStop, null, 'nothing of Hands-off is set while it is not offered');
});
