// The titles of the conversations handed to a terminal (src/chat/handed.mjs): kept in a file of the state folder, so
// "Open in the App" after a restart of the dashboard (an update does one) brings the title back, not the first
// message. A temporary folder only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('handed');
test.after(() => box.cleanup());
const { handedChats } = await import('../../src/chat/handed.mjs');

test('a handed conversation\'s title outlives a restart of the dashboard; at most the last 50 are kept', () => {
  const file = path.join(box.root, 'state', 'chat-handed.json');
  const before = handedChats(() => file);
  before.set('c1', { conversation: 'conv-1', tool: 'claude', title: 'Cart total rounding', named: false });
  before.set('c2', { conversation: 'conv-2', tool: 'opencode', title: 'Tidy the docs', named: true });
  // A restart: a new dashboard reads what the old one kept.
  const after = handedChats(() => file);
  assert.deepEqual(after.titleOf('conv-1', 'claude'), { title: 'Cart total rounding' });
  assert.deepEqual(after.titleOf('conv-2', 'opencode'), { title: 'Tidy the docs', named: true });
  assert.deepEqual(after.titleOf('conv-2', 'claude'), {}, 'a conversation stays with its coding tool');
  assert.equal(after.get('c1').conversation, 'conv-1');
  assert.ok(after.has('c2'));
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  for (let i = 0; i < 60; i++) after.set(`n${i}`, { conversation: `x${i}`, tool: 'claude', title: `t${i}` });
  const third = handedChats(() => file);
  assert.equal(third.has('c1'), false, 'the oldest went');
  assert.equal(third.has('n59'), true);
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(handedChats(() => file).titleOf('x1', 'claude'), {}, 'an unreadable file: nothing kept, no error');
});
