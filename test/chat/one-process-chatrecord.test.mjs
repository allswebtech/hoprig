// A chat opened with a first message on a conversation whose record names another chat (runs.mjs createChatRun: another
// dashboard's, or one that is still closing) is opened to read along, and the answer says the message did not go, as it
// does for a terminal: never a 409 for a chat that was opened all the same, never a second process. Claude Code is the
// stand-in (fixtures/fake-claude.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

function request(base, method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...(cookie ? { Cookie: cookie } : {}) };
    const req = http.request(new URL(p, base), { method, headers }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, cookie: (res.headers['set-cookie'] || [''])[0].split(';')[0] });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('a first message into a conversation another chat\'s record holds: the chat opens, the message is not sent, nothing runs', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('chatrecord');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const R = await import('../../src/runs.mjs');
  saveConfig({ server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  let other = null;
  t.after(async () => {
    if (other) R.removeRun(other.file);
    await app.close();
    box.cleanup();
  });
  const { cookie } = await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } });
  const owner = (method, p, body) => request(base, method, p, { body, cookie });
  const held = (id) => R.listRuns({ chats: true, usage: false }).filter((r) => R.runsConversation(r, id, 'claude'));

  // A conversation on disk, its chat closed: nothing holds it.
  const id = (await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'hello' })).json.id;
  await until('the first answer', async () => (await owner('GET', `/api/chats/${id}`)).json.events.some((e) => e.kind === 'turn-end'));
  assert.equal((await owner('POST', `/api/chats/${id}/close`, {})).status, 200);
  await until('its record to go', () => held(id).length === 0);

  // Another chat's record on it (as another dashboard's chat writes it, while its process runs).
  other = R.createChatRun({ chat: 'another-dashboards-chat', conversation: id, tool: 'claude', cwd: proj, profile: 'sub' });
  const r = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', sessionId: id, text: 'go on' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.sent, r.json.why], [false, 'another chat runs this conversation right now']);
  const view = (await owner('GET', `/api/chats/${r.json.id}`)).json;
  assert.equal(view.running, false, 'no process of its own');
  assert.deepEqual(held(id).map((x) => x.chat), ['another-dashboards-chat'], 'one record on the conversation: the other chat\'s');
  // The other chat ends: this one sends.
  R.removeRun(other.file);
  other = null;
  assert.equal((await owner('POST', `/api/chats/${r.json.id}/send`, { text: 'now go on' })).status, 200);
  await until('its process to stop when idle', async () => !(await owner('GET', `/api/chats/${r.json.id}`)).json.running);
});
