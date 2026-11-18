// Chat v2 against the stand-in Claude Code (fixtures/fake-claude.mjs, fake-claude-tasks.mjs): text and thinking
// streamed, an edit's diff, subagents nested under their call, background tasks and workflows in the task table,
// the turn Claude Code starts by itself after one ends (a result is not the end), the queue, and the settings that
// change in the running process (with the restart where they cannot).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('chatv2');
test.after(() => box.cleanup());
const { Chat } = await import('../../src/chat/chat.mjs');

const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};
function newChat(o = {}, env = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const argsFile = path.join(cwd, '..', `${path.basename(cwd)}.args`);
  const c = new Chat({
    id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE] },
    resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile, ...env }), ...o,
  });
  c.argsFile = argsFile;
  c.liveEvents = [];
  c.on('live', (e) => c.liveEvents.push(e));
  c.statuses = [];
  c.on('status', () => c.statuses.at(-1) !== c.status() && c.statuses.push(c.status()));
  return c;
}
const logged = (c) => fs.readFileSync(c.argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const starts = (c) => logged(c).filter(Array.isArray);
const controls = (c, subtype) => logged(c).filter((x) => x.control && x.control.subtype === subtype).map((x) => x.control);
const ends = (c) => c.events.filter((e) => e.kind === 'turn-end');
const of = (c, kind) => c.events.filter((e) => e.kind === kind);
async function turn(c, text, o) {
  const n = ends(c).length;
  await c.send(text, o);
  await until(`the end of "${text}"`, () => ends(c).length > n);
}

test('text and thinking stream, and the final blocks take the place of what streamed', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  await turn(c, 'think');
  const thinking = of(c, 'thinking')[0];
  const text = of(c, 'text')[0];
  assert.equal(thinking.text, 'First the question, then the answer.');
  const joined = (kind, id) => c.liveEvents.filter((e) => e.kind === kind && e.blockId === id).map((e) => e.text).join('');
  assert.equal(joined('thinking-delta', thinking.blockId), thinking.text, 'the deltas are the same block');
  assert.equal(joined('text-delta', text.blockId), 'Forty-two.');
  assert.ok(c.liveEvents.some((e) => e.kind === 'thinking-delta' && e.tokens === 12), 'thinking says how far it is');
  assert.equal(c.live.size, 0, 'nothing is left streaming');
  assert.ok(!c.events.some((e) => e.kind.endsWith('-delta')), 'deltas are never numbered events');
  assert.equal(c.usage.contextWindow, 200000);
  assert.equal(c.usage.contextUsed, 2100);
});

test('an edit\'s result carries its diff; a tool call shows while it is written', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  fs.writeFileSync(path.join(c.cwd, 'a.txt'), 'old line\nrest\n');
  await turn(c, 'edit a.txt');
  const r = of(c, 'tool-result')[0];
  assert.deepEqual(r.diff, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old line', '+changed'] }]);
  const tool = of(c, 'tool')[0];
  assert.equal(tool.toolKind, 'edit');
  const started = c.liveEvents.filter((e) => e.kind === 'tool-start' && e.id === tool.id);
  assert.equal(started[0].title, '', 'at its first line, before its input');
  assert.equal(started.at(-1).title, path.join(c.cwd, 'a.txt'), 'and again once the path is written');
});

test('a subagent: its steps nest under the call that started it, and its task is in the table', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  await turn(c, 'agent');
  const call = of(c, 'tool').find((e) => e.name === 'Agent');
  const nested = c.events.filter((e) => e.agent === call.id);
  assert.deepEqual(nested.map((e) => [e.kind, e.name || e.text]), [['tool', 'Bash'], ['tool-result', 'a.txt'], ['text', 'There is a.txt.']]);
  const task = [...c.tasks.values()][0];
  assert.equal(task.toolId, call.id);
  assert.equal(task.type, 'agent');
  assert.equal(task.title, 'Look around');
  assert.equal(task.now, 'Running ls', 'what it does now, apart from its name');
  assert.equal(task.status, 'completed');
  assert.deepEqual(task.usage, { tokens: 1000, tools: 1, ms: 60 });
  assert.equal(c.status(), 'waiting');
});

