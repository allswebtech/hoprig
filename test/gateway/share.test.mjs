// Sharing a gateway through the dashboard, against a fake gateway that streams: sharing is off until turned on, a key
// is made per computer and kept hashed, the key is swapped for the gateway's own on the way, only Claude's API passes
// (not the gateway's own dashboard), answers stream, wrong keys and busy keys are limited, a removed key stops
// working, and a provider added by address and key works and gives its key up when it is removed. No secret appears
// in any response or log line.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { GW_KEY, fakeAddon, fakeGateway, stream } from './fakegateway.mjs';

const box = sandbox('gateway-share');
test.after(() => box.cleanup());

// Every line the server logs, checked for secrets at the end.
const logged = [];
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k];
  console[k] = (...a) => {
    logged.push(a.join(' '));
    orig(...a);
  };
}

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { readProfile, writeProfile } = await import('../../src/profiles.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { presentedKey, remoteUse, upstreamAuth } = await import('../../src/gateway/index.mjs');

const gw = await fakeGateway();
test.after(() => gw.close());

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
// The Providers list asks whether the gateway add-on answers on its port: a free port, so the answer never depends on
// a gateway running on the computer that runs the tests (its default port is a real one's).
saveConfig({ addons: { trouteai: { port: await (await import('../../src/machines/tunnels.mjs')).freePort() } } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
// The per-key limit is small so a test can reach it, but not smaller than a provider added by address uses by itself:
// its first check (one round, up to 20 requests) runs through its own key while the test reads the provider's state,
// and with a limit of 6 which came first decided whether that state said online or refused.
const PER_KEY = 30;
const app = createServer({ backend, watch: false, dashboardFile: false, gateway: { addons: [fakeAddon(gw.port)], perKeyPerMinute: PER_KEY, failuresPerIp: 12 }, accounts: { gateways: [] } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

const bodies = [];
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
async function call(p, body) {
  const r = await fetch(base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  bodies.push(text);
  return { status: r.status, json: JSON.parse(text || '{}') };
}
const MSG = JSON.stringify({ model: 'combo-best', max_tokens: 1, stream: true, messages: [{ role: 'user', content: 'Hi' }] });
async function viaGateway(path, headers, opts = {}) {
  const r = await stream(`${base}${path}`, { headers, body: MSG, ...opts });
  bodies.push(r.text, JSON.stringify(r.headers));
  return r;
}

let key;
let keyId;

test('the pieces: which key a client sends, which provider file a gateway key may come from, what counts as a remote gateway', () => {
  assert.equal(presentedKey({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(presentedKey({ headers: { 'x-api-key': ' xyz ' } }), 'xyz');
  assert.equal(presentedKey({ headers: {} }), null);
  const api = (env) => ({ kind: 'api', env });
  assert.deepEqual(upstreamAuth(api({ ANTHROPIC_BASE_URL: 'http://localhost:20017', ANTHROPIC_AUTH_TOKEN: 'k1234567' }), 20017), { authorization: 'Bearer k1234567' });
  assert.deepEqual(upstreamAuth(api({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:20017/', ANTHROPIC_API_KEY: 'k1234567' }), 20017), { 'x-api-key': 'k1234567' });
  // Never a subscription's sign-in, never a provider of another address or port.
  assert.equal(upstreamAuth({ kind: 'subscription', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' } }, 20017), null);
  assert.equal(upstreamAuth(api({ ANTHROPIC_BASE_URL: 'http://localhost:20017', ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat01-abcdef' }), 20017), null);
  assert.equal(upstreamAuth(api({ ANTHROPIC_BASE_URL: 'http://localhost:20017', ANTHROPIC_AUTH_TOKEN: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'x' }), 20017), null);
  assert.equal(upstreamAuth(api({ ANTHROPIC_BASE_URL: 'https://api.example.com', ANTHROPIC_AUTH_TOKEN: 'k1234567' }), 20017), null);
  assert.equal(upstreamAuth(api({ ANTHROPIC_BASE_URL: 'http://localhost:20018', ANTHROPIC_AUTH_TOKEN: 'k1234567' }), 20017), null);
  const k = `hop_gw_${'a'.repeat(43)}`;
  assert.deepEqual(remoteUse({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:7433/gateway/m/laptop/trouteai', ANTHROPIC_AUTH_TOKEN: k } }), { kind: 'linked', machine: 'laptop', gateway: 'trouteai' });
  assert.deepEqual(remoteUse({ env: { ANTHROPIC_BASE_URL: 'https://pc.example.net/deck/gateway/trouteai', ANTHROPIC_AUTH_TOKEN: k } }), { kind: 'address', url: 'https://pc.example.net/deck', gateway: 'trouteai' });
  assert.equal(remoteUse({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:7433/gateway/trouteai', ANTHROPIC_AUTH_TOKEN: 'not-a-gateway-key' } }), null);
  assert.equal(remoteUse({ env: { ANTHROPIC_BASE_URL: 'http://localhost:20017', ANTHROPIC_AUTH_TOKEN: k } }), null);
});

test('sharing is off until the owner turns it on, and needs a provider for the gateway here', async () => {
  let r = await call('/api/gateways/all');
  assert.equal(r.status, 200);
  const here = r.json.computers[0];
  assert.equal(here.machine, null);
  assert.deepEqual(here.gateways.map((g) => [g.id, g.running, g.shared, g.ready, g.version]), [['trouteai', true, false, false, '1.0.9']]);
  r = await call('/api/gateways/trouteai/share', { on: true });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /add TRouteAI as a provider/);
  writeProfile('api', { label: 'API via TRouteAI', prerun: 'true', env: { ANTHROPIC_BASE_URL: `http://localhost:${gw.port}`, ANTHROPIC_AUTH_TOKEN: GW_KEY, ANTHROPIC_MODEL: 'combo-best' }, models: '*=combo-best' });
  r = await call('/api/gateways/trouteai/keys', { name: 'laptop' });
  assert.equal(r.status, 409, 'no key while sharing is off');
  assert.match(r.json.error, /turned off/);
  r = await call('/api/gateways/trouteai/share', { on: true });
  assert.equal(r.status, 200);
  assert.equal(r.json.shared, true);
  assert.deepEqual(r.json.provider, { name: 'api', label: 'API via TRouteAI' });
  assert.deepEqual(loadConfig().gateways.shared, { trouteai: { provider: 'api' } });
  // Before a key exists, nothing gets through.
  const none = await viaGateway('/gateway/trouteai/v1/messages', {});
  assert.equal(none.status, 401);
  assert.match(JSON.parse(none.text).error.message, /needs a gateway key/);
});

test('a key per computer, shown once and kept hashed', async () => {
  const r = await call('/api/gateways/trouteai/keys', { name: 'laptop' });
  assert.equal(r.status, 200);
  ({ key, keyId } = r.json);
  assert.match(key, /^hop_gw_[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.path, '/gateway/trouteai');
  assert.equal(r.json.model, 'combo-best');
  const stored = loadConfig().gateways.keys;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, 'laptop');
  assert.equal(JSON.stringify(loadConfig()).includes(key), false, 'only the hash is stored');
  const all = await call('/api/gateways/all');
  assert.deepEqual(all.json.computers[0].gateways[0].keys.map((k) => [k.id, k.name]), [[keyId, 'laptop']]);
  assert.equal(JSON.stringify(all.json).includes(key), false);
});

test('a request with the key reaches the gateway with the gateway\'s own key, streams, and carries nothing else', async () => {
  const before = gw.seen.length;
  const r = await viaGateway('/gateway/trouteai/v1/messages?beta=true', {
    authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
    cookie: 'sid=browser-cookie', origin: 'https://evil.example', 'x-forwarded-for': '1.2.3.4', 'x-claude-code-session-id': '11111111-2222-3333-4444-555555555555',
  });
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers['content-type'], /event-stream/);
  assert.equal(r.headers['anthropic-ratelimit-unified-status'], 'allowed', 'the limit headers Auto mode reads pass back');
  assert.equal(r.headers['set-cookie'], undefined, 'the gateway\'s cookies do not');
  assert.match(r.text, /message_start[\s\S]*"text":"Hi"[\s\S]*message_stop/);
  // Streamed: the first event arrived before the gateway's pause was over.
  assert.ok(r.chunks.length >= 2, 'more than one chunk');
  assert.ok(r.chunks.at(-1).at - r.chunks[0].at >= 200, `chunks ${r.chunks.map((c) => c.at - r.chunks[0].at)}`);
  const got = gw.seen.slice(before);
  assert.equal(got.length, 1);
  const h = got[0].headers;
  assert.equal(got[0].url, '/v1/messages?beta=true');
  assert.equal(h.authorization, `Bearer ${GW_KEY}`, 'swapped for the gateway\'s own key');
  assert.equal(JSON.stringify(h).includes(key), false, 'the gateway key stays on the dashboard');
  for (const k of ['cookie', 'origin', 'x-forwarded-for', 'x-api-key']) assert.equal(h[k], undefined, k);
  assert.equal(h['anthropic-beta'], 'fine-grained-tool-streaming-2025-05-14', 'a sign-in beta never passes');
  assert.equal(h['x-claude-code-session-id'], '11111111-2222-3333-4444-555555555555');
  assert.equal(got[0].body, MSG);
  // The key works as x-api-key too (ANTHROPIC_API_KEY).
  const x = await viaGateway('/gateway/trouteai/v1/models', { 'x-api-key': key }, { method: 'GET', body: '' });
  assert.equal(x.status, 200);
  assert.deepEqual(JSON.parse(x.text).data.map((m) => m.id), ['combo-best', 'haiku-like']);
});

test('only Claude\'s API is shared: the gateway\'s own dashboard and settings are not', async () => {
  const before = gw.seen.length;
  for (const p of ['/gateway/trouteai/', '/gateway/trouteai/dashboard', '/gateway/trouteai/api/keys', '/gateway/trouteai/../v1x']) {
    const r = await viaGateway(p, { authorization: `Bearer ${key}` }, { method: 'GET', body: '' });
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.text, /dashboard: settings/);
  }
  assert.equal(gw.seen.length, before, 'none of them reached the gateway');
  const st = await viaGateway('/gateway/trouteai/__status', { authorization: `Bearer ${key}` }, { method: 'GET', body: '' });
  assert.equal(st.status, 200);
  const j = JSON.parse(st.text);
  assert.equal(j.hoprig, 'gateway');
  assert.equal(j.running, true);
  assert.equal(j.model, 'combo-best');
  const other = await viaGateway('/gateway/nosuch/v1/messages', { authorization: `Bearer ${key}` });
  assert.equal(other.status, 404);
});

test('each key is rate limited', async () => {
  const two = await call('/api/gateways/trouteai/keys', { name: 'busy computer' });
  let last;
  for (let i = 0; i <= PER_KEY; i++) last = await viaGateway('/gateway/trouteai/v1/models', { authorization: `Bearer ${two.json.key}` }, { method: 'GET', body: '' });
  assert.equal(last.status, 429);
  assert.equal(JSON.parse(last.text).error.type, 'rate_limit_error');
  assert.ok(last.headers['retry-after']);
  const three = await call('/api/gateways/trouteai/keys', { name: 'quiet computer' });
  const mine = await viaGateway('/gateway/trouteai/v1/models', { authorization: `Bearer ${three.json.key}` }, { method: 'GET', body: '' });
  assert.equal(mine.status, 200, 'another key is not held up');
  for (const id of [two.json.keyId, three.json.keyId]) assert.equal((await call(`/api/gateways/keys/${id}/remove`, {})).status, 200);
});

test('a provider added by address and key: no PRERUN, its state, then removing it gives the key up', async () => {
  let r = await call('/api/gateways/add', { url: `${base}/gateway/trouteai`, key: 'hop_gw_wrong' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /hop_gw_/);
  r = await call('/api/gateways/add', { url: 'http://127.0.0.1:1/somewhere', key });
  assert.equal(r.status, 400);
  r = await call('/api/gateways/add', { url: `${base}/gateway/trouteai/`, key: `hop_gw_${'b'.repeat(43)}` });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not valid/);
  const k3 = (await call('/api/gateways/trouteai/keys', { name: 'by address' })).json;
  r = await call('/api/gateways/add', { url: `${base}/gateway/trouteai/`, key: k3.key });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p = readProfile(r.json.name);
  assert.match(r.json.name, /^gw-/);
  assert.equal(p.prerun, '', 'the gateway runs on the other computer: nothing is started here');
  assert.equal(p.env.ANTHROPIC_BASE_URL, `${base}/gateway/trouteai`);
  assert.equal(p.env.ANTHROPIC_MODEL, 'combo-best');
  assert.equal(p.models, '*=combo-best');
  const list = await call('/api/accounts');
  const a = list.json.accounts.find((x) => x.name === r.json.name);
  assert.equal(a.remote.state, 'online');
  assert.equal(a.remote.title, 'TRouteAI');
  assert.equal(list.json.accounts.find((x) => x.name === 'api').remote, null);
  assert.ok(loadConfig().gateways.keys.some((k) => k.id === k3.keyId));
  assert.equal((await call(`/api/accounts/${r.json.name}/delete`, {})).status, 200);
  assert.equal(loadConfig().gateways.keys.some((k) => k.id === k3.keyId), false, 'its key was given up on the sharing side');
});

test('a removed key and a sharing that is off stop the requests', async () => {
  let r = await call(`/api/gateways/keys/${keyId}/remove`, {});
  assert.equal(r.status, 200);
  r = await viaGateway('/gateway/trouteai/v1/messages', { authorization: `Bearer ${key}` });
  assert.equal(r.status, 401);
  assert.match(JSON.parse(r.text).error.message, /removed/);
  const k = (await call('/api/gateways/trouteai/keys', { name: 'laptop' })).json.key;
  assert.equal((await call('/api/gateways/trouteai/share', { on: false })).status, 200);
  r = await viaGateway('/gateway/trouteai/v1/messages', { authorization: `Bearer ${k}` });
  assert.equal(r.status, 403);
  assert.match(JSON.parse(r.text).error.message, /turned off/);
  assert.equal((await call('/api/gateways/trouteai/keys', { name: 'x' })).status, 409);
});

test('wrong keys are limited per address', async () => {
  let last;
  for (let i = 0; i < 14; i++) last = await viaGateway('/gateway/trouteai/v1/messages', { authorization: `Bearer hop_gw_${String(i).padStart(43, 'x')}` });
  assert.equal(last.status, 429);
  assert.match(JSON.parse(last.text).error.message, /Too many wrong gateway keys/);
});

test('the pass-through for linked computers takes only a key a provider here holds', async () => {
  const r = await viaGateway('/gateway/m/laptop/trouteai/v1/messages', { authorization: `Bearer hop_gw_${'c'.repeat(43)}` });
  assert.ok(r.status === 401 || r.status === 429, String(r.status));
});

test('no secret in any response or log line', () => {
  const all = bodies.join('\n') + logged.join('\n');
  assert.equal(all.includes(GW_KEY), false, 'the gateway\'s own key never leaves the server');
  assert.equal(/sk-ant-/.test(all), false);
  assert.equal(logged.join('\n').includes('hop_gw_'), false, 'gateway keys are not logged');
});
