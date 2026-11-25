// A browser sends a host name's cookies to every port of it, so a gateway's page link takes a loopback name the owner
// is not signed in under. GET /api/addons and GET /api/accounts say which names those are, and the Add-ons and
// Providers pages hand them to the link (web/gateways.js gatewayPageLink).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('gatewaypage-signedin');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
const app = createServer({ backend, watch: false, dashboardFile: false, addons: { addons: [] }, accounts: { gateways: [] } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const get = async (p) => {
  const r = await fetch(base + p, { headers: { Origin: base, Cookie: cookie } });
  assert.equal(r.status, 200, p);
  return r.json();
};

test('the add-ons and providers answers name the loopback names the owner is signed in under', async () => {
  for (const p of ['/api/addons', '/api/accounts']) assert.deepEqual((await get(p)).signedIn, ['127.0.0.1'], p);
});

test('the Add-ons and Providers pages hand those names to the gateway page link', () => {
  const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
  assert.match(read('addons.js'), /signedIn = Array\.isArray\(r\.signedIn\) \? r\.signedIn : \[\]/);
  assert.match(read('addons.js'), /gatewayPageLink\(pageOf\(a\), \{[^}]*signedIn[,\s]/);
  assert.match(read('accounts.js'), /signedIn = Array\.isArray\(d\.signedIn\) \? d\.signedIn : \[\]/);
  assert.match(read('accounts.js'), /gatewayPageLink\(g\.page, \{[^}]*signedIn[,\s]/);
});
