// Wrong keys must not lock out the computers that hold a right one. Behind cloudflared or a tunnel every caller has the
// same address (127.0.0.1 here), so the limit of 10 wrong keys per address in 15 minutes is counted only for keys that
// fail: after 10 wrong keys a valid key from the same address still passes, and the 11th wrong key is refused.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { GW_KEY, fakeAddon, fakeGateway, stream } from './fakegateway.mjs';

const box = sandbox('gateway-lockout');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const gw = await fakeGateway({ pauseMs: 0 });
test.after(() => gw.close());

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
writeProfile('api', { label: 'API via TRouteAI', env: { ANTHROPIC_BASE_URL: `http://localhost:${gw.port}`, ANTHROPIC_AUTH_TOKEN: GW_KEY } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
// The default limits: 10 wrong keys per address.
const app = createServer({ backend, watch: false, dashboardFile: false, gateway: { addons: [fakeAddon(gw.port)] }, accounts: { gateways: [] } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const call = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = (p, key) => stream(`${base}${p}`, { method: 'GET', headers: { authorization: `Bearer ${key}` } });
const wrong = (i) => `hop_gw_${String(i).padStart(43, 'w')}`;

test('10 wrong keys from one address, then a valid key from it still passes, and the 11th wrong key is refused', async () => {
  await call('/api/gateways/trouteai/share', { on: true });
  const { key } = await call('/api/gateways/trouteai/keys', { name: 'laptop' });
  // A provider here for a linked computer: its key must pass the limit on the pass-through too.
  const held = `hop_gw_${'h'.repeat(43)}`;
  writeProfile('gw-laptop', { label: 'TRouteAI on Laptop', env: { ANTHROPIC_BASE_URL: `${base}/gateway/m/laptop/trouteai`, ANTHROPIC_AUTH_TOKEN: held } });

  for (let i = 0; i < 10; i++) {
    const r = await get('/gateway/trouteai/v1/models', wrong(i));
    assert.equal(r.status, 401, `wrong key ${i + 1}`);
  }
  const ok = await get('/gateway/trouteai/v1/models', key);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(JSON.parse(ok.text).data.map((m) => m.id), ['combo-best', 'haiku-like']);
  const status = await get('/gateway/trouteai/__status', key);
  assert.equal(status.status, 200);

  const eleventh = await get('/gateway/trouteai/v1/models', wrong(10));
  assert.equal(eleventh.status, 429);
  assert.match(JSON.parse(eleventh.text).error.message, /Too many wrong gateway keys/);
  assert.ok(eleventh.headers['retry-after']);

  // Still locked for wrong keys, still open for the right one.
  assert.equal((await get('/gateway/trouteai/v1/models', key)).status, 200);
  assert.equal((await get('/gateway/trouteai/v1/models', wrong(11))).status, 429);

  // The pass-through for linked computers: the held key gets past the limit (to "no such computer", as Laptop is
  // not linked in this test); a wrong one is refused by the limit.
  const passed = await get('/gateway/m/laptop/trouteai/v1/models', held);
  assert.equal(passed.status, 404, passed.text);
  assert.match(JSON.parse(passed.text).error.message, /no longer one of your computers/);
  assert.equal((await get('/gateway/m/laptop/trouteai/v1/models', wrong(12))).status, 429);
});
