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
