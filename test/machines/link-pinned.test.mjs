// End to end, no network: a hub behind an HTTPS front whose certificate comes from the hub's own (throwaway)
// authority, like Caddy's `tls internal` for a hub reached by IP address. The hub shows the join line with the
// fingerprint; a computer joins with it and the link comes up over wss, verified; without it, or with a wrong one,
// the join is refused and the code stays unused; the link reconnects on the stored pin, survives a renewed
// certificate, and refuses (in plain words) a hub whose authority changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { saveConfig } from '../../src/config.mjs';
import { sandbox } from '../server/helpers.mjs';
import { makeAuthority, makeCert, tlsFront } from './certs.mjs';
import { asBrowser, miniDashboard } from './harness.mjs';

const box = sandbox('machines-link-pinned');
const { createMachines } = await import('../../src/machines/index.mjs');
const join = await import('../../src/machines/join.mjs');
const { pinOf, forgetHubCertificate } = await import('../../src/machines/hubcert.mjs');
const { loadMachines } = await import('../../src/machines/store.mjs');
const { storedTokens } = await import('../../src/machines/tokens.mjs');
const { RateLimiter } = await import('../../src/server/auth.mjs');

const printed = [];
for (const k of ['log', 'error', 'warn']) {
  const orig = console[k];
  console[k] = (...a) => {
    printed.push(a.join(' '));
    orig(...a);
  };
}

const A = makeAuthority('Hub own');
const other = makeAuthority('Someone else');
const pin = pinOf(A.root.cert);
const chainOf = (auth, leaf = auth.leaf('127.0.0.1')) => ({ key: leaf.keyPem, chain: leaf.cert + auth.inter.cert });

