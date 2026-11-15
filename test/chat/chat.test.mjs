// The coding chat's engine (src/chat/chat.mjs) and protocol (protocol.mjs) against a stand-in Claude Code that
// speaks stream-json (fixtures/fake-claude.mjs): a turn, a tool call, a permission card allowed and denied, Stop,
// resume from the transcript, and the next turn's model. Also the page's plain words for tool calls (web/chattext.js).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('chat');
test.after(() => box.cleanup());

const { Chat } = await import('../../src/chat/chat.mjs');
const P = await import('../../src/chat/protocol.mjs');
const T = await import('../../web/chattext.js');

const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error(`timed out waiting for ${what}`);
};

function newChat(o = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const argsFile = path.join(cwd, '..', `${path.basename(cwd)}.args`);
  const c = new Chat({
    id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE] },
    resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }), ...o,
  });
  c.argsFile = argsFile;
  return c;
}
const turnEnd = (c) => new Promise((r) => c.once('turn', r));
const kinds = (c) => c.events.map((e) => e.kind);
const starts = (c) => fs.readFileSync(c.argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a turn: the message, Claude\'s answer, and what the turn cost', async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  assert.equal(c.status(), 'waiting');
  const done = turnEnd(c);
  await c.send('hello there');
  assert.equal(c.status(), 'working');
  await done;
  assert.deepEqual(kinds(c), ['user', 'text', 'done']);
  assert.equal(c.events[1].text, 'echo: hello there');
  const d = c.events[2];
  assert.equal(d.ok, true);
  assert.ok(Math.abs(d.turnCostUsd - 0.01) < 1e-9, 'the turn\'s own cost, not the running total');
  assert.deepEqual(d.usage, { input: 120, output: 30, cacheRead: 1000, cacheWrite: 0 });
  assert.equal(c.status(), 'waiting');
  assert.equal(c.title, 'hello there');
  assert.equal(c.lastText, 'echo: hello there');
  const a = starts(c)[0];
  for (const f of ['-p', '--verbose']) assert.ok(a.includes(f));
  assert.equal(a[a.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(a[a.indexOf('--permission-prompt-tool') + 1], 'stdio', 'permission prompts come to us');
  assert.equal(a[a.indexOf('--session-id') + 1], c.id);
  for (const f of ['--tools', '--setting-sources', '--system-prompt', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(!a.includes(f), `${f}: none of Tia's restrictions in a coding chat`);
  await assert.rejects(Promise.resolve().then(async () => {
    const p = c.send('one');
    await c.send('two');
    await p;
  }), /still working/, 'one message at a time');
  await until('the queued turn', () => c.status() === 'waiting');
});

test('a tool call: folded into its input and result', async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  fs.writeFileSync(path.join(c.cwd, 'notes.txt'), 'blue whale\n');
  const done = turnEnd(c);
  await c.send('read notes.txt');
  await done;
  assert.deepEqual(kinds(c), ['user', 'tool', 'result', 'text', 'done']);
  const tool = c.events[1];
  assert.equal(tool.name, 'Read');
  assert.equal(tool.input.file_path, path.join(c.cwd, 'notes.txt'));
  assert.equal(tool.full, undefined, 'the full input stays on the server');
  assert.equal(c.events[2].id, tool.id);
  assert.equal(c.events[2].text, 'blue whale\n');
  assert.equal(c.events[2].isError, false);
});

test('a permission card: allowed writes the file, denied does not', async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  let done = turnEnd(c);
  await c.send('write out.txt');
  await until('the card', () => c.status() === 'attention');
  const ask = c.events.find((e) => e.kind === 'ask');
  assert.equal(ask.tool, 'Write');
  assert.equal(ask.input.file_path, path.join(c.cwd, 'out.txt'));
  assert.equal(ask.canAlways, true, 'Claude Code offered a rule for this session');
  assert.equal(ask.suggestions, undefined, 'Claude Code\'s rule suggestions stay on the server');
  assert.equal(ask.full, undefined);
  assert.ok(!fs.existsSync(path.join(c.cwd, 'out.txt')), 'nothing happens before the OK');
  c.answer(ask.request, { allow: true });
  assert.throws(() => c.answer(ask.request, { allow: true }), /already answered/);
  await done;
  assert.equal(fs.readFileSync(path.join(c.cwd, 'out.txt'), 'utf8'), 'written by the fake\n');
  assert.ok(c.events.some((e) => e.kind === 'answer' && e.request === ask.request && e.allow === true));

  done = turnEnd(c);
  await c.send('write no.txt');
  await until('the second card', () => c.status() === 'attention');
  const ask2 = c.events.filter((e) => e.kind === 'ask').at(-1);
  c.answer(ask2.request, { allow: false, message: 'not now' });
  await done;
  assert.ok(!fs.existsSync(path.join(c.cwd, 'no.txt')));
  const res = c.events.filter((e) => e.kind === 'result').at(-1);
  assert.equal(res.isError, true);
  assert.match(res.text, /said no to this Write call in the dashboard: not now/);
  assert.equal(c.status(), 'waiting');
});

test('the permission mode decides: bypassPermissions asks nothing', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('write free.txt');
  await done;
  assert.ok(fs.existsSync(path.join(c.cwd, 'free.txt')));
  assert.ok(!c.events.some((e) => e.kind === 'ask'));
  const a = starts(c)[0];
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

test('Stop: Claude Code ends the turn and the running tool; the chat waits again', async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('sleep');
  await until('the long command', () => c.events.some((e) => e.kind === 'tool' && e.name === 'Bash'));
  assert.equal(c.interrupt(), true);
  const d = await done;
  assert.equal(d.ok, false);
  assert.equal(d.subtype, 'error_during_execution');
  assert.equal(c.status(), 'waiting');
  assert.equal(c.events.filter((e) => e.kind === 'notice' && e.text === 'Stopped.').length, 0, 'the turn\'s end says it; no second line');
  assert.ok(c.child, 'the process stays for the next message');
  assert.equal(c.interrupt(), false, 'nothing to stop');
  const next = turnEnd(c);
  await c.send('still there?');
  await next;
  assert.equal(c.events.filter((e) => e.kind === 'text').at(-1).text, 'echo: still there?');
});

test('resume: a chat opened again shows the transcript and continues it with --resume', async (t) => {
  const a = newChat();
  let done = turnEnd(a);
  await a.send('task write the tests');
  await done;
  assert.deepEqual(a.todos.list, [{ id: '1', status: 'pending', content: 'write the tests', activeForm: 'Doing write the tests' }]);
  done = turnEnd(a);
  await a.send('first words');
  await done;
  await a.stopAndWait();
  assert.equal(a.child, null);

  const b = new Chat({ ...a.o, title: '' });
  b.argsFile = a.argsFile;
  t.after(() => b.stopAndWait());
  assert.deepEqual(b.events.filter((e) => e.kind === 'user').map((e) => e.text), ['task write the tests', 'first words']);
  assert.equal(b.events.filter((e) => e.kind === 'text').at(-1).text, 'echo: first words');
  assert.equal(b.title, 'task write the tests');
  assert.equal(b.todos.list.length, 1, 'the to-do list comes back from the transcript');
  done = turnEnd(b);
  await b.send('again');
  await done;
  const s = starts(b);
  assert.equal(s.length, 2);
  assert.equal(s[0][s[0].indexOf('--session-id') + 1], a.id);
  assert.equal(s[1][s[1].indexOf('--resume') + 1], a.id, 'the same conversation');
  assert.ok(!s[1].includes('--session-id'));
});

test('a terminal went on with the conversation: the chat reads it again (a new epoch)', async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('hello');
  await done;
  await c.stopAndWait();
  const epoch = c.epoch;
  assert.equal(c.refresh(), false, 'nothing changed');
  fs.appendFileSync(c.file(), JSON.stringify({ type: 'user', message: { role: 'user', content: 'typed in the terminal' }, timestamp: new Date().toISOString() }) + '\n');
  assert.equal(c.refresh(), true);
  assert.equal(c.epoch, epoch + 1);
  assert.equal(c.events.at(-1).text, 'typed in the terminal');
});

