// The pull request and task output routes through the real dashboard (createServer): the merge refuses without the
// owner's confirmation, the PR read of a folder without a remote says so, an unknown task is not found.
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

test('the PR and task output routes: confirmation, no remote, no such task, the sign-in', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('prsrv');
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
  const base_ = `/api/chats/${id}`;
  const pr = await owner('GET', `${base_}/pr`);
  assert.deepEqual([pr.status, pr.json.remote, pr.json.pr], [200, false, null], 'a folder without a remote: no pull request, gh not asked');
  const noConfirm = await owner('POST', `${base_}/pr/merge`, {});
  assert.equal(noConfirm.status, 400, 'a merge without the confirmation is refused');
  assert.equal((await owner('POST', `${base_}/pr/merge`, { confirm: 'yes' })).status, 400, 'only true confirms');
  assert.equal((await owner('POST', `${base_}/pr/merge`, { confirm: true })).status, 400, 'the number of the pull request is needed');
  assert.equal((await owner('GET', `${base_}/tasks/nope/output`)).status, 404);
  assert.equal((await request(base, 'GET', `${base_}/pr`)).status, 401, 'no sign-in');
});
