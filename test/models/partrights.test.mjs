// A part of a Lead chat never gets more rights than the chat that leads it: it opens in the lead's own mode only where
// the owner may start a session in that mode on this computer now (bypass only while "Allow bypass permissions mode"
// is on), under the same hook and settings as the lead (its folder, its extra folders). Through a real dashboard
// (createServer; Claude Code a stand-in that records its start); the providers are addresses that fail the test when
// asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';
import { SHELL_STANDINS } from '../seal.mjs';

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
        resolve({ status: res.statusCode, json });
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
async function tripwire(t) {
  const asked = [];
  const srv = http.createServer((req, res) => {
    asked.push(req.url);
    res.writeHead(500).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  return { asked, url: `http://127.0.0.1:${srv.address().port}` };
}
const flagAfter = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
/** A start's settings file without what only a lead has (its PreToolUse hook): the rest must be the lead's. */
const settingsOf = (args) => {
  const f = flagAfter(args, '--settings');
  const s = f ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  if (s.hooks) delete s.hooks.PreToolUse;
  return s;
};

test('a part opens in the lead chat\'s own mode and settings, and never in bypass while the switch is off', { timeout: 120_000, skip: SHELL_STANDINS.skip }, async (t) => {
  const box = sandbox('partrights');
  const work = path.join(box.root, 'work');
  const shop = path.join(work, 'shop');
  fs.mkdirSync(shop, { recursive: true });
  const wire = await tripwire(t);
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], allowBypass: true, server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, automation: { schedules: { atOnce: 3 } } });
  writeProfile('sub', { label: 'Main', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
  writeProfile('alpha', { label: 'Alpha', env: { ANTHROPIC_BASE_URL: wire.url, ANTHROPIC_AUTH_TOKEN: 'sk-alpha-test-0123456789' } });
  const argsFile = path.join(box.root, 'starts.args');
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    parts: { models: async () => null }, // a part's model is looked up in the catalog; the providers here are never asked
    // A Claude Code that knows the hook events: every chat's start gets the hook and its settings file.
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, engineOpts: { version: '2.1.328' }, resolveEnv: async (name) => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile, HOPRIG_TEST_PROVIDER: name }), idleMs: 30_000 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  // The after hooks run in the order they are added: the dashboard ends first, then its home is removed.
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  app.features.find((f) => f.name === 'parts').setAddress(base);
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      resolve(res.headers['set-cookie'][0].split(';')[0]);
    });
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  const starts = () => (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray) : []);

  // The lead: in bypass (allowed now), alpha ticked.
  const open = await owner('POST', '/api/chats', { dir: shop, profile: 'sub', lead: true, others: ['alpha'], permissionMode: 'bypassPermissions', text: 'hello' });
  assert.equal(open.status, 200, JSON.stringify(open.json));
  const tokenFile = path.join(box.state, 'part-servers', `${open.json.id}.token`);
  await until('the lead started with its tool', () => fs.existsSync(tokenFile));
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const lead = await until('the lead\'s start recorded', () => starts()[0]);
  assert.equal(flagAfter(lead, '--permission-mode'), 'bypassPermissions');
  assert.ok(flagAfter(lead, '--settings'), 'the lead has its settings file (the hook)');
  const part = (body) => request(base, 'POST', '/api/parts', { body, headers: { Authorization: `Bearer ${token}` } });

  // A part while bypass is allowed: the lead's mode, the lead's settings.
  const a = (await part({ action: 'start', provider: 'alpha', brief: 'write notes.txt' })).json;
  assert.ok(!a.isError, a.text);
  const p1 = await until('the part\'s start recorded', () => starts()[1]);
  assert.equal(flagAfter(p1, '--permission-mode'), 'bypassPermissions', 'the lead\'s own mode');
  assert.equal(p1.includes('--allow-dangerously-skip-permissions'), lead.includes('--allow-dangerously-skip-permissions'));
  assert.ok(!p1.includes('--agents') && !p1.includes('--mcp-config'), 'a part never leads and gets no tool to hand parts on');
  assert.deepEqual(settingsOf(p1), settingsOf(lead), 'the same hook and settings as the chat that leads it');
  const leadChat = (await owner('GET', '/api/chats')).json.chats.find((c) => c.chatId === open.json.id);
  const onAlpha = (await owner('GET', '/api/chats')).json.chats.filter((c) => c.profile && c.profile.name === 'alpha');
  assert.equal(onAlpha.length, 1);
  assert.equal(onAlpha[0].cwd, leadChat.cwd, 'the lead\'s folder');

  // The owner turns "Allow bypass permissions mode" off: the next part gets no bypass, whatever the lead runs in.
  saveConfig({ ...loadConfig(), allowBypass: false });
  const b = (await part({ action: 'start', provider: 'alpha', brief: 'write more.txt' })).json;
  assert.ok(!b.isError, b.text);
  const p2 = await until('the second part\'s start recorded', () => starts()[2]);
  assert.notEqual(flagAfter(p2, '--permission-mode'), 'bypassPermissions', `no bypass by a side door: ${JSON.stringify(p2)}`);
  assert.ok(!p2.includes('--allow-dangerously-skip-permissions'), 'not even the flag that allows switching to it');
  assert.deepEqual(wire.asked, [], 'no provider was asked');
});

test('the mode a part opens in: the lead\'s where it is allowed, else Manual', async () => {
  const { partDoor } = await import('../../src/models/partdoor.mjs');
  let cfg = { allowBypass: true };
  const door = partDoor({ chat: {}, config: () => cfg });
  assert.equal(door.modeFor({ permissionMode: 'bypassPermissions' }), 'bypassPermissions');
  assert.equal(door.modeFor({ permissionMode: 'acceptEdits' }), 'acceptEdits');
  assert.equal(door.modeFor({ permissionMode: null }), 'manual', 'no mode of its own: Manual, never Settings\' default');
  cfg = { allowBypass: false };
  assert.equal(door.modeFor({ permissionMode: 'bypassPermissions' }), 'manual');
  assert.equal(door.modeFor({ permissionMode: 'plan' }), 'plan');
});
