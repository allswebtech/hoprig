// A gateway's own page is never passed through the dashboard, not even for the signed-in owner: its scripts would run
// on the dashboard's address with his sign-in. A request to any path that could lead there, with his cookie, reaches
// nothing of the stand-in gateway, while its shared API (/v1/ with a gateway key) still does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { GW_KEY, fakeAddon, fakeGateway, stream } from './fakegateway.mjs';

const box = sandbox('gateway-page-not-passed');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const gw = await fakeGateway({ pauseMs: 10 });
test.after(() => gw.close());

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
saveConfig({ addons: { trouteai: { port: await (await import('../../src/machines/tunnels.mjs')).freePort() } } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
const app = createServer({ backend, watch: false, dashboardFile: false, gateway: { addons: [fakeAddon(gw.port)] }, accounts: { gateways: [] } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const owner = { Origin: base, Cookie: cookie };
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { ...owner, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));

// Sharing on and a key made, so the gateway's address through the dashboard is live for its API.
writeProfile('api', { label: 'API via TRouteAI', prerun: 'true', env: { ANTHROPIC_BASE_URL: `http://localhost:${gw.port}`, ANTHROPIC_AUTH_TOKEN: GW_KEY, ANTHROPIC_MODEL: 'combo-best' }, models: '*=combo-best' });
assert.equal((await post('/api/gateways/trouteai/share', { on: true })).status, 200);
const made = await post('/api/gateways/trouteai/keys', { name: 'laptop' });
assert.equal(made.status, 200);
const key = made.json.key;

const PATHS = [
  '/gateway/trouteai/', '/gateway/trouteai', '/gateway/trouteai/dashboard', '/gateway/trouteai/login',
  '/gateway/trouteai/_next/static/app.js', '/gateway/trouteai/api/keys', '/gateway/trouteai/%2e%2e/dashboard',
  '/gateway/trouteai/v1/../dashboard', '/gateway/m/box2/trouteai/', '/m/box2/gateway/trouteai/',
  '/addons/trouteai/', '/api/addons/trouteai/page', '/api/gateways/trouteai/page', `/gateway/${gw.port}/`,
];

test('the owner\'s signed-in requests to a gateway page path reach nothing of the gateway', async () => {
  const before = gw.seen.length;
  for (const p of PATHS) {
    for (const method of ['GET', 'POST']) {
      const r = await stream(base + p, { method, headers: owner, body: method === 'POST' ? '{}' : '' });
      assert.doesNotMatch(r.text, /gateway dashboard: settings/, `${method} ${p}`);
      assert.ok(!/^2/.test(String(r.status)) || !/gateway dashboard/.test(r.text), `${method} ${p}`);
    }
  }
  assert.deepEqual(gw.seen.slice(before).map((x) => x.url), [], 'none of them reached the gateway');
});

test('with the gateway key as well, only its API passes, and the dashboard\'s cookie never reaches it', async () => {
  const before = gw.seen.length;
  for (const p of ['/gateway/trouteai/', '/gateway/trouteai/dashboard']) {
    const r = await stream(base + p, { method: 'GET', headers: { ...owner, authorization: `Bearer ${key}` }, body: '' });
    assert.equal(r.status, 404, p);
  }
  assert.equal(gw.seen.length, before, 'the page paths reached nothing');
  const api = await stream(`${base}/gateway/trouteai/v1/models`, { method: 'GET', headers: { ...owner, authorization: `Bearer ${key}` }, body: '' });
  assert.equal(api.status, 200);
  const got = gw.seen.slice(before);
  assert.equal(got.length, 1);
  assert.equal(got[0].url, '/v1/models');
  assert.equal(JSON.stringify(got[0].headers).includes(cookie.split('=')[1]), false, 'the dashboard\'s cookie stays on the dashboard');
  assert.equal(got[0].headers.cookie, undefined);
});
