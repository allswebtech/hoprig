// The hub's relay: what it passes, what it refuses and who decides. The caller is given by the test the way the link gives
// it (never from the request), the upstream is a stand-in, every key is made up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { call, machineEntry, madeUpKey, upstream, until } from './helpers.mjs';

const box = sandbox('hubprov-relay');
const { writeProfile } = await import('../../src/profiles.mjs');
const { putMachine } = await import('../../src/machines/store.mjs');
const { setKept, setSharing, buildList } = await import('../../src/hubprov/list.mjs');
const { createRelay } = await import('../../src/hubprov/relay.mjs');
const { limitedProfiles } = await import('../../src/autoswitch.mjs');

const KEY = madeUpKey('apikey');
const GWKEY = madeUpKey('gwkey');
const up = await upstream();
const gw = await upstream();
writeProfile('mykey', { label: 'My key', env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${up.port}` } });
writeProfile('mygw', { label: 'My gateway', env: { ANTHROPIC_AUTH_TOKEN: GWKEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${gw.port}` } });
writeProfile('myoai', { label: 'My OpenAI', env: { OPENAI_API_KEY: madeUpKey('oai'), OPENAI_BASE_URL: `http://127.0.0.1:${up.port}/v1` } });
writeProfile('mysub', { label: 'Setup token', env: { CLAUDE_CODE_OAUTH_TOKEN: madeUpKey('oat') } });
putMachine(machineEntry('bee'));
putMachine(machineEntry('cee'));
putMachine(machineEntry('dee', { own: false }));

let who = 'bee';
const relay = createRelay();
const server = http.createServer((req, res) => relay.handle(req, res, who ? { machine: who } : null));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = (path, o = {}) => call(base, path, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: '{"model":"m","messages":[]}', ...o });
test.after(async () => {
  server.close();
  await up.close();
  await gw.close();
  box.cleanup();
});

