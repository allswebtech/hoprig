// Tia's mark on a chat (byTia: her rules let her answer its OKs) is on the safe side: a chat opened on an existing
// conversation is never hers, and a chat of hers whose conversation went on while the dashboard was down is hers no
// more after a restart. A real dashboard with Claude Code's stand-in; her requests come through another computer's
// door (its token and its relay's own mark), as a hub relays them.
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
        resolve({ status: res.statusCode, json, setCookie: res.headers['set-cookie'] });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
};

test('Tia\'s mark: never on an earlier conversation; after a restart only on a conversation that did not go on', { timeout: 90_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('tiamark');
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
  const { token } = createToken('hub');
  const apps = [];
  t.after(() => Promise.all(apps.map((a) => a.close().catch(() => {}))));
  async function start() {
    const app = createServer({
      watchTickMs: 300, dashboardFile: false,
      chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400 },
    });
    apps.push(app);
    const { port } = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).setCookie[0].split(';')[0];
    return {
      app,
      owner: (m, p, b) => request(base, m, p, { body: b, headers: { Cookie: cookie } }),
      tia: (m, p, b) => request(base, m, p, { body: b, headers: { Authorization: `Bearer ${token}`, [SELF_HEADER]: '1' } }),
    };
  }
  const cardOf = async (s, id) => (await s.owner('GET', '/api/chats')).json.chats.find((c) => c.chatId === id);
  const turnEnded = (s, id) => until('a turn ends', async () => (await s.owner('GET', `/api/chats/${id}`)).json.events.some((e) => e.kind === 'turn-end'));
  const idle = (s, id) => until('the chat stops when idle', async () => !(await s.owner('GET', `/api/chats/${id}`)).json.running);
  const transcript = (id) => path.join(box.claude, 'projects', proj.replace(/[^A-Za-z0-9]/g, '-'), `${id}.jsonl`);
  /** A line the owner writes into the conversation elsewhere (a terminal, another computer). */
  const ownersLine = (id, text) => {
    const lines = fs.readFileSync(transcript(id), 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(lines.at(-1));
    fs.appendFileSync(transcript(id), JSON.stringify({ type: 'user', isSidechain: false, uuid: `u-${Date.now()}`, parentUuid: last.uuid, timestamp: new Date().toISOString(), sessionId: id, message: { role: 'user', content: text } }) + '\n');
  };

  let s = await start();
  // ---- a chat she opens on an earlier conversation (the owner's, full of his instructions): never hers ----
  const his = (await s.owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'owner: tidy the build scripts' })).json.id;
  await turnEnded(s, his);
  assert.equal((await s.owner('POST', `/api/chats/${his}/close`, {})).status, 200);
  await until('closed', async () => !(await cardOf(s, his)));
  const onHis = await s.tia('POST', '/api/chats', { dir: proj, profile: 'sub', sessionId: his, defaults: true, byTia: true });
  assert.equal(onHis.status, 200, onHis.json && onHis.json.error);
  assert.equal((await cardOf(s, onHis.json.id)).byTia, false, 'a chat on an existing conversation is not hers, whoever opens it');
  assert.equal((await s.owner('POST', `/api/chats/${onHis.json.id}/close`, {})).status, 200);
  // Her own earlier conversation too (the safe side): she closed it, she opens it again, it is not hers.
  const own = (await s.tia('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'tia: run the tests', defaults: true, byTia: true })).json.id;
  await turnEnded(s, own);
  assert.equal((await cardOf(s, own)).byTia, true, 'a new chat of hers is hers');
  assert.equal((await s.owner('POST', `/api/chats/${own}/close`, {})).status, 200);
  await until('closed', async () => !(await cardOf(s, own)));
  const again = await s.tia('POST', '/api/chats', { dir: proj, profile: 'sub', sessionId: own, defaults: true, byTia: true });
  assert.equal(again.status, 200, again.json && again.json.error);
  assert.equal((await cardOf(s, again.json.id)).byTia, false, 'her own earlier conversation is not hers either');
  assert.equal((await s.owner('POST', `/api/chats/${again.json.id}/close`, {})).status, 200);

  // ---- two chats of hers; the dashboard stops; the owner goes on with one of them elsewhere ----
  const quiet = (await s.tia('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'tia: lint', defaults: true, byTia: true })).json.id;
  const moved = (await s.tia('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'tia: build', defaults: true, byTia: true })).json.id;
  for (const id of [quiet, moved]) {
    await turnEnded(s, id);
    await idle(s, id);
    assert.equal((await cardOf(s, id)).byTia, true);
  }
  await s.app.close();
  ownersLine(moved, 'owner: and delete the old release folder');
  s = await start();
  assert.equal((await cardOf(s, moved)).byTia, false, 'the conversation went on while the dashboard was down: not hers');
  const view = (await s.owner('GET', `/api/chats/${moved}`)).json;
  assert.ok(JSON.stringify(view.events).includes('delete the old release folder'), 'the owner\'s line is read');
  assert.equal((await cardOf(s, quiet)).byTia, true, 'nothing changed while it was down: still hers');

  // ---- once more: the mark that went stays gone; a record from an older version (no "known") is never hers ----
  await s.app.close();
  const file = path.join(box.state, 'chats.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.find((r) => r.id === moved).byTia, undefined, 'the mark that went is gone on disk too');
  const q = saved.find((r) => r.id === quiet);
  assert.equal(q.byTia, true);
  assert.equal(q.known, fs.statSync(transcript(quiet)).size, 'her chat\'s record keeps what it knew of the conversation');
  delete q.known;
  fs.writeFileSync(file, JSON.stringify(saved));
  s = await start();
  assert.equal((await cardOf(s, quiet)).byTia, false, 'a record without what it knew is never hers after a restart');
  assert.equal((await cardOf(s, moved)).byTia, false);
});
