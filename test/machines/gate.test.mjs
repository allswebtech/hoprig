// The bearer rules on the machine being controlled, over real HTTP with the mini dashboard (wired exactly as the
// server.mjs integration patch): a valid token needs no cookie and no Origin, reaches /api/* and /ws/term, and
// never pairing, tokens, machines, relay, password, login or logout. Plus pairing by code over HTTP.
import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { sandbox } from '../server/helpers.mjs';
import { asBrowser, miniDashboard } from './harness.mjs';

const box = sandbox('machines-gate');
const { createMachines } = await import('../../src/machines/index.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { createCode } = await import('../../src/machines/pairing.mjs');
const { RateLimiter } = await import('../../src/server/auth.mjs');

const dash = await miniDashboard({ createMachines, opts: { claudeVersion: async () => '9.9.9', pairLimiter: new RateLimiter({ perIp: 3 }) } }).listen();
test.after(async () => {
  await dash.close();
  box.cleanup();
});

const { token, id } = createToken('hub');
const withToken = (p, { method = 'GET', body, auth = `Bearer ${token}` } = {}) =>
  fetch(dash.base + p, { method, headers: { Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const wsStatus = (p, headers) =>
  new Promise((resolve) => {
    const w = new WebSocket(`ws://127.0.0.1:${dash.port}${p}`, { headers });
    w.on('unexpected-response', (rq, res) => resolve(res.statusCode));
    w.on('message', (d) => {
      resolve(d.toString());
      w.close();
    });
    w.on('error', () => resolve('error'));
  });

test('a valid token: no cookie, no Origin, and the request reaches the route', async () => {
  const r = await withToken('/api/sessions/x/send', { method: 'POST', body: { text: 'hi' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.viaToken, true);
  assert.equal(r.json.headers.origin, undefined);
  const info = await withToken('/api/machine');
  assert.equal(info.status, 200);
  assert.equal(info.json.api, 1);
  assert.equal(info.json.claude, '9.9.9');
  assert.ok(info.json.hostname && info.json.platform && 'version' in info.json);
});

test('an unknown or revoked token: 401 with code "token"; another scheme counts as no token', async () => {
  const bad = await withToken('/api/state', { auth: 'Bearer hop_' + 'A'.repeat(43) });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, 'token');
  assert.equal((await withToken('/api/state', { auth: 'Bearer junk' })).json.code, 'token');
  const basic = await withToken('/api/state', { auth: 'Basic abc' });
  assert.equal(basic.status, 401);
  assert.equal(basic.json.error, 'log in first', 'falls through to the normal login check');
});

test('every forbidden route refuses a valid token', async () => {
  const forbidden = [
    ['POST', '/api/login'], ['POST', '/api/logout'], ['GET', '/api/me'], ['POST', '/api/settings/password'],
    ['POST', '/api/pair/claim'], ['POST', '/api/pair/code'], ['GET', '/api/pair/code'],
    ['GET', '/api/tokens'], ['POST', `/api/tokens/${id}/revoke`],
    ['GET', '/api/machines'], ['GET', '/api/machines/sessions'], ['POST', '/api/machines/ssh'], ['POST', '/api/machines/box2/remove'],
    ['GET', '/m/box2/api/state'], ['POST', '/m/box2/api/sessions/x/send'], ['GET', '/m/box2/'],
    ['GET', '/'], ['GET', '/app.js'], ['GET', '/login'],
  ];
  for (const [method, p] of forbidden) {
    const r = await withToken(p, { method, body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.equal(r.json.code, 'token-forbidden', `${method} ${p}`);
  }
  // still valid afterwards
  assert.equal((await withToken('/api/state')).status, 200);
});

test('a request that carries the mark of her relay (a hub relaying her) never reaches what her door never gives her', async () => {
  const relayed = (p, method = 'POST') => fetch(dash.base + p, { method, headers: { Authorization: `Bearer ${token}`, 'x-hoprig-self': '1', 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  for (const p of ['/api/gateways/trouteai/share', '/api/addons/public-link/start', '/api/workspace/drop', '/api/herrights', '/api/workspace/credentials', '/api/updates/settings', '/api/settings/bypass/everything', '/api/gatewayhost/trouteai/restart', '/api/gatewayhost/trouteai/start', '/api/gatewayhost/trouteai/stop']) {
    const r = await relayed(p);
    assert.equal(r.status, 403, p);
    assert.ok(['her-never', 'token-forbidden'].includes(r.json.code), p + ' ' + r.json.code);
    if (p.startsWith('/api/gatewayhost/')) assert.equal(r.json.code, 'her-never', p);
  }
  // what she may do still passes the gate; the same token without her mark is the owner's other computer and is not asked
  assert.equal((await relayed('/api/state', 'GET')).status, 200);
  assert.notEqual((await withToken('/api/gateways/trouteai/share', { method: 'POST', body: {} })).json.code, 'her-never');
});

test('WebSocket: a token reaches /ws/term (no cookie, no Origin forwarded); never /m/...; a bad one gets 401', async () => {
  assert.equal(await wsStatus('/ws/term?name=one', { Authorization: `Bearer ${token}` }), 'hello one cookie=no origin=no');
  assert.equal(await wsStatus('/m/box2/ws/term?name=one', { Authorization: `Bearer ${token}` }), 403);
  assert.equal(await wsStatus('/ws/other', { Authorization: `Bearer ${token}` }), 403);
  assert.equal(await wsStatus('/ws/term?name=one', { Authorization: 'Bearer hop_' + 'B'.repeat(43) }), 401);
  assert.equal(await wsStatus('/ws/term?name=one', {}), 403, 'no token and no Origin: refused as before');
});

test('routes behind the login need the cookie, and the Origin for changes', async () => {
  const browser = asBrowser(dash.base);
  assert.equal((await browser('/api/tokens')).status, 200);
  assert.equal((await fetch(`${dash.base}/api/tokens`)).status, 401);
  const noOrigin = await fetch(`${dash.base}/api/pair/code`, { method: 'POST', headers: { Cookie: 'sid=good-cookie', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
  const t2 = createToken('other');
  const list = (await browser('/api/tokens')).json.tokens;
  assert.ok(list.some((t) => t.id === t2.id && t.name === 'other'));
  assert.equal(JSON.stringify(list).includes('hash'), false);
  assert.equal((await browser(`/api/tokens/${t2.id}/revoke`, { body: {} })).status, 200);
  assert.equal((await withToken('/api/state', { auth: `Bearer ${t2.token}` })).status, 401, 'revoked: refused at once');
  assert.equal((await browser(`/api/tokens/${t2.id}/revoke`, { body: {} })).status, 404);
});

test('pairing by code over HTTP: no login needed, works once, then the token works; wrong codes are rate-limited', async () => {
  const claim = (code, name = 'the-hub') =>
    fetch(`${dash.base}/api/pair/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const browser = asBrowser(dash.base);
  const made = await browser('/api/pair/code', { body: {} });
  assert.equal(made.status, 200);
  assert.equal((await browser(`/api/pair/code?id=${made.json.id}`)).json.status, 'pending');
  const ok = await claim(made.json.code);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.hoprig, 'pair');
  assert.match(ok.json.token, /^hop_/);
  assert.equal(ok.json.api, 1);
  assert.deepEqual((await browser(`/api/pair/code?id=${made.json.id}`)).json, { status: 'claimed', by: 'the-hub' });
  assert.equal((await withToken('/api/state', { auth: `Bearer ${ok.json.token}` })).status, 200);
  assert.equal((await claim(made.json.code)).json.code, 'bad-code', 'one use only');

  const fresh = createCode();
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await claim('ZZZZ-ZZZZ')).status);
  assert.deepEqual(codes, [403, 403, 429, 429], 'perIp 3 here (one already used by the replay above)');
  assert.equal((await claim(fresh.code)).status, 429, 'even the right code waits once the limit is hit');
});

test('a token may revoke itself, and only itself', async () => {
  const mine = createToken('leaving-hub');
  const other = createToken('staying-hub');
  const r = await withToken('/api/tokens/self/revoke', { method: 'POST', body: {}, auth: `Bearer ${mine.token}` });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.revoked.map((t) => t.id), [mine.id]);
  assert.equal((await withToken('/api/state', { auth: `Bearer ${mine.token}` })).status, 401);
  assert.equal((await withToken('/api/state', { auth: `Bearer ${other.token}` })).status, 200, 'the others are untouched');
  assert.equal((await withToken(`/api/tokens/${other.id}/revoke`, { method: 'POST', body: {}, auth: `Bearer ${other.token}` })).status, 403);
  assert.equal((await withToken('/api/login/link', { method: 'POST', body: {} })).status, 403, 'nor sign-in links');
  assert.equal((await withToken('/api/login/links', { method: 'POST', body: {} })).status, 403);
});
