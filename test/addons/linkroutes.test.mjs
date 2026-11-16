// The routes of Settings → Public link over real HTTP (src/addons/linkroutes.mjs): the state with both kinds
// explained by data, the checks before a turn-on (a password typed once when it was never judged, a weak one
// refused with its plain reason), and the password change that refuses a weak one while the link is on. Nothing
// here starts a tunnel: every turn-on is refused before that, and no add-on is attached.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('linkroutes');
test.after(() => box.cleanup());

const { loadConfig, saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, addons: { addons: [] } });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => app.close());

let cookie = '';
const call = async (p, body) => {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const c = r.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  return { status: r.status, json: await r.json() };
};

test('the state explains both kinds and what a visitor meets; it is behind the sign-in and carries no secret', async () => {
  assert.equal((await call('/api/public-link')).status, 401);
  await call('/api/login', { password: 'right-password' });
  const s = (await call('/api/public-link')).json;
  assert.deepEqual([s.on, s.kind, s.state, s.url], [false, 'temporary', 'off', null]);
  assert.deepEqual(s.kinds.map((k) => [k.id, k.title, k.ready]), [['temporary', 'Temporary', true], ['custom', 'Custom', false]]);
  for (const k of s.kinds) for (const f of ['text', 'needs', 'gives']) assert.ok(k[f].length > 20, `${k.id}.${f}`);
  assert.match(s.visitor, /sign-in page/);
  assert.equal(s.custom.state, 'none');
  assert.deepEqual(s.password, { state: 'strong', why: null }, 'judged at the sign-in above');
  assert.ok(!JSON.stringify(s).includes(loadConfig().server.passwordHash.slice(10)), 'not the hash');
});

test('a turn-on: a bad body is refused; a password never judged is typed once (wrong: refused); Custom needs its set-up first', async () => {
  assert.equal((await call('/api/public-link', { on: 'yes' })).status, 400);
  assert.equal((await call('/api/public-link', { on: true, kind: 'both' })).status, 400);
  assert.equal((await call('/api/public-link', { on: true, password: 7 })).status, 400);
  saveConfig({ server: { passwordCheck: undefined } }); // as after an update: the stored password was never judged
  let r = (await call('/api/public-link', { on: true, kind: 'custom' })).json;
  assert.deepEqual([r.ok, r.need], [false, 'check-password']);
  assert.match(r.error, /Type your dashboard password once/);
  assert.equal((await call('/api/public-link', { on: true, kind: 'custom', password: 'not-it' })).status, 403);
  r = (await call('/api/public-link', { on: true, kind: 'custom', password: 'right-password' })).json;
  assert.deepEqual([r.ok, r.need], [false, 'custom-setup'], 'judged strong; then the next step is the set-up');
  assert.equal((await call('/api/public-link')).json.password.state, 'strong');
  assert.equal(loadConfig().publicLink, undefined, 'nothing was switched');
  assert.equal((await call('/api/public-link/custom/nope', {})).status, 404);
  assert.equal((await call('/api/public-link/temporary/sign-in', {})).status, 404);
});

test('a weak password: the turn-on says why and asks for a stronger one; while the link is on, a weak new one is refused', async () => {
  assert.equal((await call('/api/settings/password', { current: 'right-password', next: 'weakpass1' })).status, 200);
  const r = (await call('/api/public-link', { on: true, kind: 'temporary' })).json;
  assert.deepEqual([r.ok, r.need], [false, 'stronger-password']);
  assert.match(r.error, /too weak for a public link: it has fewer than 12 characters/);
  // The page's "Make a strong password": a strong one passes the same check.
  assert.equal((await call('/api/settings/password', { current: 'weakpass1', next: 'a-much-longer-pass' })).status, 200);
  assert.equal((await call('/api/public-link')).json.password.state, 'strong');
  saveConfig({ publicLink: { on: true, kind: 'temporary' } }); // on (no add-on runs here, so nothing starts)
  const weak = await call('/api/settings/password', { current: 'a-much-longer-pass', next: 'weakpass2' });
  assert.equal(weak.status, 400);
  assert.match(weak.json.error, /public link is on, so the new password must be strong: it has fewer than 12 characters/);
  saveConfig({ publicLink: undefined });
});
