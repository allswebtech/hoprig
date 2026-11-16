// The administrator password of a Setup job crosses only an encrypted leg between a hub and another computer
// (src/machines/legs.mjs). A real dashboard is the computer (its Setup routes with a stand-in sudo); a hub relays to it
// by every way it can be reached: by address over http and over https, through a tunnel to its loopback (as SSH and
// join do), and by the direct link over ws and over wss with a pinned certificate. On a plain leg the hub refuses the
// password and the computer never sees it: not in what reached its socket, its log, sudo's input or the job. The
// computer refuses on its own too: a plain leg it can tell, and a request whose leg it cannot tell (an older hub).
import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import { saveConfig } from '../../src/config.mjs';
import { sandbox } from '../server/helpers.mjs';
import { makeAuthority, tlsFront } from './certs.mjs';
import { asBrowser, miniDashboard } from './harness.mjs';

const box = sandbox('machines-legs');
const { createMachines } = await import('../../src/machines/index.mjs');
const join = await import('../../src/machines/join.mjs');
const { pinOf } = await import('../../src/machines/hubcert.mjs');
const { loadMachines, putMachine } = await import('../../src/machines/store.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const legs = await import('../../src/machines/legs.mjs');
const { RateLimiter, hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const PASSWORD = 'Sudo pw 7#leg';
const printed = [];
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k];
  console[k] = (...a) => {
    printed.push(a.join(' '));
    orig(...a);
  };
}

// ---- the computer: a real dashboard, its Setup with a stand-in sudo that records what it was given ----
const sudoInput = [];
const sys = { platform: 'linux', pm: 'apt', root: false, user: 'dev', arch: 'x64', tmp: os.tmpdir(), home: box.home, env: process.env, has: (b) => b === 'sudo', exists: () => false, clt: true, run: async () => ({ ok: false, stdout: '', stderr: '' }) };
const pcsetup = {
  sys,
  sudoNeedsPassword: async () => true,
  stream: async (argv, o = {}) => {
    sudoInput.push(String(o.input || ''));
    return { ok: o.input === `${PASSWORD}\n`, code: 0, output: '' };
  },
  runPcSetup: async ({ ui }) => {
    ui.say?.('installed nothing (stand-in)');
    return { ok: true, missing: [], changed: false };
  },
};
const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name }) };
saveConfig({ server: { passwordHash: await hashPassword('owner-login'), host: '127.0.0.1', port: 1, machineLabel: 'Home PC' } });
const app = createServer({ backend, watch: false, machines: { claudeVersion: async () => null, join: { link: { minDelayMs: 200, pingMs: 1000 }, syncMs: 200 } }, pcsetup });
const me = { port: (await app.listen(0, '127.0.0.1')).port };
me.base = `http://127.0.0.1:${me.port}`;
saveConfig({ server: { port: me.port } });
// Every byte that reached the computer's own socket.
let wire = '';
app.server.on('connection', (s) => s.on('data', (d) => (wire += d.toString('latin1'))));
const keeper = app.features.find((f) => f.name === 'machines').machines.joins;

// ---- the hub, with its own certificate authority (Caddy's `tls internal`) behind an HTTPS front ----
const A = makeAuthority('Leg test');
const chain = () => {
  const leaf = A.leaf('127.0.0.1');
  return { key: leaf.keyPem, chain: leaf.cert + A.inter.cert };
};
const pin = pinOf(A.root.cert);
const hub = await miniDashboard({ createMachines, opts: { claudeVersion: async () => null, relayIdleMs: 5000, hub: { probeTimeoutMs: 1500, hubName: 'the-hub', link: { limiter: new RateLimiter({ perIp: 50 }), pingMs: 1000, authority: async () => A.root.cert } } } }).listen();
const hubFront = await tlsFront(hub.port, chain());
const meFront = await tlsFront(me.port, chain()); // the computer's own HTTPS address
const browser = asBrowser(hub.base);

test.after(async () => {
  keeper.close();
  await hubFront.close();
  await meFront.close();
  await hub.close();
  await app.close();
  box.cleanup();
});

