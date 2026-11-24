// Fork (the App's session menu): a new chat on a copy of a conversation as it is now, against the stand-in Claude
// Code (fixtures/fake-claude.mjs). The copy is Claude Code's own (--resume <old> --fork-session --resume-session-at).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('chatfork');
test.after(() => box.cleanup());
const { Chat } = await import('../../src/chat/chat.mjs');
const { endPoint } = await import('../../src/chat/engines/claude-transcript.mjs');

const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
function newChat(o = {}) {
  const argsFile = path.join(box.root, `${crypto.randomUUID()}.args`);
  const c = new Chat({ id: crypto.randomUUID(), cwd, profile: 'p', permissionMode: 'bypassPermissions', command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }), ...o });
  c.argsFile = argsFile;
  return c;
}
const users = (c) => c.events.filter((e) => e.kind === 'user').map((e) => e.text);
async function turn(c, text) {
  const n = c.events.filter((e) => e.kind === 'turn-end').length;
  await c.send(text);
  await until(`the end of "${text}"`, () => c.events.filter((e) => e.kind === 'turn-end').length > n);
}

test('the newest line of a conversation\'s file: a message of the main conversation, not a subagent\'s', () => {
  const f = path.join(box.root, 'conv.jsonl');
  fs.writeFileSync(f, [
    JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [] } }),
    JSON.stringify({ type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [] } }),
    JSON.stringify({ type: 'summary', summary: 'x' }),
    '{"type":"user","uuid":"half', // still being written
  ].join('\n'));
  assert.equal(endPoint(f), 'a1');
  assert.equal(endPoint(path.join(box.root, 'none.jsonl')), null);
});

test('a fork copies the whole conversation: the new chat shows it, goes on in a copy, and the original stays', { skip: process.platform === 'win32' && 'POSIX stand-in' }, async (t) => {
  const a = newChat();
  t.after(() => a.stopAndWait());
  assert.equal(a.forkSource(), null, 'nothing said yet: nothing to fork');
  await turn(a, 'hello');
  await turn(a, 'second');
  const src = a.forkSource();
  assert.equal(src.from, a.conversationId);
  assert.equal(src.messageId, null, 'all of it, not cut at a message');
  assert.equal(src.at, endPoint(a.engine.file(cwd, a.conversationId)));
  const b = newChat({ fork: src });
  t.after(() => b.stopAndWait());
  b.load();
  assert.deepEqual(users(b), ['hello', 'second'], 'the copy shows the conversation before its first message');
  await turn(b, 'third');
  const start = fs.readFileSync(b.argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray)[0];
  const at = (f) => start[start.indexOf(f) + 1];
  assert.deepEqual([at('--resume'), at('--resume-session-at'), start.includes('--fork-session'), at('--session-id')], [a.conversationId, src.at, true, b.conversationId]);
  assert.notEqual(b.conversationId, a.conversationId);
  a.load();
  assert.deepEqual(users(a), ['hello', 'second'], 'the original is not touched');
});

test('a rewound conversation not written to since is copied as the rewind left it', { skip: process.platform === 'win32' && 'POSIX stand-in' }, async (t) => {
  const a = newChat();
  t.after(() => a.stopAndWait());
  await turn(a, 'one');
  await turn(a, 'two');
  const two = a.events.filter((e) => e.kind === 'user')[1];
  await a.rewind(two.messageId, { files: false, conversation: true });
  const src = a.forkSource();
  assert.deepEqual([src.from, src.messageId], [a.fork.from, two.messageId], 'from the old file, cut at the same message');
  assert.equal(src.at, a.fork.at);
});

test('no fork while a turn runs: the newest line may be a tool call still without its result', { skip: process.platform === 'win32' && 'POSIX stand-in' }, async (t) => {
  const a = newChat();
  t.after(() => a.stopAndWait());
  await turn(a, 'hello');
  await a.send('sleep'); // a tool call that runs until it is stopped
  await until('the turn runs', () => a.turn);
  assert.throws(() => a.forkSource(), (e) => e.status === 409 && /once the turn is over/.test(e.message));
  a.stop();
  assert.ok(a.forkSource(), 'after the stop it forks');
});
