// The Temporary kind's own parts (src/addons/publiclink.mjs): reading the address from cloudflared's real output,
// the install plan per OS, the config change while a link runs and its exact undo, the push with a new address, and
// a second temporary address for another local service against a stand-in cloudflared. The switch that runs the
// link itself is tested in linkswitch.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-publiclink-'));
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A stand-in cloudflared: --version, and `tunnel …` prints the lines the real 2026.10.1 printed, then waits.
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'cloudflared'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "cloudflared version 2026.10.1 (built 2026-10-15-1724 UTC)"; exit 0; fi
echo "$@" > "${tmp}/args.txt"
echo "2026-11-14T04:52:38Z INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "2026-11-14T04:52:43Z INF |  https://stem-wonder-lucky-hung.trycloudflare.com                                          |" >&2
echo "2026-11-14T04:52:45Z INF Registered tunnel connection connIndex=0 connection=d5695230 event=0 ip=198.41.200.233 location=del06 protocol=quic" >&2
exec sleep 600
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const P = await import('../../src/addons/publiclink.mjs');
const { findAddon } = await import('../../src/addons/index.mjs');
const { saveConfig } = await import('../../src/config.mjs');

test('the address is read from cloudflared\'s real output; its own service address is not one', () => {
  const lines = [
    '2026-11-14T04:52:38Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.',
    '2026-11-14T04:52:38Z INF Requesting new quick Tunnel on trycloudflare.com...',
    '2026-11-14T04:52:43Z INF +--------------------------------------------------------------------------------------------+',
    '2026-11-14T04:52:43Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
  ];
  assert.equal(P.parseTunnelUrl(lines.join('\n')), null);
  lines.push('2026-11-14T04:52:43Z INF |  https://stem-wonder-lucky-hung.trycloudflare.com                                          |');
  assert.equal(P.parseTunnelUrl(lines.join('\n')), 'https://stem-wonder-lucky-hung.trycloudflare.com');
  assert.equal(P.parseTunnelUrl('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'), null);
});

test('connected only when it says so; its connectivity errors are kept', () => {
  const url = '2026-11-14T04:56:20Z INF |  https://stem-wonder-lucky-hung.trycloudflare.com                                          |';
  const blocked = [
    url,
    '2026-11-14T04:56:41Z INF |  ERROR: Allow outbound QUIC traffic on port 7844 or use HTTP2.                                                                                                   |',
    '2026-11-14T04:56:41Z INF |  ERROR: Allow outbound QUIC traffic on port 7844 or use HTTP2.                                                                                                   |',
    '2026-11-14T04:56:41Z INF |  ERROR: Allow outbound TCP on port 7844.                                                                                                                         |',
    '2026-11-14T04:56:41Z INF precheck complete hard_fail=true run_id=7192640e',
  ].join('\n');
  assert.deepEqual(P.tunnelState(blocked), { url: 'https://stem-wonder-lucky-hung.trycloudflare.com', registered: false, errors: ['Allow outbound QUIC traffic on port 7844 or use HTTP2.', 'Allow outbound TCP on port 7844.'] });
  const ok = `${url}\n2026-11-14T04:52:45Z INF Registered tunnel connection connIndex=0 connection=d5695230 event=0 ip=198.41.200.233 location=del06 protocol=quic`;
  assert.equal(P.tunnelState(ok).registered, true);
});

