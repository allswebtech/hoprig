// The notice where it still comes (he chose a provider billed by use and set no daily limit): no way in words, a
// `code` the page draws its buttons from, and the subscription that can answer now beside it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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

test('his paid choice with no daily limit: a notice with a code and the subscription offered, no path in words', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-in is POSIX' }, async (t) => {
  const box = sandbox('tia-notice');
  const mark = path.join(box.root, 'engine-started');
  const engine = path.join(box.root, 'engine.mjs');
  fs.writeFileSync(engine, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(mark)}, 'started\\n');\nprocess.exit(1);\n`);
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  saveConfig({ ...loadConfig(), usage: false, server: { backend: 'pty', roots: [box.home], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, runsOn: 'api' } });
  writeProfile('api', { label: 'Key', env: { ANTHROPIC_API_KEY: 'sk-made-up' } });
  writeProfile('one', { label: 'Plan one', env: { CLAUDE_CODE_OAUTH_TOKEN: 'made-up' } });
  const { createServer } = await import('../../src/server/server.mjs');
  const app = createServer({ watch: false, dashboardFile: false, assistant: { engine: { command: { command: process.execPath, args: [engine] }, resolveEnv: async () => ({ ...process.env }) } } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  app.features.find((f) => f.name === 'assistant').setAddress(base);
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).headers['set-cookie'][0].split(';')[0];
  const r = await request(base, 'POST', '/api/assistant/chat', { body: { text: 'What runs now?' }, headers: { Cookie: cookie } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let notice = null;
  for (let i = 0; i < 60 && !notice; i++) {
    await new Promise((res) => setTimeout(res, 100));
    notice = (await request(base, 'GET', `/api/assistant/chat/${r.json.conversation}?from=0`, { headers: { Cookie: cookie } })).json.events.find((e) => e.kind === 'notice');
  }
  assert.ok(notice, 'no notice came');
  assert.equal(notice.code, 'paid-no-cap');
  assert.deepEqual(notice.use, { name: 'one', label: 'Plan one' });
  assert.doesNotMatch(notice.text, /Settings|→/, 'a path in words');
  assert.equal(fs.existsSync(mark), false, 'her engine started on the paid provider');
  // His press on "Use Plan one": the existing settings route sets "Tia runs on", then she answers on it.
  const s = await request(base, 'POST', '/api/assistant/settings', { body: { runsOn: 'one' }, headers: { Cookie: cookie } });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const o = (await request(base, 'GET', '/api/assistant', { headers: { Cookie: cookie } })).json;
  assert.deepEqual([o.ready.ok, o.ready.runsOn, o.ready.paid], [true, 'one', false]);
});