test('a background agent: the result is not the end; the chat works until Claude Code\'s own turn after it', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions', idleMs: 50 });
  t.after(() => c.stopAndWait());
  await turn(c, 'bgagent 400');
  const task = [...c.tasks.values()][0];
  assert.equal(task.background, true);
  assert.equal(task.status, 'running');
  assert.deepEqual([task.model, task.effort], ['sonnet', 'low'], 'the model and effort the call asked for');
  assert.equal(c.status(), 'working', 'a background agent runs');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(c.session, 'the idle timer leaves a process with background work alone');
  await until('Claude Code\'s own turn', () => ends(c).length === 2, 5000);
  const auto = of(c, 'turn-start');
  assert.deepEqual(auto.map((e) => e.auto), [true]);
  assert.equal(of(c, 'text').at(-1).text, 'The background helper said hi.');
  assert.ok(c.events.some((e) => e.kind === 'text' && e.agent === task.toolId), 'the agent\'s words nest under its call');
  assert.equal(task.status, 'completed');
  await until('waiting', () => c.status() === 'waiting');
  assert.deepEqual(c.statuses, ['working', 'waiting'], 'never "waiting" between the result and the turn after it');
  await until('the idle process to stop', () => !c.session);
});

test('a workflow: its phases and agents with their models and states, then the turn after it', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  await turn(c, 'workflow 300');
  const w = [...c.tasks.values()][0];
  assert.equal(w.type, 'workflow');
  assert.equal(w.title, 'checks');
  assert.deepEqual(w.phases.map((p) => p.title), ['Look', 'Fix']);
  assert.deepEqual(w.agents.map((a) => [a.label, a.phase, a.model, a.state]), [['tests', 1, 'claude-sonnet-5-5', 'done'], ['lint', 1, 'claude-haiku-5-5', 'start'], ['fix', 2, 'claude-opus-5-5', 'queued']]);
  assert.equal(c.status(), 'working');
  await until('the turn after it', () => ends(c).length === 2 && c.status() === 'waiting', 5000);
  assert.deepEqual(w.agents.map((a) => a.state), ['done', 'done', 'done']);
  assert.equal(w.status, 'completed');
});

test('one task stopped on its own; Stop ends a turn only, and with only background work there is no turn to stop', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  await turn(c, 'bgsleep');
  const task = [...c.tasks.values()][0];
  assert.equal(c.status(), 'working');
  assert.equal(c.interrupt(), false, 'no turn runs');
  await assert.rejects(c.stopTask('nope'), /no such task/);
  await c.stopTask(task.taskId);
  await until('the task to stop', () => task.status === 'stopped');
  await until('waiting', () => c.status() === 'waiting');
  assert.deepEqual(controls(c, 'stop_task'), [{ subtype: 'stop_task', task_id: task.taskId }]);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ends(c).length, 1, 'a stopped task brings no turn of its own');
});

test('a message while a turn runs is queued in Claude Code, can be taken back, and runs after', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  await c.send('slow 500');
  await until('the slow turn to run', () => c.session && c.turn);
  const two = await c.send('two');
  const three = await c.send('three');
  assert.equal(two.queued, true);
  assert.deepEqual(c.queue.items.map((q) => [q.text, q.state]), [['two', 'sent'], ['three', 'sent']]);
  assert.equal(of(c, 'user').length, 1, 'a queued message is shown once it is taken');
  await c.unqueue(three.id);
  assert.deepEqual(controls(c, 'cancel_async_message'), [{ subtype: 'cancel_async_message', message_uuid: three.id }]);
  assert.deepEqual(c.queue.items.map((q) => q.text), ['two']);
  await until('both turns', () => ends(c).length === 2 && c.status() === 'waiting');
  assert.deepEqual(of(c, 'user').map((e) => e.text), ['slow 500', 'two']);
  assert.equal(of(c, 'text').at(-1).text, 'echo: two');
  assert.deepEqual(c.queue.items, []);
  await assert.rejects(c.unqueue(two.id), /not queued/);
});