test('the release file per OS and processor, and how it is installed', () => {
  assert.equal(P.releaseAsset('linux', 'x64'), 'cloudflared-linux-amd64');
  assert.equal(P.releaseAsset('linux', 'arm64'), 'cloudflared-linux-arm64');
  assert.equal(P.releaseAsset('linux', 'arm'), 'cloudflared-linux-arm');
  assert.equal(P.releaseAsset('linux', 'ia32'), 'cloudflared-linux-386');
  assert.equal(P.releaseAsset('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz');
  assert.equal(P.releaseAsset('darwin', 'x64'), 'cloudflared-darwin-amd64.tgz');
  assert.equal(P.releaseAsset('win32', 'x64'), 'cloudflared-windows-amd64.exe');
  assert.equal(P.releaseAsset('win32', 'arm64'), 'cloudflared-windows-amd64.exe');
  assert.equal(P.releaseAsset('freebsd', 'x64'), null);
  assert.deepEqual(P.installPlan({ platform: 'darwin', arch: 'arm64', hasBrew: true }), { kind: 'brew', argv: ['brew', 'install', 'cloudflared'] });
  assert.deepEqual(P.installPlan({ platform: 'darwin', arch: 'arm64', hasBrew: false, into: '/x', version: '2026.10.1' }),
    { kind: 'download', url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.1/cloudflared-darwin-arm64.tgz', file: path.join('/x', 'cloudflared'), tgz: true, sha256: '647615df99d49cd179ea5e13ef760b9bbfb33630f6ae62f87e33dfadda60adcc' });
  assert.deepEqual(P.installPlan({ platform: 'linux', arch: 'x64', into: '/x', version: '2026.10.1' }),
    { kind: 'download', url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.1/cloudflared-linux-amd64', file: path.join('/x', 'cloudflared'), tgz: false, sha256: '3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586' });
  assert.equal(P.installPlan({ platform: 'win32', arch: 'x64', into: 'C:\\x' }).file.endsWith('cloudflared.exe'), true);
  assert.equal(P.installPlan({ platform: 'aix', arch: 'ppc64' }).kind, 'none');
  assert.deepEqual(P.tunnelArgv('/b/cloudflared', 7433), ['/b/cloudflared', 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:7433']);
});

// The pinned release's files are checked against hashes written in the code. Raising CLOUDFLARED_VERSION without
// new hashes fails here, and every file the plan can name for any OS and processor has one.
test('every release file it can install has a known SHA-256, for exactly the pinned version', () => {
  assert.equal(P.CLOUDFLARED_SHA256.version, P.CLOUDFLARED_VERSION, 'the hashes are for the version it installs');
  const assets = new Set();
  for (const platform of ['linux', 'darwin', 'win32', 'freebsd', 'aix']) {
    for (const arch of ['x64', 'arm64', 'arm', 'ia32', 'ppc64', 's390x', 'riscv64']) {
      const a = P.releaseAsset(platform, arch);
      if (!a) continue;
      assets.add(a);
      assert.match(P.CLOUDFLARED_SHA256.files[a] || '', /^[0-9a-f]{64}$/, a);
      const plan = P.installPlan({ platform, arch, into: '/x' });
      if (plan.kind === 'download') assert.equal(plan.sha256, P.CLOUDFLARED_SHA256.files[a], a);
    }
  }
  assert.deepEqual(Object.keys(P.CLOUDFLARED_SHA256.files).sort(), [...assets].sort(), 'no hash of a file it never installs');
  const other = P.installPlan({ platform: 'linux', arch: 'x64', into: '/x', version: '2099.1.0' });
  assert.equal(other.kind, 'none');
  assert.match(other.reason, /no known SHA-256/);
});

test('a download that does not match its hash is not installed and leaves nothing; one that matches is moved into place', async () => {
  const crypto = await import('node:crypto');
  const into = path.join(tmp, 'cf-bin');
  fs.mkdirSync(into, { recursive: true });
  const file = path.join(into, 'cloudflared');
  fs.writeFileSync(file, 'the program that was there', { mode: 0o755 });
  const bytes = Buffer.from('#!/bin/sh\necho a stand-in release file\n');
  const fetchImpl = async (url) => ({ ok: true, status: 200, url, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
  const plan = (sha256) => ({ kind: 'download', url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.1/cloudflared-linux-amd64', file, tgz: false, sha256 });
  const lines = [];
  const bad = await P.install({ onLine: (l) => lines.push(l), fetchImpl, plan: plan('0'.repeat(64)) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /did not match/);
  assert.ok(lines.some((l) => /did not match/.test(l)), lines.join('\n'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'the program that was there', 'the program in place is untouched');
  assert.deepEqual(fs.readdirSync(into), ['cloudflared'], 'no temporary file is left');
  const good = await P.install({ onLine: () => {}, fetchImpl, plan: plan(crypto.createHash('sha256').update(bytes).digest('hex')) });
  assert.equal(good.error, undefined);
  assert.deepEqual(fs.readFileSync(file), bytes, 'the checked file is in place');
  assert.ok((fs.statSync(file).mode & 0o111) !== 0, 'and can run');
  assert.deepEqual(fs.readdirSync(into), ['cloudflared']);

  // The macOS kind: an archive, checked as a whole, then the program inside is moved into place the same way.
  if (process.platform === 'win32') return;
  const { execFileSync } = await import('node:child_process');
  const src = path.join(tmp, 'tgz-src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'cloudflared'), 'the program from the archive');
  execFileSync('tar', ['-czf', path.join(tmp, 'c.tgz'), '-C', src, 'cloudflared']);
  const tgz = fs.readFileSync(path.join(tmp, 'c.tgz'));
  const tgzFetch = async (url) => ({ ok: true, status: 200, url, arrayBuffer: async () => tgz.buffer.slice(tgz.byteOffset, tgz.byteOffset + tgz.length) });
  const tgzPlan = (sha256) => ({ ...plan(sha256), url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.1/cloudflared-darwin-arm64.tgz', tgz: true });
  const badTgz = await P.install({ onLine: () => {}, fetchImpl: tgzFetch, plan: tgzPlan('1'.repeat(64)) });
  assert.match(badTgz.error, /cloudflared-darwin-arm64\.tgz did not match/);
  assert.deepEqual(fs.readFileSync(file), bytes, 'what was in place stays');
  await P.install({ onLine: () => {}, fetchImpl: tgzFetch, plan: tgzPlan(crypto.createHash('sha256').update(tgz).digest('hex')) });
  assert.equal(fs.readFileSync(file, 'utf8'), 'the program from the archive');
  assert.deepEqual(fs.readdirSync(into), ['cloudflared']);
});

test('the config change while it runs, and its exact undo', () => {
  const o = 'https://a-b.trycloudflare.com';
  const fresh = P.patchFor({}, o);
  assert.deepEqual(fresh.patch, { server: { trustProxy: true, allowedOrigins: [o] } });
  assert.deepEqual(P.restoreFor({ trustProxy: true, allowedOrigins: [o] }, fresh.restore), { server: { trustProxy: undefined, allowedOrigins: undefined } });
  const had = P.patchFor({ trustProxy: false, allowedOrigins: ['https://deck.example.net'] }, o);
  assert.deepEqual(had.patch.server.allowedOrigins, ['https://deck.example.net', o]);
  assert.deepEqual(P.restoreFor({ trustProxy: true, allowedOrigins: ['https://deck.example.net', o] }, had.restore),
    { server: { trustProxy: false, allowedOrigins: ['https://deck.example.net'] } });
});

test('each new temporary address is sent through the owner\'s notifications, as the plain address', async () => {
  const { buildRequest } = await import('../../src/server/notify.mjs');
  const ev = P.newAddressEvent('https://stem-wonder-lucky-hung.trycloudflare.com');
  assert.deepEqual(ev, { status: 'link', force: true, session: '', title: 'New public link for this dashboard', message: 'https://stem-wonder-lucky-hung.trycloudflare.com', url: 'https://stem-wonder-lucky-hung.trycloudflare.com' });
  const req = buildRequest({ url: 'https://ntfy.sh/a-long-random-topic' }, ev);
  assert.deepEqual([req.headers.Title, req.headers.Click, req.headers.Tags, req.body], ['New public link for this dashboard', ev.url, 'link', ev.url]);
  // Sent when a push address is set, whatever events were chosen (force); nothing when there is none.
  const sent = [];
  const send = async (n, e) => (sent.push([n.url, e.title]), { sent: true });
  assert.deepEqual(await P.notifyNewAddress(ev.url, 'port 20017', { send, config: () => ({ server: { notify: { url: 'https://ntfy.sh/t', events: ['limit'] } } }) }), { sent: true });
  assert.deepEqual(sent, [['https://ntfy.sh/t', 'New public link for port 20017']]);
  assert.deepEqual(await P.notifyNewAddress(ev.url, 'x', { send, config: () => ({ server: {} }) }), { sent: false });
  assert.deepEqual(await P.notifyNewAddress(ev.url, 'x', { send: async () => { throw new Error('down'); }, config: () => ({ server: { notify: { url: 'https://ntfy.sh/t' } } }) }), { sent: false }, 'never throws');
  // With the real sendNotification and a stand-in receiver (the switch sends it at each new address: linkswitch.test).
  const { sendNotification } = await import('../../src/server/notify.mjs');
  const got = [];
  const fetchImpl = async (url, o) => (got.push({ url, title: o.headers.Title, body: o.body }), { ok: true, status: 200 });
  await P.notifyNewAddress(ev.url, 'this dashboard', { send: (n, e) => sendNotification(n, e, { fetchImpl }), config: () => ({ server: { notify: { url: 'https://ntfy.sh/a-long-random-topic', events: ['waiting'] } } }) });
  assert.deepEqual(got, [{ url: 'https://ntfy.sh/a-long-random-topic', title: 'New public link for this dashboard', body: ev.url }]);
});

test('a temporary address for another local service: asked first when it has no sign-in of its own', async () => {
  // The dashboard runs on a port given on its command line (7655): that port is never "another" service.
  fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'state', 'dashboard.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: 7655, at: Date.now() }));
  const a = findAddon('public-link');
  const look = (login) => async () => ({ status: login ? 401 : 200, headers: new Headers(), text: async () => '<h1>open</h1>' });
  const sent = [];
  const notify = async (url, what) => (sent.push([url, what]), { sent: true });
  // Only while the switch is on as Temporary.
  assert.match((await a.actions['quick-service-start']({ port: 20017 }, { notify, fetchImpl: look(true) })).error, /Turn the public link on as Temporary first/);
  saveConfig({ publicLink: { on: true, kind: 'temporary' } });
  assert.match((await a.actions['quick-service-start']({ port: 7655 }, { notify })).error, /dashboard itself/);
  const ask = await a.actions['quick-service-start']({ port: 20017 }, { notify, fetchImpl: look(false) });
  assert.deepEqual([ask.ok, /no sign-in page of its own/.test(ask.confirm)], [false, true]);
  const r = await a.actions['quick-service-start']({ port: 20017 }, { notify, fetchImpl: look(true), waitMs: 10_000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(path.join(tmp, 'args.txt'), 'utf8').trim(), 'tunnel --no-autoupdate --url http://127.0.0.1:20017');
  assert.deepEqual(sent, [[r.url, 'port 20017']]);
  assert.deepEqual((await a.status()).service, { port: 20017, url: r.url });
  assert.match((await a.actions['quick-service-start']({ port: 20018, confirmed: true }, { notify })).error, /stop it first/);
  assert.equal((await a.actions['quick-service-stop']()).ok, true);
  assert.equal((await a.status()).service, null);
});
