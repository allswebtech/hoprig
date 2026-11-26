// GET /api/local/facts: what set-up and doctor ask the running dashboard (its version, where it really listens, the
// sessions of its built-in terminals). Only a request from this computer with the key of the dashboard file gets it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

test('the running dashboard tells this computer, with the key, its version, its address and its built-in terminals', { timeout: 60_000 }, async (t) => {
  const box = sandbox('localfacts');
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { runningDashboard, runningKey, stateKey } = await import('../../src/server/dashboardfile.mjs');
  saveConfig({ server: { backend: 'pty', passwordHash: await hashPassword('first-password') } });
  const backend = { kind: 'pty', capabilities: {}, list: async () => [{ session: 'shop' }, { session: 'alpha' }], capture: async () => '' };
  const app = createServer({ backend, serverFacts: { publicIps: [], dmi: {}, localDisplay: false } });
  const { port } = await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const base = `http://127.0.0.1:${port}/api/local/facts`;
  const running = { ...runningDashboard(), key: runningKey() };
  assert.equal(running.port, port);
  assert.equal(typeof running.key, 'string');
  if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(process.env.HOPRIG_STATE_DIR, 'dashboard.json')).mode & 0o777).toString(8), '600', 'only this user reads the key');
  const ok = await fetch(base, { headers: { 'x-hoprig-local-key': running.key } });
  assert.equal(ok.status, 200);
  const version = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  assert.deepEqual(await ok.json(), { version, pid: process.pid, state: stateKey(), host: '127.0.0.1', port, backend: 'pty', terminals: ['shop', 'alpha'] });
  for (const headers of [{}, { 'x-hoprig-local-key': 'x'.repeat(running.key.length) }, { 'x-hoprig-local-key': running.key, 'x-forwarded-for': '203.0.113.9' }]) {
    const r = await fetch(base, { headers });
    assert.equal(r.status, 404, JSON.stringify(Object.keys(headers)));
    assert.doesNotMatch(await r.text(), new RegExp(version.replace(/\./g, '\\.')), 'nothing told');
  }
  // A key of the right length in letters but not in bytes (sent as latin1): a wrong key, not a 500.
  const http = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    const q = http.request(base, { headers: { 'x-hoprig-local-key': Buffer.from('é'.repeat(running.key.length), 'latin1').toString('latin1') } }, (r) => { r.resume(); resolve(r.statusCode); });
    q.on('error', reject);
    q.end();
  });
  assert.equal(status, 404);
});
