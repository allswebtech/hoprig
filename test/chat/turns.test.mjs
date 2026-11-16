// A chat's turn as the owner sees it: what the status line says while a tool runs, Stop (the owner's end, not an
// error, and nothing queued starts after it), a no on a card (his reason, not the words written for Claude), the
// rewind of the conversation (Claude Code's fork at a message), and what bypass leaves to the owner.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('chatturns');
test.after(() => box.cleanup());
const { Chat } = await import('../../src/chat/chat.mjs');
const { hear } = await import('../../src/chat/hear.mjs');
const { allowPending } = await import('../../src/chat/asks.mjs');
const P = await import('./protocol.mjs');

const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};
function newChat(o = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const argsFile = path.join(cwd, '..', `${path.basename(cwd)}.args`);
  const c = new Chat({ id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }), ...o });
  c.argsFile = argsFile;
  return c;
}
const logged = (c) => fs.readFileSync(c.argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ends = (c) => c.events.filter((e) => e.kind === 'turn-end');
const of = (c, kind) => c.events.filter((e) => e.kind === kind);
async function turn(c, text) {
  const n = ends(c).length;
  await c.send(text);
  await until(`the end of "${text}"`, () => ends(c).length > n && !c.turn);
}

test('"requesting" ends when the answer streams or a tool runs, and on Claude Code\'s own status null', () => {
  const c = newChat();
  hear(c, { kind: 'status', state: 'requesting' });
  assert.equal(c.activity, 'requesting');
  hear(c, { kind: 'tool-start', id: 't1', name: 'Bash', title: '', toolKind: 'shell', agent: null });
  assert.equal(c.activity, null, 'a tool is written: the status line says the tool, not "thinking"');
  hear(c, { kind: 'status', state: 'requesting' });
  hear(c, { kind: 'text-delta', blockId: 'b', text: 'x', agent: 'sub' });
  assert.equal(c.activity, 'requesting', 'a subagent\'s stream is not the main answer');
  hear(c, { kind: 'status', state: 'compacting' });
  hear(c, { kind: 'status', state: null });
  assert.equal(c.activity, null, 'compacting is over');
  hear(c, { kind: 'tool-start', id: 't2', name: 'Bash', title: 'mock bash', toolKind: 'shell', agent: null });
  hear(c, { kind: 'tool', id: 't2', name: 'Bash', title: 'mock bash', toolKind: 'shell', input: { command: 'sleep 6\necho' }, full: {}, agent: null });
  const live = c.live.get('tool:t2');
  assert.equal(live.command, 'sleep 6', 'what runs, for the status line');
  assert.ok(Number.isFinite(live.runAt), 'since when, for its seconds');
});

test('Stop: the owner\'s end (no error), the stopped tool is "stopped", and a queued message comes back instead of starting', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  await c.send('sleep');
  await until('the long command', () => of(c, 'tool').length && c.turn);
  const q = await c.send('then this');
  assert.equal(q.queued, true);
  const back = await c.takeBack();
  assert.deepEqual(back, [{ text: 'then this', files: [] }]);
  assert.deepEqual(c.queue.items, [], 'nothing left for Claude Code to start after Stop');
  assert.equal(logged(c).filter((x) => x.control && x.control.subtype === 'cancel_async_message').length, 1);
  assert.equal(c.interrupt(), true);
  await until('the end', () => !c.turn);
  const end = ends(c).at(-1);
  assert.deepEqual([end.stopped, end.error], [true, null]);
  assert.equal(c.lastError, null);
  assert.equal(c.lastEnd, 'stopped');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(of(c, 'user').map((e) => e.text), ['sleep'], 'the queued message did not run');
});

test('a tool result Claude Code wrote for a stop or a no is the owner\'s act, live and read back', () => {
  const stop = P.parseLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed." }] } });
  assert.deepEqual(stop.map((e) => [e.ok, e.stopped, e.text]), [[false, true, '']]);
  const no = P.parseLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'The user said no to this Write call in the dashboard: use notes.txt instead. Do not do it another way; wait for the user to say how to go on.' }] } });
  assert.deepEqual(no.map((e) => [e.ok, e.denied, e.text]), [[false, true, 'use notes.txt instead']]);
  const failed = P.parseLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c', is_error: true, content: 'Exit code 2' }] } });
  assert.deepEqual(failed.map((e) => [e.ok, !!e.stopped, !!e.denied]), [[false, false, false]], 'a real failure stays one');
});

