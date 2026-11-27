// Open in Terminal stops the chat's process and KEEPS its record (title, settings) in the open chats, instead of
// deleting it: when the terminal never runs the conversation (an untrusted folder, a start that fails, a terminal that
// ends), the conversation is not open nowhere: its chat is still there, and it is the App again by itself. The routes
// are driven with stand-ins (no dashboard).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-keeprecord-')));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.HOPRIG_PROFILES_DIR = path.join(tmp, 'profiles');
process.env.HOPRIG_WORKSPACE_DIR = path.join(tmp, 'ws');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { handoffRoutes } = await import('../../src/chat/handoff.mjs');
const { Chat } = await import('../../src/chat/chat.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
writeProfile('work', { label: 'Work', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const CONV = 'c0ffee00-0000-4000-8000-00000000000b';
const route = (routes, method, url) => {
  const r = routes.find(([m, re]) => m === method && re.test(url));
  return (body) => r[2]({ body }, r[1].exec(url));
};

// The real chat with its real engine, told that its conversation exists; its process ends are counted.
function chatOf() {
  const c = new Chat({ id: CONV, engine: 'claude', cwd: tmp, profile: 'work', title: 'Cart total rounding' });
  const calls = { stopped: 0, closed: 0 };
  Object.assign(c, {
    engine: Object.assign(Object.create(c.engine), { exists: async () => true }),
    busy: () => false,
    stopAndWait: async () => { calls.stopped++; },
    close: async () => { calls.closed++; },
  });
  return { c, calls };
}

function harness(c, { fail = false } = {}) {
  const made = [];
  const started = [];
  const ctx = {
    HttpError, config: () => ({ handsOff: { offered: false } }), root: false, backend: { list: async () => [] }, poke() {},
    readJson: async (req) => req.body || {},
    deck: { start: async (o) => { if (fail) throw new HttpError(500, 'no terminal'); started.push(o); return 'alpha'; }, respawn: async () => {} },
  };
  const chats = new Map([[c.id, c]]);
  const o = {
    chats, make: (rec) => made.push(rec), save() {}, load() {}, chatOr404: () => c, memory: { last: () => null }, models: () => [],
    openChatOf: () => null, freeId: (id) => id, terminalOf: async () => null, claim: async (id, fn) => ({ started: await fn() }),
    serial: (id, fn) => fn(), forget() {}, auto: { name: 'auto', on: () => false }, handedFile: path.join(tmp, 'state', 'handed.json'),
  };
  return { routes: handoffRoutes(ctx, o), made, started, chats };
}

test('Open in Terminal stops the chat process and keeps the chat record, with its title', async () => {
  const { c, calls } = chatOf();
  const { routes, started, chats } = harness(c);
  const r = await route(routes, 'POST', `/api/chats/${CONV}/terminal`)({});
  assert.deepEqual(r, { name: 'alpha' });
  assert.equal(started.length, 1, 'the terminal started on the conversation');
  assert.equal(calls.stopped, 1, 'the chat process ended before the terminal ran the conversation');
  assert.equal(calls.closed, 0, 'the chat is not closed: it can run again');
  assert.ok(chats.get(CONV) === c, 'its record is still among the open chats');
  assert.equal(c.title, 'Cart total rounding');
  assert.notEqual(c.closed, true);
});

test('a terminal that does not start leaves the chat open as it was, and nothing is made anew', async () => {
  const { c, calls } = chatOf();
  const { routes, made, chats } = harness(c, { fail: true });
  await assert.rejects(route(routes, 'POST', `/api/chats/${CONV}/terminal`)({}), /no terminal/);
  assert.ok(chats.get(CONV) === c, 'the chat is still open');
  assert.equal(made.length, 0, 'no second copy of the record');
  assert.equal(calls.closed, 0);
});
