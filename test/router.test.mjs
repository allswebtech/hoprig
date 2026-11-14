// The router against stand-in endpoints: which account gets a request, what it is sent, and what Claude Code
// gets back. No real account is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-router-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
delete process.env.HOPRIG_PROFILES_DIR;

// Two stand-in endpoints. `anthropic` plays api.anthropic.com (the stored login and the second subscription),
// `gateway` plays a proxy profile. Each records what it was sent and answers as `script` says.
function endpoint() {
  const seen = [];
  let script = () => ({ status: 200, body: { ok: true } });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      seen.push(entry);
      const a = script(entry);
      res.writeHead(a.status, { 'content-type': 'application/json', ...(a.headers || {}) });
      if (a.chunks) {
        let i = 0;
        const tick = () => (i < a.chunks.length ? (res.write(a.chunks[i++]), setTimeout(tick, 15)) : res.end());
        tick();
      } else res.end(JSON.stringify(a.body ?? {}));
    });
  });
  return { server, seen, set: (fn) => (script = fn), listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))) };
}
const anthropic = endpoint();
const gateway = endpoint();
const aPort = await anthropic.listen();
const gPort = await gateway.listen();
process.env.HOPRIG_ANTHROPIC_URL = `http://127.0.0.1:${aPort}`;

const P = await import('../src/profiles.mjs');
const A = await import('../src/autoswitch.mjs');
const R = await import('../src/router.mjs');
const S = await import('../src/routerstate.mjs');

