// Her MCP server is told where THIS dashboard listens, never a default port: another dashboard (the one a person
// really uses) may hold the configured or the usual port, and her calls would then reach it.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch { return null; } })(), headers: res.headers }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('her address is the port this server listens on, not the configured one, with no dashboard file', { timeout: 60_000 }, async (t) => {
  const box = sandbox('tia-addr');
  // A decoy on the configured port: a dashboard her calls must never reach. It counts what it gets.
  let reached = 0;
  const decoy = http.createServer((req, res) => {
    reached++;
    res.end('{}');
  });
  await new Promise((r) => decoy.listen(0, '127.0.0.1', r));
  const decoyPort = decoy.address().port;
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ server: { backend: 'pty', port: decoyPort, passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'work' } });
  const app = createServer({ watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    await new Promise((r) => decoy.close(r));
    box.cleanup();
  });
  assert.notEqual(port, decoyPort);
  const base = `http://127.0.0.1:${port}`;
  const login = await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const r = await request(base, 'POST', '/api/assistant/client-token', { body: {}, headers: { Cookie: cookie } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.command, new RegExp(`HOPRIG_DASHBOARD_URL=http://127\\.0\\.0\\.1:${port}\\b`));
  assert.doesNotMatch(r.json.command, new RegExp(`:${decoyPort}\\b`));
  assert.equal(reached, 0);
});

test('her engine never starts without its own dashboard address', async () => {
  sandbox('tia-addr2');
  const { mcpConfig } = await import('../../src/assistant/engine.mjs');
  for (const url of [undefined, null, '', 'u', '127.0.0.1:7433']) assert.throws(() => mcpConfig({ url, tokenFile: '/s/t', conversation: 'c1' }), /own address/, String(url));
  assert.equal(mcpConfig({ url: 'http://127.0.0.1:8331', tokenFile: '/s/t', conversation: 'c1' }).mcpServers.hoprig.env.HOPRIG_DASHBOARD_URL, 'http://127.0.0.1:8331');
});

// The address is asked for again when a turn comes: a server that was not listening yet at start() is reached later.
test('readiness takes the address the server listens on now when none was known at start', async () => {
  const { assistantFeature } = await import('../../src/assistant/feature.mjs');
  let listening = null;
  const ctx = { config: () => ({ assistant: { enabled: true, runsOn: 'sub', accounts: ['sub'] } }), listening: () => listening, dispatch: async () => ({}), HttpError: class extends Error {}, onTick: () => () => {}, readJson: async () => ({}), saveConfig: () => {} };
  const f = assistantFeature(ctx, { core: { spend: { take: () => null, spent: () => {}, today: () => ({ spent: 0, held: 0 }) } } });
  const route = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/assistant'))[2];
  const req = { headers: {} };
  assert.match((await route(req)).ready.problem, /did not say where it listens/);
  listening = { address: '127.0.0.1', port: 8331 };
  const r = (await route(req)).ready;
  assert.notEqual(r.problem && /listens/.test(r.problem), true, JSON.stringify(r));
  f.close();
});