const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
};
const job = async () => (await fetch(`${me.base}/api/pcsetup/job`, { headers: { Authorization: `Bearer ${createToken('job-reader').token}` } })).json();
const idle = () => until('the job to end', async () => !(await job()).running);
const setup = (name, body) => browser(`/m/${name}/api/pcsetup/setup`, { body: { kits: ['extras'], ...body } });

/** A machine on the hub that reaches the computer by `how`, with a fresh token there. */
function add(name, how) {
  const { id, token } = createToken(`hub-${name}`);
  putMachine({ name, label: name.toUpperCase(), token, tokenId: id, added: Date.now(), ...how });
  return name;
}

/** Joins the computer to the hub by the direct link at `url`; the name it has on the hub. */
async function linkAt(url, opts = {}) {
  const before = new Set(loadMachines().filter((m) => m.via === 'link').map((m) => m.name));
  const c = (await browser('/api/links/code', { body: {} })).json;
  await join.joinByAddress(url, c.code, { keeper, ...opts });
  return loadMachines().find((m) => m.via === 'link' && !before.has(m.name)).name;
}

/** An encrypted leg: asked for, sent, checked by sudo, the job runs. */
async function goesThrough(name) {
  await idle();
  assert.deepEqual((await setup(name, {})).json, { needsPassword: true });
  const r = await setup(name, { password: PASSWORD });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { started: true });
  assert.equal(sudoInput.at(-1), `${PASSWORD}\n`, 'sudo got it');
  await idle();
  assert.ok(!JSON.stringify(await job()).includes(PASSWORD), 'never in the job');
}

/** A plain leg: no password field asked for, the password refused by the hub and never on the computer. */
async function refusedByHub(name, page) {
  await idle();
  const ask = await setup(name, {});
  assert.deepEqual(ask.json, { needsPassword: true, plainLeg: true }, 'the computer says: not over this leg');
  wire = '';
  const inputs = sudoInput.length;
  const startedAt = (await job()).startedAt;
  const r = await setup(name, { password: PASSWORD });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.code, 'plain-leg');
  assert.match(r.json.error, /asked only on .+'s own page, because the connection from this dashboard to .+ is not encrypted/);
  assert.equal(r.json.page, page);
  assert.ok(!wire.includes(PASSWORD), 'not one byte of it reached the computer');
  assert.equal(sudoInput.length, inputs, 'sudo was not asked');
  assert.equal((await job()).startedAt, startedAt, 'no job started');
}

test('by address over http: refused, with that computer\'s own page; the rest of its API still goes through', async () => {
  const name = add('plain-url', { via: 'url', url: me.base });
  await refusedByHub(name, me.base);
  // A body without a password is read and sent on unchanged.
  const r = await browser(`/m/${name}/api/pcsetup/rules`, { body: { action: 'nothing' } });
  assert.equal(r.status, 400, 'the computer answered it');
  assert.ok(wire.includes('"action":"nothing"'));
});

test('by address over https: the password goes through', async () => {
  const name = add('tls-url', { via: 'url', url: `https://127.0.0.1:${meFront.port}` });
  // The front's certificate is from the test's own authority, which this process does not trust otherwise.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    await goesThrough(name);
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
});

test('through a tunnel to its loopback (as by SSH, or a computer that joined by SSH): the password goes through', async () => {
  await goesThrough(add('tunnel', { via: 'join', port: me.port, joinId: 'abcdefabcdef' }));
});

test('the direct link over ws: refused by the hub, and by the computer even when told the leg is encrypted', async () => {
  const name = await linkAt(hub.base);
  await refusedByHub(name, null);
  // A hub that says "encrypted" over this plain link (an older or a lying one) gets nowhere: the computer knows its link.
  const m = loadMachines().find((x) => x.name === name);
  wire = '';
  const inputs = sudoInput.length;
  const r = await fetch(`http://127.0.0.1:${m.port}/api/pcsetup/setup`, { method: 'POST', headers: { Authorization: `Bearer ${m.token}`, 'Content-Type': 'application/json', [legs.LEG_HEADER]: 'encrypted' }, body: JSON.stringify({ kits: ['extras'], password: PASSWORD }) });
  assert.deepEqual(await r.json(), { needsPassword: true, plainLeg: true });
  assert.equal(sudoInput.length, inputs, 'sudo was not asked');
});

