// The login endpoint over real HTTP, with a stand-in backend (no tmux needed): the try limit holds against a burst
// of parallel guesses, and a good login does not eat into it.
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('login');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const backend = { list: async () => [], capture: async () => '' };

// Linux answers on every 127.x address; macOS only on 127.0.0.1 unless an alias is added (a connection from 127.0.0.2
// fails there with EADDRNOTAVAIL). The rules below are about the address the server sees (req.socket.remoteAddress):
// where the system cannot connect from another loopback address, the test connects from 127.0.0.1 (or ::1) and hands
// that address in at the socket, before the dashboard's own handler reads it.
const aliases = await new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false));
  s.listen(0, '127.0.0.2', () => s.close(() => resolve(true)));
});
const PEER = 'x-test-peer';
/** What makes the server see `from` as the peer: { localAddress, extra headers }. Really where it can, else handed in. */
function peerFrom(from) {
  if (aliases || from === '127.0.0.1' || from === '::1') return { localAddress: from, extra: {} };
  return { localAddress: from.includes(':') ? '::1' : '127.0.0.1', extra: { [PEER]: from } };
}
/** On `app`'s server: a request that carries PEER is seen as coming from that address; the header itself goes. */
function handPeerIn(t, app) {
  if (!aliases) t.diagnostic('this system connects only from 127.0.0.1: the other loopback addresses are handed to the server\'s socket');
  app.server.prependListener('request', (req) => {
    // A kept-alive connection carries the next request too: an address handed in for an earlier one does not stay.
    delete req.socket.remoteAddress;
    const want = req.headers[PEER];
    if (!want) return;
    delete req.headers[PEER];
    const seen = req.socket.remoteAddress;
    Object.defineProperty(req.socket, 'remoteAddress', { value: seen.startsWith('::ffff:') && !want.includes(':') ? `::ffff:${want}` : want, configurable: true });
  });
}

async function withServer(fn) {
  saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
  const app = createServer({ backend });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  const login = (password) =>
    fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password }) });
  try {
    await fn({ origin, login });
  } finally {
    await app.close();
  }
}

test('a burst of parallel wrong passwords gets at most the allowed number of checks', async () => {
  await withServer(async ({ login }) => {
    const codes = (await Promise.all(Array.from({ length: 20 }, (_, i) => login(`wrong-${i}`)))).map((r) => r.status);
    const checked = codes.filter((c) => c === 401).length;
    assert.ok(checked >= 1 && checked <= 5, `password was checked ${checked} times: ${codes.join(',')}`);
    assert.equal(codes.filter((c) => c === 429).length, 20 - checked);
    // The address is locked now, also for the right password, and the answer says for how long.
    const again = await login('right-password');
    assert.equal(again.status, 429);
    assert.ok(Number(again.headers.get('retry-after')) > 0);
  });
});