test('an API-key provider: the hub adds its key, the answer comes back, and no key is in the answer', async () => {
  who = 'bee';
  const r = await post('/hubp/mykey/v1/messages');
  assert.equal(r.status, 200);
  assert.match(r.body, /"hi"/);
  const seen = up.seen.at(-1);
  assert.equal(seen.headers['x-api-key'], KEY);
  assert.equal(seen.path, '/v1/messages');
  assert.equal(seen.body, '{"model":"m","messages":[]}', 'the body is passed on unchanged');
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('a gateway provider: the hub adds the gateway key as a bearer token; the caller never sends one', async () => {
  const r = await post('/hubp/mygw/v1/messages', { headers: { authorization: 'Bearer hop_hl_whatever', 'content-type': 'application/json' } });
  assert.equal(r.status, 200);
  assert.equal(gw.seen.at(-1).headers.authorization, `Bearer ${GWKEY}`);
  assert.ok(!JSON.stringify(gw.seen.at(-1).headers).includes('hop_hl_'), 'the caller\'s own key stays on its computer');
});

test('an OpenAI-kind key passes only its own API paths, and a base that ends in /v1 is not given /v1 twice', async () => {
  const ok = await post('/hubp/myoai/v1/responses');
  assert.equal(ok.status, 200);
  assert.equal(up.seen.at(-1).path, '/v1/responses');
  const wrong = await post('/hubp/myoai/v1/messages');
  assert.equal(wrong.status, 404, 'Claude\'s path is not an OpenAI key\'s path');
  const anth = await post('/hubp/mykey/v1/responses');
  assert.equal(anth.status, 404, 'OpenAI\'s path is not a Claude key\'s path');
});

test('only the API paths of the kind pass: not a gateway page, not a setting, not a wrong method', async () => {
  for (const p of ['/hubp/mygw/v1/organizations', '/hubp/mygw/admin', '/hubp/mygw/v1/messages/batches', '/hubp/mygw/', '/hubp/mygw/v2/messages']) {
    assert.equal((await post(p)).status, 404, p);
  }
  assert.equal((await call(base, '/hubp/mykey/v1/messages')).status, 404, 'a GET of /v1/messages');
  assert.equal((await post('/hubp/mykey/v1/models')).status, 404, 'a POST of /v1/models');
  assert.equal((await call(base, '/hubp/mykey/v1/models')).status, 200);
  assert.equal((await post('/hubp/mykey/v1/messages/count_tokens')).status, 200);
});

test('unsafe paths are 404 before anything else (encoded slashes, dots, backslashes)', async () => {
  const before = up.seen.length;
  for (const p of ['/hubp/mykey/v1/..%2fadmin', '/hubp/mykey/v1/%2e%2e/x', '/hubp/mykey/v1/messages%2f..%2fsettings', '/hubp/mykey/v1/a%5cb', '/hubp/mykey/v1/%252e%252e/x']) {
    assert.equal((await post(p)).status, 404, p);
  }
  assert.equal(up.seen.length, before, 'nothing reached the upstream');
});

test('the hub decides: a computer that is not his own, an unknown one and no caller get nothing', async () => {
  const before = up.seen.length;
  who = 'dee';
  assert.equal((await post('/hubp/mykey/v1/messages')).status, 403);
  assert.equal((await call(base, '/hubp/list')).status, 403);
  who = 'nobody';
  assert.equal((await post('/hubp/mykey/v1/messages')).status, 403);
  who = null;
  assert.equal((await post('/hubp/mykey/v1/messages')).status, 404);
  who = 'bee';
  assert.equal(up.seen.length, before);
});

test('the switch off and Keep to this computer are the hub\'s decision, and read each time', async () => {
  who = 'bee';
  setKept('mykey', true);
  const kept = await post('/hubp/mykey/v1/messages');
  assert.equal(kept.status, 403);
  assert.match(kept.body, /keeps this provider to itself/);
  assert.ok(!buildList().providers.some((p) => p.name === 'mykey'), 'a kept provider is not in the list');
  setKept('mykey', false);
  assert.equal((await post('/hubp/mykey/v1/messages')).status, 200);
  setSharing(false);
  const off = await post('/hubp/mykey/v1/messages');
  assert.equal(off.status, 403);
  assert.match(off.body, /no longer shares its providers with this computer/);
  assert.equal((await call(base, '/hubp/list')).status, 403);
  setSharing(true);
  assert.equal((await post('/hubp/mykey/v1/messages')).status, 200);
});

test('a setup token written as a bearer token is no key: not in the list, not relayed', async () => {
  const oat = ['sk-ant', 'oat01', madeUpKey('x')].join('-');
  writeProfile('mytok', { label: 'Token as key', env: { ANTHROPIC_AUTH_TOKEN: oat, ANTHROPIC_BASE_URL: `http://127.0.0.1:${up.port}` } });
  const list = (await call(base, '/hubp/list')).body;
  assert.ok(!list.includes('mytok') && !list.includes(oat));
  assert.equal((await post('/hubp/mytok/v1/messages')).status, 404);
});

test('a subscription (a setup token) is never relayed: one row to sign in on, and its path is 404', async () => {
  const list = JSON.parse((await call(base, '/hubp/list')).body);
  const sub = list.providers.filter((p) => p.signin);
  assert.equal(sub.length, 1);
  assert.equal(sub[0].kind, 'subscription');
  assert.equal((await post('/hubp/mysub/v1/messages')).status, 404);
  assert.equal((await post('/hubp/subscription/v1/messages')).status, 404);
});

test('the list holds names, kinds, models and limit marks, and no key, token or address', async () => {
  const r = await call(base, '/hubp/list');
  assert.equal(r.status, 200);
  for (const secret of [KEY, GWKEY, '127.0.0.1', 'sk-', 'http://', 'oat-']) assert.ok(!r.body.includes(secret), `the list holds ${secret}`);
  const list = JSON.parse(r.body);
  assert.deepEqual(list.providers.map((p) => p.name).sort(), ['mygw', 'mykey', 'myoai', 'subscription']);
});

test('a 429 answer is kept on the hub as the provider\'s limit mark and shows in the list', async () => {
  const lim = await upstream({ status: 429, headers: { 'retry-after': '600' } });
  writeProfile('mylimit', { label: 'Limited', env: { ANTHROPIC_API_KEY: madeUpKey('lim'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${lim.port}` } });
  const r = await post('/hubp/mylimit/v1/messages');
  assert.equal(r.status, 429, 'the answer goes back as it is');
  assert.ok(limitedProfiles().mylimit, 'the hub marked it');
  const row = JSON.parse((await call(base, '/hubp/list')).body).providers.find((p) => p.name === 'mylimit');
  assert.ok(row.limited && row.limited.until > Date.now());
  await lim.close();
});

test('each computer gets 300 requests a minute, counted per computer', async () => {
  const r2 = createRelay(); // the default: 300 a minute
  const s2 = http.createServer((req, res) => r2.handle(req, res, { machine: req.headers['x-m'] }));
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const hit = (m) => call(b2, '/hubp/mykey/v1/models', { headers: { 'x-m': m } });
  for (let i = 0; i < 300; i++) assert.equal((await hit('bee')).status, 200, `request ${i + 1}`);
  const over = await hit('bee');
  assert.equal(over.status, 429);
  assert.equal(over.headers['retry-after'], '20');
  assert.equal((await hit('cee')).status, 200, 'another computer has its own count');
  assert.equal(r2.usage().bee.requests, 300);
  assert.equal(r2.usage().cee.requests, 1);
  s2.close();
});

test('the upstream is down: the answer says so in plain words and holds no key', async () => {
  writeProfile('mydead', { label: 'Dead', env: { ANTHROPIC_API_KEY: madeUpKey('dead'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } });
  const r = await post('/hubp/mydead/v1/messages');
  assert.equal(r.status, 502);
  assert.match(r.body, /not running|cannot be reached/);
});

test('the connection is reset in the middle of a stream: the upstream request ends within a second', async () => {
  const s = await upstream();
  // The stand-in streams on /v1/stream*: reach it through an allowed path by a profile base that holds the prefix.
  writeProfile('mystream2', { label: 'Stream', env: { ANTHROPIC_API_KEY: madeUpKey('str'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${s.port}/v1/stream/x/y` } });
  const sock = http.request(`${base}/hubp/mystream2/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, agent: false });
  const got = await new Promise((resolve) => {
    sock.on('response', (res) => {
      res.once('data', () => resolve(res));
    });
    sock.on('error', () => {});
    sock.end('{}');
  });
  const e = await until('the upstream request', () => s.seen.find((x) => x.path.startsWith('/v1/stream')));
  const t0 = Date.now();
  got.destroy(); // the stream is reset
  sock.destroy();
  await until('the upstream request to end', () => e.closed, 1500);
  assert.ok(e.closedAt - t0 < 1000, `ended after ${e.closedAt - t0} ms`);
  await s.close();
});
