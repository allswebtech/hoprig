// The owner-only route that chooses which credentials file signs Tia's sessions in to the git server
// (src/server/hersignin.mjs), and that the choice can never be made through Tia's door: /api/hersignin is no route of
// her door, and it is no key her /api/settings door may send. The route names a file; it never reads or returns the
// token the file holds.
import assert from 'node:assert/strict';
import test from 'node:test';
import { herGitSigninFile } from '../../src/assistant/hersignin.mjs';
import { herSigninFeature } from '../../src/server/hersignin.mjs';
import { checkRoute } from '../../src/assistant/door.mjs';

// A fake ctx that keeps config in memory and merges `server` one level deep, as src/config.mjs saveConfig does.
function fakeCtx(initial = {}) {
  let cfg = { ...initial, server: { ...(initial.server || {}) } };
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  return {
    config: () => cfg,
    saveConfig(patch) {
      const next = { ...cfg, ...patch };
      if (patch.server) next.server = { ...(cfg.server || {}), ...patch.server };
      cfg = next;
      return cfg;
    },
    readJson: async (req) => req,
    HttpError,
  };
}

test('the owner route reads and sets the chosen file, keeps other settings, clears it, and refuses a bad name', async () => {
  const ctx = fakeCtx({ server: { roots: ['/home/alex/projects'] } });
  const f = herSigninFeature(ctx);
  const get = f.routes.find(([m]) => m === 'GET')[2];
  const post = f.routes.find(([m]) => m === 'POST')[2];
  assert.deepEqual(await get(), { file: null });
  assert.deepEqual(await post({ file: 'shop/shop.token' }), { file: 'shop/shop.token' });
  assert.equal(herGitSigninFile(ctx.config()), 'shop/shop.token');
  assert.ok(Number.isInteger(ctx.config().server.herGitSignin.at));
  assert.deepEqual(ctx.config().server.roots, ['/home/alex/projects']); // another server setting survives
  assert.deepEqual(await get(), { file: 'shop/shop.token' });
  // Clearing it: everything is as today.
  assert.deepEqual(await post({ file: '' }), { file: null });
  assert.equal(herGitSigninFile(ctx.config()), null);
  // A name that could lead out of the credentials folder is refused, and changes nothing.
  await post({ file: 'shop/token' });
  await assert.rejects(() => post({ file: '../../etc/passwd' }), (e) => e.status === 400 && /credentials folder/.test(e.message));
  await assert.rejects(() => post({ file: '/etc/passwd' }), (e) => e.status === 400);
  assert.equal(herGitSigninFile(ctx.config()), 'shop/token');
});

test('the git sign-in cannot be chosen through Tia\'s door', () => {
  const refused = (method, p, body = {}) => {
    try {
      checkRoute(method, p, body, { config: () => ({}) });
      return false;
    } catch (e) {
      return e.status === 403 && e.code === 'tia-route';
    }
  };
  // /api/hersignin and its check are no routes of her door — this computer's, or behind a computer's prefix.
  assert.ok(refused('POST', '/api/hersignin'));
  assert.ok(refused('GET', '/api/hersignin'));
  assert.ok(refused('POST', '/api/hersignin/check'));
  assert.ok(refused('POST', '/m/alpha/api/hersignin'));
  // Her /api/settings door will not carry the choice either (settingsBody: it is the owner's setting).
  assert.ok(refused('POST', '/api/settings', { server: { herGitSignin: { file: 'shop/token' } } }));
});

test('the git sign-in is chosen, and checked, only from the owner\'s own page: a token or another computer is refused (decision 7)', async () => {
  // ctx.caller(req): only 'page' (the owner's own signed-in page) may choose the file or run the check; 'computer' (a
  // token / another computer) and 'self' (Tia's door) are refused — the same owner-page guard, and the machines gate
  // (TOKEN_FORBIDDEN) refuses a token before the route is reached.
  const choose = (f) => f.routes.find(([m, re]) => m === 'POST' && re.test('/api/hersignin'))[2];
  const check = (f) => f.routes.find(([m, re]) => m === 'POST' && re.test('/api/hersignin/check'))[2];
  for (const who of ['computer', 'self']) {
    const ctx = fakeCtx({ server: {} });
    ctx.caller = () => who;
    const f = herSigninFeature(ctx);
    await assert.rejects(() => choose(f)({ file: 'shop/token' }), (e) => e.status === 403, who);
    await assert.rejects(() => check(f)({}), (e) => e.status === 403, who);
    assert.equal(herGitSigninFile(ctx.config()), null, `nothing was chosen from ${who}`);
  }
  // The owner's own page ('page') still chooses the file.
  const ctx = fakeCtx({ server: {} });
  ctx.caller = () => 'page';
  assert.deepEqual(await choose(herSigninFeature(ctx))({ file: 'shop/token' }), { file: 'shop/token' });
  assert.equal(herGitSigninFile(ctx.config()), 'shop/token');
});
