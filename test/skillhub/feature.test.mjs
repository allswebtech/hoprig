// Settings → Skills on the server: owner-only (no login, a wrong token or Tia's token is refused over real HTTP),
// project folders must be inside the dashboard's folders, and the routes answer with the review flow.
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { sandbox, writeTree } from './helpers.mjs';

const box = sandbox('skills-feature');
test.after(() => box.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { skillhubFeature } = await import('../../src/skillhub/feature.mjs');

const inside = writeTree(path.join(box.home, 'proj'), { 'package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }) });
const outside = writeTree(path.join(box.root, 'elsewhere'), { 'README.md': 'x' });

test('owner-only over real HTTP: no login, a wrong bearer or Tia\'s token gets nothing', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [box.home] } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (const p of ['/api/skillhub', '/api/skillhub/suggest?project=/', '/api/skillhub/tools']) {
      assert.equal((await fetch(origin + p)).status, 401, p);
      assert.equal((await fetch(origin + p, { headers: { Authorization: 'Bearer tia_0123456789abcdef' } })).status, 401, p);
      assert.equal((await fetch(origin + p, { headers: { Authorization: 'Bearer not-a-token' } })).status, 401, p);
    }
    const post = await fetch(`${origin}/api/skillhub/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ spec: 'hoprig' }) });
    assert.equal(post.status, 401);
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const ok = await fetch(`${origin}/api/skillhub`, { headers: { Cookie: cookie } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).user.dir, path.join(box.claude, 'skills'));
    const cross = await fetch(`${origin}/api/skillhub/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example', Cookie: cookie }, body: JSON.stringify({ spec: 'hoprig' }) });
    assert.equal(cross.status, 403);
  } finally {
    await app.close();
  }
});

function harness() {
  const sctx = {
    config: () => ({ server: { roots: [box.home] } }),
    readJson: async (req) => req.body || {},
    notify: async () => ({ sent: false }),
  };
  const f = skillhubFeature(sctx, { toolRun: async () => ({ ok: true, code: 0, stdout: '1.0.0\n', stderr: '' }) });
  const call = async (method, p, body, headers = {}) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) {
      const match = re.exec(u.pathname);
      if (match && m === method) return fn(Object.assign(Readable.from([]), { body, headers }), match, u.searchParams);
    }
    throw new Error(`no route ${method} ${p}`);
  };
  return { f, call };
}

test('routes: suggest inside the roots only; review → approve → list → remove → undo; Tia refused in the feature too', async () => {
  const { call } = harness();
  await assert.rejects(call('GET', `/api/skillhub/suggest?project=${encodeURIComponent(outside)}`), (e) => e.status === 403);
  await assert.rejects(call('GET', '/api/skillhub/suggest?project=relative/x'), (e) => e.status === 400);
  await assert.rejects(call('GET', '/api/skillhub', undefined, { authorization: 'Bearer tia_abc' }), (e) => e.status === 403);
  const s = await call('GET', `/api/skillhub/suggest?project=${encodeURIComponent(inside)}`);
  assert.equal(s.suggestions[0].id, 'hoprig');
  assert.deepEqual(s.suggestions.find((x) => x.id === 'next-bundle-optimizer').why, ['package.json has next 16.0.0']);

  const r = await call('POST', '/api/skillhub/review', { spec: 'hoprig', project: inside, scope: 'user' });
  assert.equal(r.folder, undefined, 'the quarantine path stays on the server');
  assert.equal(r.pinned, true);
  assert.match(r.skillMd, /^---\nname: hoprig/);
  await call('POST', '/api/skillhub/approve', { id: r.id });
  const list = await call('GET', `/api/skillhub?project=${encodeURIComponent(inside)}`);
  assert.deepEqual(list.user.skills.map((x) => x.name), ['hoprig']);
  assert.deepEqual(list.project.skills, []);
  await assert.rejects(call('POST', '/api/skillhub/remove', { name: '../x' }), (e) => e.status === 400);
  await call('POST', '/api/skillhub/remove', { name: 'hoprig' });
  await call('POST', '/api/skillhub/undo', { name: 'hoprig' });
  assert.equal((await call('GET', '/api/skillhub')).user.skills.length, 1);
  const tools = await call('GET', '/api/skillhub/tools');
  assert.equal(tools.tools[0].npm, 'rea-agents');
  await assert.rejects(call('POST', '/api/skillhub/settings', { weekly: 'yes' }), (e) => e.status === 400);
  assert.equal((await call('POST', '/api/skillhub/settings', { weekly: true })).weekly, true);
});

test('the weekly check only tells: a notification, never an install', async () => {
  const notes = [];
  const sctx = { config: () => ({ server: { roots: [box.home] } }), readJson: async () => ({}), notify: async (ev) => notes.push(ev) };
  const f = skillhubFeature(sctx, { now: () => Date.now() + 8 * 24 * 3600_000 });
  const found = await f.weeklyCheck();
  assert.deepEqual(found, []); // the bundled skill is current
  assert.equal(notes.length, 0);
  assert.equal(await f.weeklyCheck(), null, 'not again within a week');
});