test('model and effort for the next turn: a new process with --resume and the new flags', async (t) => {
  const c = newChat({ model: 'sonnet' });
  t.after(() => c.stopAndWait());
  let done = turnEnd(c);
  await c.send('one');
  await done;
  c.setNext({ model: 'haiku', effort: 'low' });
  await until('the old process to end', () => !c.child);
  done = turnEnd(c);
  await c.send('two');
  await done;
  const [s0, s1] = starts(c);
  assert.equal(s0[s0.indexOf('--model') + 1], 'sonnet');
  assert.equal(s1[s1.indexOf('--model') + 1], 'haiku');
  assert.equal(s1[s1.indexOf('--effort') + 1], 'low');
  assert.ok(s1.includes('--resume'));
});

test('a provider that names its own model gets no --model; one that cannot start says so', async (t) => {
  const c = newChat({ model: 'opus', resolveEnv: async () => ({ ...process.env, ANTHROPIC_MODEL: 'their-model' }) });
  c.argsFile = path.join(box.root, `own-${c.id}.args`);
  c.o.resolveEnv = async () => ({ ...process.env, ANTHROPIC_MODEL: 'their-model', FAKE_CLAUDE_ARGS: c.argsFile });
  t.after(() => c.stopAndWait());
  const done = turnEnd(c);
  await c.send('hi');
  await done;
  assert.ok(!starts(c)[0].includes('--model'));

  const broken = newChat({ resolveEnv: async () => { throw new Error('the provider\'s start command failed (1)'); } });
  await broken.send('hi');
  const d = broken.events.at(-1);
  assert.equal(d.kind, 'done');
  assert.match(d.error, /could not start: the provider's start command failed/);
  assert.equal(broken.status(), 'waiting');
});

test('protocol: arguments, answers and lines', () => {
  const a = P.chatArgs({ sessionId: 'S', permissionMode: 'manual', effort: 'high', model: 'opus' });
  assert.deepEqual(a.slice(-2), ['--session-id', 'S']);
  assert.deepEqual(P.chatArgs({ sessionId: 'S', resume: true }).slice(-2), ['--resume', 'S']);
  assert.throws(() => P.chatArgs({}), /session id/);
  assert.deepEqual(JSON.parse(P.allowLine('r1', { a: 1 })), { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { a: 1 } } } });
  assert.equal(JSON.parse(P.denyLine('r2', 'no')).response.response.behavior, 'deny');
  assert.deepEqual(JSON.parse(P.interruptLine('x')), { type: 'control_request', request_id: 'x', request: { subtype: 'interrupt' } });

  const [ask] = P.parseLine({ type: 'control_request', request_id: 'R', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, description: 'list', permission_suggestions: [{ destination: 'session' }] } });
  assert.equal(ask.kind, 'ask');
  assert.equal(ask.request, 'R');
  assert.deepEqual(ask.input, { command: 'ls' });
  assert.deepEqual(P.parseLine({ type: 'assistant', parent_tool_use_id: 'toolu_x', message: { content: [{ type: 'text', text: 'from a helper' }] } }), [], 'a subagent\'s messages stay out');
  assert.deepEqual(P.parseLine('not json'), []);
  const [done] = P.parseLine({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.5 });
  assert.equal(done.error, 'stopped');
  const big = P.clipInput({ s: 'x'.repeat(20_000) });
  assert.ok(big.s.length < 9000 && big.s.includes('more characters'));
});

