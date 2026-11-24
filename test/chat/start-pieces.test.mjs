// The dashboard's start with a long conversation open in the App (src/chat/engines/claude-pieces.mjs, reading.mjs):
// its last part is read first, in pieces that give the server's one thread back, and its earlier part only when the
// page asks for it. Counted, not timed (a busy computer cannot make it pass or fail): how often the thread came back
// while the start read a 3 MB transcript; then that the earlier part puts every event back once, in order, the same as
// a read of the whole file, also with lines cut across a piece's edge and a transcript that grows meanwhile.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('startpieces');
test.after(() => box.cleanup());
const { Chat } = await import('../../src/chat/chat.mjs');
const { projectDir } = await import('../../src/sessions.mjs');
const { readTranscript } = await import('../../src/chat/engines/claude-transcript.mjs');
const { PIECE, TAIL_EVENTS } = await import('../../src/chat/engines/claude-pieces.mjs');

const line = (o) => `${JSON.stringify(o)}\n`;
/** A conversation of `turns` turns, each a message and an answer of a length that varies (lines cross pieces' edges). */
function convo(cwd, id, turns) {
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.jsonl`);
  let text = '';
  for (let n = 0; n < turns; n++) {
    text += line({ type: 'user', uuid: `u-${n}`, timestamp: new Date(1e12 + n * 1000).toISOString(), message: { role: 'user', content: `message ${n}` } });
    text += line({ type: 'assistant', uuid: `a-${n}`, timestamp: new Date(1e12 + n * 1000 + 500).toISOString(), message: { id: `msg-${n}`, role: 'assistant', content: [{ type: 'text', text: `answer ${n} é ${'x'.repeat(200 + ((n * 7919) % 2600))}` }] } });
  }
  fs.writeFileSync(f, text);
  return f;
}
const plain = (events) => events.map(({ i, full, ...e }) => e);
const fakeTool = { command: process.execPath, args: ['-e', ''] }; // never started here

test('at the start a long conversation\'s last part is read in pieces that give the thread back; the earlier part comes once, in order, when asked', async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'shop-')));
  const id = crypto.randomUUID();
  const f = convo(cwd, id, 2000);
  const size = fs.statSync(f).size;
  assert.ok(size > 12 * PIECE, `a long one: ${size} bytes`);
  const whole = readTranscript(f).events;

  let back = 0;
  let going = true;
  const tick = () => {
    if (!going) return;
    back++;
    setImmediate(tick);
  };
  setImmediate(tick);
  const c = new Chat({ id, cwd, profile: 'p', command: fakeTool });
  assert.ok(c.loading, 'the start does not read it at once: the read is under way');
  assert.equal(c.events.length, 0, 'nothing drawn from a half read file');
  await c.loading;
  going = false;
  assert.ok(back >= 2, `the thread came back between the pieces (${back} times)`);

  const users = c.events.filter((e) => e.kind === 'user');
  assert.ok(c.events.length >= TAIL_EVENTS && c.events.length < whole.length, `the last part first: ${c.events.length} of ${whole.length}`);
  assert.equal(c.events[0].kind, 'user', 'it starts at one of the owner\'s messages: no turn cut in two');
  assert.equal(users.at(-1).text, 'message 1999');
  assert.deepEqual(plain(c.events), plain(whole.slice(-c.events.length)), 'the same events as the whole read, at its end');
  assert.ok(c.partial && c.partial.start > 0);
  assert.equal(c.window(0, 0).events.length, 300, 'the page\'s first screen comes from it');
  assert.equal(c.knownSize, size);

  // The page asks for what is before the first event it has: the earlier part is read now, in pieces, once.
  back = 0;
  going = true;
  setImmediate(tick);
  const first = c.events[0].i;
  await c.earlier();
  going = false;
  assert.ok(back >= 2, `the earlier part was read in pieces too (${back})`);
  assert.equal(c.partial, null);
  assert.deepEqual(plain(c.events), plain(whole), 'everything once, in order: nothing doubled, nothing lost');
  assert.ok(c.base >= 0 && c.events.every((e, k) => e.i === c.base + k), 'one numbering, without a gap');
  assert.equal(c.events.find((e) => e.i === first).text, c.before(first + 1).at(-1).text, 'what the page had keeps its numbers');
  assert.deepEqual(plain(c.before(first, 300)), plain(whole.slice(whole.length - (c.next - first) - 300, whole.length - (c.next - first))), 'the 300 before it');
});

test('a transcript that grows while its last part is read: nothing is lost, the next look reads what came', async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'blog-')));
  const id = crypto.randomUUID();
  const f = convo(cwd, id, 800);
  const c = new Chat({ id, cwd, profile: 'p', command: fakeTool });
  // One line before the read looks at the file's size, one while its pieces are read.
  fs.appendFileSync(f, line({ type: 'user', uuid: 'u-late', message: { role: 'user', content: 'written before the read' } }));
  setImmediate(() => setImmediate(() => fs.appendFileSync(f, line({ type: 'user', uuid: 'u-later', message: { role: 'user', content: 'written while it was read' } }))));
  assert.equal(c.refresh(), false, 'a look while the first read runs waits for it');
  await c.loading;
  c.refresh(); // what came after the read's look at the size is read now
  if (c.partial) await c.earlier();
  assert.deepEqual(c.events.filter((e) => e.kind === 'user').slice(-2).map((e) => e.text), ['written before the read', 'written while it was read']);
  assert.deepEqual(plain(c.events), plain(readTranscript(f).events), 'all of it, once, in order');
  assert.equal(c.partial, null);
});

test('a short conversation is read at once, as before, and has no earlier part', () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'cart-')));
  const id = crypto.randomUUID();
  convo(cwd, id, 5);
  const c = new Chat({ id, cwd, profile: 'p', command: fakeTool });
  assert.ok(!c.loading, 'no read under way');
  assert.equal(c.events.filter((e) => e.kind === 'user').length, 5);
  assert.equal(c.partial, null);
});

test('after /clear the earlier part is still the old conversation\'s: never the new one\'s file put before it', async () => {
  const { hear } = await import('../../src/chat/hear.mjs');
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'cart-clear-')));
  const id = crypto.randomUUID();
  const f = convo(cwd, id, 1500);
  const whole = readTranscript(f).events;
  const c = new Chat({ id, cwd, profile: 'p', command: fakeTool });
  await c.loading;
  assert.ok(c.partial, 'read from its last part');
  const fresh = crypto.randomUUID();
  hear(c, { kind: 'session-changed', reason: 'clear', id: fresh });
  assert.equal(c.conversationId, fresh);
  // The new conversation has written a file of its own by the time the page asks for the earlier part.
  const nf = path.join(projectDir(cwd), `${fresh}.jsonl`);
  fs.writeFileSync(nf, Array.from({ length: 40 }, (_, n) => line({ type: 'user', uuid: `n-${n}`, message: { role: 'user', content: `new message ${n}` } })).join(''));
  await c.earlier();
  const users = c.events.filter((e) => e.kind === 'user').map((e) => e.text);
  assert.equal(users.filter((t) => t.startsWith('new')).length, 0, 'nothing of the new conversation before the old one');
  assert.equal(users[0], 'message 0', 'the old conversation from its start');
  assert.deepEqual(plain(c.events.filter((e) => e.kind !== 'session-changed')), plain(whole), 'the old conversation whole, once, in order');
  assert.equal(c.partial, null);
});

test('a to-do list written before the last part is there after a start in pieces, as after a whole read; tasks created there too', async () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'todo-')));
  const id = crypto.randomUUID();
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.jsonl`);
  const call = (uuid, name, input) => line({ type: 'assistant', uuid, message: { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${uuid}`, name, input }] } });
  const result = (uuid, of, text) => line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${of}`, content: text }] } });
  let text = call('w1', 'TodoWrite', { todos: [{ content: 'Fix the cart total', status: 'in_progress', activeForm: 'Fixing the cart total' }] });
  text += call('c1', 'TaskCreate', { subject: 'Write the coupon test' }) + result('r1', 'c1', 'Task #7 created successfully');
  for (let n = 0; n < 600; n++) {
    text += line({ type: 'user', uuid: `u-${n}`, message: { role: 'user', content: `message ${n}` } });
    text += line({ type: 'assistant', uuid: `a-${n}`, message: { id: `msg-${n}`, role: 'assistant', content: [{ type: 'text', text: `answer ${n} ${'x'.repeat(300)}` }] } });
  }
  text += call('u2', 'TaskUpdate', { taskId: '7', status: 'completed' }); // in the last part, of a task created before it
  fs.writeFileSync(f, text);
  const want = readTranscript(f).todos;
  assert.deepEqual(want.map((t) => [t.content, t.status]), [['Fix the cart total', 'in_progress'], ['Write the coupon test', 'completed']]);
  const c = new Chat({ id, cwd, profile: 'p', command: fakeTool });
  await c.loading;
  assert.ok(c.partial, 'read from its last part');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.todosRead, null, 'the start reads no earlier part for the to-do list: nobody looked at the session yet');
  assert.ok(c.todosOwed, 'it is left for the first look');
  c.refresh(); // a page looks at it (GET, the stream, a message)
  assert.ok(c.todosRead, 'the first look reads it');
  await c.todosRead;
  assert.deepEqual(c.todos, want, 'the same list as the whole read');
  await c.earlier();
  assert.deepEqual(c.todos, want, 'and still after the earlier part is shown');
  // A page that looked while the start's read was under way: the list follows that read at once.
  const c2 = new Chat({ id, cwd, profile: 'p', command: fakeTool });
  c2.refresh();
  await c2.loading;
  assert.ok(c2.todosRead, 'read once the start\'s read is done');
  await c2.todosRead;
  assert.deepEqual(c2.todos, want);
});

