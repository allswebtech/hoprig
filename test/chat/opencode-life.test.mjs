// The life of an OpenCode chat around its turns, on the stand-in of OpenCode's server: a subagent stopped on its own
// and with the chat, a turn that runs (or waits for an OK) on the server when the chat comes back, a conversation
// OpenCode could not be asked about or no longer has, a tool turned off, the first read that never starts the server,
// the server's hold, a chat closed while it starts, a stale read, and a message OpenCode took before it answered.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { SESSION_ID, recordedTurns, standIn, standInOpts } from './fixtures/opencode-standin.mjs';

const CWD = '/work/proj';
// The chats' own folders, removed when the file's tests are done (they were left in the temp folder).
const temps = [];
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-oclife-'));
  temps.push(d);
  return d;
};
after(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});
const CHILD = 'ses_child0000000001';
const CHILD2 = 'ses_child0000000002';
const ev = (type, data) => ({ event: { type, data: { sessionID: SESSION_ID, ...data } } });

async function until(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let n = 0;
async function chatOn(s, o = {}, opts = {}) {
  const { Chat } = await import('../../src/chat/chat.mjs');
  const dir = tempDir();
  const id = `7d9c2a4e-1b3f-4c5d-8e6f-${String(++n).padStart(12, '0')}`;
  const c = new Chat({ id, engine: 'opencode', cwd: CWD, profile: 'gw', turnsDir: dir, resolveEnv: async () => ({}), engineOpts: { enabled: () => true, ...standInOpts(s), ...opts }, idleMs: 60_000, stopGraceMs: 3000, owedMs: 50, ...o });
  if (c.loading) await c.loading;
  return c;
}
const turnEnds = (c) => c.events.filter((e) => e.kind === 'turn-end');

// A turn that starts a subagent and ends; the subagent runs on until it is stopped.
const subagent = (child) => ({
  text: 'Look around with a subagent',
  steps: [
    ev('session.execution.started', {}),
    ev('session.tool.input.started', { id: 'call_sub', name: 'subagent' }),
    ev('session.tool.called', { id: 'call_sub', input: { description: 'Look around', prompt: 'List the files', agent: 'explore' } }),
    { event: { type: 'session.created', data: { sessionID: child, parentID: SESSION_ID, agent: 'explore' } } },
    ev('session.tool.success', { id: 'call_sub', content: [{ type: 'text', text: 'The subagent works in the background' }] }),
    ev('session.execution.succeeded', {}),
    { wait: 'interrupt' },
    { event: { type: 'session.execution.interrupted', data: { sessionID: child, reason: 'user' } } },
  ],
});

test('a subagent that runs on after the turn: one task\'s Stop ends it, a mode change reaches it, and closing the chat stops it', { timeout: 20_000 }, async (t) => {
  const s = await standIn({ turns: [subagent(CHILD), subagent(CHILD2)], children: [CHILD, CHILD2] });
  t.after(() => s.close());
  const c = await chatOn(s);
  assert.equal(c.engine.capabilities.stopTask, true, 'the page offers the Stop of one task');
  await c.send('Look around with a subagent');
  await until(() => turnEnds(c).length === 1, 'the turn');
  await until(() => c.tasks.has(CHILD), 'the task');
  assert.equal(c.busy(), true, 'the subagent still works');
  assert.equal(c.interrupt(), false, 'no turn runs: the turn\'s Stop has nothing to end');
  // The mode changes while it runs: the subagent's conversation gets the new rules too.
  await c.setSettings({ mode: 'acceptEdits' });
  const patched = s.calls.filter((x) => x.method === 'PATCH' && x.path === `/api/session/${CHILD}`);
  assert.deepEqual(patched.at(-1).body.permissions.map((r) => r.action), ['shell', 'webfetch', 'external_directory']);
  await c.stopTask(CHILD);
  assert.ok(s.calls.some((x) => x.method === 'POST' && x.path === `/api/session/${CHILD}/interrupt`));
  await until(() => !c.busy(), 'the subagent stopped');
  await assert.rejects(c.stopTask(CHILD), /not running/);

  // Again; this time the chat closes while the subagent runs: it does not go on with nobody watching.
  await c.send('Look around with a subagent');
  await until(() => turnEnds(c).length === 2 && c.tasks.has(CHILD2) && c.busy(), 'the second subagent');
  await c.close();
  await until(() => s.calls.some((x) => x.path === `/api/session/${CHILD2}/interrupt`), 'the subagent stopped with the chat');
});

test('closing a chat while its turn runs stops that turn on the server', { timeout: 20_000 }, async (t) => {
  const sleep = recordedTurns().find((x) => x.steps.some((y) => y.wait === 'interrupt'));
  const s = await standIn({ turns: [sleep] });
  t.after(() => s.close());
  const c = await chatOn(s);
  await c.send('Run sleep');
  const a = await until(() => [...c.pending.values()][0], 'the OK');
  c.answer(a.request, { allow: true });
  await until(() => c.events.some((e) => e.kind === 'tool' && /sleep/.test((e.input || {}).command || '')), 'the command');
  await c.close();
  await until(() => s.calls.some((x) => x.path === `/api/session/${SESSION_ID}/interrupt`), 'the interrupt');
});

test('back on a conversation whose turn still runs on the server: the chat works, and the OK it waits for is a card', { timeout: 20_000 }, async (t) => {
  const waiting = { permission: [{ id: 'per_waiting0001', action: 'shell', resources: ['rm -rf build'], save: ['rm *'], source: { type: 'tool', id: 'toolu_before' } }] };
  const s = await standIn({ busy: true, waiting });
  t.after(() => s.close());
  const c = await chatOn(s, { conversationId: SESSION_ID });
  const { start } = await import('../../src/chat/run.mjs');
  assert.equal(await start(c), true);
  const card = await until(() => [...c.pending.values()][0], 'the card of the OK asked before the chat listened');
  assert.equal(card.request, 'per_waiting0001');
  assert.equal(card.owner, 'unknown', 'its call was not seen: the owner\'s');
  assert.equal(card.subject, 'rm -rf build');
  assert.equal(c.status(), 'attention');
  assert.ok(c.turn, 'a turn runs');
  c.answer(card.request, { allow: false, message: 'no' });
  await until(() => s.calls.some((x) => x.path === `/api/session/${SESSION_ID}/permission/per_waiting0001/reply`), 'the answer');
  await c.close();
});

test('a conversation OpenCode could not be asked about is never replaced quietly; one it no longer has is, and the chat says so', { timeout: 20_000 }, async (t) => {
  const { opencode } = await import('../../src/chat/engines/opencode.mjs');
  const client = (status) => () => ({ req: async () => { throw Object.assign(new Error('x'), { status }); } });
  const ensure = async () => ({ ok: true, server: { port: 1, secret: 's' } });
  assert.equal(await opencode.exists(CWD, SESSION_ID, { enabled: () => true, ensure, client: client(404) }), false);
  await assert.rejects(opencode.exists(CWD, SESSION_ID, { enabled: () => true, ensure, client: client(500) }), /x/);
  await assert.rejects(opencode.exists(CWD, SESSION_ID, { enabled: () => true, ensure: async () => ({ ok: false, why: 'another start of this server is still busy' }) }), /still busy/);

  const s = await standIn();
  t.after(() => s.close());
  // The server is busy when the chat asks: the message is not sent anywhere, the chat keeps its conversation.
  const busy = await chatOn(s, { conversationId: SESSION_ID }, { ensure: async () => ({ ok: false, why: 'another start of this server is still busy' }) });
  await busy.send('hello');
  assert.match(turnEnds(busy).at(-1).error, /could not start: another start of this server is still busy/);
  assert.equal(busy.conversationId, SESSION_ID);
  assert.ok(!s.calls.some((x) => x.method === 'POST' && x.path === '/api/session'), 'no new conversation');
  await busy.close();
  // OpenCode says it has no such conversation any more: a new one, said in the chat.
  const gone = await chatOn(s, { conversationId: 'ses_gone00000000001' });
  await gone.send('Reply with exactly three short words, nothing else.');
  await until(() => turnEnds(gone).length === 1, 'the answer');
  assert.equal(gone.conversationId, SESSION_ID);
  assert.ok(gone.events.some((e) => e.kind === 'notice' && /no longer has this chat's earlier conversation/.test(e.text)));
  await gone.close();
});

test('OpenCode turned off: an open chat runs nothing and starts no server; a saved chat never starts it by itself', { timeout: 20_000 }, async (t) => {
  const s = await standIn();
  t.after(() => s.close());
  let ensured = 0;
  const counting = { ensure: async () => (ensured++, { ok: true, server: s.server }), served: { ensure: async () => (ensured++, { ok: true, server: s.server }), providers: standInOpts(s).served.providers, hold: () => () => {} } };
  const off = await chatOn(s, { conversationId: SESSION_ID }, { enabled: () => false, running: () => null, ...counting });
  assert.equal(ensured, 0, 'read when the dashboard starts: only from a server that runs, none here');
  assert.equal(off.events.length, 0);
  assert.equal(off.unread, true);
  // A page looks (a read that may start the server while OpenCode is on): while it is off, still none is started.
  off.refresh();
  await off.loading;
  assert.equal(ensured, 0, 'a look while it is off starts no server');
  assert.equal(off.unread, true);
  await off.send('hello');
  assert.match(turnEnds(off).at(-1).error, /OpenCode is off on this computer/);
  assert.equal(ensured, 0, 'no server was started');
  assert.ok(!s.calls.some((x) => x.path.endsWith('/prompt')));
  await off.close();
  // A new chat (no conversation yet to ask about): refused where it starts, no conversation made.
  const fresh = await chatOn(s, {}, { enabled: () => false, running: () => null, ...counting });
  await fresh.send('hello');
  assert.match(turnEnds(fresh).at(-1).error, /OpenCode is off on this computer/);
  assert.ok(!s.calls.some((x) => x.method === 'POST' && x.path === '/api/session'), 'no conversation made');
  assert.equal(ensured, 0);
  await fresh.close();
  const { opencode } = await import('../../src/chat/engines/opencode.mjs');
  await assert.rejects(opencode.history(CWD, { enabled: () => false, ...counting }), /off on this computer/);
  assert.equal(await opencode.stamp({ id: SESSION_ID }, { running: () => null, ...counting }), 0, 'looking for news never starts it');
  assert.equal(await opencode.transcript({ id: SESSION_ID }, { running: () => null, ...counting }, { start: false }), null);
  assert.equal(await opencode.transcript({ id: SESSION_ID }, { enabled: () => false, running: () => null, ...counting }), null, 'off: never started to read');
  assert.equal(ensured, 0);
  // Off, and OpenCode's server runs by the time a page looks (a terminal started it): the saved chat is read from it,
  // nothing is started.
  let up = null;
  const readable = await chatOn(s, { conversationId: SESSION_ID }, { enabled: () => false, ...counting, running: () => up });
  assert.equal(readable.unread, true);
  up = s.server;
  readable.refresh();
  if (readable.loading) await readable.loading;
  assert.ok(readable.events.some((e) => e.kind === 'user'), 'its conversation is shown');
  assert.equal(ensured, 0);
  await readable.close();
  // On, and no server ran at the start: the chat reads its conversation when a page looks at it.
  const later = await chatOn(s, { conversationId: SESSION_ID }, { running: () => null });
  assert.equal(later.events.length, 0);
  later.refresh();
  await until(() => later.events.some((e) => e.kind === 'user'), 'read on the first look');
  await later.close();
});

test('the chat holds OpenCode\'s server while it runs on it, and lets go when it ends', { timeout: 20_000 }, async (t) => {
  const s = await standIn();
  t.after(() => s.close());
  let held = 0;
  const served = { ...standInOpts(s).served, hold: () => (held++, () => held--) };
  const c = await chatOn(s, {}, { served });
  await c.send('Reply with exactly three short words, nothing else.');
  await until(() => turnEnds(c).length === 1, 'the answer');
  assert.equal(held, 1);
  await c.close();
  assert.equal(held, 0);
});

test('a chat closed while it starts makes no conversation; a read that comes after a turn started does not replace it', { timeout: 20_000 }, async (t) => {
  const s = await standIn({ modelMs: 300 });
  t.after(() => s.close());
  const c = await chatOn(s);
  const sent = c.send('hello');
  await until(() => s.calls.some((x) => x.path === '/api/model'), 'the start under way');
  await c.close();
  await sent;
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!s.calls.some((x) => x.method === 'POST' && x.path === '/api/session'), 'no empty conversation left in OpenCode\'s list');

  const slow = await standIn({ messageMs: 300 });
  t.after(() => slow.close());
  const { Chat } = await import('../../src/chat/chat.mjs');
  const d = new Chat({ id: '9d9c2a4e-1b3f-4c5d-8e6f-0a1b2c3d4e5f', conversationId: SESSION_ID, engine: 'opencode', cwd: CWD, profile: 'gw', turnsDir: tempDir(), resolveEnv: async () => ({}), engineOpts: { enabled: () => true, ...standInOpts(slow) } });
  await d.send('Reply with exactly three short words, nothing else.'); // while the first read is still under way
  await d.loading;
  assert.equal(d.events.filter((e) => e.kind === 'user').length, 1, 'the read that came late did not replace the turn');
  assert.equal(d.events.find((e) => e.kind === 'user').text, 'Reply with exactly three short words, nothing else.');
  await d.close();
});

test('a message OpenCode takes before it has answered for it is still shown as taken', { timeout: 20_000 }, async (t) => {
  const s = await standIn({ deliverFirst: true, turns: [{ text: 'first', steps: [ev('session.execution.started', {}), { wait: 'go' }, ev('session.execution.succeeded', {})] }] });
  t.after(() => s.close());
  const c = await chatOn(s);
  await c.send('first');
  await until(() => c.session && c.session.map && c.session.busy, 'the first turn');
  const q = await c.send('second');
  assert.equal(q.queued, true);
  await until(() => !c.queue.items.length, 'taken out of the queue');
  assert.deepEqual(c.events.filter((e) => e.kind === 'user').map((e) => e.text), ['first', 'second']);
  s.came('go');
  await until(() => turnEnds(c).length >= 1, 'the turn');
  await c.close();
});

test('a read OpenCode\'s server could not answer is no empty conversation: the chat reads again at its next look', { timeout: 20_000 }, async (t) => {
  const { readTranscript } = await import('../../src/chat/engines/opencode-transcript.mjs');
  const failing = (status) => ({ req: async () => { throw Object.assign(new Error('fetch failed'), status ? { status } : {}); } });
  assert.deepEqual((await readTranscript(failing(404), SESSION_ID)).events, [], 'OpenCode has no such conversation: empty');
  await assert.rejects(readTranscript(failing(), SESSION_ID), /fetch failed/, 'a server that is gone (a stale state file)');
  await assert.rejects(readTranscript(failing(503), SESSION_ID), /fetch failed/);
  // A chat whose first read hit a server that had gone: unread, and read once one runs.
  const s = await standIn();
  t.after(() => s.close());
  let client = () => failing();
  const c = await chatOn(s, { conversationId: SESSION_ID }, { client: (o) => client(o) });
  assert.equal(c.unread, true);
  assert.equal(c.events.length, 0);
  const { opencodeClient } = await import('../../src/codetools/clients.mjs');
  client = opencodeClient;
  c.refresh();
  if (c.loading) await c.loading;
  assert.ok(c.events.some((e) => e.kind === 'user'), 'read at the next look');
  await c.close();
});
