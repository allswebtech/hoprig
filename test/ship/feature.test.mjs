// Go live through the dashboard's routes (src/ship/feature.mjs): the owner's own page only (the assistant's token,
// another token, another origin are refused); a yes holds only for the hash of what the page showed; the whole path
// put together → confirm → check → tap → live, then a take-back; no full path in any answer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { oneCall } from '../onecall.mjs';
import { tempShip, write } from './helpers.mjs';
import { DEPLOY, SERVER, manifest } from './fixtures/shop.mjs';

const t = tempShip('ship-feature');
const shop = path.join(t.projects, 'shop');
test.after(() => {
  try {
    process.kill(Number(fs.readFileSync(path.join(shop, 'run', 'server.pid'), 'utf8')), 'SIGKILL');
  } catch {
    /* none */
  }
  t.cleanup();
});
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
// tempShip gives this dashboard a workspace of its own (HOPRIG_WORKSPACE_DIR in its root): never the real one.
assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));
const port = await new Promise((res) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
t.repo(shop, { 'server.mjs': SERVER, 'deploy.mjs': DEPLOY, 'port.txt': String(port), 'project.json': manifest(port), '.gitignore': 'run/\ndata/\n' });
write(shop, { 'data/db.json': '{"orders":1}\n' });
t.branch(shop, 'work/banner', { 'banner.txt': 'sale\n' }, 'A banner');

test('routes: owner only, a yes for what was shown, put together, check, live, take back', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] } });
  // The computer that runs the suite may be busy: the check's overload rule has its own test (check.test.mjs).
  const app = createServer({ backend: { kind: 'tmux', list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, ship: { busy: () => ({ over: false, why: null }) } });
  const { port: dash } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${dash}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    // Each call on a connection of its own (test/onecall.mjs): a check and a go-live run between calls here, and no
    // request is sent on a kept-alive connection the server may be closing meanwhile.
    const get = async (p, extra = {}) => {
      const r = await oneCall(origin, 'GET', p, { headers: { Cookie: cookie, ...extra } });
      return { status: r.status, body: r.json };
    };
    const post = async (p, body, o = origin, extra = {}) => {
      const r = await oneCall(origin, 'POST', p, { headers: { Origin: o, Cookie: cookie, ...extra }, body });
      return { status: r.status, body: r.json };
    };
    const noPath = (body, what) => assert.ok(!JSON.stringify(body).includes(t.root), `${what}: no full path`);

    assert.equal((await fetch(`${origin}/api/ship/p/shop`)).status, 401);
    // A token is refused before the page's login counts: by its own feature (401) or by this one (403).
    for (const tok of ['tia_0123456789abcdef', 'hop_0123456789abcdef', 'x']) assert.ok([401, 403].includes((await get('/api/ship/p/shop', { Authorization: `Bearer ${tok}` })).status), tok);
    assert.equal((await post('/api/ship/p/shop/together', { name: 'x', branches: ['work/banner'] }, 'http://evil.example')).status, 403, 'another origin');
    assert.equal((await get('/api/ship/p/..')).status, 404);

    let v = await get('/api/ship/p/shop');
    assert.equal(v.status, 200);
    noPath(v.body, 'view');
    assert.deepEqual(v.body.branches.map((b) => b.name), ['work/banner']);
    assert.equal(v.body.check.confirmed, false);
    assert.match(v.body.live.shown.update[0], /^node deploy\.mjs \{commit\}/);

    const tg = await post('/api/ship/p/shop/together', { name: 'friday', branches: ['work/banner'] });
    assert.equal(tg.status, 200, JSON.stringify(tg.body));
    noPath(tg.body, 'together');
    assert.equal(tg.body.finished, true);
    const id = tg.body.id;

    assert.equal((await post('/api/ship/p/shop/check', { id })).body.code, 'not-confirmed');
    assert.equal((await post('/api/ship/p/shop/allow', { kind: 'check', seen: '0'.repeat(64), id })).body.code, 'changed', 'a yes for other commands');
    v = await get('/api/ship/p/shop');
    assert.equal((await post('/api/ship/p/shop/allow', { kind: 'check', seen: v.body.check.shown.hash, id })).status, 200);
    const c = await post('/api/ship/p/shop/check', { id });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.check.state, 'ready');
    assert.equal(c.body.auto, null, 'the switch is off: nothing by itself');

    v = await get('/api/ship/p/shop');
    assert.equal((await post('/api/ship/p/shop/live', { id, seen: v.body.live.shown.hash })).body.code, 'not-confirmed');
    assert.equal((await post('/api/ship/p/shop/allow', { kind: 'live', seen: v.body.live.shown.hash, id })).status, 200);
    assert.equal((await post('/api/ship/p/shop/live', { id, seen: '1'.repeat(64) })).body.code, 'changed');
    v = await get('/api/ship/p/shop');
    assert.match(v.body.tap.update[0], /^node deploy\.mjs [0-9a-f]{40} {2}\(up to 2 min\)$/, 'the tap shows the commit that will run, with its time limit');
    assert.match(v.body.tap.back[0], /^node deploy\.mjs [0-9a-f]{40} {2}\(up to 2 min\)$/);
    assert.match(v.body.tap.commit, /^[0-9a-f]{12}$/, 'which commit is which, in short');
    assert.ok(v.body.tap.update[0].includes(v.body.tap.commit) && v.body.tap.back[0].includes(v.body.tap.before));
    assert.deepEqual(v.body.tap.keep, ['data'], 'the kept paths are on the sheet');
    const go = await post('/api/ship/p/shop/live', { id, seen: v.body.live.shown.hash });
    assert.equal(go.status, 200, JSON.stringify(go.body));
    await Promise.all(app.features.find((f) => f.name === 'ship').running());
    v = await get('/api/ship/p/shop');
    noPath(v.body, 'after');
    assert.equal(v.body.last.outcome, 'live', v.body.last.why);
    // The take-back sheet shows what takeBack will run: this step's own back, with {before} filled in.
    assert.equal(v.body.last.back.length, 1);
    assert.match(v.body.last.back[0], /^node deploy\.mjs [0-9a-f]{40} {2}\(up to 2 min\)$/);
    assert.equal(v.body.step, null);

    const b = await post('/api/ship/p/shop/back', {});
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.outcome, 'taken-back');
    // A view that read the journal before the step ended and its last record after: the step is not also "under way".
    const { readLast } = await import('../../src/ship/live.mjs');
    const { gitFolder } = await import('../../src/ship/lock.mjs');
    const journal = path.join(await gitFolder(shop), 'hoprig-ship.json');
    fs.writeFileSync(journal, JSON.stringify({ ...readLast(fs.realpathSync(shop)), part: 'verify', outcome: null }));
    try {
      const seen = await app.features.find((f) => f.name === 'ship').view('shop');
      assert.equal(seen.step, null, 'the ended step is shown once, as its outcome');
      assert.equal(seen.last.outcome, 'taken-back');
    } finally {
      fs.rmSync(journal, { force: true });
    }
    assert.equal((await post('/api/ship/p/shop/auto', { on: true, typed: 'nope' })).body.code, 'typed');
    assert.equal((await post('/api/ship/p/shop/auto', { on: true, typed: 'shop' })).body.auto, true);
    assert.deepEqual(t.trapped(), []);
  } finally {
    await app.close();
  }
});