test('rewind of the conversation: it goes on from before the message as a copy (a fork), the old one stays', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  await turn(c, 'one');
  await turn(c, 'two');
  await turn(c, 'three');
  const old = c.conversationId;
  const two = of(c, 'user')[1];
  const dry = await c.rewind(two.messageId, { dryRun: true, files: false, conversation: true });
  assert.deepEqual(dry.conversation, { messages: 2, text: 'two' }, 'two of the owner\'s messages go; "two" goes back into the box');
  assert.equal(c.conversationId, old, 'a dry run changes nothing');
  const r = await c.rewind(two.messageId, { files: false, conversation: true });
  assert.equal(r.conversation.text, 'two');
  assert.notEqual(c.conversationId, old, 'a new conversation');
  assert.deepEqual(of(c, 'user').map((e) => e.text), ['one'], 'the chat shows the conversation up to before "two"');
  assert.match(of(c, 'notice').at(-1).text, /conversation went back to before your message; the earlier one is still in History/);
  assert.equal(c.record().fork.from, old, 'kept with the chat until the copy has a file of its own');
  // Read again (a refresh, a restart) before the next message: still the old one up to there.
  const again = new Chat({ ...c.record(), command: c.o.command, resolveEnv: c.o.resolveEnv });
  assert.deepEqual(again.events.filter((e) => e.kind === 'user').map((e) => e.text), ['one']);
  assert.equal(c.refresh(), false, 'no file of its own yet: nothing to read again');
  await turn(c, 'four');
  const args = logged(c).filter(Array.isArray).at(-1);
  const at = (f) => args[args.indexOf(f) + 1];
  assert.deepEqual([at('--resume'), at('--session-id'), args.includes('--fork-session')], [old, c.conversationId, true]);
  assert.equal(c.record().fork, undefined, 'its own file now');
  c.load();
  assert.deepEqual(of(c, 'user').map((e) => e.text), ['one', 'four'], 'read back from its own file');
  assert.ok(fs.existsSync(c.engine.file(c.cwd, old)), 'the old conversation stays');
  assert.deepEqual(P.transcriptEvents(c.engine.file(c.cwd, old)).events.filter((e) => e.kind === 'user').map((e) => e.text), ['one', 'two', 'three']);
});

test('rewind of the conversation to its first message starts it over; files and conversation together', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  fs.writeFileSync(path.join(c.cwd, 'f.txt'), 'before\n');
  await turn(c, 'write f.txt');
  const first = of(c, 'user')[0];
  const r = await c.rewind(first.messageId, { files: true, conversation: true });
  assert.equal(fs.readFileSync(path.join(c.cwd, 'f.txt'), 'utf8'), 'before\n', 'the file went back');
  assert.equal(r.conversation.text, 'write f.txt');
  assert.deepEqual(of(c, 'user'), []);
  assert.match(of(c, 'notice').at(-1).text, /^Files rewound to before your message \(1 file\)\. The conversation went back/);
  await turn(c, 'hello again');
  const args = logged(c).filter(Array.isArray).at(-1);
  assert.ok(!args.includes('--fork-session') && !args.includes('--resume'), 'nothing before it: a new conversation');
  await assert.rejects(c.rewind('no-such-message', { files: false, conversation: true }), /not in the conversation's file/);
});

test('bypass allows what waits, except what is the owner\'s own word (a question, a plan, a rule, a hook, a safety stop)', () => {
  const answered = [];
  const pushed = [];
  const chat = {
    session: { answer: (r, a) => answered.push([r, a.allow]) },
    pending: new Map([
      ['p', { request: 'p', full: {}, owner: null }],
      ['q', { request: 'q', full: {}, owner: 'question' }],
      ['r', { request: 'r', full: {}, owner: 'rule' }],
      ['s', { request: 's', full: {}, owner: 'safety' }],
    ]),
    push: (e) => pushed.push(e),
    changed() {},
  };
  allowPending(chat);
  assert.deepEqual(answered, [['p', true]]);
  assert.deepEqual([...chat.pending.keys()], ['q', 'r', 's'], 'still the owner\'s cards');
  assert.deepEqual(pushed.map((e) => [e.request, e.outcome]), [['p', 'allowed']]);
});
