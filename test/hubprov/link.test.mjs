// The hub's providers over a real direct link: a linked computer (B) opens streams to the hub (A) over the link it has,
// and A's relay answers them with A's key. Both ends run in this process: A's providers are files of this sandbox, B's
// rows come from its list. Every key and computer is made up.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { call, machineEntry, madeUpKey, upstream, until } from './helpers.mjs';

const box = sandbox('hubprov-link');
const { writeProfile, readProfile, listProfiles, profileEnv } = await import('../../src/profiles.mjs');
const { putMachine, setOwn, loadMachines } = await import('../../src/machines/store.mjs');
const { LinkHub, LinkClient } = await import('../../src/machines/link.mjs');
const { hubprovFeature } = await import('../../src/hubprov/feature.mjs');
const { issueRelaySecret, setSharing } = await import('../../src/hubprov/list.mjs');
const { keyRow, mintKey } = await import('../../src/hubprov/localkeys.mjs');

const KEY = madeUpKey('apikey');
const GWKEY = madeUpKey('gwkey');
const up = await upstream();
const gw = await upstream();
const stream = await upstream();
writeProfile('mykey', { label: 'My key', env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${up.port}` } });
writeProfile('mygw', { label: 'My gateway', env: { ANTHROPIC_AUTH_TOKEN: GWKEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${gw.port}` } });
writeProfile('mystream', { label: 'Streamer', env: { ANTHROPIC_API_KEY: madeUpKey('str'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${stream.port}/v1/stream/x/y` } });
writeProfile('mysub', { label: 'Setup token', env: { CLAUDE_CODE_OAUTH_TOKEN: madeUpKey('oat') } });

const ctxOf = (box2) => ({
  HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
  caller: () => 'page', readJson: async () => ({}), listening: () => box2.addr,
});

// ---- A: the hub, with a real LinkHub on a real listener ----
const secret = 'ccl_' + crypto.randomBytes(32).toString('base64url');
putMachine({ ...machineEntry('bee'), linkHash: crypto.createHash('sha256').update(secret).digest('hex') });
const links = new LinkHub({ pingMs: 500 });
const hubA = hubprovFeature(ctxOf({ addr: null }), { machines: { links, hub: null }, pushMs: 100000 });
const aServer = http.createServer((req, res) => { res.writeHead(404); res.end(); });
aServer.on('upgrade', (req, sock, head) => links.upgrade(req, sock, head));
await new Promise((r) => aServer.listen(0, '127.0.0.1', r));
const aUrl = `http://127.0.0.1:${aServer.address().port}`;

// ---- B: a linked computer: its dashboard answers on loopback, its link client is up ----
const bBox = { addr: null };
const entry = { id: crypto.randomBytes(6).toString('hex'), via: 'link', url: aUrl, secret, tokenId: crypto.randomBytes(6).toString('hex'), hubLabel: 'Hub A' };
const client = new LinkClient({ entry, local: () => ({ host: '127.0.0.1', port: 1 }), minDelayMs: 100, pingMs: 500 });
const keeper = { map: new Map([[entry.id, { tunnel: client }]]) };
const hubB = hubprovFeature(ctxOf(bBox), { machines: null, joinsOf: () => keeper, joined: () => [entry], pushMs: 100 }); // B's source replaces A's
const bServer = http.createServer(async (req, res) => {
  if (!(await hubB.handle(req, res))) { res.writeHead(404); res.end('{"error":"none"}'); }
});
await new Promise((r) => bServer.listen(0, '127.0.0.1', r));
bBox.addr = { address: '127.0.0.1', port: bServer.address().port };
const bBase = `http://127.0.0.1:${bBox.addr.port}`;
client.start();
await client.waitUp(8000);
hubB.start();
await until('B\'s list of the hub\'s providers', () => hubB.shown().length >= 3).catch(async (e) => {
  const s = client.hubStream();
  const r = await new Promise((resolve) => {
    if (!s) return resolve('no stream, state ' + client.state);
    const q = http.request({ method: 'GET', path: '/hubp/list', createConnection: () => s, headers: { host: 'hub' } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(res.statusCode + ' ' + Buffer.concat(c).toString().slice(0, 300))); });
    q.on('error', (er) => resolve('error ' + er.message));
    q.setTimeout(3000, () => q.destroy(new Error('timeout')));
    q.end();
  });
  throw new Error(e.message + ' :: ' + r);
});
const names = () => listProfiles().filter((p) => p.hub).map((p) => p.name).sort();
test.after(async () => {
  client.close(); hubB.close(); hubA.close(); links.close(); aServer.close(); bServer.close();
  await Promise.all([up.close(), gw.close(), stream.close()]);
  box.cleanup();
});

const asSession = (name, extra = {}) => {
  const p = readProfile(name);
  const env = profileEnv(p, {});
  return { env, key: env.ANTHROPIC_AUTH_TOKEN, base: env.ANTHROPIC_BASE_URL, ...extra };
};
const ask = (base, key, path2 = '/v1/messages', o = {}) => call(base.replace(/\/hub\/p\/.*/, ''), new URL(base).pathname + path2, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' }, body: '{"model":"m"}', ...o });

test('B lists the hub\'s providers as rows after its own, each flagged hub; the subscription is one row to sign in on', () => {
  assert.deepEqual(names(), ['hub-mygw', 'hub-mykey', 'hub-mystream', 'hub-subscription']);
  const sub = readProfile('hub-subscription');
  assert.equal(sub.signinHere, true);
  assert.equal(sub.kind, 'login');
  assert.equal(readProfile('hub-mykey').hub, true);
  // The profiles the hub holds are files here (one sandbox): none of its keys is in a row.
  for (const p of listProfiles().filter((x) => x.hub)) assert.ok(!JSON.stringify(p).includes(KEY) && !JSON.stringify(p).includes(GWKEY), p.name);
});

test('a session on a hub row: only B\'s loopback address and a hop_hl_ key; a request reaches the hub\'s key', async () => {
  const s = asSession('hub-mykey');
  assert.match(s.base, new RegExp(`^http://127\\.0\\.0\\.1:${bBox.addr.port}/hub/p/mykey$`));
  assert.match(s.key, /^hop_hl_/);
  assert.ok(!JSON.stringify(s.env).includes(KEY), 'the hub key is not in the session environment');
  assert.equal(s.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  const r = await ask(s.base, s.key);
  assert.equal(r.status, 200, r.body);
  assert.equal(up.seen.at(-1).headers['x-api-key'], KEY, 'the hub added its key');
  assert.ok(!JSON.stringify(up.seen.at(-1).headers).includes('hop_hl_'));
  // Every session gets a key of its own.
  assert.notEqual(asSession('hub-mykey').key, s.key);
});

test('a gateway row: the same path; the hub adds the gateway\'s own key', async () => {
  const s = asSession('hub-mygw');
  const r = await ask(s.base, s.key);
  assert.equal(r.status, 200, r.body);
  assert.equal(gw.seen.at(-1).headers.authorization, `Bearer ${GWKEY}`);
});

test('no key of the hub is written anywhere on B after relayed requests: a marker search over every file but A\'s profiles', () => {
  const hits = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (full === box.profiles) continue; // the hub\'s own profile files (the sandbox is shared by both ends)
      if (f.isDirectory()) walk(full);
      else {
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes(KEY) || text.includes(GWKEY)) hits.push(full);
      }
    }
  };
  walk(box.root);
  assert.deepEqual(hits, []);
});

test('a hop_hl_ key is refused from a non-loopback address, behind a proxy header, for another row and when expired', async () => {
  const s = asSession('hub-mykey');
  const odd = http.createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.40', configurable: true });
    hubB.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } });
  });
  await new Promise((r) => odd.listen(0, '127.0.0.1', r));
  const far = await call(`http://127.0.0.1:${odd.address().port}`, '/hub/p/mykey/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${s.key}` }, body: '{}' });
  assert.equal(far.status, 404);
  odd.close();
  const proxied = await call(bBase, '/hub/p/mykey/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${s.key}`, 'x-forwarded-for': '203.0.113.9' }, body: '{}' });
  assert.equal(proxied.status, 404);
  const other = asSession('hub-mygw');
  assert.equal((await call(bBase, '/hub/p/mykey/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${other.key}` }, body: '{}' })).status, 401, 'a key of another row');
  const old = mintKey({ row: 'mykey', ttlMs: 1, now: Date.now() - 10_000 });
  assert.equal(keyRow(old), null);
  assert.equal((await call(bBase, '/hub/p/mykey/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${old}` }, body: '{}' })).status, 401, 'an expired key');
  assert.equal((await call(bBase, '/hub/p/mykey/v1/messages', { method: 'POST', body: '{}' })).status, 401, 'no key');
  assert.equal((await call(bBase, '/hub/p/mykey/v1/messages', { method: 'POST', headers: { authorization: 'Bearer hop_hl_x' }, body: '{}' })).status, 401);
  assert.equal(up.seen.every((x) => x.headers['x-api-key'] === KEY), true);
});

test('the relay does not exist on the dashboard\'s own listener: /hubp is 404, with or without a bearer, from a hub rows key too', async () => {
  const s = asSession('hub-mykey');
  for (const h of [{}, { authorization: `Bearer ${s.key}` }, { authorization: `Bearer hop_${'a'.repeat(43)}` }, { authorization: `Bearer hpr_${'a'.repeat(43)}` }]) {
    assert.equal((await call(bBase, '/hubp/list', { headers: h })).status, 404);
    assert.equal((await call(bBase, '/hubp/mykey/v1/messages', { method: 'POST', headers: h, body: '{}' })).status, 404);
  }
});

test('a computer reached over SSH uses a relay secret: only on loopback, no proxy header, a secret the hub made; a revoked or wrong one is 404', async () => {
  const sec = issueRelaySecret('bee');
  const ok = await call(bBase, '/hubp/list', { headers: { authorization: `Bearer ${sec}` } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).providers.length, 4);
  assert.equal((await call(bBase, '/hubp/list', { headers: { authorization: `Bearer ${sec}`, 'x-forwarded-for': '203.0.113.9' } })).status, 404);
  assert.equal((await call(bBase, '/hubp/list', { headers: { authorization: `Bearer hpr_${'b'.repeat(43)}` } })).status, 404);
  const sec2 = issueRelaySecret('bee'); // a new secret replaces the old
  assert.equal((await call(bBase, '/hubp/list', { headers: { authorization: `Bearer ${sec}` } })).status, 404);
  assert.equal((await call(bBase, '/hubp/list', { headers: { authorization: `Bearer ${sec2}` } })).status, 200);
  const fs2 = fs.readFileSync(path.join(box.config, 'hubprov.json'), 'utf8');
  assert.ok(!fs2.includes(sec2), 'only the hash is kept');
});

test('the link drops in the middle of a stream: the hub ends the upstream request within a second and B ends with an error, not a clean end', async () => {
  const s = asSession('hub-mystream');
  const u = new URL(s.base);
  const req = http.request({ host: u.hostname, port: u.port, path: `${u.pathname}/v1/messages`, method: 'POST', headers: { authorization: `Bearer ${s.key}`, 'content-type': 'application/json' }, agent: false });
  const outcome = new Promise((resolve) => {
    req.on('response', (res) => {
      let first = false;
      res.on('data', () => { if (!first) { first = true; resolve({ got: 'first', res }); } });
    });
  });
  req.on('error', () => {});
  req.end('{}');
  const { res } = await outcome;
  const ended = new Promise((resolve) => { res.on('end', () => resolve('clean-end')); res.on('error', () => resolve('error')); res.on('close', () => resolve(res.complete ? 'clean-end' : 'error')); });
  const e = await until('the upstream request', () => stream.seen.find((x) => x.path.startsWith('/v1/stream')));
  const t0 = Date.now();
  client.ws.terminate(); // the link drops
  assert.equal(await ended, 'error', 'no clean end of the answer');
  await until('the upstream to hear it', () => e.closed, 1000);
  assert.ok(e.closedAt - t0 < 1000, `the upstream request ended after ${e.closedAt - t0} ms`);
  await client.waitUp(10_000); // it reconnects by itself
});

test('the hub is offline: B says so in words, a refused connection to the router (502), and the row is held offline for a while', async () => {
  const s = asSession('hub-mykey');
  const save = client.state;
  client.state = 'waiting';
  const r = await ask(s.base, s.key);
  client.state = save;
  assert.equal(r.status, 502);
  assert.match(r.body, /Your hub \S+ is offline: this computer has no provider of its own\./);
});

test('the hub\'s switch off, and a computer that is not his own, stop a session on B: the answer is the hub\'s refusal', async () => {
  const s = asSession('hub-mykey');
  try {
    setSharing(false);
    const off = await ask(s.base, s.key);
    assert.equal(off.status, 403);
    assert.match(off.body, /no longer shares its providers with this computer/);
  } finally {
    setSharing(true);
    await hubB.refresh(); // the hub would push its list again; this test has no hub dashboard to do it
  }
  assert.equal((await ask(s.base, s.key)).status, 200);
  try {
    setOwn('bee', false);
    const notOwn = await ask(s.base, s.key);
    assert.equal(notOwn.status, 403);
  } finally {
    setOwn('bee', true);
  }
  assert.equal((await ask(s.base, s.key)).status, 200);
});

test('the hub gives a linked computer no token for itself: the machine entry holds the computer\'s token, and a link claim answers none', () => {
  const m = loadMachines().find((x) => x.name === 'bee');
  assert.ok(m.token, 'the hub holds a token for B');
  // What the link answers B with is a secret for the link only (see src/machines/link.mjs claim): no field named token.
  const src = fs.readFileSync(new URL('../../src/machines/link.mjs', import.meta.url), 'utf8');
  const claimed = src.slice(src.indexOf('return { hoprig: \'link\''), src.indexOf('}\n', src.indexOf('return { hoprig: \'link\'')));
  assert.doesNotMatch(claimed, /\btoken\b/);
});

test('a hub row is never relayed on again: the hub shares only its own providers, not the rows it got from another hub', async () => {
  const sec = issueRelaySecret('bee');
  const list = JSON.parse((await call(bBase, '/hubp/list', { headers: { authorization: `Bearer ${sec}` } })).body);
  assert.ok(!list.providers.some((p) => p.name.startsWith('hub-')), 'no hub row in the list');
  const r = await call(bBase, '/hubp/hub-mykey/v1/messages', { method: 'POST', headers: { authorization: `Bearer ${sec}` }, body: '{}' });
  assert.equal(r.status, 404);
});
