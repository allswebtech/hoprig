// Only Claude's API passes through a shared gateway, also when the path is encoded to look like it. An encoded slash or
// backslash, a backslash, or a "." / ".." segment in any case or encoding is answered 404 on both paths
// (/gateway/<id>/… and /gateway/m/<computer>/<id>/…), even with a valid key, and nothing reaches the gateway. Paths
// are sent raw: a client library would clean some of them up before they leave.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { GW_KEY, fakeAddon, fakeGateway } from './fakegateway.mjs';

const box = sandbox('gateway-paths');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { putMachine } = await import('../../src/machines/store.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { unsafePath } = await import('../../src/gateway/index.mjs');

const gw = await fakeGateway({ pauseMs: 0 });
test.after(() => gw.close());

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
writeProfile('api', { label: 'API via TRouteAI', env: { ANTHROPIC_BASE_URL: `http://localhost:${gw.port}`, ANTHROPIC_AUTH_TOKEN: GW_KEY } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
const app = createServer({ backend, watch: false, dashboardFile: false, gateway: { addons: [fakeAddon(gw.port)] }, accounts: { gateways: [] } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

/** GET with the path exactly as given. */
function raw(path, key) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { authorization: `Bearer ${key}` } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    r.on('error', reject);
    r.end();
  });
}

// What follows the gateway's prefix. Every one of them could leave /v1/ once decoded or cleaned up.
const TRICKS = [
  '/v1/..%2fadmin', '/v1/..%2Fadmin', '/v1/%2e%2e%2fadmin', '/v1/%2E%2E%2Fadmin', '/v1/models%2f..%2f..%2fapi',
  '/v1/%5c..%5cadmin', '/v1/..%5Cadmin', '/v1\\..\\admin', '/v1/\\admin',
  '/v1/../admin', '/v1/./models', '/v1/%2e%2e/admin', '/v1/%2E/models', '/v1/.%2E/admin', '/v1/models/..',
  '/v1/%252e%252e%252fadmin', '/v1/%25%32%66admin', '/v1/%zz', '/v1/models%',
];

test('the check itself: Claude\'s API paths pass, tricks do not', () => {
  for (const ok of ['/gateway/trouteai/v1/messages', '/gateway/m/desk/trouteai/v1/messages/count_tokens', '/gateway/t/v1/models?limit=1000'.split('?')[0], '/gateway/t/v1/models/claude-haiku-5-5', '/gateway/t/v1/a.b..c']) {
    assert.equal(unsafePath(ok), false, ok);
  }
  for (const t of TRICKS) assert.equal(unsafePath(`/gateway/trouteai${t}`), true, t);
});

test('both paths answer 404 to every trick, with a valid key, and the gateway never sees one', async () => {
  await call('/api/gateways/trouteai/share', { on: true });
  const { key } = await call('/api/gateways/trouteai/keys', { name: 'laptop' });
  // This dashboard linked to itself by address, and a provider here for its gateway: /gateway/m/self/… then goes
  // through the linked path all the way to the gateway, exactly as for another computer.
  putMachine({ name: 'self', label: 'Self', via: 'url', url: base, token: 'unused-machine-token', added: Date.now() });
  const { key: held } = await call('/api/gateways/trouteai/keys', { name: 'self' });
  writeProfile('gw-self', { label: 'TRouteAI on Self', env: { ANTHROPIC_BASE_URL: `${base}/gateway/m/self/trouteai`, ANTHROPIC_AUTH_TOKEN: held } });

  // The control: a plain API path reaches the gateway on both.
  let before = gw.seen.length;
  assert.equal((await raw('/gateway/trouteai/v1/models', key)).status, 200);
  assert.equal((await raw('/gateway/m/self/trouteai/v1/models', held)).status, 200);
  assert.deepEqual(gw.seen.slice(before).map((s) => s.url), ['/v1/models', '/v1/models']);

  before = gw.seen.length;
  for (const [prefix, k] of [['/gateway/trouteai', key], ['/gateway/m/self/trouteai', held]]) {
    for (const t of TRICKS) {
      const r = await raw(prefix + t, k);
      assert.equal(r.status, 404, `${prefix}${t}: ${r.status} ${r.text}`);
      assert.doesNotMatch(r.text, /gateway dashboard/, `${prefix}${t}`);
    }
  }
  assert.deepEqual(gw.seen.slice(before).map((s) => s.url), [], 'nothing reached the gateway');
  // Still working afterwards: the tricks were not counted as wrong keys.
  assert.equal((await raw('/gateway/trouteai/v1/models', key)).status, 200);
});
