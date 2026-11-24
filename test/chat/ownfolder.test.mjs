// A chat's provider as the page gets it: a provider whose Claude Code sign-in is in a folder of its own says so
// (ownFolder: the page then offers its Providers page, not this computer's default sign-in), and never the folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode, text: t, json: (() => { try { return JSON.parse(t); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('a chat on a provider with its own Claude folder says so, without the folder', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('ownfolder');
  const proj = path.join(box.root, 'work', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const folder = path.join(box.root, 'second-claude-folder');
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ server: { backend: 'pty', roots: [path.join(box.root, 'work')], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('main', { label: 'Main' });
  writeProfile('second', { label: 'Second', env: { CLAUDE_CONFIG_DIR: folder } });
  const app = createServer({ dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 } });
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
  for (const [name, own] of [['second', true], ['main', undefined]]) {
    const id = (await owner('POST', '/api/chats', { dir: proj, profile: name })).json.id;
    const v = await owner('GET', `/api/chats/${id}`);
    assert.equal(v.json.profile.ownFolder, own, `${name}: ${JSON.stringify(v.json.profile)}`);
    assert.ok(!v.text.includes(folder), 'the folder never reaches the page');
    await owner('POST', `/api/chats/${id}/close`, {});
  }
});
