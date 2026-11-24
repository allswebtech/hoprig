// "!" in the App through the real dashboard (createServer): POST /api/chats/<id>/shell runs in the session's folder,
// one at a time per session, refuses a bad command and a request without the sign-in or from another page; while it
// runs GET …/shell shows its output so far and POST …/shell/stop ends it.
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

test('the "!" route: its folder, one at a time, a bad command, the sign-in and the origin, its output while it runs, Stop', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('bangsrv');
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
  const id = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub' })).json.id;
  const S = `/api/chats/${id}/shell`;

  const pwd = await owner('POST', S, { command: 'pwd' });
  assert.equal(pwd.status, 200);
  assert.equal(pwd.json.output.trim(), fs.realpathSync(proj), 'it runs in the session\'s folder');
  assert.equal(pwd.json.code, 0);
  for (const bad of [{}, { command: '' }, { command: 'a\0b' }, { command: 'x'.repeat(4001) }]) assert.equal((await owner('POST', S, bad)).status, 400, JSON.stringify(bad).slice(0, 30));
  assert.equal((await request(base, 'POST', S, { body: { command: 'pwd' } })).status, 401, 'not without the sign-in');
  const elsewhere = await request(base, 'POST', S, { body: { command: 'pwd' }, headers: { Cookie: cookie, Origin: 'http://evil.example' } });
  assert.ok(elsewhere.status === 403 || elsewhere.status === 401, `not from another page (${elsewhere.status})`);
  assert.equal((await request(base, 'POST', `${S}/stop`, { body: {} })).status, 401, 'nor its Stop');

  // One at a time: a second one while the first runs is refused; the first shows its output so far and stops.
  const first = owner('POST', S, { command: 'echo begun; sleep 777' });
  let look;
  const end = Date.now() + 10_000;
  while (!((look = (await owner('GET', S)).json).running && look.output.includes('begun')) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([look.running, look.command, look.output], [true, 'echo begun; sleep 777', 'begun\n'], 'its output while it runs');
  const second = await owner('POST', S, { command: 'pwd' });
  assert.equal(second.status, 409);
  assert.match(second.json.error, /a command runs in this session already/);
  assert.equal((await owner('POST', `${S}/stop`, {})).json.stopped, true);
  const r = (await first).json;
  assert.deepEqual([r.code, r.stopped, r.output], [null, true, 'begun\n']);
  assert.equal((await owner('GET', S)).json.running, false);
  assert.equal((await owner('POST', S, { command: 'echo free' })).json.output, 'free\n', 'free for the next one');
});
