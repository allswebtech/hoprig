// An OpenCode conversation between a terminal and a chat (src/chat/handoff.mjs), on the stand-in of OpenCode's
// server: Open as chat takes only a provider that serves the run's coding tool and only a model id it can use;
// Open in terminal refuses a choice the terminal cannot take before the chat is let go; Continue here stops the turn
// the terminal left running on OpenCode's server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { SESSION_ID, standIn, standInOpts } from './fixtures/opencode-standin.mjs';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

test('Open as chat, Open in terminal and Continue here for an OpenCode conversation', { timeout: 30_000, skip: process.platform === 'win32' && 'POSIX signals' }, async (t) => {
  const box = sandbox('handoff-oc');
  const s = await standIn();
  t.after(async () => {
    await s.close();
    box.cleanup();
  });
  const cwd = path.join(box.root, 'proj');
  fs.mkdirSync(cwd);
  const { writeProfile } = await import('../../src/profiles.mjs');
  writeProfile('sub', { label: 'Main' }); // a Claude subscription
  writeProfile('gw', { label: 'Gateway', api: ['messages'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'gw-token-of-the-test' } });
  const { Chat } = await import('../../src/chat/chat.mjs');
  const { handoffRoutes, terminals } = await import('../../src/chat/handoff.mjs');
  const { createRun, updateRun } = await import('../../src/runs.mjs');
  const { system } = await import('../../src/procid.mjs');

  const chats = new Map();
  const turnsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-handoff-'));
  const engineOpts = { enabled: () => true, ...standInOpts(s) };
  const make = (rec) => {
    const c = new Chat({ ...rec, turnsDir, resolveEnv: async () => ({}), engineOpts, idleMs: 60_000 });
    chats.set(c.id, c);
    return c;
  };
  let found = null;
  const started = [];
  const ctx = {
    HttpError,
    readJson: async (req) => req.body,
    config: () => ({ codingTools: ['claude', 'opencode'], server: {} }),
    deck: { find: async () => found, start: async (o) => (started.push(o), 'oc-term') },
    backend: { list: async () => [], respawn: async () => {} },
    poke: () => {},
  };
  // One conversation, one process (handoff.mjs claim), by the coding tool's own records, as feature.mjs sets it up.
  const chatOf = (id, tool) => ([...chats.values()].find((c) => c.conversationId === id && c.engine.id === tool && (c.session || c.starting || c.busy())) || {}).id || null;
  const { terminalOf, claim, serial, forget } = terminals(ctx, { chatOf });
  const routes = handoffRoutes(ctx, {
    chats, make, save: () => {}, load: () => {}, memory: { last: () => null }, models: () => ['opus'],
    chatOr404: (id) => chats.get(id) || (() => { throw new HttpError(404, 'no chat'); })(),
    openChatOf: (id) => ([...chats.values()].find((c) => c.conversationId === id) || {}).id || null,
    freeId: (id) => id, terminalOf, claim, serial, forget, auto: { name: 'auto', on: () => false },
  });
  const call = async (method, p, body = {}) => {
    for (const [m, re, fn] of routes) {
      const hit = m === method && re.exec(p);
      if (hit) {
        try {
          return { status: 200, json: await fn({ body }, hit) };
        } catch (e) {
          return { status: e.status || 500, json: { error: e.message } };
        }
      }
    }
    throw new Error(`no route ${method} ${p}`);
  };

  // Open as chat: the run's own coding tool decides which providers fit (a subscription never reaches OpenCode).
  const run = (o) => ({ tool: 'opencode', sessionId: SESSION_ID, profile: 'gw', cwd, carryArgs: [], ...o });
  found = { run: run({ profile: 'sub' }) };
  let r = await call('POST', '/api/chats/from-session', { session: 'oc-term' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cannot be used for OpenCode/);
  // A model taken from the terminal's flags is used only when it is a model id; the terminal's "ask" is "manual".
  found = { run: run({ carryArgs: ['--permission-mode', 'ask', '--model', '-rf'] }) };
  r = await call('POST', '/api/chats/from-session', { session: 'oc-term' });
  assert.equal(r.status, 200, r.json.error);
  let c = chats.get(r.json.id);
  assert.deepEqual([c.engine.id, c.model, c.permissionMode, c.conversationId], ['opencode', null, 'manual', SESSION_ID]);
  chats.clear();
  found = { run: run({ carryArgs: ['--model', 'claude-haiku-5-5'] }) };
  c = chats.get((await call('POST', '/api/chats/from-session', { session: 'oc-term' })).json.id);
  assert.equal(c.model, 'claude-haiku-5-5');

  // Open in terminal: a choice the terminal refuses leaves the chat open, as it was.
  c.model = '-bad model';
  r = await call('POST', `/api/chats/${c.id}/terminal`);
  assert.equal(r.status, 400);
  assert.ok(chats.has(c.id), 'the chat is still there');
  assert.equal(started.length, 0);
  c.model = 'claude-haiku-5-5';
  r = await call('POST', `/api/chats/${c.id}/terminal`);
  assert.equal(r.status, 200, r.json.error);
  assert.equal(started[0].tool, 'opencode');
  assert.deepEqual([started[0].mode, started[0].sessionId], ['resume', SESSION_ID]);
  assert.deepEqual(started[0].flags.slice(0, 2), ['--permission-mode', 'ask'], 'a chat that asked goes on asking');
  assert.ok(!chats.has(c.id));

  // Continue here: the terminal stops, and the turn it left running on OpenCode's server stops too.
  const d = make({ id: '3d9c2a4e-1b3f-4c5d-8e6f-0a1b2c3d4e5f', conversationId: SESSION_ID, engine: 'opencode', cwd, profile: 'gw' });
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const { file } = createRun({ profile: 'gw', cwd, tool: 'opencode' });
  // The child's record, as it would write it: its pid and its identity (procid.mjs).
  updateRun(file, { pid: child.pid, proc: system.of([child.pid]).get(child.pid), sessionId: SESSION_ID, status: 'working' });
  assert.ok(await terminalOf(SESSION_ID, 'opencode'), 'the terminal runs it');
  assert.equal(await terminalOf(SESSION_ID, 'claude'), null, 'by tool and id');
  r = await call('POST', `/api/chats/${d.id}/take`);
  assert.equal(r.status, 200, r.json.error);
  assert.ok(s.calls.some((x) => x.method === 'POST' && x.path === `/api/session/${SESSION_ID}/interrupt`), 'its turn on the server stopped');
  await d.close();
});
