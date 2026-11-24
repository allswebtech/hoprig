// GET /api/models and POST /api/models/check on a real test dashboard, against stand-in endpoints: a gateway that
// lists five, an API endpoint that lists forty, one that lists none, one that is down, and a subscription. What the
// page gets holds names only; an endpoint is asked only when a picker asks, at most once in ten minutes; the start
// of a session and a chat checks a model against the provider's list, and a saved value keeps working.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

/** A stand-in endpoint: GET /v1/models answers `list`; every request is counted. */
async function standIn(list) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || req.headers['x-api-key'] || '' });
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: list }));
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
const models = (n, p) => Array.from({ length: n }, (_, i) => ({ id: `${p}-${i + 1}`, display_name: `${p} ${i + 1}` }));

test('the pickers\' route: each kind of provider, names only, asked only when a picker asks', { timeout: 60_000 }, async (t) => {
  const box = sandbox('models');
  const relay = await standIn([{ id: 'relay-main-2', display_name: 'Relay Main 2', capabilities: { context_window: 1_000_000 } }, ...models(4, 'relay')]);
  const forty = await standIn(models(40, 'claude-x'));
  const none = await standIn([]);
  const down = await standIn([]);
  await down.close(); // nothing answers at its address any more
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const KEYS = { relay: 'relay-secret-key-0001', forty: 'forty-secret-key-0002', none: 'none-secret-key-0003', down: 'down-secret-key-0004', team: 'sk-ant-oat-team-secret-0005' };
  writeProfile('relay', { label: 'Relay', models: 'claude-fable-*=relay-big-1', env: { ANTHROPIC_BASE_URL: relay.url, ANTHROPIC_AUTH_TOKEN: KEYS.relay } });
  writeProfile('forty', { label: 'Forty', env: { ANTHROPIC_BASE_URL: forty.url, ANTHROPIC_API_KEY: KEYS.forty } });
  writeProfile('none', { label: 'None', env: { ANTHROPIC_BASE_URL: none.url, ANTHROPIC_API_KEY: KEYS.none } });
  writeProfile('down', { label: 'Down', env: { ANTHROPIC_BASE_URL: down.url, ANTHROPIC_API_KEY: KEYS.down } });
  writeProfile('team', { label: 'Team', env: { CLAUDE_CODE_OAUTH_TOKEN: KEYS.team } });
  saveConfig({ usage: false, sessionDefaults: { model: 'relay-gone-9' }, server: { backend: 'pty', roots: [box.root], passwordHash: await hashPassword('test-password-1') } });
  const app = createServer({ watch: false, automation: { tick: false }, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close().catch(() => {});
    await Promise.all([relay.close(), forty.close(), none.close()]);
    box.cleanup();
  });
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const all = [];
  const call = async (p, body) => {
    const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { Origin: base, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    all.push(text);
    return { status: r.status, json: JSON.parse(text) };
  };
  const asked = () => [relay, forty, none].map((s) => s.seen.length);

  // A dashboard start and the page's usual loads ask no endpoint.
  await call('/api/state');
  await call('/api/settings');
  assert.deepEqual(asked(), [0, 0, 0], 'nobody is asked before a picker opens');

  const r = (await call('/api/models?provider=relay&tool=claude')).json;
  assert.equal(r.source, 'endpoint');
  assert.deepEqual(r.models.map((m) => m.id), ['relay-main-2', 'relay-1', 'relay-2', 'relay-3', 'relay-4', 'relay-big-1']);
  assert.equal(r.models[0].window1m, true);
  assert.equal(relay.seen[0].auth, `Bearer ${KEYS.relay}`, 'the server asks with the profile\'s own key');
  assert.equal((await call('/api/models?provider=forty')).json.models.length, 40);
  const n = (await call('/api/models?provider=none')).json;
  assert.equal(n.source, 'fallback');
  assert.match(n.why, /This provider lists no models/);
  assert.equal(n.typed, true);
  const d = (await call('/api/models?provider=down')).json;
  assert.equal(d.source, 'fallback');
  assert.match(d.why, /the provider's address does not answer/);
  assert.deepEqual(d.models.map((m) => m.id), ['opus', 'sonnet', 'haiku']);
  const s = (await call('/api/models?provider=team')).json;
  assert.equal(s.source, 'subscription');
  assert.ok(s.models.length > 3 && s.models.some((m) => m.id === 'opus[1m]'));

  // Ten minutes kept: a picker opened again asks nobody.
  await call('/api/models?provider=relay');
  await call('/api/models?provider=forty');
  assert.deepEqual(asked(), [1, 1, 1]);

  // The fallback's field: a typed name is checked; a name the provider's own list leaves out is refused plainly.
  assert.deepEqual((await call('/api/models/check', { provider: 'down', model: 'claude-exact-1' })).json, { ok: true, why: null });
  assert.match((await call('/api/models/check', { provider: 'down', model: 'bad name' })).json.why, /not a model name/);
  assert.match((await call('/api/models/check', { provider: 'relay', model: 'relay-99' })).json.why, /does not serve "relay-99"/);
  // The picker's saved value: marked only where the check would refuse it (a family name works on every provider).
  assert.deepEqual((await call('/api/models?provider=relay&saved=relay-gone-9')).json.notListed, ['relay-gone-9']);
  assert.deepEqual((await call('/api/models?provider=relay&saved=opus')).json.notListed, []);
  assert.deepEqual((await call('/api/models?provider=team&saved=claude-opus-4-1')).json.notListed, []);
  assert.deepEqual((await call('/api/models?provider=down&saved=claude-exact-1')).json.notListed, [], 'no list: nothing is left out');
  assert.deepEqual((await call('/api/models?provider=relay&saved=bad%20name')).json.notListed, []);
  assert.equal((await call('/api/models?provider=nobody')).status, 400);
  assert.equal((await call('/api/models?provider=..%2Fetc')).status, 400);

  // A terminal session's start checks the model against the provider's list (no session starts for a refusal).
  const work = path.join(box.root, 'work');
  fs.mkdirSync(work);
  const refused = await call('/api/sessions', { dir: work, profile: 'relay', mode: 'new', model: 'relay-99' });
  assert.equal(refused.status, 400);
  assert.match(refused.json.error, /does not serve "relay-99"/);

  // No key, no address of an endpoint, in anything the page got.
  const got = all.join('\n');
  for (const k of Object.values(KEYS)) assert.ok(!got.includes(k), 'no key reaches the page');
  for (const u of [relay.url, forty.url, none.url, down.url]) assert.ok(!got.includes(u), 'no endpoint address reaches the page');
  assert.deepEqual(asked(), [1, 1, 1], 'the start\'s check asked nobody');
});

test('GET /api/models/lead on a subscription: the one line under "Lead model", names only, nothing to ask', async (t) => {
  const { modelsFeature } = await import('../../src/models/feature.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  writeProfile('teamlead', { label: 'Team', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
  class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
  const f = modelsFeature({ HttpError, readJson: async () => ({}) }, { fetchImpl: async () => assert.fail('asks nobody') });
  const [, , route] = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/models/lead'));
  const r = await route({}, null, new URLSearchParams('provider=teamlead&tool=claude'));
  assert.deepEqual(r, { can: true, line: 'Fast, running and recording: haiku\nStrong, writing and reviewing code: sonnet\nStrongest, hard thinking: opus' });
  await assert.rejects(route({}, null, new URLSearchParams('provider=nobody&tool=claude')), /no provider/);
});

test('GET /api/models/others: the providers that can be ticked, never the session\'s own, no key or address', async () => {
  const { modelsFeature } = await import('../../src/models/feature.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  writeProfile('own1', { label: 'Own', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
  writeProfile('other1', { label: 'Other', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8243', ANTHROPIC_AUTH_TOKEN: 'sk-other-test-0123456789' } });
  class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
  const f = modelsFeature({ HttpError, readJson: async () => ({}) });
  const [, , route] = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/models/others'));
  const r = await route({}, null, new URLSearchParams('provider=own1'));
  assert.ok(r.providers.some((p) => p.name === 'other1'));
  assert.ok(!r.providers.some((p) => p.name === 'own1'));
  assert.ok(!/sk-|127\.0\.0\.1/.test(JSON.stringify(r)));
});

test('GET /api/models/lead on a gateway never asked yet: it waits for the list the picker asks, never says "no such model" early', async () => {
  const { modelsFeature } = await import('../../src/models/feature.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { forgetModels } = await import('../../src/models/catalog.mjs');
  const { NOT_KNOWN } = await import('../../src/models/lead.mjs');
  forgetModels();
  writeProfile('gwlead', { label: 'Gw', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8247', ANTHROPIC_AUTH_TOKEN: 'sk-gw-test-0123456789' } });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return new Response(JSON.stringify({ data: [{ id: 'gw-haiku-1' }, { id: 'gw-sonnet-2' }, { id: 'gw-opus-3' }] }));
  };
  class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
  const f = modelsFeature({ HttpError, readJson: async () => ({}) }, { fetchImpl });
  const route = (re) => f.routes.find(([m, r]) => m === 'GET' && r.test(re))[2];
  const q = new URLSearchParams('provider=gwlead&tool=claude');
  // The picker and the switch are drawn at the same moment: one ask, and the line names the gateway's own models.
  const [, line] = await Promise.all([route('/api/models')({}, null, q), route('/api/models/lead')({}, null, q)]);
  assert.equal(calls, 1, 'one shared ask');
  assert.match(line.line, /gw-haiku-1.*gw-sonnet-2.*gw-opus-3/s);
  // A list that cannot be had: the reason it was not had, and that Lead will not split the work, never "not known yet"
  // nor "no such model".
  forgetModels();
  const down = modelsFeature({ HttpError, readJson: async () => ({}) }, { fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  const r = await down.routes.find(([m, re]) => m === 'GET' && re.test('/api/models/lead'))[2]({}, null, q);
  assert.deepEqual(r, { can: false, line: 'Could not get this provider\'s model list: the provider\'s address does not answer. Lead model will not split the work on this provider.' });
  // An address that can never be asked: its reason, never "not known yet".
  writeProfile('gwpw', { label: 'Gateway with a password', env: { ANTHROPIC_BASE_URL: 'http://user:pw@127.0.0.1:8245', ANTHROPIC_AUTH_TOKEN: 'sk-gwpw-test-0123456789' } });
  const pw = await down.routes.find(([m, re]) => m === 'GET' && re.test('/api/models/lead'))[2]({}, null, new URLSearchParams('provider=gwpw&tool=claude'));
  assert.equal(pw.can, false);
  assert.match(pw.line, /address holds a name and password.*will not split the work/);
  assert.ok(!pw.line.includes('pw@') && pw.line !== NOT_KNOWN);
});
