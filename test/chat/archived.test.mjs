// The App's Archived list through the real dashboard (createServer): Archive keeps the conversation in the list, a
// session closed before its first message adds nothing, and one continued in a new session leaves it.
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

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((res) => setTimeout(res, 50));
  }
};

test('Archived: an archived session can be continued; an empty one is not listed; a continued one leaves the list', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('archived');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      resolve(res.headers['set-cookie'][0].split(';')[0]);
    });
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  assert.equal((await request(base, 'GET', '/api/chats/archived')).status, 401, 'behind the sign-in');
  assert.deepEqual((await owner('GET', '/api/chats/archived')).json.list, []);

  const empty = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub' })).json.id;
  await owner('POST', `/api/chats/${empty}/close`, {});
  assert.deepEqual((await owner('GET', '/api/chats/archived')).json.list, [], 'closed before its first message: nothing to continue');

  const id = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'hello' })).json.id;
  const conv = await until('the first turn', async () => {
    const v = (await owner('GET', `/api/chats/${id}`)).json;
    return v.events.some((e) => e.kind === 'turn-end') && v.conversationId;
  });
  await owner('POST', `/api/chats/${id}/title`, { title: 'Fix the cart' });
  await owner('POST', `/api/chats/${id}/close`, {});
  const list = (await owner('GET', '/api/chats/archived')).json.list;
  assert.deepEqual(list.map((x) => [x.title, x.conversationId, x.cwd, x.tool, x.profile]), [['Fix the cart', conv, fs.realpathSync(proj), 'claude', 'sub']]);
  // Continued in a new session (what the list's sheet does): open again, it leaves the list.
  const again = await owner('POST', '/api/chats', { dir: list[0].cwd, tool: list[0].tool, profile: list[0].profile, sessionId: list[0].conversationId });
  assert.equal(again.status, 200);
  assert.deepEqual((await owner('GET', '/api/chats/archived')).json.list, [], 'open in a session again');
  await owner('POST', `/api/chats/${again.json.id}/close`, {});
  assert.equal((await owner('GET', '/api/chats/archived')).json.list.length, 1, 'archived again: one entry per conversation');
});