test('a coding tool that does not queue: the chat holds the message and sends it when the turn ends', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  c.engine = { ...c.engine, capabilities: { ...c.engine.capabilities, queue: false } };
  t.after(() => c.stopAndWait());
  await c.send('slow 300');
  await until('the slow turn to run', () => c.session && c.turn);
  await c.send('held');
  assert.deepEqual(c.queue.items.map((q) => q.state), ['held']);
  await until('both turns', () => ends(c).length === 2 && c.status() === 'waiting');
  assert.deepEqual(of(c, 'user').map((e) => e.text), ['slow 300', 'held']);
});

test('model, effort, ultracode and mode change in the running process: no new start', async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  await turn(c, 'hello');
  assert.deepEqual(await c.setSettings({ model: 'haiku' }), { restart: false });
  await c.setSettings({ effort: 'high' });
  await c.setSettings({ ultracode: true });
  await c.setSettings({ effort: null, model: null });
  assert.deepEqual(controls(c, 'set_model'), [{ subtype: 'set_model', model: 'haiku' }, { subtype: 'set_model' }], 'Auto: Claude Code\'s own default');
  assert.deepEqual(controls(c, 'apply_flag_settings').map((x) => x.settings), [
    { effortLevel: 'high', ultracode: false }, { effortLevel: 'high', ultracode: true }, { effortLevel: null, ultracode: true },
  ], 'an effort change always says ultracode too');
  assert.ok(of(c, 'notice').some((e) => e.text === 'Set model to haiku'), 'Claude Code\'s word on it is shown');
  // A card open while the owner switches to bypass stays his: the one rule (src/asking.mjs) answers only a plain
  // delete, and a file change Claude Code asked for before the switch is not one. The next change asks nothing.
  await c.send('write card.txt');
  await until('the card', () => c.status() === 'attention');
  await c.setSettings({ mode: 'bypassPermissions' });
  assert.deepEqual(controls(c, 'set_permission_mode'), [{ subtype: 'set_permission_mode', mode: 'bypassPermissions' }]);
  assert.equal(c.liveMode, 'bypassPermissions');
  assert.equal(c.status(), 'attention', 'the card is still open');
  c.answer([...c.pending.keys()][0], { allow: true });
  await until('the end', () => ends(c).length === 2);
  assert.ok(fs.existsSync(path.join(c.cwd, 'card.txt')));
  assert.equal(of(c, 'ask-closed').at(-1).outcome, 'allowed');
  await turn(c, 'write free.txt');
  assert.equal(of(c, 'ask').length, 1, 'no card in bypass');
  await c.setSettings({ mode: 'manual' });
  assert.equal(controls(c, 'set_permission_mode').at(-1).mode, 'default', '"manual" is Claude Code\'s "default"');
  assert.equal(starts(c).length, 1, 'one process all along');
  assert.deepEqual(c.record().ultracode, true);
});

