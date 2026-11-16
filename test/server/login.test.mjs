// The login endpoint over real HTTP, with a stand-in backend (no tmux needed): the try limit holds against a burst
// of parallel guesses, and a good login does not eat into it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('login');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const backend = { list: async () => [], capture: async () => '' };

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
