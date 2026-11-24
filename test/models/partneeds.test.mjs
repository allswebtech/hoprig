// A part of a Lead chat in a folder WITH a project's needs: the extra folders reach the part as they reach the chat
// that leads it (its project's need and the lead's "Also open"), read-only, with their deny rules, in the same
// settings file under the same hook. Through a real dashboard (createServer; Claude Code a stand-in that records its
// start); the provider's address fails the test when asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { closedGateways } from '../seal.mjs';
import { acceptAll, needsWorld } from '../workspace/needsfix.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, '..', 'assistant', 'fixtures', 'fake-session.mjs');

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
const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const flagAfter = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
/** A start's settings file; only the lead has the PreToolUse hook of its helpers, so that is left out to compare. */
const settingsOf = (args) => {
  const f = flagAfter(args, '--settings');
  const s = f ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  if (s.hooks) delete s.hooks.PreToolUse;
  return s;
};

test('a part in a project with needs gets the same read-only extra folders and deny rules as the chat that leads it', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const w = needsWorld('partneeds', { shopNeeds: ['kits/parts'], accept: false });
  process.env.HOPRIG_WORKSPACE_DIR = w.ws;
  const asked = [];
  const wire = http.createServer((req, res) => {
    asked.push(req.url);
    res.writeHead(500).end();
  });
  await new Promise((r) => wire.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => wire.close(r)));
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ addons: closedGateways(), launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') }, automation: { schedules: { atOnce: 2 } } });
  acceptAll({ shop: ['kits/parts'], 'kits/parts': [] }); // the owner's yes for shop's need, on this computer
  writeProfile('sub', { label: 'Main', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
  writeProfile('alpha', { label: 'Alpha', env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${wire.address().port}`, ANTHROPIC_AUTH_TOKEN: 'sk-alpha-test-0123456789' } });
  const argsFile = path.join(w.root, 'starts.args');
  const app = createServer({
    watchTickMs: 300, dashboardFile: false, parts: { models: async () => null },
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, engineOpts: { version: '2.1.328' }, resolveEnv: async (name) => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile, HOPRIG_TEST_PROVIDER: name }), idleMs: 30_000 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  // The after hooks run in the order they are added: the dashboard ends first, then its home is removed.
  t.after(async () => {
    await app.close();
    w.cleanup();
  });
  app.features.find((f) => f.name === 'parts').setAddress(base);
  const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).headers['set-cookie'][0].split(';')[0];
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  const starts = () => (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray) : []);

  // The lead in shop (its need kits/parts), with "Also open" blog for this chat only.
  const open = await owner('POST', '/api/chats', { dir: w.shop, profile: 'sub', lead: true, others: ['alpha'], with: ['blog'], permissionMode: 'manual', text: 'hello' });
  assert.equal(open.status, 200, JSON.stringify(open.json));
  const tokenFile = path.join(process.env.HOPRIG_STATE_DIR, 'part-servers', `${open.json.id}.token`);
  await until('the lead started with its tool', () => fs.existsSync(tokenFile));
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const lead = await until('the lead\'s start', () => starts()[0]);
  const leadSettings = settingsOf(lead);
  const parts = fs.realpathSync(w.parts);
  const blog = fs.realpathSync(path.join(w.projects, 'blog'));
  assert.deepEqual(leadSettings.permissions.additionalDirectories, [parts, blog], 'the lead has its need and "Also open"');

  const a = (await request(base, 'POST', '/api/parts', { body: { action: 'start', provider: 'alpha', kind: 'coder', brief: 'write notes.txt' }, headers: { Authorization: `Bearer ${token}` } })).json;
  assert.ok(!a.isError, a.text);
  const part = await until('the part\'s start', () => starts()[1]);
  const partSettings = settingsOf(part);
  assert.deepEqual(partSettings.permissions.additionalDirectories, [parts, blog], 'the part reads the same extra folders');
  for (const r of [`Write(/${parts}/**)`, `Edit(/${blog}/**)`, `Read(/${parts}/ai-ignore-dir/**)`, `Read(/${parts}/.env)`]) assert.ok(partSettings.permissions.deny.includes(r), `read-only for the part too: ${r}`);
  assert.ok(!JSON.stringify(partSettings).includes('Bash(rm'), 'no allow rule of the need travels');
  assert.ok(partSettings.hooks && partSettings.hooks.PermissionRequest, 'under the same hook');
  assert.deepEqual(partSettings, leadSettings, 'the same settings as the chat that leads it');
  assert.deepEqual(asked, [], 'no provider was asked');
});
