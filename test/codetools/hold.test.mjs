// An open chat holds its coding tool's one server per computer: nothing stops the server under it (src/codetools/
// servers.mjs serverUsers), also from another process, and the hold goes with the chat.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

test('a chat holds the tool\'s server until it lets go; a hold of a process that is gone does not count', async (t) => {
  const box = sandbox('hold');
  t.after(() => box.cleanup());
  const { holdServer, serverDir, serverUsers } = await import('../../src/codetools/servers.mjs');
  assert.deepEqual(serverUsers('opencode', { runs: [] }), []);
  const a = holdServer('opencode');
  const b = holdServer('opencode');
  assert.deepEqual(serverUsers('opencode', { runs: [] }).map((u) => u.chats), [true], 'one holder: this process');
  assert.deepEqual(serverUsers('codex', { runs: [] }), [], 'per tool');
  a();
  a(); // twice is once
  assert.equal(serverUsers('opencode', { runs: [] }).length, 1, 'the other chat still holds it');
  b();
  assert.deepEqual(serverUsers('opencode', { runs: [] }), []);
  // Another dashboard process that ended without letting go: its file is not a user, and is cleared.
  fs.writeFileSync(`${serverDir()}/opencode-held-999999999`, '999999999');
  assert.deepEqual(serverUsers('opencode', { runs: [] }), []);
  assert.ok(!fs.existsSync(`${serverDir()}/opencode-held-999999999`));
});
