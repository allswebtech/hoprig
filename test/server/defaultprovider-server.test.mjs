// The dashboard's default provider for a new session (src/defaultprovider.mjs), over real HTTP: the state says it
// for the computer and for each folder whose own default differs; a start without a provider takes the folder's.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('defprov');
test.after(() => box.cleanup());
const folder = (n) => (fs.mkdirSync(path.join(box.root, n)), fs.realpathSync(path.join(box.root, n)));
const workA = folder('a');
const workB = folder('b');

const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { clearLimited, markLimited, setAutoSwitch } = await import('../../src/autoswitch.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { rememberFolderProvider } = await import('../../src/defaultprovider.mjs');
const { createServer } = await import('../../src/server/server.mjs');

saveConfig({ launcher: ['launcher'], server: { roots: [box.root], passwordHash: await hashPassword('right-password') } });
writeProfile('sub', { label: 'Subscription' });
writeProfile('team', { label: 'Team' });
writeProfile('key', { label: 'Key', env: { ANTHROPIC_API_KEY: 'sk-test-not-real' } });
setAutoSwitch({ enabled: false, order: ['sub', 'team'] });
// Claude Code ran in folder b on "team" (the launcher keeps that: test/defaultprovider.test.mjs).
rememberFolderProvider(workB, 'team');

const created = [];
const backend = {
  list: async () => [], capture: async () => '', kind: 'pty', capabilities: {},
  create: async ({ name, dir, argv }) => (created.push({ name, dir, argv }), { name }),
};
const app = createServer({ backend, watch: false, dashboardFile: false });
let ctx = null; // what every feature gets: a stand-in feature takes it when the server starts
app.features.push({ name: 'probe', start: (c) => (ctx = c) });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (p, body) => {
  const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { Origin: base, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};

test('Auto mode off: the computer\'s default is the first of the order, a folder\'s is the provider used last there', async () => {
  const st = (await call('/api/state')).json;
  assert.equal(st.recommended, 'sub');
  assert.deepEqual(st.recommendedIn, { [workB]: 'team' });
});

test('a new session without a provider starts on the folder\'s default; a chosen one is kept', async () => {
  created.length = 0;
  assert.equal((await call('/api/sessions', { dir: workB, mode: 'new' })).status, 200);
  assert.equal((await call('/api/sessions', { dir: workA, mode: 'new', profile: '' })).status, 200);
  assert.equal((await call('/api/sessions', { dir: workB, mode: 'new', profile: 'key' })).status, 200);
  assert.deepEqual(created.map((c) => [c.dir, c.argv[1]]), [[workB, 'team'], [workA, 'sub'], [workB, 'key']]);
  assert.equal((await call('/api/sessions', { dir: workA, mode: 'new', profile: 'nobody' })).status, 400);
});

test('a pay-per-use key used last in a folder (a limit card\'s "Continue on") is not that folder\'s default', async () => {
  rememberFolderProvider(workA, 'key');
  assert.deepEqual((await call('/api/state')).json.recommendedIn, { [workB]: 'team' });
  created.length = 0;
  await call('/api/sessions', { dir: workA, mode: 'new' });
  assert.equal(created[0].argv[1], 'sub');
});

test('a feature asks for a folder\'s default; a provider it names as used last there goes under the same tests', async () => {
  assert.equal(await ctx.defaultProvider(workB), 'team');
  assert.equal(await ctx.defaultProvider(workA), 'sub', 'the key used last in a is passed over');
  assert.equal(await ctx.defaultProvider(workA, 'team'), 'team', 'a chat\'s own last provider');
  assert.equal(await ctx.defaultProvider(workB, 'key'), 'sub', 'a pay-per-use key is not a default');
  markLimited('team', { until: Date.now() + 3600_000 });
  assert.equal(await ctx.defaultProvider(workB), 'sub', 'nor one at its limit');
  clearLimited('team');
  assert.equal(await ctx.defaultProvider(null), 'sub');
});

test('Auto mode on: "auto" everywhere', async () => {
  setAutoSwitch({ enabled: true });
  const st = (await call('/api/state')).json;
  assert.equal(st.recommended, 'auto');
  assert.deepEqual(st.recommendedIn, {});
  created.length = 0;
  await call('/api/sessions', { dir: workB, mode: 'new' });
  assert.equal(created[0].argv[1], 'auto');
  assert.equal(await ctx.defaultProvider(workB, 'team'), 'auto');
});
