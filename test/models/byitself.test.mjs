// What the models' list does BY ITSELF in the real dashboard (createServer): a start, the page's usual loads and three
// ticks of the watcher, each more than ten minutes apart, with providers whose endpoints fail the test when asked. No
// endpoint is asked (a list is asked only when a picker opens), and nothing in the home changes for it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { SHELL_STANDINS, closedGateways } from '../seal.mjs';
import { tempWork } from '../work/helpers.mjs';

/** Every file under `root` → a hash of its content. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p);
      else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}
// Windows: PowerShell (which Hoprig asks about processes there) makes its own module cache in a home that never had
// one; that file is the system's, not a change of Hoprig's.
const POWERSHELL_CACHE = /(^|\/)AppData\/Local\/Microsoft\/Windows\/PowerShell\/ModuleAnalysisCache$/;
const changes = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k] && !(process.platform === 'win32' && POWERSHELL_CACHE.test(k))).sort();

/** An endpoint that must never be asked: every request is kept, and answered with a list (so a hidden ask still "works"). */
async function mustNotBeAsked(ids = ['relay-1']) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

test('a start, page loads and three ticks ask no endpoint for its models and change nothing in the home', { timeout: 90_000, skip: SHELL_STANDINS.skip }, async (t) => {
  const w = tempWork('models-byitself');
  assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(w.root), 'a workspace of its own, never the real one');
  const gate = await mustNotBeAsked();
  const api = await mustNotBeAsked();
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  writeProfile('relay', { label: 'Relay', env: { ANTHROPIC_BASE_URL: gate.url, ANTHROPIC_AUTH_TOKEN: 'relay-test-key-0001' } });
  writeProfile('direct', { label: 'Direct', env: { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'direct-test-key-0002' } });
  writeProfile('team', { label: 'Team', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-0003' } });
  saveConfig({ addons: closedGateways(), claudeBin: path.join(w.root, 'no-claude'), usage: false, sessionDefaults: { model: 'relay-1' }, server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') } });
  const cfgFile = path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json');
  const cfgBefore = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const before = snapshot(w.root);
  let app = null;
  t.after(async () => {
    if (app) await app.close().catch(() => {});
    await Promise.all([gate.close(), api.close()]);
    w.cleanup();
  });
  const { createServer } = await import('../../src/server/server.mjs');
  app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `models-byitself-${process.pid}` });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  await new Promise((r) => setTimeout(r, 1500)); // what the start itself does is over
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-for-tests' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  // The page's usual loads, without opening a picker: Home, Settings, Work's lists.
  for (const p of ['/api/state', '/api/settings', '/api/chats', '/api/work']) await fetch(base + p, { headers: { Origin: base, Cookie: cookie } });
  for (let i = 0; i < 3; i++) await app.watcher.tick();
  assert.deepEqual(gate.seen, [], 'the gateway was never asked');
  assert.deepEqual(api.seen, [], 'the API endpoint was never asked');
  const after = snapshot(w.root);
  // Nothing of the lists is written anywhere (they are kept in memory only); the home, the workspace and the provider
  // files are as they were. The dashboard's own state folder holds what the dashboard always writes.
  // config.json: the keys the dashboard writes by itself at a start are named; the model choices are as they were.
  const cfgAfter = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const changedKeys = [...new Set([...Object.keys(cfgBefore), ...Object.keys(cfgAfter)])].filter((k) => JSON.stringify(cfgBefore[k]) !== JSON.stringify(cfgAfter[k])).sort();
  assert.deepEqual(cfgAfter.sessionDefaults, cfgBefore.sessionDefaults, 'the saved default model is as it was');
  assert.ok(!changedKeys.some((k) => /model/i.test(k)), `no model setting changed: ${changedKeys}`);
  assert.deepEqual(cfgAfter.assistant, cfgBefore.assistant, 'Tia\'s settings are as they were');
  t.diagnostic(`config.json keys the dashboard's own start wrote: ${changedKeys.join(', ') || 'none'}`);
  assert.deepEqual(changes(before, after).filter((f) => !f.startsWith('state/') && f !== 'config/config.json'), [], 'nothing outside the dashboard\'s state changed');
  assert.deepEqual(changes(before, after).filter((f) => /model/i.test(f)), [], 'no file of the model lists');
});

test('a start with both switches off asks no endpoint; a real Lead start asks its provider\'s list once, for its reason; neither changes the home', { timeout: 90_000, skip: SHELL_STANDINS.skip }, async (t) => {
  const w = tempWork('models-leadstart');
  // Here it may be asked once, by the Lead start only: every request is kept. Its list names model families (tiers).
  const gate = await mustNotBeAsked(['relay-haiku-1', 'relay-sonnet-2', 'relay-opus-3']);
  const other = await mustNotBeAsked();
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { forgetModels } = await import('../../src/models/catalog.mjs');
  forgetModels();
  writeProfile('relay', { label: 'Relay', env: { ANTHROPIC_BASE_URL: gate.url, ANTHROPIC_AUTH_TOKEN: 'relay-test-key-0001' } });
  writeProfile('other', { label: 'Other', env: { ANTHROPIC_BASE_URL: other.url, ANTHROPIC_AUTH_TOKEN: 'other-test-key-0002' } });
  const shop = path.join(w.home, 'shop');
  fs.mkdirSync(shop, { recursive: true });
  saveConfig({ addons: closedGateways(), claudeBin: path.join(w.root, 'no-claude'), usage: false, server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') } });
  const argsFile = path.join(w.root, 'starts.args');
  const FAKE = path.join(import.meta.dirname, '..', 'chat', 'fixtures', 'fake-claude.mjs');
  let app = null;
  t.after(async () => {
    if (app) await app.close().catch(() => {});
    await Promise.all([gate.close(), other.close()]);
    w.cleanup();
  });
  const { createServer } = await import('../../src/server/server.mjs');
  app = createServer({ watch: false, dashboardFile: false, tmuxSocket: `models-leadstart-${process.pid}`, parts: { models: async () => null },
    chat: { command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }), idleMs: 30_000 } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-for-tests' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const starts = () => (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray) : []);
  const until = async (fn) => {
    for (let i = 0; i < 150 && !fn(); i++) await new Promise((r) => setTimeout(r, 100));
    return fn();
  };
  const before = snapshot(w.root);

  // Both switches off (as after an update): the start is as before, and no endpoint is asked.
  const off = await post('/api/chats', { dir: shop, profile: 'relay', text: 'hello' });
  assert.ok(off.id, JSON.stringify(off));
  const s1 = await until(() => starts()[0]);
  assert.ok(s1 && !s1.includes('--agents') && !s1.includes('--mcp-config'), 'nothing of Lead in the start');
  for (let i = 0; i < 3; i++) await app.watcher.tick();
  assert.deepEqual([gate.seen, other.seen], [[], []], 'no endpoint asked with both switches off');

  // A real Lead start: its own provider's list is asked once (the reason: the helpers' models), no other provider.
  const on = await post('/api/chats', { dir: shop, profile: 'relay', lead: true, others: ['other'], text: 'hello' });
  assert.ok(on.id, JSON.stringify(on));
  const s2 = await until(() => starts()[1]);
  assert.ok(s2 && s2.includes('--agents'), 'it leads');
  for (let i = 0; i < 3; i++) await app.watcher.tick();
  assert.deepEqual(gate.seen.map((x) => x.split('?')[0]), ['GET /v1/models'], 'its own list, once');
  assert.deepEqual(other.seen, [], 'a ticked provider is not asked until a part is handed to it');
  const after = snapshot(w.root);
  // The only files outside the dashboard's state: the two conversations the coding tool keeps of the two chats started
  // here (named by their ids), and the stand-in's own record of its starts.
  const { projectDir } = await import('../../src/sessions.mjs');
  const convs = (await fetch(`${base}/api/chats`, { headers: { Origin: base, Cookie: cookie } }).then((r) => r.json())).chats.map((c) => c.sessionId);
  const theirs = new Set(convs.map((id) => path.relative(w.root, path.join(projectDir(fs.realpathSync(shop)), `${id}.jsonl`)).split(path.sep).join('/')));
  assert.equal(theirs.size, 2);
  assert.deepEqual(changes(before, after).filter((f) => !f.startsWith('state/') && f !== 'config/config.json' && !theirs.has(f) && f !== path.relative(w.root, argsFile)), [], 'nothing else outside the dashboard\'s state changed');
});