test('protocol: the transcript as the page shows it', () => {
  const f = path.join(box.root, 'transcript.jsonl');
  const at = new Date().toISOString();
  const lines = [
    { type: 'summary', summary: 'x' },
    { type: 'user', timestamp: at, message: { role: 'user', content: 'fix the bug' } },
    { type: 'user', timestamp: at, isMeta: true, message: { role: 'user', content: 'meta' } },
    { type: 'user', timestamp: at, message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', timestamp: at, isSidechain: true, message: { content: [{ type: 'text', text: 'helper' }] } },
    { type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] } },
    { type: 'user', timestamp: at, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"type":"user","mess');
  const { events } = P.transcriptEvents(f);
  assert.deepEqual(events.map((e) => [e.kind, e.text || e.name]), [['user', 'fix the bug'], ['text', 'On it.'], ['tool', 'Bash'], ['result', 'ok'], ['notice', 'Stopped.']]);
  assert.deepEqual(P.transcriptEvents(path.join(box.root, 'none.jsonl')).events, []);
});

test('protocol: the to-do list from TaskCreate, TaskUpdate and TodoWrite', () => {
  const t = P.newTodos();
  assert.equal(P.todoStep(t, { kind: 'tool', id: 'a', name: 'TaskCreate', input: { subject: 'One' } }), false);
  assert.equal(P.todoStep(t, { kind: 'result', id: 'a', text: 'Task #7 created successfully: One' }), true);
  assert.equal(P.todoStep(t, { kind: 'tool', id: 'b', name: 'TaskUpdate', input: { taskId: '7', status: 'in_progress' } }), true);
  assert.deepEqual(t.list, [{ id: '7', status: 'in_progress', content: 'One', activeForm: '' }]);
  P.todoStep(t, { kind: 'tool', id: 'c', name: 'TaskUpdate', input: { taskId: '7', status: 'deleted' } });
  assert.deepEqual(t.list, []);
  P.todoStep(t, { kind: 'tool', id: 'd', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }] } });
  assert.deepEqual(t.list.map((x) => [x.content, x.status]), [['A', 'completed'], ['B', 'pending']]);
});

test('page words: a tool call in one line, an edit as a small diff', () => {
  assert.deepEqual(T.toolLine('Bash', { command: 'npm test\nmore' }), { verb: 'Ran', detail: 'npm test', mono: true });
  assert.deepEqual(T.toolLine('Edit', { file_path: '/p/src/a.js', old_string: 'a\nb\nc', new_string: 'a\nB\nc' }), { verb: 'Edited', detail: 'a.js · +1 −1', mono: true });
  // Only the lines both sides share at the start and the end are context: here "c" counts as changed.
  assert.equal(T.toolLine('Edit', { file_path: 'a.js', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' }).detail, 'a.js · +3 −2');
  assert.equal(T.toolLine('mcp__github__create_issue', {}).verb, 'create issue');
  assert.equal(T.toolLine('Unknown', { what: 'x' }).detail, 'x');
  assert.deepEqual(T.lineDiff('one\ntwo\nthree', 'one\n2\nthree'), [[' ', 'one'], ['-', 'two'], ['+', '2'], [' ', 'three']]);
  assert.deepEqual(T.lineDiff('', 'new'), [['-', ''], ['+', 'new']]);
  assert.equal(T.askTitle('Bash', {}), 'Claude wants to run a command');
  assert.equal(T.turnLine({ turnCostUsd: 0.0123, usage: { input: 100, output: 2000, cacheRead: 900 }, durationMs: 4200 }), '$0.01 · 1.0k tokens in · 2.0k out · 4 s');
});
