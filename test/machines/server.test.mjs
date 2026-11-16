// The machines integration inside the real dashboard server (stand-in backend, no tmux): sign-in links over HTTP,
// the running dashboard's address file, `hoprig link`, and that a bearer token passes the server's own checks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { REPO } from './harness.mjs';

const box = sandbox('machines-server');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { runningDashboard } = await import('../../src/server/dashboardfile.mjs');
const { dashboardAddress } = await import('../../src/machines/pairing.mjs');
const { linkBase } = await import('../../src/machines/cli.mjs');
const { reachableUrl } = await import('../../src/addons/reach.mjs');

const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name }) };
saveConfig({ server: { passwordHash: await hashPassword('right-password'), port: 1 } });
// No add-ons: the public link is switched in a test below by its files only, and must not start a real cloudflared.
const app = createServer({ backend, watch: false, addons: { addons: [] }, machines: { claudeVersion: async () => null, certOf: async () => ({ kind: 'public' }) } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

const post = (p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), cookie: r.headers.get('set-cookie') }));

async function login() {
  const r = await post('/api/login', { password: 'right-password' });
  return r.cookie.split(';')[0];
}

test('the running dashboard records where it listens; pair and link read it before the config', () => {
  assert.deepEqual(runningDashboard(), { pid: process.pid, host: '127.0.0.1', port });
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.state, 'dashboard.json'), 'utf8')).port, port);
  assert.deepEqual(dashboardAddress(), { host: '127.0.0.1', port }, 'not the config\'s port 1');
  assert.deepEqual(linkBase(), { url: `http://127.0.0.1:${port}`, local: true });
  assert.equal(linkBase({ server: { publicUrl: 'https://pc.example.ts.net' } }).url, 'https://pc.example.ts.net');
  const lan = { en0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' }] };
  assert.deepEqual(linkBase({ server: { host: '0.0.0.0', port: 7433 } }, lan, null), { url: 'http://192.168.1.20:7433', local: false }, 'all addresses: the network one');
  assert.deepEqual(linkBase({ server: { host: '0.0.0.0', port: 7433 } }, lan, { host: '0.0.0.0', port }), { url: `http://192.168.1.20:${port}`, local: false }, 'the running port wins');
});

test('while the public link is on, the join line and `hoprig link` use its address (reachableUrl)', async () => {
  const cookie = await login();
  const joinCode = async () => (await post('/api/links/code', {}, { Cookie: cookie })).json;
  const none = await joinCode();
  assert.deepEqual([none.url, none.line, none.via], [null, null, null], 'off, and no public address set: no line to paste elsewhere');
  const addons = path.join(box.state, 'addons');
  fs.mkdirSync(path.join(addons, 'fixed-link'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'fixed-link', 'fixed.json'), JSON.stringify({ mode: 'named', hostname: 'office.example.com', tunnelId: 'x', extra: [] }));
  try {
    // Custom: its address while it is on.
    saveConfig({ publicLink: { on: true, kind: 'custom' } });
    assert.equal(reachableUrl(), 'https://office.example.com');
    const c = await joinCode();
    assert.equal(c.url, 'https://office.example.com');
    assert.match(c.command, /https:\/\/office\.example\.com/);
    // The one line to paste on the other computer, and how the address is had (Custom: it stays).
    assert.equal(c.line, `https://office.example.com#join=${c.code}`);
    assert.equal(c.via, 'custom');
    assert.deepEqual(linkBase(), { url: 'https://office.example.com', local: false });
    // Temporary: only while its cloudflared runs (a stopped one's address is dead).
    saveConfig({ publicLink: { on: true, kind: 'temporary' } });
    fs.writeFileSync(path.join(addons, 'link.json'), JSON.stringify({ kind: 'temporary', url: 'https://stem-wonder.trycloudflare.com', pid: process.pid }));
    assert.equal(reachableUrl(), 'https://stem-wonder.trycloudflare.com');
    const t = await joinCode();
    assert.equal(t.url, 'https://stem-wonder.trycloudflare.com');
    assert.equal(t.via, 'temporary', 'the page then says that the link ends when the address changes');
    assert.equal(t.line, `https://stem-wonder.trycloudflare.com#join=${t.code}`);
    fs.writeFileSync(path.join(addons, 'link.json'), JSON.stringify({ kind: 'temporary', url: 'https://stem-wonder.trycloudflare.com', pid: 2 ** 22 + 7 }));
    assert.equal(reachableUrl(), null);
    saveConfig({ publicLink: { on: false, kind: 'custom' } });
    assert.equal(reachableUrl(), null, 'off: none');
    // A public address that is set (a hub behind its own proxy) comes first, with its path.
    assert.equal(reachableUrl({ server: { publicUrl: 'https://hub.example.net/deck/' }, publicLink: { on: true, kind: 'custom' } }), 'https://hub.example.net/deck');
  } finally {
    saveConfig({ publicLink: undefined });
    fs.rmSync(addons, { recursive: true, force: true });
  }
});

