// Who may change what the hub shares: the owner's own page only. A machine token, Tia's door, a session, a linked
// computer and a request without the owner's login are refused, over a real dashboard.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { madeUpKey } from './helpers.mjs';

const box = sandbox('hubprov-routes');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { sharing, isKept } = await import('../../src/hubprov/list.mjs');
const { hubprovFeature } = await import('../../src/hubprov/feature.mjs');

saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
writeProfile('mykey', { label: 'My key', env: { ANTHROPIC_API_KEY: madeUpKey('k'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } });
const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {} };
const app = createServer({ backend, watch: false });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(() => { app.close(); box.cleanup(); });

const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const { token } = createToken('a hub');
const send = async (method, p, { headers = {}, body } = {}) => {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, text: await r.text() };
};
const owner = { Cookie: cookie, Origin: base };

test('the owner\'s own page turns the switch off and on, and keeps a provider to this computer', async () => {
  assert.equal(sharing(), true, 'on by default');
  let r = await send('POST', '/api/hubprov/switch', { headers: owner, body: { on: false } });
  assert.equal(r.status, 200, r.text);
  assert.equal(sharing(), false);
  r = await send('POST', '/api/hubprov/switch', { headers: owner, body: { on: true } });
  assert.equal(sharing(), true);
  r = await send('POST', '/api/hubprov/mykey/keep', { headers: owner, body: { on: true } });
  assert.equal(r.status, 200, r.text);
  assert.equal(isKept('mykey'), true);
  assert.equal((await send('POST', '/api/hubprov/nosuch/keep', { headers: owner, body: { on: true } })).status, 404);
  assert.equal((await send('POST', '/api/hubprov/mykey/keep', { headers: owner, body: { on: 'yes' } })).status, 400);
  await send('POST', '/api/hubprov/mykey/keep', { headers: owner, body: { on: false } });
  const state = JSON.parse((await send('GET', '/api/hubprov/state', { headers: owner })).text);
  assert.deepEqual(state.kept, []);
  assert.equal(state.sharing, true);
});

test('a machine token, no login and another site are refused: the right cannot be granted by who wants it', async () => {
  const bearer = { Authorization: `Bearer ${token}` };
  for (const [m, p, b] of [['POST', '/api/hubprov/switch', { on: false }], ['POST', '/api/hubprov/mykey/keep', { on: true }], ['GET', '/api/hubprov/state'], ['POST', '/api/hubprov/push', { providers: [] }]]) {
    const t = await send(m, p, { headers: bearer, body: b });
    assert.equal(t.status, 403, `${p} with a token: ${t.text}`);
    assert.ok([401, 403].includes((await send(m, p, { body: b })).status), `${p} without a login`);
    if (m === 'POST') assert.equal((await send(m, p, { headers: { Cookie: cookie, Origin: 'https://evil.example.com' }, body: b })).status, 403, `${p} from another site`);
  }
  assert.equal(sharing(), true);
  assert.equal(isKept('mykey'), false);
});

test('Tia\'s door (a request of this server\'s own) and a linked computer are refused by the route itself', async () => {
  const mk = (caller) => hubprovFeature({ HttpError: class extends Error { constructor(s, m) { super(m); this.status = s; } }, caller: () => caller, readJson: async () => ({ on: false }), listening: () => null }, { machines: null, pushMs: 1e6 });
  for (const caller of ['self', 'computer']) {
    const f = mk(caller);
    for (const [method, re] of [['POST', /switch/], ['POST', /keep/], ['GET', /state/]]) {
      const [, , fn] = f.routes.find(([m, r]) => m === method && r.source.includes(re.source));
      await assert.rejects(Promise.resolve().then(() => fn({}, ['', 'mykey'])), (e) => e.status === 403, `${caller} ${re}`);
    }
    f.close();
  }
  assert.equal(sharing(), true);
});

test('the list is for a link stream only: on the dashboard it is 404 for the owner too', async () => {
  assert.equal((await send('GET', '/api/hubprov/list', { headers: owner })).status, 404);
  assert.equal((await send('GET', '/hubp/list', { headers: owner })).status, 404);
});

test('the assistant\'s list of acts holds these routes only as acts that are not hers', async () => {
  const fs = await import('node:fs');
  const rows = JSON.parse(fs.readFileSync(new URL('../../src/assistant/inventory.json', import.meta.url), 'utf8')).rows || [];
  const mine = rows.filter((r) => /hubprov/.test(r.act));
  assert.equal(mine.length, 3);
  for (const r of mine) assert.ok(r.not && !r.hers, `${r.act} is not hers`);
});

test('a start on a hub row while the hub is off: the words, not a failure inside the coding tool; and the rows show in the list', async () => {
  const { saveRows } = await import('../../src/hubprov/rows.mjs');
  const os = await import('node:os');
  const row = { name: 'hub-shared', hubRow: 'shared', label: 'Shared key', kind: 'api', paid: false, signin: false, limited: null, hubLabel: 'Hub A', offline: true };
  saveRows({ port, rows: [row] });
  const owner2 = { ...owner, 'Content-Type': 'application/json' };
  const accounts = JSON.parse((await send('GET', '/api/accounts', { headers: owner })).text).accounts;
  const mine = accounts.find((a) => a.name === 'hub-shared');
  assert.ok(mine && mine.hub === true && mine.hubOffline === true, 'the row is in the list with its mark');
  assert.ok(!JSON.stringify(accounts).includes('hop_hl_'), 'no key in the list');
  const r = await send('POST', '/api/sessions', { headers: owner2, body: { dir: os.homedir(), profile: 'hub-shared', mode: 'new' } });
  assert.equal(r.status, 409, r.text);
  assert.match(r.text, /Your hub Hub A is offline: pick another provider\./, 'this computer has a provider of its own (mykey)');
  saveRows({ port, rows: [{ ...row, offline: false }] });
  const live = await send('POST', '/api/sessions', { headers: owner2, body: { dir: os.homedir(), profile: 'hub-shared', mode: 'new' } });
  assert.doesNotMatch(live.text, /is offline/);
});

test('her door refuses each route of provider sharing, also through a linked computer and with a confirmation', async () => {
  const { checkRoute } = await import('../../src/assistant/door.mjs');
  for (const p of ['/api/hubprov/switch', '/api/hubprov/mykey/keep', '/api/hubprov/push', '/api/hubprov/state', '/m/box2/api/hubprov/switch']) {
    for (const body of [{}, { on: false }, { confirm: 'box2' }]) {
      for (const method of ['POST', 'GET']) {
        assert.throws(() => checkRoute(method, p, body), (e) => e.status === 403, `${method} ${p}`);
      }
    }
  }
});