test('a live to-do list always wins over the earlier part\'s: one that came before the first look, and one that came while it was read', async () => {
  const { hear } = await import('../../src/chat/hear.mjs');
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'todo-live-')));
  const id = crypto.randomUUID();
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const call = (uuid, name, input) => line({ type: 'assistant', uuid, message: { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${uuid}`, name, input }] } });
  let text = call('w1', 'TodoWrite', { todos: [{ content: 'Old step', status: 'in_progress', activeForm: 'Doing the old step' }] });
  for (let n = 0; n < 600; n++) {
    text += line({ type: 'user', uuid: `u-${n}`, message: { role: 'user', content: `message ${n}` } });
    text += line({ type: 'assistant', uuid: `a-${n}`, message: { id: `msg-${n}`, role: 'assistant', content: [{ type: 'text', text: `answer ${n} ${'x'.repeat(300)}` }] } });
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), text);
  const live = [{ content: 'New step of this turn', status: 'in_progress', activeForm: 'Doing the new step' }];
  // Before the first look: a turn started by a message that needs no page (Tia, a schedule) sets a new list.
  const c = new Chat({ id, cwd, profile: 'p', command: fakeTool });
  await c.loading;
  assert.ok(c.partial, 'read from its last part');
  hear(c, { kind: 'todos', list: live });
  c.refresh(); // the owner opens the page
  await c.todosRead;
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(c.todos.map((t) => t.content), ['New step of this turn'], 'the live list stays after the first look');
  // While the earlier part is read: the live list that comes meanwhile is not replaced when the read ends.
  const c2 = new Chat({ id, cwd, profile: 'p', command: fakeTool });
  await c2.loading;
  c2.refresh();
  assert.ok(c2.todosRead, 'the first look reads the earlier part');
  hear(c2, { kind: 'todos', list: live });
  await c2.todosRead;
  assert.deepEqual(c2.todos.map((t) => t.content), ['New step of this turn'], 'the live list stays after the read');
  // And with nothing live, the earlier part's list is still taken (the case above this one).
  const c3 = new Chat({ id, cwd, profile: 'p', command: fakeTool });
  await c3.loading;
  c3.refresh();
  await c3.todosRead;
  assert.deepEqual(c3.todos.map((t) => t.content), ['Old step']);
});
