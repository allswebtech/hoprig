// A chat runs Claude Code (until other engines come): a provider that does not serve it (an OpenAI key, a Codex
// sign-in) is refused with a plain sentence wherever a chat starts or moves, and a Codex or OpenCode terminal session
// is never taken into a chat. In the real dashboard (createServer, built-in terminals) for the routes, and on the
// hand-off routes themselves for a terminal run of another coding tool.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, '..', 'assistant', 'fixtures', 'fake-session.mjs');
const CONV = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('a chat, its provider chip and a chat schedule refuse a provider that does not serve Claude Code', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('chatclaudeonly');
  const proj = path.join(box.root, 'work', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [path.dirname(proj)], passwordHash: await hashPassword('pw-for-tests') } });
  // "oai" comes first by name and has no limit: before, it was the recommended provider of a new session or chat.
  writeProfile('oai', { label: 'OpenAI key', env: { OPENAI_API_KEY: 'sk-openai-secret-of-the-test' } });
  writeProfile('codexin', { signin: 'codex' });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 30_000 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const login = await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } });
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });

  assert.equal((await owner('GET', '/api/state')).json.recommended, 'sub', 'the recommended provider serves Claude Code');
  for (const profile of ['oai', 'codexin']) {
    const r = await owner('POST', '/api/chats', { dir: proj, profile });
    assert.equal(r.status, 400, profile);
    assert.match(r.json.error, /cannot be used for Claude Code: (it does not answer|it is the sign-in of another coding tool)/);
  }
  const made = await owner('POST', '/api/chats', { dir: proj });
  assert.equal(made.status, 200, 'with nothing chosen: the recommended one');
  const id = made.json.id;
  assert.equal((await owner('GET', `/api/chats/${id}`)).json.profile.name, 'sub');
  const moved = await owner('POST', `/api/chats/${id}/provider`, { profile: 'oai' });
  assert.equal(moved.status, 400);
  assert.match(moved.json.error, /"OpenAI key" cannot be used for Claude Code/);
  assert.equal((await owner('GET', `/api/chats/${id}`)).json.profile.name, 'sub', 'the chat stays where it was');

  const schedule = { when: { kind: 'daily', time: '07:00' }, action: { type: 'start', in: 'chat', dir: proj, profile: 'oai' } };
  const r = await owner('POST', '/api/automation/schedules', { op: 'add', schedule });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cannot be used for Claude Code/);
  assert.equal((await owner('POST', '/api/automation/schedules', { op: 'add', schedule: { ...schedule, action: { ...schedule.action, profile: 'sub' } } })).status, 200);
  assert.equal((await owner('POST', `/api/chats/${id}/close`, {})).status, 200);
});

test('Open as chat takes a Claude Code terminal only: a Codex run is refused, and so is a run on a provider that does not serve Claude Code', { skip: process.platform === 'win32' && 'POSIX paths' }, async (t) => {
  const box = sandbox('chathandoff');
  t.after(() => box.cleanup());
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { handoffRoutes, terminals } = await import('../../src/chat/handoff.mjs');
  writeProfile('oai', { env: { OPENAI_API_KEY: 'sk-openai-secret-of-the-test' } });
  writeProfile('sub', { label: 'Main' });
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  let run = null;
  const made = [];
  const ctx = {
    HttpError, readJson: async () => ({ session: 'term' }), config: () => ({}),
    deck: { find: async () => ({ term: { id: 't1' }, run }) },
    backend: { list: async () => [] },
  };
  const o = {
    chats: new Map(), make: (r) => made.push(r), save: () => {}, load: () => {}, chatOr404: () => null,
    memory: { last: () => null }, models: () => ['sonnet'], openChatOf: () => null, freeId: (x) => x,
    terminalOf: async () => null, auto: { name: 'auto', on: () => false },
  };
  const fromSession = handoffRoutes(ctx, o).find(([m, re]) => m === 'POST' && re.test('/api/chats/from-session'))[2];
  const refused = async (want) => {
    const e = await fromSession({}).then(() => null, (x) => x);
    assert.ok(e, 'refused');
    assert.match(e.message, want);
    return e;
  };

  for (const tool of ['codex', 'opencode']) {
    run = { tool, sessionId: CONV, cwd: '/w', profile: 'oai' };
    assert.equal((await refused(/for Claude Code sessions only/)).status, 409, tool);
  }
  run = { tool: 'claude', sessionId: CONV, cwd: '/w', profile: 'oai' };
  assert.equal((await refused(/cannot be used for Claude Code/)).status, 400);
  assert.deepEqual(made, [], 'no chat was made');
  run = { sessionId: CONV, cwd: '/w', profile: 'sub' }; // an older record without `tool`: Claude Code
  assert.deepEqual(await fromSession({}), { id: CONV });
  assert.equal(made[0].profile, 'sub');

  // The conversation a chat runs is looked for in Claude Code's run records only.
  const { runsDir } = await import('../../src/paths.mjs');
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.writeFileSync(path.join(runsDir(), 'r1.json'), JSON.stringify({ runId: 'r1', pid: process.pid, tool: 'codex', sessionId: CONV, profile: 'oai', cwd: '/w', status: 'working', startedAt: 1, statusAt: 1 }));
  assert.equal(await terminals(ctx).terminalOf(CONV), null, 'a Codex run with the same id is not this conversation');
});
