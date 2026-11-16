// A new chat and a new terminal session with no provider chosen start on the folder's default (src/defaultprovider.mjs,
// ctx.defaultProvider): the provider used last there while it can work, else the Providers page's order. One at its
// limit (also when a chat set that mark), a pay-per-use key and a provider no coding tool of this version can use are
// never picked by themselves. Through the real routes of a dashboard; Claude Code in a chat is the stand-in, a terminal
// is a stand-in backend that only records what it would start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');

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
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('no provider chosen: a new chat and a new terminal session take the folder\'s default, never one at its limit, a paid key or an unusable one', { timeout: 90_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('chatdefault');
  const work = path.join(box.root, 'work');
  const folder = (n) => (fs.mkdirSync(path.join(work, n), { recursive: true }), fs.realpathSync(path.join(work, n)));
  const [own, paid, other, fresh] = ['own', 'paid', 'other', 'fresh'].map(folder);
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { clearLimited, markLimited, setAutoSwitch } = await import('../../src/autoswitch.mjs');
  const { rememberFolderProvider } = await import('../../src/defaultprovider.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: ['launcher'], server: { roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  // "aa" sorts first: another coding tool's sign-in that no coding tool of this version can use.
  writeProfile('aa', { label: 'Old sign-in', signin: 'codex' });
  writeProfile('sub', { label: 'Main' });
  writeProfile('team', { label: 'Team' });
  writeProfile('key', { label: 'Key', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
  setAutoSwitch({ enabled: false, order: ['sub', 'team'] });
  // Where Claude Code's launcher started last (it keeps that: test/defaultprovider.test.mjs).
  rememberFolderProvider(own, 'team');
  rememberFolderProvider(paid, 'key');
  rememberFolderProvider(other, 'aa');

  const created = [];
  const backend = {
    kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '',
    create: async ({ name, dir, argv }) => (created.push({ dir, argv }), { name }),
  };
  const app = createServer({
    backend, watch: false, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 },
  });
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
  const chats = [];
  const chatIn = async (dir, body = {}) => {
    const r = await owner('POST', '/api/chats', { dir, ...body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    chats.push(r.json.id);
    return (await owner('GET', `/api/chats/${r.json.id}`)).json.profile.name;
  };
  const terminalIn = async (dir) => {
    const r = await owner('POST', '/api/sessions', { dir, mode: 'new' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return created.at(-1).argv[1];
  };
  const closeAll = async () => {
    for (const id of chats.splice(0)) await owner('POST', `/api/chats/${id}/close`, {});
  };

  const st = (await owner('GET', '/api/state')).json;
  assert.equal(st.recommended, 'sub', 'the computer\'s default: the first of the order, never the unusable one that sorts first');
  assert.deepEqual(st.recommendedIn, { [own]: 'team' }, 'only a folder whose own default differs; not the paid key, not the unusable one');

  // A folder with its own last provider: both start there.
  assert.equal(await chatIn(own), 'team', 'a chat: the launcher\'s last provider in the folder (no chat ran there yet)');
  assert.equal(await terminalIn(own), 'team');
  // A pay-per-use key used last there, or a provider no coding tool of this version can use: passed over.
  assert.equal(await chatIn(paid), 'sub');
  assert.equal(await terminalIn(paid), 'sub');
  assert.equal(await chatIn(other), 'sub');
  assert.equal(await terminalIn(other), 'sub');
  assert.equal(await chatIn(fresh), 'sub', 'a folder never used: the computer\'s default');
  await closeAll();

  // The last chat in a folder is that folder's own provider for the next chat, under the same tests.
  assert.equal(await chatIn(fresh, { profile: 'team' }), 'team');
  await closeAll();
  assert.equal(await chatIn(fresh), 'team', 'as the last chat here ran');
  await closeAll();
  assert.equal(await chatIn(paid, { profile: 'key' }), 'key', 'the owner may choose the paid key');
  await closeAll();
  assert.equal(await chatIn(paid), 'sub', 'the last chat\'s paid key is not a default by itself');
  await closeAll();

  // "team" at its limit, marked by a chat (src/chat/providerlimit.mjs writes the same mark): nothing picks it by itself.
  markLimited('team', { until: Date.now() + 3600_000, reason: 'chat', text: 'You\'ve hit your usage limit' });
  assert.equal(await chatIn(own), 'sub');
  assert.equal(await terminalIn(own), 'sub');
  assert.equal(await chatIn(fresh), 'sub', 'the last chat\'s provider at its limit');
  assert.deepEqual((await owner('GET', '/api/state')).json.recommendedIn, {}, 'no folder\'s default is the one at its limit');
  await closeAll();
  clearLimited('team');
  assert.equal(await terminalIn(own), 'team', 'free again: the folder\'s own provider');
});