test('the direct link over wss, with the hub\'s pinned certificate: the password goes through', async () => {
  await goesThrough(await linkAt(`https://127.0.0.1:${hubFront.port}`, { fingerprint: pin }));
});

test('the hub\'s list says which legs are encrypted (the page shows no password field for the others)', async () => {
  const list = (await browser('/api/machines?fresh=1')).json.machines;
  const by = Object.fromEntries(list.map((m) => [m.name, m.encrypted]));
  assert.equal(by['plain-url'], false);
  assert.equal(by['tls-url'], true);
  assert.equal(by.tunnel, true);
  const links = list.filter((m) => m.via === 'link').map((m) => m.encrypted);
  assert.deepEqual(links.sort(), [false, true]);
});

test('the computer on its own: a token request whose leg it cannot tell is refused; its owner\'s own login is not', async () => {
  const { token } = createToken('an-older-hub');
  const post = (headers, body) => fetch(`${me.base}/api/pcsetup/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: me.base, ...headers }, body: JSON.stringify({ kits: ['extras'], ...body }) }).then((r) => r.json());
  const inputs = sudoInput.length;
  assert.deepEqual(await post({ Authorization: `Bearer ${token}` }, { password: PASSWORD }), { needsPassword: true, plainLeg: true }, 'loopback, no word from the hub');
  assert.deepEqual(await post({ Authorization: `Bearer ${token}`, [legs.LEG_HEADER]: 'encrypted', 'X-Forwarded-Proto': 'http' }, { password: PASSWORD }), { needsPassword: true, plainLeg: true }, 'a proxy here that says http');
  assert.equal(sudoInput.length, inputs);
  // The owner on this dashboard's own page: never refused here (its plain-http warning is the page's).
  await idle();
  const login = await fetch(`${me.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: me.base }, body: JSON.stringify({ password: 'owner-login' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await post({ Cookie: cookie }, { password: PASSWORD }), { started: true });
  await idle();
});

test('where each end decides, for the cases a test cannot make here (a peer on the network, a TLS socket)', () => {
  const req = (remoteAddress, headers = {}, encrypted = false) => ({ socket: { remoteAddress, remotePort: 1, encrypted }, headers });
  assert.equal(legs.arrivedEncrypted(req('192.168.1.20', { [legs.LEG_HEADER]: 'encrypted' })), false, 'from the network over plain http');
  assert.equal(legs.arrivedEncrypted(req('192.168.1.20', {}, true)), true, 'straight over TLS');
  assert.equal(legs.arrivedEncrypted(req('::ffff:127.0.0.1', { [legs.LEG_HEADER]: 'encrypted' })), true, 'a tunnel, with the hub\'s word');
  assert.equal(legs.legEncrypted({ via: 'ssh' }), true);
  assert.equal(legs.legEncrypted({ via: 'url', url: 'http://pc:7433' }), false);
  assert.equal(legs.legEncrypted({ via: 'url', url: 'https://pc.example.com' }), true);
  assert.equal(legs.legEncrypted({ via: 'link', linkId: 'x' }, () => true), true);
  assert.equal(legs.legEncrypted({ via: 'link', linkId: 'x' }), false);
  assert.equal(legs.upgradeEncrypted(req('10.0.0.5', { [legs.LEG_HEADER]: 'wss' })), false, 'a plain socket from the network, whatever it says');
  assert.equal(legs.upgradeEncrypted(req('127.0.0.1', { 'x-forwarded-proto': 'https' }), false), false, 'a front\'s word only with trustProxy');
  assert.equal(legs.upgradeEncrypted(req('127.0.0.1', { 'x-forwarded-proto': 'https' }), true), true);
  assert.equal(legs.hasPassword('{"kits":[],"password":""}'), true);
  assert.equal(legs.hasPassword('not json'), false);
});

test('the password was never printed', () => {
  assert.ok(!printed.some((l) => l.includes(PASSWORD)), printed.join('\n'));
});
