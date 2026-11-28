// ONE truth for "may she act alone": the Operator switch (config operator.acts) and nothing else. One reader
// (tia.mjs actsAlone / tiaRaw), and every answer that shows it agrees: her acts, GET /api/assistant/settings, readiness.
// A setting file with only the old key (assistant.actAlone) or only the switch is read the same everywhere.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { actsAlone, resolveTia, tiaRaw } from '../../src/assistant/tia.mjs';
import { createOps } from '../../src/assistant/ops.mjs';
import { sandbox } from '../server/helpers.mjs';

const CASES = [
  [{ assistant: { enabled: true }, operator: { acts: true } }, true],
  [{ assistant: { enabled: true }, operator: { acts: false } }, false],
  [{ assistant: { enabled: true } }, false],
  [{ assistant: { enabled: true, actAlone: true } }, false],
  [{ assistant: { enabled: true, actAlone: true }, operator: { acts: false } }, false],
  [{ assistant: { enabled: true, actAlone: false }, operator: { acts: true } }, true],
  [{ operator: { acts: true } }, true],
  [{}, false],
];

test('one reader: the switch decides, the old key never does', () => {
  for (const [config, want] of CASES) {
    assert.equal(actsAlone(config), want, JSON.stringify(config));
    assert.equal(resolveTia(tiaRaw(config), { profiles: [] }).actAlone, want, `resolveTia ${JSON.stringify(config)}`);
  }
});

test('her own settings answer (ops) and the page settings answer are the same truth', async () => {
  for (const [config, want] of CASES) {
    const s = await createOps({ ctx: { config: () => config } }).assistantSettings();
    assert.equal(s.actAlone, want, JSON.stringify(config));
  }
});

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

test('GET /api/assistant/settings shows what the Operator switch says, for every old or new file', { timeout: 60_000 }, async (t) => {
  const box = sandbox('oneswitch');
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  saveConfig({ ...loadConfig(), usage: false, server: { backend: 'pty', roots: [box.home], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true } });
  const { createServer } = await import('../../src/server/server.mjs');
  const app = createServer({ watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).headers['set-cookie'][0].split(';')[0];
  for (const [config, want] of CASES.filter(([c]) => c.assistant)) {
    saveConfig({ ...loadConfig(), assistant: config.assistant, operator: config.operator || {} });
    const r = await request(base, 'GET', '/api/assistant/settings', { headers: { Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.json.settings.actAlone, want, JSON.stringify(config));
  }
});
