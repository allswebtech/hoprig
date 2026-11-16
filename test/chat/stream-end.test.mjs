// How a chat's event stream ends. Only a chat that left the open list for good gets the last "closed" event (its
// page then shows it as not open and stops following). A restart of the dashboard ends every chat's process but
// keeps the chat (it is loaded again), and a hand-off to a terminal that fails keeps it too: there the stream just
// ends, so the page looks again and follows the chat once it answers. Claude Code is the stand-in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'fixtures', 'fake-claude.mjs');

const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

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

/** A server-sent event stream: { got: [{ event, data }], ended() }. */
function stream(base, p, headers) {
  const got = [];
  let ended = false;
  const req = http.get(new URL(p, base), { headers }, (r) => {
    let buf = '';
    r.setEncoding('utf8');
    r.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (ev && data) got.push({ event: ev[1], data: JSON.parse(data[1]) });
      }
    });
    r.on('end', () => (ended = true));
    r.on('close', () => (ended = true));
  });
  req.on('error', () => (ended = true));
  return { got, ended: () => ended, close: () => req.destroy() };
}

test('a chat stream says "closed" only for a chat closed for good', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('chatend');
  t.after(() => box.cleanup());
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, sessionDefaults: { permissionMode: 'bypassPermissions' } });
  writeProfile('sub', { label: 'Main' });
  const serve = async () => {
    const app = createServer({
      watchTickMs: 300, dashboardFile: false,
      chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000 },
    });
    const { port } = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const cookie = await new Promise((resolve) => {
      const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
        res.resume();
        resolve(res.headers['set-cookie'][0].split(';')[0]);
      });
      req.end(JSON.stringify({ password: 'pw-for-tests' }));
    });
    const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
    const follow = async (id) => {
      const v = (await owner('GET', `/api/chats/${id}`)).json;
      const s = stream(base, `/api/chats/${id}/stream?from=${v.next}&epoch=${v.epoch}`, { Cookie: cookie });
      t.after(() => s.close());
      await until('the stream', () => s.got.some((e) => e.event === 'state'));
      return s;
    };
    return { app, owner, follow };
  };

  let one = await serve();
  let closedOne = false;
  t.after(() => !closedOne && one.app.close());
  const id = (await one.owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'hello' })).json.id;
  await until('the first answer', async () => (await one.owner('GET', `/api/chats/${id}`)).json.events.some((e) => e.kind === 'turn-end'));

  // ---- a hand-off whose terminal does not start: the chat stays open, its page is not told it closed ----
  const s1 = await one.follow(id);
  const start = one.app.deck.start;
  one.app.deck.start = async () => {
    throw new Error('the terminal could not start (test)');
  };
  assert.equal((await one.owner('POST', `/api/chats/${id}/terminal`, {})).status, 500);
  one.app.deck.start = start;
  await until('the stream to end', () => s1.ended());
  assert.ok(!s1.got.some((e) => e.event === 'closed'), 'no "closed" for a chat that stays open');
  assert.equal((await one.owner('GET', `/api/chats/${id}`)).status, 200, 'the next look finds it');

  // ---- a restart: every process ends, the chat stays, and its page follows it again afterwards ----
  const s2 = await one.follow(id);
  await one.app.close();
  closedOne = true;
  await until('the stream to end', () => s2.ended());
  assert.ok(!s2.got.some((e) => e.event === 'closed'), 'no "closed" at a restart');
  const two = await serve();
  t.after(() => two.app.close());
  assert.equal((await two.owner('GET', `/api/chats/${id}`)).status, 200, 'the chat is open after the restart');

  // ---- closed for good: the last thing the stream says is "closed" ----
  const s3 = await two.follow(id);
  assert.equal((await two.owner('POST', `/api/chats/${id}/close`, {})).status, 200);
  await until('the stream to end', () => s3.ended());
  assert.equal(s3.got.at(-1).event, 'closed');
  assert.equal(s3.got.at(-1).data.closed.conversationId, id);
});
