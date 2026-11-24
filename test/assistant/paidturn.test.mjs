// Her own turn on a provider billed by use spends too (feature.mjs readiness and turn): past the daily cap, or with no
// cap set, the turn is refused with a notice and her engine is never started, so no request reaches the provider.
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

test('her own turn on a paid provider past the cap, or under Auto with a paid key, never starts her engine', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-in is POSIX' }, async (t) => {
  const box = sandbox('tia-paidturn');
  const mark = path.join(box.root, 'engine-started');
  const engine = path.join(box.root, 'engine.mjs');
  fs.writeFileSync(engine, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(mark)}, 'started\\n');\nprocess.exit(1);\n`);
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { HOLD_USD, spendFile } = await import('../../src/assistant/spend.mjs');
  saveConfig({ usage: false, server: { backend: 'pty', roots: [box.home], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'handsoff', accounts: ['api', 'sub', 'auto'], runsOn: 'api', dailyCapUsd: HOLD_USD } });
  writeProfile('api', { label: 'API', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
  writeProfile('sub', { label: 'Main' });
  // The day's cap is used already: one hold of HOLD_USD in today's ledger.
  fs.mkdirSync(path.dirname(spendFile()), { recursive: true });
  fs.writeFileSync(spendFile(), JSON.stringify({ at: Date.now(), kind: 'hold' }) + '\n');
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
  const say = async (text) => {
    const r = await request(base, 'POST', '/api/assistant/chat', { body: { text }, headers: { Cookie: cookie } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.conversation;
    for (let i = 0; i < 60; i++) {
      const e = (await request(base, 'GET', `/api/assistant/chat/${id}?from=0`, { headers: { Cookie: cookie } })).json;
      const notice = e.events.find((x) => x.kind === 'notice');
      if (notice) return notice.text;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('no notice came');
  };
  assert.match(await say('What runs now?'), /costs money, and today's daily limit for paid use of \$0\.50 is reached/);
  // Auto mode with the API key in its order: her turn is paid as well.
  saveConfig({ ...loadConfig(), autoSwitch: { enabled: true, order: ['sub', 'api'] }, assistant: { ...loadConfig().assistant, runsOn: 'auto' } });
  assert.match(await say('And now?'), /costs money, and today's daily limit for paid use of \$0\.50 is reached/);
  assert.equal(fs.existsSync(mark), false, 'her engine started: a request would have reached the provider');
});

// Inside the cap her turn runs with what is left of it as its budget: the coding tool stops the turn there.
test('her own paid turn inside the cap gets what is left of the cap as its budget', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-in is POSIX' }, async (t) => {
  const box = sandbox('tia-paidbudget');
  const argv = path.join(box.root, 'argv.json');
  const engine = path.join(box.root, 'engine.mjs');
  fs.writeFileSync(engine, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n`);
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  saveConfig({ usage: false, server: { backend: 'pty', roots: [box.home], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'handsoff', accounts: ['api'], runsOn: 'api', dailyCapUsd: 3 } });
  writeProfile('api', { label: 'API', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
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
  await request(base, 'POST', '/api/assistant/chat', { body: { text: 'What runs now?' }, headers: { Cookie: cookie } });
  for (let i = 0; i < 100 && !fs.existsSync(argv); i++) await new Promise((r) => setTimeout(r, 100));
  const args = JSON.parse(fs.readFileSync(argv, 'utf8'));
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '3', JSON.stringify(args));
});
