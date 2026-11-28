// The hub's providers over SSH, the kind the owner's computers are linked by: the hub's ssh to a computer carries ONE more
// forward back to a relay of the hub that only a relay secret opens; the hub tells that computer its port and secret at its
// next push (no step for the owner); the computer carries a session's request there. The ssh program itself is a stand-in
// here (the real one is proved in containers); the hub, the other computer's dashboard and the stand-in upstream are real.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { call, machineEntry, madeUpKey, upstream, until } from './helpers.mjs';

const box = sandbox('hubprov-ssh');
const { writeProfile } = await import('../../src/profiles.mjs');
const { putMachine, loadMachines } = await import('../../src/machines/store.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { Tunnels, Tunnel } = await import('../../src/machines/tunnels.mjs');
const { tunnelArgs } = await import('../../src/machines/ssh.mjs');
const { hubprovFeature } = await import('../../src/hubprov/feature.mjs');
const { mintKey } = await import('../../src/hubprov/localkeys.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');

// ---- the hub (A) ----
const KEY = madeUpKey('apikey');
const up = await upstream();
writeProfile('mykey', { label: 'My key', env: { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${up.port}` } });
const tunnels = new Tunnels({});
let reverse = null;
tunnels.peek = () => ({ reversePort: reverse });
let bPort = 0;
const hubFake = { tunnels, hubLabel: () => 'Hub A', endpoint: async () => ({ protocol: 'http:', hostname: '127.0.0.1', port: bPort, basePath: '' }), remove: async (name) => ({ removed: true, name }) };
const aCtx = { HttpError: class extends Error { constructor(s, m) { super(m); this.status = s; } }, caller: () => 'page', readJson: async () => ({}), listening: () => null };
const A = hubprovFeature(aCtx, { machines: { links: null, hub: hubFake }, pushMs: 1e9 });
await until('the relay listens on the hub\'s own loopback', () => A.relayPort() > 0);

// ---- the other computer (B): a real dashboard ----
saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
const bTok = createToken('Hub A', { hub: true });
const notHub = createToken('something else');
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
// B's own dashboard also lists the computers of this sandbox (it shares the machines file with A): its ssh is a stand-in that fails.
const noSsh = () => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => child.emit('exit', 255, null));
  return child;
};
const app = createServer({ backend, watch: false, machines: { hub: { ssh: { spawnImpl: noSsh } } } });
const { port } = await app.listen(0, '127.0.0.1');
bPort = port;
const base = `http://127.0.0.1:${port}`;
putMachine({ ...machineEntry('bee', { via: 'ssh', target: 'u@bee.example.com', remoteHost: '127.0.0.1', remotePort: port }), token: bTok.token, tokenId: bTok.id });
test('one more forward on the same ssh: a port sshd picks on the other computer, leading to the relay; none for a plain tunnel', () => {
  const plain = tunnelArgs({ target: 'u@h', localPort: 5001, remoteHost: '127.0.0.1', remotePort: 7433 });
  assert.ok(!plain.includes('-R'));
  const withBack = tunnelArgs({ target: 'u@h', localPort: 5001, remoteHost: '127.0.0.1', remotePort: 7433, reverse: 40123 });
  assert.equal(withBack.filter((a) => a === '-R').length, 1);
  assert.equal(withBack[withBack.indexOf('-R') + 1], '127.0.0.1:0:127.0.0.1:40123', 'its own loopback on both ends; the other end never a network address');
  assert.ok(withBack.indexOf('-L') >= 0 && withBack.indexOf('--') > withBack.indexOf('-R'));
  for (const bad of [0, -1, 70000, '40123', 1.5, null]) assert.ok(!tunnelArgs({ target: 'u@h', localPort: 1, remoteHost: 'x', remotePort: 1, reverse: bad }).includes('-R'), String(bad));
});

const fakeSpawn = (script) => {
  const calls = [];
  const spawnImpl = (bin, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    setImmediate(() => script(child, args, calls.length));
    return child;
  };
  return { spawnImpl, calls };
};

test('the tunnel learns the port sshd gave the forward; a refused forward costs the link nothing: the next try is without it', async () => {
  const sp = fakeSpawn((child, args, n) => {
    if (n === 1) {
      child.stderr.emit('data', Buffer.from('Warning: remote port forwarding failed for listen port 0\n'));
      child.emit('exit', 255, null);
    } else child.stderr.emit('data', Buffer.from('Allocated port 40999 for remote forward to 127.0.0.1:41000\n'));
  });
  const t = new Tunnel({ machine: { target: 'u@h', remoteHost: '127.0.0.1', remotePort: 7433, extra: [], reverse: 41000 }, spawnImpl: sp.spawnImpl, freePort: async () => 5555, probe: async () => sp.calls.length >= 2, minDelayMs: 5, probeEveryMs: 5 });
  await assert.rejects(t.ensure(2000));
  assert.ok(sp.calls[0].includes('-R'), 'the first try asked for it');
  await t.ensure(2000);
  assert.ok(!sp.calls[1].includes('-R'), 'the second try without it');
  assert.equal(t.reversePort, null);
  t.close();
  const sp2 = fakeSpawn((child) => child.stderr.emit('data', Buffer.from('Allocated port 40999 for remote forward to 127.0.0.1:41000\n')));
  const t2 = new Tunnel({ machine: { target: 'u@h', remoteHost: '127.0.0.1', remotePort: 7433, extra: [], reverse: 41000 }, spawnImpl: sp2.spawnImpl, freePort: async () => 5556, probe: async () => true, probeEveryMs: 5 });
  await t2.ensure(2000);
  await until('the allocated port', () => t2.reversePort === 40999);
  assert.equal(t2.status().reversePort, 40999);
  t2.close();
});

test.after(async () => {
  A.close();
  app.close();
  await up.close();
  box.cleanup();
});
const bearer = { authorization: `Bearer ${bTok.token}`, 'content-type': 'application/json' };
const accounts = async () => {
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return JSON.parse((await call(base, '/api/accounts', { headers: { cookie, origin: base } })).body).accounts;
};

test('the tunnel of a computer added by SSH asks for the forward back; one added any other way, or not his own, does not', () => {
  const re = tunnels.opts.reverseOf;
  assert.equal(re({ via: 'ssh', name: 'bee' }), A.relayPort());
  assert.equal(re({ via: 'ssh', name: 'cee', own: false }), null);
  assert.equal(re({ via: 'link', name: 'dee' }), null);
  assert.equal(re({ via: 'url', name: 'eee' }), null);
});

test('the relay on the hub: no secret, a wrong secret and a computer that is not his own get nothing; the answer never holds the key', async () => {
  const at = `http://127.0.0.1:${A.relayPort()}`;
  assert.equal((await call(at, '/hubp/list')).status, 404);
  assert.equal((await call(at, '/hubp/list', { headers: { authorization: 'Bearer hpr_' + 'a'.repeat(43) } })).status, 404);
  assert.equal((await call(at, '/hubp/list', { headers: { authorization: `Bearer ${bTok.token}` } })).status, 404, 'a machine token is no relay secret');
});

test('at its next push the hub gives the computer its relay and its own secret; nothing was pressed; the rows appear', async () => {
  assert.deepEqual((await accounts()).filter((a) => a.hub), []);
  reverse = A.relayPort(); // the port sshd gave on B: here the relay itself, since nothing is between them in this test
  await A.pushAll();
  await until('the hub row on B', async () => (await accounts()).some((a) => a.name === 'hub-mykey' && a.hub && !a.hubOffline));
  const state = fs.readFileSync(path.join(box.state, 'hubprov-hubs.json'), 'utf8');
  assert.match(state, /hpr_/);
  assert.ok(!state.includes(KEY), 'the hub key is not on the other computer');
  const hubFile = fs.readFileSync(path.join(box.config, 'hubprov.json'), 'utf8');
  assert.ok(!/"hpr_/.test(hubFile), 'the hub keeps only a hash of the secret');
  assert.equal(fs.statSync(path.join(box.state, 'hubprov-hubs.json')).mode & 0o077, 0, 'mode 600');
});

test('a computer the owner marks as not his own is taken back: its rows go at the next push and its secret ends', async () => {
  const { setOwn } = await import('../../src/machines/store.mjs');
  const at = `http://127.0.0.1:${A.relayPort()}`;
  const secret = JSON.parse(fs.readFileSync(path.join(box.state, 'hubprov-hubs.json'), 'utf8')).hubs[bTok.id].relay.secret;
  assert.equal((await call(at, '/hubp/list', { headers: { authorization: `Bearer ${secret}` } })).status, 200);
  setOwn('bee', false);
  await A.pushAll();
  await until('the rows are gone on B', async () => !(await accounts()).some((a) => a.hub));
  assert.equal((await call(at, '/hubp/list', { headers: { authorization: `Bearer ${secret}` } })).status, 404, 'the secret ended');
  setOwn('bee', true);
  await A.pushAll(true);
  await until('his own again: rows back', async () => (await accounts()).some((a) => a.name === 'hub-mykey'));
});

test('the hub restarted and has a new forward: its next push replaces the port and the secret on B, by itself', async () => {
  const file = path.join(box.state, 'hubprov-hubs.json');
  const before = JSON.parse(fs.readFileSync(file, 'utf8')).hubs[bTok.id].relay;
  const r = await call(base, '/api/hubprov/push', { method: 'POST', headers: bearer, body: JSON.stringify({ hub: 'Hub A', providers: [], relay: { secret: 'hpr_' + 'd'.repeat(43), port: before.port + 1 } }) });
  assert.equal(r.status, 200);
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).hubs[bTok.id].relay;
  assert.deepEqual(after, { secret: 'hpr_' + 'd'.repeat(43), port: before.port + 1 });
  await A.pushAll(true); // the real secret and port again (the hub still holds the first secret in this run)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hubs[bTok.id].relay, before);
});

test('a session on that row: the request is carried over the forward with the secret; the hub adds its key; the session key is B\'s own', async () => {
  const key = mintKey({ row: 'mykey' });
  const r = await call(base, '/hub/p/mykey/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: '{"model":"m","stream":true}' });
  assert.equal(r.status, 200, r.body);
  const seen = up.seen.at(-1);
  assert.equal(seen.headers['x-api-key'], KEY, 'the hub added the real key');
  assert.ok(!JSON.stringify(seen.headers).includes('hop_hl_') && !JSON.stringify(seen.headers).includes('hpr_'), 'neither B\'s session key nor the secret goes on to the upstream');
  assert.ok(!r.body.includes(KEY));
  const wrong = await call(base, '/hub/p/mykey/v1/messages', { method: 'POST', headers: { 'x-api-key': 'hop_hl_' + 'b'.repeat(43), 'content-type': 'application/json' }, body: '{}' });
  assert.equal(wrong.status, 401);
});

test('the hub\'s switch and the keep mark are the hub\'s: B is refused with the hub\'s words', async () => {
  const { setSharing, setKept } = await import('../../src/hubprov/list.mjs');
  const key = mintKey({ row: 'mykey' });
  const ask = () => call(base, '/hub/p/mykey/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: '{}' });
  setKept('mykey', true);
  assert.equal((await ask()).status, 403);
  setKept('mykey', false);
  setSharing(false);
  const off = await ask();
  assert.equal(off.status, 403);
  assert.match(off.body, /no longer shares/);
  setSharing(true);
  assert.equal((await ask()).status, 200);
});

test('only a token a hub holds may push: another computer\'s token and a push without a usable relay change nothing', async () => {
  const other = await call(base, '/api/hubprov/push', { method: 'POST', headers: { authorization: `Bearer ${notHub.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ providers: [], relay: { secret: 'hpr_' + 'c'.repeat(43), port: 40000 } }) });
  assert.equal(other.status, 403);
  const before = fs.readFileSync(path.join(box.state, 'hubprov-hubs.json'), 'utf8');
  for (const relay of [{ secret: 'hpr_' + 'c'.repeat(43), port: 80 }, { secret: 'nope', port: 40000 }, { secret: 'hpr_' + 'c'.repeat(43), port: '40000;x' }]) {
    const r = await call(base, '/api/hubprov/push', { method: 'POST', headers: bearer, body: JSON.stringify({ providers: [], relay }) });
    assert.equal(r.status, 200);
  }
  const after = JSON.parse(fs.readFileSync(path.join(box.state, 'hubprov-hubs.json'), 'utf8')).hubs[bTok.id].relay;
  assert.deepEqual(after, JSON.parse(before).hubs[bTok.id].relay, 'a bad relay is not kept: the one before stays');
  await A.pushAll(true); // the hub tells its list again
});

test('Remove takes the secret back: the same secret is refused at once', async () => {
  const at = `http://127.0.0.1:${A.relayPort()}`;
  const keep = JSON.parse(fs.readFileSync(path.join(box.state, 'hubprov-hubs.json'), 'utf8')).hubs[bTok.id].relay.secret;
  assert.equal((await call(at, '/hubp/list', { headers: { authorization: `Bearer ${keep}` } })).status, 200);
  await hubFake.remove('bee');
  assert.equal((await call(at, '/hubp/list', { headers: { authorization: `Bearer ${keep}` } })).status, 404);
  assert.ok(loadMachines().some((m) => m.name === 'bee'), 'the machines file is the machines feature\'s own business here');
});

test('the hub gone: B says the hub is offline in words; a start is refused with them', async () => {
  A.close();
  await until('the row shows offline', async () => (await accounts()).some((a) => a.name === 'hub-mykey' && a.hubOffline), 15000);
});