P.writeProfile('sub', { label: 'Stored login' });
P.writeProfile('sub2', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-second' } });
P.writeProfile('api', { models: 'claude-fable-*=claude-opus-5-5', env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${gPort}/gw/`, ANTHROPIC_AUTH_TOKEN: 'gateway-token' } });
P.writeProfile('key', { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-key' } });
A.setAutoSwitch({ enabled: true, order: ['sub', 'sub2', 'api'] });

const lines = [];
const router = R.createRouter({ key: 'k'.repeat(48), log: (l) => lines.push(l), version: 'test' });
const rPort = await new Promise((r) => router.listen(0, '127.0.0.1', () => r(router.address().port)));
const base = `http://127.0.0.1:${rPort}/${'k'.repeat(48)}`;
test.after(() => {
  router.close(); anthropic.server.close(); gateway.server.close();
  router.closeAllConnections(); anthropic.server.closeAllConnections(); gateway.server.closeAllConnections();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SID = '11111111-1111-4111-8111-111111111111';
const ask = (model = 'claude-fable-5-2', extra = {}) =>
  fetch(`${base}/v1/messages?beta=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', authorization: 'Bearer sk-ant-oat01-login', 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
      'anthropic-version': '2023-06-01', 'x-claude-code-session-id': SID, ...extra,
    },
    body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
  });
const reset = () => { anthropic.seen.length = 0; gateway.seen.length = 0; lines.length = 0; for (const n of ['sub', 'sub2', 'api', 'key']) A.clearLimited(n); };
const limitAnswer = (resetIn = 7200) => ({
  status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + resetIn), 'retry-after': String(resetIn) },
  body: { type: 'error', error: { type: 'rate_limit_error', message: 'limit' } },
});
const usageHeaders = { 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.42', 'anthropic-ratelimit-unified-5h-reset': '1800000000', 'anthropic-ratelimit-unified-7d-utilization': '0.1' };

test('a request goes to the preferred account untouched, and its usage and session are recorded', async () => {
  reset();
  anthropic.set(() => ({ status: 200, headers: usageHeaders, body: { id: 'msg_1', model: 'claude-fable-5-2' } }));
  const r = await ask();
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: 'msg_1', model: 'claude-fable-5-2' });
  assert.equal(anthropic.seen.length, 1);
  const got = anthropic.seen[0];
  assert.equal(got.url, '/v1/messages?beta=true');
  assert.equal(got.headers.authorization, 'Bearer sk-ant-oat01-login', 'the identity account keeps the credentials Claude Code sent');
  assert.equal(got.headers['anthropic-beta'], 'claude-code-20250219,oauth-2025-04-20');
  assert.equal(JSON.parse(got.body).model, 'claude-fable-5-2');
  assert.deepEqual(S.profileUsage().sub, { at: S.profileUsage().sub.at, fiveHour: { pct: 42, resetsAt: 1800000000000 }, week: { pct: 10, resetsAt: null }, status: 'allowed' });
  await new Promise((r2) => setTimeout(r2, 2200)); // the session map is written every two seconds
  assert.equal(S.routerSessions()[SID].profile, 'sub');
  assert.match(lines[0], /11111111 sub:200$/);
});

test('at a limit with an API account next, the same request goes there; Claude Code only sees the good answer', async () => {
  reset();
  A.setAutoSwitch({ order: ['sub', 'api'] });
  anthropic.set(() => limitAnswer());
  gateway.set(() => ({ status: 200, body: { id: 'msg_2', model: 'claude-opus-5.5' } }));
  const r = await ask('claude-fable-5-2');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).id, 'msg_2');
  assert.deepEqual(anthropic.seen.map((e) => e.headers.authorization), ['Bearer sk-ant-oat01-login']);
  const g = gateway.seen[0];
  assert.equal(g.url, '/gw/v1/messages?beta=true');
  assert.equal(g.headers.authorization, 'Bearer gateway-token', 'the gateway gets its own key');
  assert.equal(g.headers['x-api-key'], undefined);
  assert.equal(g.headers['anthropic-beta'], 'claude-code-20250219', 'the OAuth marker is removed');
  assert.equal(JSON.parse(g.body).model, 'claude-opus-5-5', 'and its own model name');
  assert.equal(Number(g.headers['content-length']), Buffer.byteLength(g.body));
  const limited = A.limitedProfiles();
  assert.deepEqual(Object.keys(limited), ['sub']);
  assert.equal(limited.sub.exact, true, 'the end of the limit is the one Anthropic gave');
  assert.match(lines[0], /sub:429 > api:200$/);
  // While sub is at its limit, requests do not even try it; a model the map does not mention is left alone.
  anthropic.seen.length = 0; gateway.seen.length = 0;
  await ask('claude-haiku-5-5');
  assert.deepEqual([anthropic.seen.length, JSON.parse(gateway.seen[0].body).model], [0, 'claude-haiku-5-5']);
  // Once it is free again, requests go back to it by themselves.
  A.clearLimited('sub');
  anthropic.set(() => ({ status: 200, body: {} }));
  await ask();
  assert.deepEqual(anthropic.seen.map((e) => e.headers.authorization), ['Bearer sk-ant-oat01-login']);
  A.setAutoSwitch({ order: ['sub', 'sub2', 'api'] });
});

test('another subscription is never used by the router: Claude Code hears "limit reached" and is restarted as it', async () => {
  reset();
  const everything = () => JSON.stringify([...anthropic.seen, ...gateway.seen].map((e) => [e.headers, e.body]));
  // Order sub → sub2 → api. sub answers "limit reached": sub2 comes before the API account, and only Claude Code
  // itself may use sub2. So the router hands sub's real answer back and stops there.
  anthropic.set(() => limitAnswer());
  gateway.set(() => ({ status: 200, body: { id: 'never' } }));
  let r = await ask();
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('anthropic-ratelimit-unified-status'), 'rejected');
  assert.equal((await r.json()).error.message, 'limit');
  assert.equal(gateway.seen.length, 0, 'the API account is not used while a subscription comes before it');
  assert.ok(!everything().includes('sk-ant-oat01-second'), 'the second subscription\'s token never leaves the router');
  assert.match(lines[0], /sub:429 \(continue as sub2\)$/);
  // Asked again while sub is known to be at its limit: not even tried, and the answer is one Claude Code does not retry.
  anthropic.seen.length = 0;
  r = await fetch(`${base}/as/sub/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer sk-ant-oat01-login' }, body: '{"model":"m","messages":[]}' });
  assert.deepEqual([r.status, r.headers.get('x-should-retry'), anthropic.seen.length], [429, 'false', 0]);
  assert.match((await r.json()).error.message, /continues the session on sub2/);
  // Restarted as sub2, Claude Code sends sub2's own token; it passes through untouched.
  anthropic.set(() => ({ status: 200, body: { id: 'as-sub2' } }));
  r = await fetch(`${base}/as/sub2/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer the-token-claude-code-holds', 'x-claude-code-session-id': SID },
    body: JSON.stringify({ model: 'claude-fable-5-2', messages: [] }),
  });
  assert.equal((await r.json()).id, 'as-sub2');
  assert.equal(anthropic.seen.at(-1).headers.authorization, 'Bearer the-token-claude-code-holds');
  // sub is free again while the session runs as sub2: the session is NOT interrupted (the launcher moves it back
  // between replies); and when sub2 reaches its limit with sub still limited, the API account takes over.
  A.clearLimited('sub');
  anthropic.seen.length = 0;
  r = await fetch(`${base}/as/sub2/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer the-token-claude-code-holds' }, body: '{"model":"m","messages":[]}' });
  assert.deepEqual([r.status, anthropic.seen.length], [200, 1]);
  A.markLimited('sub', { until: Date.now() + 3600_000 });
  anthropic.set(() => limitAnswer());
  r = await fetch(`${base}/as/sub2/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer the-token-claude-code-holds' }, body: '{"model":"m","messages":[]}' });
  assert.equal((await r.json()).id, 'never', 'both subscriptions at their limit: the API account answers');
  assert.ok(!everything().includes('sk-ant-oat01-second'));
});

test('when every account is at its limit Claude Code gets the identity account\'s real limit answer', async () => {
  reset();
  A.setAutoSwitch({ order: ['sub', 'api'] });
  anthropic.set(() => limitAnswer(3600));
  gateway.set(() => ({ status: 429, headers: { 'retry-after': '600' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'gateway limit' } } }));
  const r = await ask();
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('anthropic-ratelimit-unified-status'), 'rejected');
  assert.equal((await r.json()).error.message, 'limit');
  assert.deepEqual(Object.keys(A.limitedProfiles()).sort(), ['api', 'sub']);
  // Asked again while all are limited: the identity account is asked, so the message and reset time are real.
  anthropic.seen.length = 0; gateway.seen.length = 0;
  assert.equal((await ask()).status, 429);
  assert.deepEqual([anthropic.seen.length, gateway.seen.length], [1, 0]);
  A.setAutoSwitch({ order: ['sub', 'sub2', 'api'] });
});

test('other failures: a bad request is Claude Code\'s to see; an overloaded or refused account is skipped', async () => {
  reset();
  A.setAutoSwitch({ order: ['sub', 'api'] });
  anthropic.set(() => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } } }));
  let r = await ask();
  assert.equal(r.status, 400);
  assert.deepEqual([anthropic.seen.length, gateway.seen.length], [1, 0], 'a 400 is not retried elsewhere');
  reset();
  anthropic.set(() => ({ status: 529, body: {} }));
  gateway.set(() => ({ status: 200, body: { id: 'ok' } }));
  r = await ask();
  assert.equal((await r.json()).id, 'ok');
  assert.deepEqual(A.limitedProfiles(), {}, 'overloaded is not a limit');
  reset();
  anthropic.set(() => ({ status: 401, body: {} }));
  r = await ask();
  assert.equal((await r.json()).id, 'ok');
  assert.equal(A.limitedProfiles().sub.reason, 'auth', 'a refused login is set aside for a while');
  A.setAutoSwitch({ order: ['sub', 'sub2', 'api'] });
});

test('a streamed answer arrives chunk by chunk; other paths pass through to the identity account; a wrong key is refused', async () => {
  reset();
  const chunks = ['event: a\ndata: 1\n\n', 'event: b\ndata: 2\n\n', 'event: c\ndata: 3\n\n'];
  anthropic.set(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, chunks }));
  const r = await ask();
  const got = [];
  const dec = new TextDecoder();
  for await (const c of r.body) got.push(dec.decode(c));
  assert.equal(got.join(''), chunks.join(''));
  assert.ok(got.length >= 2, 'not buffered into one piece');
  anthropic.set(() => ({ status: 200, body: { hello: true } }));
  anthropic.seen.length = 0;
  const hello = await fetch(`${base}/api/hello`, { method: 'HEAD' });
  assert.equal(hello.status, 200);
  assert.deepEqual([anthropic.seen[0].method, anthropic.seen[0].url], ['HEAD', '/api/hello']);
  assert.equal((await fetch(`http://127.0.0.1:${rPort}/wrong-key/v1/messages`, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/__router`).then((x) => x.json())).version, 'test');
});

test('pure parts: identity, what to do with a request, model map, the request built for each kind of account, the verdicts', () => {
  const profiles = P.listProfiles();
  const by = (n) => profiles.find((p) => p.name === n);
  // The identity: the first subscription of the order that is not at its limit.
  assert.equal(R.autoIdentity(['api', 'sub2', 'sub'], profiles).name, 'sub2');
  assert.equal(R.autoIdentity(['sub', 'sub2', 'api'], profiles, { sub: {} }).name, 'sub2');
  assert.equal(R.autoIdentity(['sub', 'sub2', 'api'], profiles, { sub: {}, sub2: {} }).name, 'sub', 'all limited: the first one, whose limit message is then shown');
  assert.equal(R.autoIdentity(['sub', 'sub2'], profiles, {}, ['sub']).name, 'sub2', 'an expired login is passed over');
  assert.equal(R.autoIdentity(['api', 'key'], profiles).name, 'api');
  assert.equal(R.autoIdentity([], profiles), null);
  // What to do with a request.
  const order = ['sub', 'sub2', 'api'];
  const plan = (id, limited, tried = []) => { const c = R.pick(order, profiles, by(id), limited, new Set(tried)); return [c.next ? c.next.name : null, c.handoff]; };
  assert.deepEqual(plan('sub', {}), ['sub', null]);
  assert.deepEqual(plan('sub', { sub: {} }), [null, 'sub2'], 'a free subscription comes before the API account: restart as it');
  assert.deepEqual(plan('sub', { sub: {}, sub2: {} }), ['api', null]);
  assert.deepEqual(plan('sub', { sub: {}, sub2: {}, api: {} }), [null, null]);
  assert.deepEqual(plan('sub2', { sub: {} }), ['sub2', null]);
  assert.deepEqual(plan('sub2', {}), ['sub2', null], 'never interrupted because a more preferred subscription is free');
  assert.deepEqual(plan('sub2', { sub: {} }, ['sub2']), ['api', null]);
  assert.deepEqual(R.pick(['sub', 'api', 'sub2'], profiles, by('sub'), { sub: {} }).next.name, 'api', 'the API account comes first in this order');
  assert.equal(R.mapModel('claude-fable-5-2', { models: 'x=y, claude-fable-*=claude-opus-5-5,*=z' }), 'claude-opus-5-5');
  assert.equal(R.mapModel('claude-fable-5-2', { models: '' }), 'claude-fable-5-2');
  const sent = { rest: '/v1/messages', headers: { authorization: 'Bearer client', 'x-api-key': 'client-key', 'anthropic-beta': 'a', 'content-type': 'application/json', connection: 'keep-alive', host: 'x' }, body: Buffer.from('{"model":"m"}') };
  const key = R.upstreamRequest(by('key'), { ...sent, isIdentity: false });
  assert.deepEqual([key.headers['x-api-key'], key.headers.authorization, key.headers.host, key.headers.connection], ['sk-ant-api03-key', undefined, undefined, undefined]);
  assert.equal(R.upstreamRequest(by('sub2'), { ...sent, isIdentity: false }), null, 'a subscription token is never attached by the router');
  assert.equal(R.upstreamRequest(by('sub'), { ...sent, isIdentity: false }), null);
  assert.equal(R.upstreamRequest(by('sub2'), { ...sent, isIdentity: true }).headers.authorization, 'Bearer client', 'as the identity, what Claude Code sent passes through');
  const now = 1_800_000_000_000;
  assert.deepEqual(R.judge(429, { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(now / 1000 + 60) }, now), { next: true, mark: { until: now + 60_000, reason: 'rate_limit' } });
  assert.deepEqual(R.judge(429, { 'retry-after': '3' }, now), { next: true, mark: null });
  assert.deepEqual(R.judge(429, { 'retry-after': '120' }, now), { next: true, mark: { until: now + 120_000, reason: 'rate_limit' } });
  assert.deepEqual(R.judge(200, {}, now), { next: false, mark: null });
  assert.deepEqual(R.judge(400, {}, now), { next: false, mark: null });
  assert.equal(R.judge(402, {}, now).mark.reason, 'billing_error');
});