test('sign-in link: made by a signed-in page, used once by another browser, which gets a session', async () => {
  const cookie = await login();
  assert.equal((await post('/api/login/links', {})).status, 401, 'making one needs the login');
  const made = await post('/api/login/links', {}, { Cookie: cookie });
  assert.equal(made.status, 200);
  assert.match(made.json.url, new RegExp(`^${base}/login#link=[A-Za-z0-9_-]{43}$`));
  assert.equal(made.json.local, true);
  assert.ok(Array.isArray(made.json.qr) && made.json.qr.length >= 21 && /^[01]+$/.test(made.json.qr[0]));
  const token = made.json.url.split('#link=')[1];
  const status = () => fetch(`${base}/api/login/links/${made.json.id}`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.deepEqual(await status(), { status: 'pending' });

  const used = await post('/api/login/link', { token });
  assert.equal(used.status, 200);
  const phone = used.cookie.split(';')[0];
  assert.match(used.cookie, /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Cookie: phone } })).status, 200, 'the phone is signed in');
  assert.deepEqual(await status(), { status: 'used' });
  const again = await post('/api/login/link', { token });
  assert.equal(again.status, 401, 'once only');
  assert.equal((await post('/api/login/link', { token }, { Origin: 'http://evil.example' })).status, 403, 'Origin checked like the login');
});

test('wrong sign-in link tokens count against the login limit', async () => {
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await post('/api/login/link', { token: 'x'.repeat(43) })).status);
  assert.ok(codes.includes(429), codes.join(','));
});

test('a bearer token needs no cookie and no Origin inside the real server; the WebSocket check too', async () => {
  const { token } = createToken('hub');
  const r = await fetch(`${base}/api/shells`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 200, 'no cookie and no Origin needed');
  const pw = await fetch(`${base}/api/settings/password`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(pw.status, 403);
  assert.equal((await fetch(`${base}/api/machine`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
});

test('hoprig link --json prints a working link', () => {
  const out = JSON.parse(execFileSync(process.execPath, [path.join(REPO, 'bin', 'hoprig.mjs'), 'link', '--json'], { env: process.env, encoding: 'utf8' }));
  assert.equal(out.hoprig, 'link');
  assert.match(out.url, new RegExp(`^http://127.0.0.1:${port}/login#link=`));
  const text = execFileSync(process.execPath, [path.join(REPO, 'bin', 'hoprig.mjs'), 'link', '--minutes', '5', '--url', 'https://pc.example.ts.net'], { env: process.env, encoding: 'utf8' });
  assert.match(text, /works once, for 5 minutes/);
  assert.match(text, /https:\/\/pc\.example\.ts\.net\/login#link=/);
  assert.match(text, /▄|█/, 'a QR code');
});

test('stopping the dashboard removes its address file', async () => {
  const other = createServer({ backend, watch: false });
  await other.listen(0, '127.0.0.1');
  await other.close();
  assert.equal(runningDashboard(), null);
});
