// The folder's last chat is the owner's own choice: a chat with no provider named starts where his last chat in that
// folder ran. Tia moving her own chat to another provider (switch_account after a limit), or moving any chat through
// her door, must not change where his next chat starts. Claude Code is the stand-in; no message is sent.
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

test('a provider Tia chose is never the folder\'s last choice', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('chatmem');
  t.after(() => box.cleanup());
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { createToken } = await import('../../src/machines/tokens.mjs');
  const { SELF_HEADER } = await import('../../src/machines/relay.mjs');
  saveConfig({ server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  writeProfile('second', { label: 'Second' });
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(() => app.close());
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      resolve(res.headers['set-cookie'][0].split(';')[0]);
    });
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  // Tia's door as another computer's dashboard relays hers: its token and its relay's own mark.
  const { token } = createToken('hub');
  const tia = (method, p, body) => request(base, method, p, { body, headers: { Authorization: `Bearer ${token}`, [SELF_HEADER]: '1' } });
  const profileOf = async (id) => (await owner('GET', `/api/chats/${id}`)).json.profile.name;
  const nextOwnersChat = async () => {
    const r = await owner('POST', '/api/chats', { dir: proj });
    assert.equal(r.status, 200, r.json && r.json.error);
    const p = await profileOf(r.json.id);
    assert.equal((await owner('POST', `/api/chats/${r.json.id}/close`, {})).status, 200);
    return p;
  };

  // The owner's chat on Main: his next one starts there.
  const mine = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub' })).json.id;
  assert.equal((await owner('POST', `/api/chats/${mine}/close`, {})).status, 200);
  assert.equal(await nextOwnersChat(), 'sub');

  // Tia's own chat, moved by her to the second provider: his next chat still starts on Main.
  const hers = await tia('POST', '/api/chats', { dir: proj, profile: 'sub', defaults: true, byTia: true });
  assert.equal(hers.status, 200, hers.json && hers.json.error);
  assert.equal((await tia('POST', `/api/chats/${hers.json.id}/provider`, { profile: 'second' })).status, 200);
  assert.equal(await profileOf(hers.json.id), 'second', 'her chat moved');
  assert.equal(await nextOwnersChat(), 'sub', 'her move is not his choice');
  assert.equal((await owner('POST', `/api/chats/${hers.json.id}/close`, {})).status, 200);

  // The owner's own chat moved through her door (a card he accepted): still not his choice of a folder default.
  const his = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub' })).json.id;
  assert.equal((await tia('POST', `/api/chats/${his}/provider`, { profile: 'second' })).status, 200);
  assert.equal(await nextOwnersChat(), 'sub');

  // He moves it himself from the page: that is his choice, and the next chat follows it.
  assert.equal((await owner('POST', `/api/chats/${his}/provider`, { profile: 'second' })).status, 200);
  assert.equal(await nextOwnersChat(), 'second');
  assert.equal((await owner('POST', `/api/chats/${his}/close`, {})).status, 200);
});