test('good logins do not use up the limit; a cross-site login is refused before the password is looked at', async () => {
  await withServer(async ({ origin, login }) => {
    for (let i = 0; i < 8; i++) {
      const r = await login('right-password');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('set-cookie'), /^sid=[\w-]{20,}; Path=\/; HttpOnly; SameSite=Strict/);
    }
    const cross = await fetch(`${origin}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: JSON.stringify({ password: 'right-password' }),
    });
    assert.equal(cross.status, 403);
    const cookie = (await login('right-password')).headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${origin}/api/state`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${origin}/api/state`)).status, 401);
  });
});

// Through a public link: cloudflared on this computer forwards each visitor with the address it reports
// (X-Forwarded-For, last entry). The per-visitor limit counts an IPv6 visitor by its /64. The overall cap holds for
// every password try from elsewhere, also with a strong password; it never locks out a sign-in link or this computer.
test('through the public link: limits per visitor (IPv6 by /64); the overall cap holds for any password, not for a sign-in link or this computer', async () => {
  const { createLoginLink } = await import('../../src/server/loginlink.mjs');
  const { passwordState } = await import('../../src/server/strength.mjs');
  const hash = await hashPassword('right-password');
  saveConfig({ server: { passwordHash: hash, trustProxy: true, passwordCheck: undefined } });
  const app = createServer({ backend });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  const post = (p, body, visitor) => fetch(`${origin}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(visitor ? { 'X-Forwarded-For': `203.0.113.250, ${visitor}`, 'X-Forwarded-Proto': 'https', 'Cf-Connecting-Ip': visitor } : {}) },
    body: JSON.stringify(body),
  });
  try {
    // 5 failures from one visitor: that visitor waits, another one does not (the spoofable first entry is ignored).
    for (let i = 0; i < 5; i++) assert.equal((await post('/api/login', { password: `wrong-${i}` }, '198.51.100.1')).status, 401);
    assert.equal((await post('/api/login', { password: 'right-password' }, '198.51.100.1')).status, 429);
    assert.equal((await post('/api/login', { password: 'right-password' }, '198.51.100.2')).status, 200);
    // Every address of one IPv6 /64 is one visitor: a host cannot get a new allowance per address.
    for (let i = 0; i < 5; i++) assert.equal((await post('/api/login', { password: 'wrong' }, `2001:db8:5:6::${i + 1}`)).status, 401);
    assert.equal((await post('/api/login', { password: 'wrong' }, '2001:db8:5:6:aaaa::99')).status, 429, 'the same /64 waits');
    assert.equal((await post('/api/login', { password: 'right-password' }, '2001:db8:5:7::1')).status, 200, 'another /64 does not');

    // The good sign-ins judged the password strong (14 characters, not a common one). A flood from many visitors
    // still meets the overall cap: 30 wrong tries in all (10 of them above), then every password try from elsewhere waits.
    assert.equal(passwordState().state, 'strong');
    const codes = [];
    for (let i = 0; i < 40; i++) codes.push((await post('/api/login', { password: 'wrong' }, `198.51.100.${10 + i}`)).status);
    assert.equal(codes.filter((c) => c === 401).length, 20, codes.join(','));
    assert.equal(codes.filter((c) => c === 429).length, 20, codes.join(','));
    assert.equal((await post('/api/login', { password: 'right-password' }, '198.51.100.99')).status, 429, 'the overall cap holds for a strong password too');
    // The owner's ways in stay open: a sign-in link, and this computer itself.
    const link = createLoginLink({ baseUrl: origin });
    const token = link.url.split('#link=').pop();
    assert.equal((await post('/api/login/link', { token }, '192.0.2.201')).status, 200, 'a sign-in link is never locked by the overall cap');
    assert.equal((await post('/api/login', { password: 'right-password' })).status, 200, 'this computer itself is never locked by the overall cap');
  } finally {
    await app.close();
    saveConfig({ server: { trustProxy: undefined, passwordCheck: undefined } });
  }
});

// Every loopback address (127.x.y.z, ::1) and this computer's own addresses reach the dashboard from this computer.
// Each of them used to count as a visitor of its own, and this computer is left out of the overall cap: so wrong
// passwords spread over loopback addresses had no limit at all. This computer is one visitor now.
test('this computer is one visitor: wrong passwords spread over loopback addresses meet the per-visitor limit', async (t) => {
  const http = await import('node:http');
  saveConfig({ server: { passwordHash: await hashPassword('right-password'), trustProxy: true } });
  const app = createServer({ backend });
  handPeerIn(t, app);
  const { port } = await app.listen(0, '::'); // both families: 127.x arrives as ::ffff:127.x, and ::1 as itself
  const origin = `http://127.0.0.1:${port}`;
  const post = (from, password, extra = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ password });
    const r = http.request({
      host: from.includes(':') ? '::1' : '127.0.0.1', port, path: '/api/login', method: 'POST', localAddress: peerFrom(from).localAddress,
      headers: { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extra, ...peerFrom(from).extra },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject);
    r.end(body);
  });
  try {
    const from = [...Array.from({ length: 29 }, (_, i) => `127.0.0.${i + 2}`), '::1'];
    const codes = [];
    for (const a of from) codes.push(await post(a, 'wrong'));
    assert.deepEqual(codes.slice(0, 5), [401, 401, 401, 401, 401], codes.join(','));
    assert.ok(codes.slice(5).every((c) => c === 429), `after 5 tries from this computer every one waits: ${codes.join(',')}`);
    assert.equal(await post('127.0.0.77', 'right-password'), 429, 'also the right password, from any loopback address');
  } finally {
    await app.close();
    saveConfig({ server: { trustProxy: undefined } });
  }
});

