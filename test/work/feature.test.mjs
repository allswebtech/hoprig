// The Work routes over real HTTP on a temporary computer: behind the login (Tia's token and other sites refused);
// every id and folder from the browser checked on the server; nothing of a file outside the Work folder can be
// read or written through them; no full path in an answer; the settings move the data only inside the workspace.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FIXTURE, tempWork, write } from './helpers.mjs';

const t = tempWork('work-feature');
test.after(() => t.cleanup());
const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

// tempWork() gave this server a workspace of its own (never the real one, which a dashboard maps when it starts).
assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));
fs.mkdirSync(path.join(t.projects, 'blog'), { recursive: true });
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/deadlines.json': fs.readFileSync(FIXTURE, 'utf8') });
write(t.root, { 'outside/tasks.json': '{"items":[{"id":"secret-item","title":"Not for the page"}]}\n' });
write(shop, { 'docs/notes.md': 'private notes\n' });

test('routes: login, ids and folders checked, nothing outside the Work file, Save shows its plan first', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (const p of ['/api/work', '/api/work/save']) {
      assert.equal((await fetch(origin + p)).status, 401, p);
      assert.equal((await fetch(origin + p, { headers: { Authorization: 'Bearer tia_0123456789abcdef' } })).status, 401, p);
    }
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = async (p) => {
      const r = await fetch(origin + p, { headers: { Cookie: cookie } });
      return { status: r.status, body: await r.json() };
    };
    const post = async (p, body, o = origin, extra = {}) => {
      const r = await fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: o, Cookie: cookie, ...extra }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    };
    const noPath = (body, what) => assert.ok(!JSON.stringify(body).includes(t.root), `${what}: no full path`);

    // No AI brain yet: the page is told why, in words, and what to do.
    let w = await get('/api/work');
    assert.equal(w.status, 200);
    assert.match(w.body.problem, /no AI brain in the workspace yet/);
    assert.deepEqual(w.body.projects, ['blog', 'shop']);

    // Point Work at the shop's planning folder; folders and projects from the browser are checked here.
    for (const bad of [{ place: 'project', project: 'shop', path: '../../outside' }, { place: 'project', project: '..', path: 'x' }, { place: 'project', project: 'shop', path: '/etc' }, { place: 'project', project: 'nope', path: 'docs' }, { place: 'brain', extra: 1 }]) {
      const r = await post('/api/work/settings', bad);
      assert.ok([400, 409].includes(r.status), JSON.stringify(bad));
    }
    fs.symlinkSync(path.join(t.root, 'outside'), path.join(shop, 'away'));
    assert.equal((await post('/api/work/settings', { place: 'project', project: 'shop', path: 'away' })).status, 409, 'a link out is refused');
    assert.equal((await post('/api/work/settings', { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' }, 'http://evil.example')).status, 403);
    let r = await post('/api/work/settings', { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' });
    assert.equal(r.status, 200);
    assert.equal(loadConfig().work.path, 'docs/plans');

    w = await get('/api/work');
    assert.equal(w.status, 200);
    assert.equal(w.body.place.label, 'shop/docs/plans');
    assert.equal(w.body.place.fileName, 'deadlines.json');
    assert.equal(w.body.items.length, 9);
    assert.ok(w.body.todayView.needsYou.length >= 1);
    noPath(w.body, 'GET /api/work');

    // Add, edit, status, remove: each id checked; unknown fields refused.
    r = await post('/api/work/items', { title: 'Renew the domain', date: '2026-12-01', project: 'shop', by: 'ai' });
    assert.equal(r.status, 200);
    assert.equal(r.body.item.id, 'renew-the-domain');
    assert.equal(r.body.item.by, 'ai');
    assert.equal((await post('/api/work/items', { title: 'Renew the domain', file: '/etc/passwd' })).status, 400);
    assert.equal((await post('/api/work/items', { title: 'Renew the domain', project: 'elsewhere' })).status, 400);
    assert.equal((await post('/api/work/items', [1, 2])).status, 400);
    const at = r.body.item.at;
    assert.equal((await post('/api/work/items/renew-the-domain', { note: 'Use the yearly plan' })).status, 400, 'the place goes with the id');
    assert.equal((await post('/api/work/items/renew-the-domain', { at, note: 'Use the yearly plan', priority: 'high' })).body.item.note, 'Use the yearly plan');
    for (const id of ['..%2F..%2Foutside%2Ftasks', 'secret-item', '%E0%A4%A', 'UPPER', '-x']) {
      const e = await post(`/api/work/items/${id}`, { at, title: 'A new title' });
      assert.ok([400, 404, 409].includes(e.status), `${id} → ${e.status}`);
      assert.ok(!JSON.stringify(e.body).includes('Not for the page'));
    }
    assert.equal((await post('/api/work/items/renew-the-domain/status', { at, status: 'done' })).body.item.status, 'done');
    assert.equal((await post('/api/work/items/renew-the-domain/status', { at, status: 'done' })).status, 409, 'already done');
    assert.equal((await post('/api/work/items/renew-the-domain/status', { at, status: 'finished' })).status, 400);
    assert.equal((await post('/api/work/items/renew-the-domain/status', { at, status: 'open', more: 1 })).status, 400);
    const trial = (await get('/api/work')).body.items.find((x) => x.id === 'trial-ends').at;
    const plan = await post('/api/work/items/trial-ends/remove', { at: trial });
    assert.equal(plan.status, 409, 'an item from a plan is not removed');
    assert.match(plan.body.error, /drop it instead/);
    assert.equal((await post('/api/work/items/trial-ends/status', { at: trial, status: 'dropped' })).status, 200);
    assert.equal((await post('/api/work/items/renew-the-domain/remove', { at })).status, 200);
    assert.equal((await post('/api/work/items/renew-the-domain/remove', { at })).status, 409, 'gone: its place holds another now');
    // Tia's token never gets past the login gate over HTTP (a bearer token is not her door): 401.
    const tia = await post('/api/work/items', { title: 'Book the venue' }, origin, { Authorization: 'Bearer tia_0123456789abcdef' });
    assert.equal(tia.status, 401);
    // And each route refuses it by itself too, should a request with it ever reach the route.
    const { workFeature } = await import('../../src/work/feature.mjs');
    const { Readable } = await import('node:stream');
    const feature = workFeature({ config: loadConfig, readJson: async () => ({ title: 'Book the venue' }), saveConfig });
    assert.ok(feature.routes.length >= 11);
    for (const [method, re, fn] of feature.routes) {
      const p = re.source.replace(/\\\//g, '/').replace(/^\^|\$$/g, '').replace('([^/]+)', 'renew-the-domain');
      const req = Object.assign(Readable.from([]), { headers: { authorization: 'Bearer tia_0123456789abcdef' } });
      await assert.rejects(fn(req, re.exec(p) || [p, 'renew-the-domain'], new URLSearchParams()), (e) => e.status === 403 && e.message === 'Work is the owner\'s only for now', `${method} ${p}`);
    }
    assert.equal((await get('/api/work')).body.items.some((x) => x.title === 'Book the venue'), false, 'nothing was added');

    // Save: the plan first (no full path), then the commit of that file only.
    const preview = await get('/api/work/save');
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.files, [{ path: 'docs/plans/deadlines.json', state: 'changed' }]);
    assert.deepEqual(preview.body.changes.map((c) => [c.id, c.what]), [['trial-ends', 'dropped']]);
    noPath(preview.body, 'GET /api/work/save');
    assert.equal((await post('/api/work/save', { push: true })).status, 400);
    const saved = await post('/api/work/save', {});
    assert.equal(saved.status, 200);
    assert.equal(saved.body.ok, true, saved.body.message);
    assert.equal(saved.body.sent, true);
    noPath(saved.body, 'POST /api/work/save');
    assert.deepEqual(t.git(shop, 'show', '--name-only', '--format=%s', 'HEAD').split('\n').filter(Boolean), ['Update work items', 'docs/plans/deadlines.json']);
    assert.ok(t.git(shop, 'status', '--porcelain').includes('docs/notes.md'), 'the other file is left as it was');

    // A hand edit a write would alter: the page is told what, a change is refused, and Tidy shows the difference
    // and writes only with the hash of what it showed.
    const listFile = path.join(shop, 'docs/plans/deadlines.json');
    const handEdited = fs.readFileSync(listFile, 'utf8').replace('"updated": "2026-11-15"', '"updated": "2026-11-15", "rev": 1.0');
    fs.writeFileSync(listFile, handEdited);
    w = await get('/api/work');
    assert.deepEqual(w.body.untidy.map((a) => a.kind), ['number', 'layout']);
    const refused = await post('/api/work/items', { title: 'Something to do' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'untidy');
    assert.equal(fs.readFileSync(listFile, 'utf8'), handEdited);
    const diff = await get('/api/work/tidy');
    assert.ok(diff.body.diff.some((d) => d.op === '-' && d.text.includes('"rev": 1.0')));
    assert.equal((await post('/api/work/tidy', { hash: 'f'.repeat(32) })).status, 409);
    assert.equal((await post('/api/work/tidy', {})).status, 400);
    assert.equal((await post('/api/work/tidy', { hash: diff.body.hash })).body.written, true);
    assert.equal((await get('/api/work')).body.untidy, undefined);
    assert.equal((await post('/api/work/items', { title: 'Something to do' })).status, 200);

    // A broken list is reported, never overwritten.
    fs.writeFileSync(path.join(shop, 'docs/plans/deadlines.json'), '{ broken');
    w = await get('/api/work');
    assert.match(w.body.problem, /not valid JSON/);
    assert.equal((await post('/api/work/items', { title: 'Something to do' })).status, 409);
    assert.equal(fs.readFileSync(path.join(shop, 'docs/plans/deadlines.json'), 'utf8'), '{ broken');
  } finally {
    await app.close();
  }
});
