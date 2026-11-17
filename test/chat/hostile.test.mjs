// A chat in a folder the dashboard did not make, whose own git settings name programs (test/fixtures/hostile-repo.mjs):
// the @ picker's file search and the branch in the status line start none of them, and answer right. Claude Code is
// the stand-in (fixtures/fake-claude.mjs).
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hostileRepo } from '../fixtures/hostile-repo.mjs';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');

test('the @ picker and the branch read a folder\'s git without starting its programs', { timeout: 60_000, skip: process.platform === 'win32' && 'the programs are shell scripts' }, async (t) => {
  const box = sandbox('chathostile');
  const work = path.join(box.root, 'work');
  const h = hostileRepo(path.join(work, 'cloned'), path.join(box.root, 'marks'));
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, sessionDefaults: { permissionMode: 'bypassPermissions' } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({
    watch: false, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'pw-for-tests' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json', Origin: base } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const made = await call('POST', '/api/chats', { dir: h.dir, profile: 'sub' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const A = `/api/chats/${made.json.id}`;

  h.clear();
  const all = await call('GET', `${A}/files?q=`);
  assert.equal(all.status, 200);
  assert.deepEqual([...all.json.files].sort(), ['.gitattributes', 'a.txt', 'b.txt', 'c.md', 'gone.txt', 'new.txt']);
  assert.deepEqual((await call('GET', `${A}/files?q=gone`)).json.files, ['gone.txt']);
  const view = await call('GET', A);
  assert.equal(view.json.branch, 'main');
  assert.deepEqual(h.ran(), [], 'the folder\'s git settings started a program');
});
