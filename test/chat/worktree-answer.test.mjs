// A chat asked to work on a branch of its own answers what came of it (worktree: { branch } or { why }), through the
// real dashboard (createServer): a page of this version tells the owner when an older computer's answer has none.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('a chat asked for a worktree answers what came of it', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('wtans');
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
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  const repo = path.join(work, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  const made = (await owner('POST', '/api/chats', { dir: repo, profile: 'sub', worktree: true })).json;
  assert.match(made.worktree.branch, /^worktree-chat-[0-9a-f]{6}$/);
  // The chat itself says so, in one plain line, as it says when it could not make the worktree.
  const lines = async (id) => ((await owner('GET', `/api/chats/${id}`)).json.events || []).filter((e) => e.kind === 'notice');
  assert.deepEqual((await lines(made.id)).map((e) => [e.level, e.text]), [['info', `This chat works on its own copy of the project, on the branch ${made.worktree.branch}. Its changes stay there until you merge them.`]]);
  const plain = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', worktree: true })).json;
  assert.match(plain.worktree.why, /not a git repository/);
  assert.deepEqual((await lines(plain.id)).map((e) => e.level), ['warning'], 'the one that failed says why, as before');
  assert.equal((await owner('POST', '/api/chats', { dir: proj, profile: 'sub' })).json.worktree, undefined, 'not asked for: no field');
});
