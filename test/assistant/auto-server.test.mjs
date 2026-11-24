// Auto mode on the real dashboard (createServer): a start under Auto, and a message into a chat that runs under Auto,
// count as paid usage once Auto's order holds a provider billed by use, and are then cards with no cap set; with only
// subscriptions in the order they run. The chat's card carries what its coding tool reported it cost (costTotal).
// The coding tool and the terminal are stand-ins; Auto's router is never started (its port is one of this test's own,
// and nothing listens there at the end).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, 'fixtures', 'fake-session.mjs');

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
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const until = async (what, fn, ms = 20_000, seen = () => '') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}${seen() ? `; last seen: ${seen()}` : ''}`);
};
const listens = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => (s.destroy(), resolve(true)));
  s.once('error', () => resolve(false));
});

test('under Auto with a paid key in its order, a start and a message into a chat under Auto are cards with no cap', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const ROUTER_PORT = 8335; // never Auto mode's usual port, which another dashboard's router may hold
  const box = sandbox('tia-auto');
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'shop');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({
    usage: false, router: { port: ROUTER_PORT }, launcher: [process.execPath, FAKE_SESSION],
    server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') },
    autoSwitch: { enabled: true, order: ['sub'] },
    assistant: { enabled: true, level: 'handsoff', accounts: ['auto', 'sub', 'api'] },
  });
  writeProfile('sub', { label: 'Main' });
  writeProfile('api', { label: 'API key', env: { ANTHROPIC_API_KEY: 'not-a-real-key-for-tests' } }); // billed by use
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }) } });
  const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const call = async (tool, args) => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': 'auto' } })).json;
  const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).headers['set-cookie'][0].split(';')[0];
  const chatCard = async (id) => (await request(base, 'GET', '/api/state', { headers: { Cookie: cookie } })).json.sessions.find((s) => s.name === `chat:${id}`);

  // Only subscriptions in Auto's order: no paid usage, the start runs at Hands off.
  let r = await call('start_chat', { folder: proj, account: 'auto', message: 'hello' }); // the stand-in echoes it (no OK asked)
  assert.equal(r.isError, false, r.text);
  assert.doesNotMatch(r.text, /Waiting for the owner's OK/, r.text);
  const id = /Started chat chat:([0-9a-f-]{36})/.exec(r.text)[1];
  let last = null;
  const done = await until('her chat idle with a cost', async () => {
    const c = (last = await chatCard(id));
    return c && c.status === 'waiting' && Number.isFinite(c.costTotal) && c.costTotal > 0 ? c : null;
  }, 20_000, () => JSON.stringify(last && { status: last.status, costTotal: last.costTotal, profile: last.profile, lastMessage: last.lastMessage, running: last.running }));
  assert.equal(done.profile.name, 'auto');
  const cost = done.costTotal;

  // The API key joins Auto's order: a message into the chat under Auto is a card with no cap; nothing reaches it.
  saveConfig({ ...loadConfig(), autoSwitch: { enabled: true, order: ['sub', 'api'] } });
  await call('list_sessions', {});
  r = await call('send_to_chat', { session: `chat:${id}`, text: 'and the docs' });
  assert.match(r.text, /Waiting for the owner's OK/, r.text);
  assert.match(r.text, /no daily limit for paid use is set/, r.text);
  await new Promise((res) => setTimeout(res, 1200));
  assert.equal((await chatCard(id)).costTotal, cost, 'the message reached the chat');
  // A start under Auto: a card too, in a chat and in a terminal.
  for (const tool of ['start_chat', 'start_session']) {
    r = await call(tool, { folder: proj, account: 'auto', message: `a ${tool}` });
    assert.match(r.text, /Waiting for the owner's OK/, `${tool}: ${r.text}`);
  }
  const sessions = (await request(base, 'GET', '/api/state', { headers: { Cookie: cookie } })).json.sessions;
  assert.equal(sessions.length, 1, `only her first chat runs: ${sessions.map((s) => s.name)}`);
  assert.equal(await listens(ROUTER_PORT), false, 'Auto mode\'s router was started');
});
