// Gateway refusals send the code of the place they name (web/errorways.js): a program that changed since it was
// confirmed (Add-ons), sharing without a provider here or while sharing is off (Providers, at its gateways panel),
// and a gateway its service runs (Health). Only stand-in programs of this test run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { fakeAddon, fakeGateway } from './fakegateway.mjs';

const box = sandbox('gateway-codes');
test.after(() => box.cleanup());
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const marker = path.join(box.root, 'ran.txt');

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const G = await import('../../src/addons/gateways.mjs');
const { findAddon } = await import('../../src/addons/index.mjs');
const { createServer } = await import('../../src/server/server.mjs');

test('a gateway program that changed since it was confirmed: gateway-not-confirmed, and it does not run', async () => {
  saveConfig({ server: { port: 7433 } });
  const file = path.join(box.root, 'relay-gw');
  const standIn = (name) => fs.writeFileSync(file, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)} + '\\n');\n`, { mode: 0o755 });
  standIn('CONFIRMED');
  try {
    const r = await G.addDefinition({ id: 'relay', title: 'Relay', bin: file, port: await freePort() });
    assert.equal(r.ok, true, r.error);
    standIn('CHANGED');
    const s = await findAddon('relay').start();
    assert.equal(s.ok, false);
    assert.equal(s.code, 'gateway-not-confirmed');
    assert.match(s.error, /in Settings → Add-ons/);
    assert.equal(fs.existsSync(marker), false, 'the changed program never ran');
  } finally {
    G.removeDefinition('relay');
  }
});

test('sharing a gateway: no provider here sends gateway-no-provider; a key while sharing is off sends gateway-not-shared', async (t) => {
  const gw = await fakeGateway();
  t.after(() => gw.close());
  saveConfig({ server: { passwordHash: await hashPassword('right-password') }, addons: { trouteai: { port: await freePort() } } });
  const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
  const app = createServer({ backend, watch: false, dashboardFile: false, gateway: { addons: [fakeAddon(gw.port)] }, accounts: { gateways: [] } });
  const { port } = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  let r = await call('/api/gateways/trouteai/share', { on: true });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'gateway-no-provider');
  assert.match(r.json.error, /Gateways on your computers/);
  r = await call('/api/gateways/trouteai/keys', { name: 'laptop' });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'gateway-not-shared');
});

test('a gateway its service runs is not stopped by a signal: the answer carries gateway-service (read from the source)', () => {
  // Reaching it needs a service of the computer (systemd, launchd): not made in a test.
  const src = fs.readFileSync(new URL('../../src/addons/localgateway.mjs', import.meta.url), 'utf8');
  assert.match(src, /stop it under Health → Gateways, which stops its service`, code: 'gateway-service' \}/);
  const routes = fs.readFileSync(new URL('../../src/addons/gatewayroutes.mjs', import.meta.url), 'utf8');
  assert.match(routes, /stopped\.code \? \{ details: \{ code: stopped\.code \} \} : \{\}/, 'the remove route passes the code on');
});
