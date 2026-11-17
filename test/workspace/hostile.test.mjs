// The counts of the projects page and of Workspace read repositories the dashboard did not make. When their own git
// settings name programs (test/fixtures/hostile-repo.mjs: the brain, a project, its code repository and a plain
// repository all like that), none of them starts over the real routes of a sandboxed dashboard, and the counts are
// still right.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { hostileRepo } from '../fixtures/hostile-repo.mjs';
import { tempHome } from './helpers.mjs';

const posix = process.platform !== 'win32';
const t = tempHome('ws-hostile');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

test('project and workspace counts start none of a folder\'s own programs, and count right', { skip: !posix && 'the programs are shell scripts' }, async () => {
  const marks = path.join(t.root, 'marks');
  const projects = path.join(t.ws, 'projects');
  const all = [
    hostileRepo(path.join(t.ws, 'ai_brain'), marks),
    hostileRepo(path.join(projects, 'shop'), marks),
    hostileRepo(path.join(projects, 'shop', 'code', 'web'), marks),
    hostileRepo(path.join(projects, 'loose'), marks),
  ];
  const ran = () => [...new Set(all.flatMap((h) => h.ran()))].sort();
  all[0].clear();

  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const read = async (p) => {
      all[0].clear();
      const r = await fetch(origin + p, { headers: { Cookie: cookie } });
      const body = await r.json();
      assert.equal(r.status, 200, `${p}: ${JSON.stringify(body)}`);
      assert.deepEqual(ran(), [], `${p} started a program a folder's git settings name`);
      return body;
    };

    const pr = await read('/api/pcsetup/projects');
    const shop = pr.workspaces.find((w) => w.id === 'shop');
    assert.ok(shop, JSON.stringify(pr));
    const counts = Object.fromEntries(shop.repos.map((r) => [r.rel, [r.ok, r.branch, r.changes]]));
    // a.txt changed and new.txt new in each; the parent also sees its code folder's files as new.
    assert.deepEqual(counts['code/web'], [true, 'main', 2]);
    assert.equal(counts['.'][0], true);
    assert.ok(counts['.'][2] >= 2);
    const loose = pr.repos.find((r) => r.id === 'loose');
    assert.deepEqual([loose.ok, loose.branch, loose.changes], [true, 'main', 2]);

    const g = await read('/api/workspace/git');
    assert.equal(g.brain.git, true);
    assert.deepEqual([g.brain.branch, g.brain.changes], ['main', 2]);

    const m = await read('/api/workspace/map');
    assert.ok(Array.isArray(m.entries));
    await read('/api/workspace');
  } finally {
    await app.close();
  }
});
