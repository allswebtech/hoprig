// The public-link add-on: reading the address from cloudflared's real output, the install plan per OS, the config
// change while it runs and its exact undo, and start / status / stop against a stand-in cloudflared.
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
const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const { findAddon } = await import('../../src/addons/index.mjs');
const raw = () => JSON.parse(fs.readFileSync(path.join(tmp, 'config', 'config.json'), 'utf8'));

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
    { kind: 'download', url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.1/cloudflared-darwin-arm64.tgz', file: path.join('/x', 'cloudflared'), tgz: true });
  assert.deepEqual(P.installPlan({ platform: 'linux', arch: 'x64', into: '/x', version: '2026.10.1' }),
    { kind: 'download', url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.1/cloudflared-linux-amd64', file: path.join('/x', 'cloudflared'), tgz: false });
  assert.equal(P.installPlan({ platform: 'win32', arch: 'x64', into: 'C:\\x' }).file.endsWith('cloudflared.exe'), true);
  assert.equal(P.installPlan({ platform: 'aix', arch: 'ppc64' }).kind, 'none');
  assert.deepEqual(P.tunnelArgv('/b/cloudflared', 7433), ['/b/cloudflared', 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:7433']);
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

test('it refuses to start without a dashboard password', async () => {
  const r = await P.publicLink.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /password/);
});

test('it refuses to start while the dashboard is not running', async () => {
  saveConfig({ server: { port: 7433, passwordHash: 'scrypt$x', allowedOrigins: ['https://deck.example.net'] } });
  const r = await P.publicLink.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /dashboard is not running/);
});

test('start: the address from its output, the settings while it runs; stop puts them back exactly', async () => {
  // The dashboard runs on a port given on its command line (7655), not the configured 7433: the tunnel goes there.
  fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'state', 'dashboard.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: 7655, at: Date.now() }));
  const before = raw().server;
  const a = findAddon('public-link');
  assert.ok(a, 'registered');
  const s0 = await a.status();
  assert.deepEqual([s0.installed, s0.version, s0.running, s0.account], [true, '2026.10.1', false, false]);
  const r = await a.start({ waitMs: 10_000 });
  assert.deepEqual([r.ok, r.url, r.already], [true, 'https://stem-wonder-lucky-hung.trycloudflare.com', false]);
  assert.equal(fs.readFileSync(path.join(tmp, 'args.txt'), 'utf8').trim(), 'tunnel --no-autoupdate --url http://127.0.0.1:7655');
  assert.equal(loadConfig().server.trustProxy, true);
  assert.deepEqual(loadConfig().server.allowedOrigins, ['https://deck.example.net', r.url]);
  const s1 = await a.status();
  assert.deepEqual([s1.running, s1.url], [true, r.url]);
  assert.equal((await a.start()).already, true, 'a second start finds it running');
  assert.equal((await a.stop()).ok, true);
  assert.deepEqual(raw().server, before, 'settings exactly as before');
  assert.equal((await a.status()).running, false);
});

test('when cloudflared ends by itself, its settings go back at the next look', async () => {
  const a = findAddon('public-link');
  const before = raw().server;
  const r = await a.start({ waitMs: 10_000 });
  const pid = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'addons', 'public-link.json'), 'utf8')).pid;
  process.kill(pid, 'SIGKILL');
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(loadConfig().server.trustProxy, true, r.url);
  assert.equal((await a.status()).running, false);
  assert.deepEqual(raw().server, before);
});

test('the command line explains and asks before it starts', async () => {
  const out = [];
  const say = (s) => out.push(s);
  assert.equal(await P.publicLink.beforeStart({ args: [], ask: async () => 'y', out: say }), process.stdin.isTTY ? true : false);
  assert.equal(await P.publicLink.beforeStart({ args: ['--yes'], out: say }), true);
  const text = out.join('\n');
  assert.match(text, /changes every time/);
  assert.match(text, /Anyone who has the address reaches the sign-in page/);
  assert.match(text, /through Cloudflare/);
  assert.match(text, /hub .* or Tailscale/);
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
  // At a start, with the real sendNotification and a stand-in receiver.
  const { sendNotification } = await import('../../src/server/notify.mjs');
  const got = [];
  const fetchImpl = async (url, o) => (got.push({ url, title: o.headers.Title, body: o.body }), { ok: true, status: 200 });
  const notify = (url, what) => P.notifyNewAddress(url, what, { send: (n, e) => sendNotification(n, e, { fetchImpl }) });
  saveConfig({ server: { notify: { url: 'https://ntfy.sh/a-long-random-topic', events: ['waiting'] } } });
  const a = findAddon('public-link');
  const r = await a.start({ waitMs: 10_000, notify });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(got, [{ url: 'https://ntfy.sh/a-long-random-topic', title: 'New public link for this dashboard', body: r.url }]);
  assert.equal((await a.start({ notify })).already, true);
  assert.equal(got.length, 1, 'not sent again while the same address runs');
  assert.equal((await a.stop()).ok, true);
  saveConfig({ server: { notify: undefined } });
});

test('a temporary address for another local service: asked first when it has no sign-in of its own', async () => {
  const a = findAddon('public-link');
  const look = (login) => async () => ({ status: login ? 401 : 200, headers: new Headers(), text: async () => '<h1>open</h1>' });
  const sent = [];
  const notify = async (url, what) => (sent.push([url, what]), { sent: true });
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
