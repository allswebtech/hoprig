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
// (X-Forwarded-For, last entry). Someone failing from many addresses must not lock the owner out.
test('through the public link: limits per visitor address; the overall cap never locks out a sign-in link, this computer, or a strong password', async () => {
  const { hashTag } = await import('../../src/server/strength.mjs');
  const { createLoginLink } = await import('../../src/server/loginlink.mjs');
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
    // The good sign-in above judged the password strong (14 characters, not a common one). 30 failures spread over
    // many visitors then do not lock the owner out: from a new address he still signs in.
    const { passwordState } = await import('../../src/server/strength.mjs');
    assert.equal(passwordState().state, 'strong');
    for (let i = 0; i < 30; i++) await post('/api/login', { password: 'wrong' }, `198.51.100.${10 + i}`);
    assert.equal((await post('/api/login', { password: 'right-password' }, '198.51.100.99')).status, 200, 'a strong password is never locked by the overall cap');

    // A password judged weak keeps the overall cap: then a sign-in link and this computer itself still get in.
    const weak = await hashPassword('short-pass');
    saveConfig({ server: { passwordHash: weak, passwordCheck: { tag: hashTag(weak), strong: false, why: 'it has fewer than 12 characters' } } });
    for (let i = 0; i < 30; i++) await post('/api/login', { password: 'wrong' }, `192.0.2.${10 + i}`);
    assert.equal((await post('/api/login', { password: 'short-pass' }, '192.0.2.200')).status, 429, 'the overall cap holds for a weak password');
    const link = createLoginLink({ baseUrl: origin });
    const token = link.url.split('#link=').pop();
    assert.equal((await post('/api/login/link', { token }, '192.0.2.201')).status, 200, 'a sign-in link is never locked by the overall cap');
    assert.equal((await post('/api/login', { password: 'short-pass' })).status, 200, 'this computer itself is never locked by the overall cap');
  } finally {
    await app.close();
    saveConfig({ server: { trustProxy: undefined, passwordCheck: undefined } });
  }
});
