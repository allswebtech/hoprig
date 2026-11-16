// A gateway key made with a hub's machine token ends with that token. It records only the token's id; when the token
// is revoked by any path (the page, self-revoke, `hoprig tokens revoke`, Remove on the hub) the key stops working at
// once, on /gateway/<id>/… and on the linked path. A key the owner made with the login is never tied to a token.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPO } from '../machines/harness.mjs';
import { sandbox } from '../server/helpers.mjs';
import { GW_KEY, fakeAddon, fakeGateway, stream } from './fakegateway.mjs';

const box = sandbox('gateway-tokenkeys');
test.after(() => box.cleanup());

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { putMachine } = await import('../../src/machines/store.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const gw = await fakeGateway({ pauseMs: 0 });
test.after(() => gw.close());

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
writeProfile('api', { label: 'API via TRouteAI', env: { ANTHROPIC_BASE_URL: `http://localhost:${gw.port}`, ANTHROPIC_AUTH_TOKEN: GW_KEY } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
const app = createServer({ backend, watch: false, dashboardFile: false, gateway: { addons: [fakeAddon(gw.port)] }, accounts: { trouteai: null } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const owner = async (p, body) => {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
/** What a linked hub does: a request with its machine token, no cookie, no Origin. */
const asHub = async (token, p, body = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const models = async (p, key) => (await stream(`${base}${p}`, { method: 'GET', headers: { authorization: `Bearer ${key}` } })).status;
const direct = (key) => models('/gateway/trouteai/v1/models', key);

test('keys made with a machine token end with it, by every way of revoking; the owner\'s key stays', async () => {
  assert.equal((await owner('/api/gateways/trouteai/share', { on: true })).status, 200);
  const mine = (await owner('/api/gateways/trouteai/keys', { name: 'by address' })).json;

  // Five hubs, one token each; each makes a key with its own token.
  const tokens = ['hub page', 'hub self', 'hub cli', 'hub removed', 'hub kept'].map((n) => ({ name: n, ...createToken(n) }));
  for (const t of tokens) {
    const r = await asHub(t.token, '/api/gateways/trouteai/keys', { name: t.name });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    t.key = r.json.key;
    t.keyId = r.json.keyId;
  }
  const stored = loadConfig().gateways.keys;
  assert.equal(stored.find((k) => k.id === mine.keyId).token, undefined, 'the owner\'s key is not tied to a token');
  for (const t of tokens) assert.equal(stored.find((k) => k.id === t.keyId).token, t.id, 'the token\'s id is recorded');
  for (const t of tokens) assert.equal(JSON.stringify(loadConfig()).includes(t.token), false, 'never the token itself');
  const listed = (await owner('/api/gateways/all')).json.computers[0].gateways[0].keys;
  assert.equal(listed.find((k) => k.id === mine.keyId).linked, false);
  assert.ok(tokens.every((t) => listed.find((k) => k.id === t.keyId).linked === true), 'the page can say which keys belong to a linked computer');
  for (const t of [{ key: mine.key }, ...tokens]) assert.equal(await direct(t.key), 200);
  // Each key a token made is in this computer's Activity log under the token's name; the owner's is not.
  const hubLines = fs.readFileSync(path.join(box.state, 'automation.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.automation === 'hub').map((e) => e.did);
  assert.deepEqual(hubLines, tokens.map((t) => `The hub ${t.name} made a key for the gateway trouteai`));
  for (const t of tokens) assert.equal(JSON.stringify(hubLines).includes(t.key), false, 'never the key');

  // The linked path: this dashboard linked to itself by address, with a provider that holds the first hub's key.
  putMachine({ name: 'self', label: 'Self', via: 'url', url: base, token: 'unused-machine-token', added: Date.now() });
  writeProfile('gw-self', { label: 'TRouteAI on Self', env: { ANTHROPIC_BASE_URL: `${base}/gateway/m/self/trouteai`, ANTHROPIC_AUTH_TOKEN: tokens[0].key } });
  assert.equal(await models('/gateway/m/self/trouteai/v1/models', tokens[0].key), 200);

  // 1. The page's revoke ("Who may control this computer").
  const [page, self, cli, removed, kept] = tokens;
  assert.equal((await owner(`/api/tokens/${page.id}/revoke`, {})).status, 200);
  assert.equal(await direct(page.key), 401);
  assert.equal(await models('/gateway/m/self/trouteai/v1/models', page.key), 401, 'the linked path stops too');

  // 2. The token gives itself up.
  assert.equal((await asHub(self.token, '/api/tokens/self/revoke')).status, 200);
  assert.equal(await direct(self.key), 401);

  // 3. `hoprig tokens revoke <id>` on this computer.
  execFileSync(process.execPath, [path.join(REPO, 'bin', 'hoprig.mjs'), 'tokens', 'revoke', cli.id], { env: process.env, encoding: 'utf8' });
  assert.equal(await direct(cli.key), 401);

  // 4. Remove on the hub: the hub asks this computer to revoke its token (here the hub is this dashboard itself).
  putMachine({ name: 'hubself', label: 'Hub', via: 'url', url: base, token: removed.token, added: Date.now() });
  const r = await owner('/api/machines/hubself/remove', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.revoked, true);
  assert.equal(await direct(removed.key), 401);

  // What stays: the owner's key, and the key of a token that was not revoked.
  assert.equal(await direct(mine.key), 200);
  assert.equal(await direct(kept.key), 200);
  assert.deepEqual(loadConfig().gateways.keys.map((k) => k.id).sort(), [mine.keyId, kept.keyId].sort(), 'the revoked tokens\' keys are gone from the config');
});
