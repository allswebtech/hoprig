// The workspace routes over real HTTP on a temporary home: behind the login (Tia's token and other sites refused),
// setup makes what is missing, the brain index and one item, a secret in a note never reaches the browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempHome, writeTree } from './helpers.mjs';

const t = tempHome('ws-feature');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

test('routes: login needed, setup, index, one item; ids only; secrets masked', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    for (const p of ['/api/workspace', '/api/brain', '/api/brain/item?id=brain:learnings', '/api/workspace/map', '/api/workspace/git', '/api/workspace/job']) {
      assert.equal((await fetch(origin + p)).status, 401, p);
      assert.equal((await fetch(origin + p, { headers: { Authorization: 'Bearer tia_0123456789abcdef' } })).status, 401, p);
    }
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = async (p) => {
      const r = await fetch(origin + p, { headers: { Cookie: cookie } });
      return { status: r.status, body: await r.json() };
    };
    const post = (p, body, o = origin) => fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: o, Cookie: cookie }, body: JSON.stringify(body) });

    const st = await get('/api/workspace');
    assert.equal(st.status, 200);
    assert.equal(st.body.exists, false);
    assert.equal(st.body.folders.length, 7);

    assert.equal((await post('/api/workspace/setup', {}, 'http://evil.example')).status, 403);
    assert.equal((await post('/api/workspace/setup', { dryRun: 'yes' })).status, 400);
    const dry = await (await post('/api/workspace/setup', { dryRun: true })).json();
    assert.equal(dry.dryRun, true);
    assert.equal(fs.existsSync(t.ws), false);
    const made = await (await post('/api/workspace/setup', {})).json();
    assert.ok(made.did.length >= 7);
    assert.equal(made.status.exists, true);
    assert.ok(made.status.folders.every((f) => f.exists));

    writeTree(path.join(t.ws, 'ai_brain'), { 'learnings.md': '# Learnings\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' });
    const ix = await get('/api/brain');
    assert.equal(ix.status, 200);
    assert.equal(ix.body.brain.learnings.id, 'brain:learnings');
    const item = await get('/api/brain/item?id=brain:learnings');
    assert.equal(item.status, 200);
    assert.match(item.body.text, /^# Learnings/);
    assert.ok(!JSON.stringify(item.body).includes('ghp_abcdef'), 'the token never reaches the browser');
    assert.equal(item.body.masked, true);
    assert.equal((await get(`/api/brain/item?id=${encodeURIComponent('../../etc/passwd')}`)).status, 400);
    assert.equal((await get(`/api/brain/item?id=${encodeURIComponent(path.join(t.ws, 'ai_brain', 'learnings.md'))}`)).status, 400);
    assert.equal((await get('/api/brain/item?id=brain:nothing')).status, 404);
    assert.equal((await get('/api/brain/item')).status, 400);
  } finally {
    await app.close();
  }
});

test('the git routes: input checked, one background job at a time with its lines and result, the terminal for signing in, nothing secret back', async () => {
  const { Readable } = await import('node:stream');
  const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
  const created = [];
  let release;
  const sctx = {
    config: () => ({}),
    readJson: async (req) => req.body || {},
    backend: { list: async () => [{ session: 'git-setup' }], create: async (o) => created.push(o) },
    deck: { launcher: () => ['node', 'hoprig.mjs'] },
  };
  const f = workspaceFeature(sctx, {
    sync: async ({ onLine, push }) => {
      onLine(`syncing ${push ? 'with' : 'without'} push`);
      await new Promise((r) => (release = r));
      return { repos: [{ label: 'ai_brain', did: ['pulled 1'], todo: [] }], done: 1, todo: 0 };
    },
    gitState: async () => ({ git: true, identity: { name: 'Alex', email: 'alex@example.invalid' }, gh: { installed: true, signedIn: true, account: 'alex' }, helper: true, brain: { exists: true, git: true, remote: 'https://git.example.test/alex/ai_brain.git' } }),
  });
  const call = async (method, p, body, headers = {}) => {
    const u = new URL(p, 'http://x');
    for (const [m, re, fn] of f.routes) {
      const match = re.exec(u.pathname);
      if (match && m === method) return fn(Object.assign(Readable.from([]), { body, headers }), match, u.searchParams);
    }
    throw new Error(`no route ${method} ${p}`);
  };
  const refused = async (p, body, status) => assert.rejects(call('POST', p, body), (e) => e.status === status, `${p} ${JSON.stringify(body)}`);
  await refused('/api/workspace/sync', { push: 'yes' }, 400);
  await refused('/api/workspace/sync', { force: true }, 400);
  await refused('/api/workspace/sync', { with: '../x' }, 400);
  await refused('/api/workspace/sync', { with: 'box2', push: true }, 400);
  await refused('/api/workspace/restore', { url: '' }, 400);
  await refused('/api/workspace/restore', { url: 'not an address', dryRun: true }, 400);
  await refused('/api/workspace/settings', { dir: 42 }, 400);
  await refused('/api/workspace/settings', { dir: 'relative/folder' }, 400);
  await refused('/api/workspace/forget', { name: '../../etc' }, 400);
  await refused('/api/workspace/forget', { name: 'shop' }, 404);
  await assert.rejects(call('GET', '/api/workspace/map', undefined, { authorization: 'Bearer tia_0123456789abcdef' }), (e) => e.status === 403);

  assert.deepEqual(await call('POST', '/api/workspace/sync', { push: true }), { started: true, kind: 'sync' });
  await refused('/api/workspace/sync', {}, 409);
  const running = await call('GET', '/api/workspace/job?from=0');
  assert.deepEqual([running.kind, running.running, running.lines], ['sync', true, ['syncing with push']]);
  release();
  await new Promise((r) => setTimeout(r, 20));
  const done = await call('GET', '/api/workspace/job?from=1');
  assert.deepEqual([done.running, done.lines, done.result.ok, done.result.data.repos[0].did], [false, [], true, ['pulled 1']]);

  const git = await call('GET', '/api/workspace/git');
  assert.deepEqual(git.gh, { installed: true, signedIn: true, account: 'alex' });
  assert.deepEqual(git.start, { method: 'POST', path: '/api/workspace/git/terminal' });
  const term = await call('POST', '/api/workspace/git/terminal', {});
  assert.equal(term.session, 'git-setup-2');
  assert.deepEqual(created[0].argv, ['node', 'hoprig.mjs', 'workspace', 'git']);

  const map = await call('GET', '/api/workspace/map');
  assert.equal(map.exists, false);
  const made = await call('POST', '/api/workspace/map', { dryRun: true });
  assert.equal(made.dryRun, true);
});