// The hub's authority as Caddy's admin API would answer it; `skew` moves the hub's clock past its short cache.
let current = A.root.cert;
let skew = 0;
const fast = { claudeVersion: async () => null, relayIdleMs: 5000 };
const me = await miniDashboard({ createMachines, opts: { ...fast, join: { link: { minDelayMs: 200, maxDelayMs: 400, pingMs: 1000 }, syncMs: 200 } }, sessions: [{ name: 'home-session' }] }).listen();
// The hub hands out its own authority at /api/link/ca (in real life read from Caddy).
const hub = await miniDashboard({ createMachines, opts: { ...fast, hub: { probeTimeoutMs: 1500, hubName: 'the-hub', link: { limiter: new RateLimiter({ perIp: 50 }), pingMs: 1000, authority: async () => current, now: () => Date.now() + skew } } }, sessions: [{ name: 'hub-session' }] }).listen();
const front = await tlsFront(hub.port, chainOf(A));
const url = `https://127.0.0.1:${front.port}`;
// Both dashboards share this test's config: the hub's public address is the HTTPS front.
saveConfig({ server: { host: '127.0.0.1', port: me.port, machineLabel: 'Home PC', publicUrl: `${url}/` } });
const keeper = me.machines.joins;
keeper.start();
const browser = asBrowser(hub.base);
const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}`);
};
const linkedState = async () => ((await browser('/api/machines?fresh=1')).json.machines.find((m) => m.via === 'link') || {}).state;
const status = (id) => keeper.status(id) || {};

test.after(async () => {
  keeper.close();
  await front.close();
  await me.close();
  await hub.close();
  box.cleanup();
});

test('the hub shows the whole line, with its authority\'s fingerprint', async () => {
  forgetHubCertificate();
  const c = (await browser('/api/links/code', { body: {} })).json;
  assert.equal(c.certificate, 'own');
  assert.equal(c.fingerprint, pin);
  assert.equal(c.url, url);
  assert.equal(c.command, `hoprig join ${url} ${c.code} --fingerprint ${pin}`);
  // The authority is public material, and the only thing /api/link/ca gives without a login.
  const ca = await (await fetch(`${hub.base}/api/link/ca`)).json();
  assert.equal(pinOf(ca.certificate), pin);
});

test('without the fingerprint, or with a wrong one: refused before the code is used; no token is left behind', async () => {
  const c = (await browser('/api/links/code', { body: {} })).json;
  const tokens = storedTokens().length;
  await assert.rejects(join.joinByAddress(url, c.code, { keeper }), (e) => e.code === 'untrusted' && /--fingerprint/.test(e.message) && /hoprig machines invite/.test(e.message));
  await assert.rejects(join.joinByAddress(url, c.code, { keeper, fingerprint: pinOf(other.root.cert) }), (e) => e.code === 'fingerprint' && /Nothing was sent/.test(e.message));
  await assert.rejects(join.joinByAddress(url, c.code, { keeper, fingerprint: 'sha256:abc' }), (e) => e.code === 'bad-fingerprint');
  await assert.rejects(join.joinByAddress(url, c.code, { keeper, insecure: true }), (e) => e.code === 'untrusted', '--insecure does not switch the check off');
  assert.deepEqual((await browser(`/api/links/code?id=${c.id}`)).json, { status: 'pending' }, 'the code was never sent');
  assert.equal(storedTokens().length, tokens);
  assert.equal(loadMachines().some((m) => m.via === 'link'), false);
});

test('with the fingerprint: joined, the link comes up over verified wss, the hub reaches the computer', async () => {
  const c = (await browser('/api/links/code', { body: {} })).json;
  const h = await join.joinByAddress(url, c.code, { keeper, fingerprint: pin });
  assert.equal(h.pin, pin);
  assert.equal(pinOf(h.ca), pin, 'the authority is kept with the join');
  const saved = join.loadJoined().find((x) => x.id === h.id);
  assert.equal(saved.pin, pin);
  assert.equal(join.publicJoined(saved).fingerprint, pin);
  assert.equal(await linkedState(), 'online');
  const m = loadMachines().find((x) => x.via === 'link');
  assert.deepEqual((await browser(`/m/${m.name}/api/state`)).json.sessions, [{ name: 'home-session' }]);
  assert.equal(printed.some((l) => /ccl_|hop_/.test(l)), false, 'no secret printed');
});

test('reconnects verify against the stored pin; a renewed certificate under the same authority is fine', async () => {
  const h = join.loadJoined().find((x) => x.via === 'link');
  // Renewal: a new intermediate and a new leaf under the same root, then every connection cut.
  const inter2 = makeCert({ cn: 'Hub own - Intermediate 2', issuer: A.root, ca: true, days: 7 });
  const leaf2 = makeCert({ cn: '127.0.0.1', issuer: inter2, ips: ['127.0.0.1'], days: 1 });
  front.use({ key: leaf2.keyPem, chain: leaf2.cert + inter2.cert });
  const before = front.connections;
  front.drop();
  await until('offline', async () => (await linkedState()) === 'offline' || front.connections > before);
  await until('back up on the renewed certificate', async () => status(h.id).state === 'up' && (await linkedState()) === 'online');
});

test('a hub whose authority changed is refused, in plain words; the old authority comes back and it reconnects', async () => {
  const h = join.loadJoined().find((x) => x.via === 'link');
  front.use(chainOf(other));
  front.drop();
  const st = await until('refused', async () => (status(h.id).state !== 'up' && /no longer signed by the authority this computer pinned/.test(status(h.id).error || '') ? status(h.id) : null));
  assert.match(st.error, new RegExp(pin.replace(/[-]/g, '\\-')));
  assert.equal(await linkedState(), 'offline');
  front.use(chainOf(A));
  await until('back up', async () => status(h.id).state === 'up', 20_000);
});

test('the hub\'s authority is made new: its line and /api/link/ca follow at once; joining again replaces the entry', async () => {
  const h = join.loadJoined().find((x) => x.via === 'link');
  const name = loadMachines().find((m) => m.via === 'link').name;
  front.use(chainOf(other));
  current = other.root.cert;
  skew += 6000; // past the few seconds /api/link/ca is cached
  forgetHubCertificate();
  const c = (await browser('/api/links/code', { body: {} })).json;
  assert.equal(c.fingerprint, pinOf(other.root.cert));
  const again = await join.joinByAddress(url, c.code, { keeper, fingerprint: c.fingerprint });
  assert.equal(again.replaced, true);
  assert.notEqual(again.id, h.id);
  const list = loadMachines().filter((m) => m.via === 'link');
  assert.equal(list.length, 1, 'one entry, not two');
  assert.equal(list[0].name, name);
  await until('online with the new authority', async () => (await linkedState()) === 'online');
});

test('leaving goes over the same verified connection', async () => {
  const h = join.loadJoined().find((x) => x.via === 'link');
  const r = await join.leaveHub(h.id, { keeper });
  assert.equal(r.hubForgot, true);
  assert.equal(loadMachines().some((m) => m.via === 'link'), false);
});