test('a coding tool that cannot change them live: it starts again with the conversation resumed once idle', async (t) => {
  const c = newChat({}, { FAKE_CLAUDE_NO_LIVE: '1' });
  t.after(() => c.stopAndWait());
  await c.send('slow 300');
  await until('the turn to run', () => c.session && c.turn);
  assert.deepEqual(await c.setSettings({ model: 'haiku', mode: 'acceptEdits' }), { restart: true });
  assert.ok(c.session, 'not while it works');
  await until('the process to stop after the turn', () => !c.session && ends(c).length === 1);
  await turn(c, 'again');
  const s = starts(c)[1];
  assert.equal(s[s.indexOf('--model') + 1], 'haiku');
  assert.equal(s[s.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(s.includes('--resume'));
});

test('a plan is approved with the mode to go on in; its text comes from the tool call', async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  await c.send('plan p.txt');
  let ask = await until('the plan-mode write', () => c.pending.size && [...c.pending.values()][0]);
  c.answer(ask.request, { allow: true });
  ask = await until('the plan', () => of(c, 'ask').find((e) => e.type === 'plan'));
  assert.match(ask.plan, /^# The plan/);
  c.answer(ask.request, { allow: true, mode: 'acceptEdits' });
  await until('the end', () => ends(c).length === 1);
  const a = logged(c).filter((x) => x.answer).at(-1).answer;
  assert.deepEqual(a.updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  assert.equal(c.permissionMode, 'acceptEdits');
  assert.equal(c.liveMode, 'acceptEdits');
});

test('rewind undoes the files a message changed (Claude Code\'s checkpoints are on)', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  fs.writeFileSync(path.join(c.cwd, 'f.txt'), 'before\n');
  await turn(c, 'write f.txt');
  const msg = of(c, 'user')[0];
  assert.equal(fs.readFileSync(path.join(c.cwd, 'f.txt'), 'utf8'), 'written by the fake\n');
  const dry = await c.rewind(msg.messageId, { dryRun: true });
  assert.deepEqual(dry.filesChanged, [path.join(c.cwd, 'f.txt')]);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'f.txt'), 'utf8'), 'written by the fake\n', 'a dry run changes nothing');
  await c.rewind(msg.messageId);
  assert.equal(fs.readFileSync(path.join(c.cwd, 'f.txt'), 'utf8'), 'before\n');
});

test('the / menu, usage and plan limits, a title, compacting and a new conversation id', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  const cmds = await c.commands(); // starts the process without a message
  assert.deepEqual(cmds.map((x) => x.name), ['compact', 'review']);
  assert.equal(c.status(), 'waiting', 'a process started for a menu is not work');
  await turn(c, 'limits');
  assert.deepEqual(c.limits.five_hour, { status: 'allowed_warning', percent: 81, resetsAt: 1900000000000, at: c.limits.five_hour.at });
  const u = await c.usageNow();
  assert.equal(u.usage.contextPercent, 10.5);
  // What fills the context, as Claude Code's /context counts it (the session rail's Context card); nothing empty.
  assert.deepEqual(u.usage.contextCategories, [{ name: 'System prompt', tokens: 3100 }, { name: 'System tools', tokens: 11900 }, { name: 'Messages', tokens: 6000 }]);
  assert.deepEqual([u.limits.five_hour.status, u.limits.five_hour.percent, u.limits.five_hour.resetsAt], ['allowed_warning', 42, Date.parse('2030-03-17T17:46:40Z')], 'the status the live line said stays');
  assert.equal(u.limits.seven_day.percent, 10);
  assert.equal(u.limits.spend, undefined, 'a window with nothing in it is left out');
  assert.equal(u.subscription, 'max');
  await turn(c, 'title A good name');
  assert.equal(c.title, 'A good name');
  await turn(c, 'compact');
  assert.equal(of(c, 'session-changed').at(-1).reason, 'compact');
  const old = c.conversationId;
  await turn(c, 'clear');
  assert.notEqual(c.conversationId, old);
  assert.equal(c.record().conversationId, c.conversationId, 'kept with the chat');
  assert.equal(c.record().id, c.id, 'the chat keeps its own id');
});

test('pictures go in as images; the message keeps what was attached', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  await turn(c, 'look at this', { images: [{ mime: 'image/png', data: 'iVBORw0KGgo=' }], attachments: [{ type: 'image', name: 'shot.png', mime: 'image/png' }] });
  assert.equal(of(c, 'text')[0].text, 'echo: look at this [1 image]');
  assert.deepEqual(of(c, 'user')[0].attachments, [{ type: 'image', name: 'shot.png', mime: 'image/png' }]);
});