test('guesses from elsewhere that use up the overall cap do not lock this computer out', async (t) => {
  const http = await import('node:http');
  saveConfig({ server: { passwordHash: await hashPassword('right-password'), trustProxy: true } });
  const app = createServer({ backend });
  handPeerIn(t, app);
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  const post = (from, password, visitor) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ password });
    const fwd = visitor ? { 'X-Forwarded-For': visitor, 'X-Forwarded-Proto': 'https', 'Cf-Connecting-Ip': visitor } : {};
    const r = http.request({
      host: '127.0.0.1', port, path: '/api/login', method: 'POST', localAddress: peerFrom(from).localAddress,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...fwd, ...peerFrom(from).extra },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject);
    r.end(body);
  });
  try {
    const codes = [];
    for (let i = 0; i < 40; i++) codes.push(await post('127.0.0.1', 'wrong', `198.51.100.${10 + i}`));
    assert.equal(codes.filter((c) => c === 401).length, 30, codes.join(','));
    assert.equal(await post('127.0.0.1', 'right-password', '198.51.100.99'), 429, 'the overall cap is used up');
    // A guess through the public link arrives from loopback too, but with the tunnel's headers: it is not this computer.
    assert.equal(await post('127.0.0.5', 'right-password'), 200, 'this computer still signs in');
  } finally {
    await app.close();
    saveConfig({ server: { trustProxy: undefined } });
  }
});

// The public link's tunnel connects from loopback for every visitor on the internet, and trustProxy is off for it.
// Counted by the loopback address, five wrong tries from anyone there locked everyone out, the owner's right password
// and his sign-in link too. Each tunnel visitor is the one Cloudflare names; a sign-in link has a count of its own.
test('over the public link, one visitor\'s wrong passwords lock neither another visitor nor the sign-in link', async (t) => {
  const http = await import('node:http');
  const { createLoginLink } = await import('../../src/server/loginlink.mjs');
  saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
  const app = createServer({ backend });
  handPeerIn(t, app);
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  // What cloudflared sends: its own forwarding headers, and Cloudflare's address of the visitor.
  const tunnel = (cf) => ({ 'X-Forwarded-For': cf || '203.0.113.250', 'X-Forwarded-Proto': 'https', ...(cf ? { 'Cf-Connecting-Ip': cf } : {}) });
  const post = (p, body, headers, from = '127.0.0.1') => new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST', localAddress: peerFrom(from).localAddress,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers, ...peerFrom(from).extra },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject);
    r.end(text);
  });
  const login = (password, headers, from) => post('/api/login', { password }, headers, from);
  try {
    const guesses = [];
    for (let i = 0; i < 6; i++) guesses.push(await login('wrong', tunnel('198.51.100.66')));
    assert.deepEqual(guesses, [401, 401, 401, 401, 401, 429], 'the guesser meets the per-visitor limit');
    assert.equal(await login('right-password', tunnel('203.0.113.9')), 200, 'the owner, another visitor over the tunnel, signs in');
    // Forwarded tries without Cloudflare's address share one count, whatever loopback address they come from.
    const plain = [];
    for (let i = 0; i < 6; i++) plain.push(await login('wrong', tunnel(null), `127.0.1.${i + 1}`));
    assert.deepEqual(plain, [401, 401, 401, 401, 401, 429], plain.join(','));
    // The sign-in link of that same locked visitor still works: wrong passwords never fill its count.
    const token = createLoginLink({ baseUrl: origin }).url.split('#link=').pop();
    assert.equal(await post('/api/login/link', { token }, tunnel(null), '127.0.1.9'), 200);
    assert.equal(await login('right-password', {}, '127.0.0.1'), 200, 'and this computer itself');
  } finally {
    await app.close();
  }
});

test('the password change counts this computer as one visitor too', async (t) => {
  const http = await import('node:http');
  saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
  const app = createServer({ backend });
  handPeerIn(t, app);
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  const post = (p, body, from, cookie) => new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST', localAddress: peerFrom(from).localAddress,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...(cookie ? { Cookie: cookie } : {}), ...peerFrom(from).extra },
    }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, cookie: (res.headers['set-cookie'] || [''])[0].split(';')[0] })); });
    r.on('error', reject);
    r.end(text);
  });
  try {
    const { cookie } = await post('/api/login', { password: 'right-password' }, '127.0.0.1');
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await post('/api/settings/password', { current: 'wrong', next: 'another-long-password' }, `127.0.2.${i + 1}`, cookie)).status);
    assert.deepEqual(codes, [403, 403, 403, 403, 403, 429, 429], codes.join(','));
  } finally {
    await app.close();
  }
});
