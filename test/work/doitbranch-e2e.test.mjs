// "Do it" on a branch of its own end to end, on a real dashboard over HTTP with the stand-in Claude Code of the chat
// tests (test/chat/fixtures/fake-claude.mjs): the stand-in commits in the worktree of work/<id>, never in the owner's
// checkout; Accept leaves the branch (nothing merged, nothing pushed) and Go live lists it; "Remove the branch" keeps a
// branch with a commit only there, and removes one without; Drop of a task does the same removal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoTree, tempWork } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const t = tempWork('work-doitbranch-e2e');
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));
t.repo(t.brain, { 'README.md': '# brain\n' });
const shop = path.join(t.projects, 'shop');
const shopServer = t.repo(shop, { 'README.md': '# shop\n' });
// The allowed folders hold the state folder, as the home folder holds it on a person's computer.
saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.root] }, sessionDefaults: { permissionMode: 'manual' } });
writeProfile('sub', { label: 'Main' });
const trees = path.join(process.env.HOPRIG_STATE_DIR, 'work-trees');
const serverRefs = () => t.git(shopServer, 'for-each-ref', '--format=%(refname) %(objectname)');
const hasBranch = (b) => {
  try {
    t.git(shop, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`);
    return true;
  } catch {
    return false;
  }
};

const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last).slice(0, 400))})`);
};

let app;
let origin;
let cookie;
await (async () => {
  app = createServer({
    backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400, stopGraceMs: 1500 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  origin = `http://127.0.0.1:${port}`;
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
  cookie = login.headers.get('set-cookie').split(';')[0];
})();
test.after(async () => {
  await app?.close();
  t.cleanup();
});
const get = async (p) => {
  const r = await fetch(origin + p, { headers: { Cookie: cookie } });
  return { status: r.status, body: await r.json() };
};
const post = async (p, body) => {
  const r = await fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const itemOf = async (id) => (await get('/api/work')).body.items.find((i) => i.id === id);
async function addTask(title) {
  const r = await post('/api/work/items', { title, project: 'shop', by: 'ai' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.item;
}
const doIt = async (it, body = {}) => {
  const plan = (await get(`/api/work/items/${encodeURIComponent(it.id)}/do?at=${it.at}`)).body;
  return { plan, r: await post(`/api/work/items/${encodeURIComponent(it.id)}/do`, { at: it.at, seen: plan.brief, provider: 'sub', ...body }) };
};
const settled = (it) => until(`the run of ${it.id} to end`, async () => {
  const runs = (await get(`/api/work/runs?item=${it.id}`)).body.runs;
  return runs[0] && runs[0].state !== 'running' ? runs[0] : null;
});

test('the stand-in commits on work/<id> in a worktree; Accept leaves the branch, nothing merged or pushed; Go live lists it', async () => {
  const before = repoTree(shop);
  const refs0 = serverRefs();
  const it = await addTask('commit hello.txt');
  const { plan, r } = await doIt(it);
  assert.deepEqual(plan.branch, { name: `work/${it.id}`, again: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.run.branch, `work/${it.id}`);
  const chat = (await get('/api/chats')).body.chats.find((c) => c.chatId === r.body.run.session);
  assert.ok(chat, 'the session is a chat of the dashboard');
  assert.ok(chat.cwd.startsWith(`${fs.realpathSync(trees)}${path.sep}`), `the session's folder is the worktree: ${chat.cwd}`);
  const end = await settled(it);
  assert.equal(end.state, 'done', JSON.stringify(end));
  assert.equal(end.branch, `work/${it.id}`);
  assert.deepEqual(end.commits.map((c) => [c.repo, c.subject]), [['.', 'Add hello.txt']]);
  assert.deepEqual(end.changed, [{ repo: '.', path: 'hello.txt.draft', kind: 'new' }]);
  assert.ok(!end.answer.includes(t.root) && !end.answer.includes('work-trees'), end.answer);
  // The commit is on the branch, in the worktree under the state folder; the checkout is as it was.
  assert.equal(t.git(shop, 'log', '-1', '--format=%s', `work/${it.id}`), 'Add hello.txt');
  const wt = t.git(shop, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  assert.ok(wt.some((d) => d.startsWith(fs.realpathSync(trees))), wt.join(', '));
  assert.deepEqual(repoTree(shop).files, before.files, 'no file of the checkout changed');
  assert.equal(repoTree(shop).head, before.head);
  assert.equal(t.git(shop, 'symbolic-ref', '--short', 'HEAD'), 'main');

  const a = await post(`/api/work/items/${it.id}/accept`, { at: (await itemOf(it.id)).at });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal((await itemOf(it.id)).status, 'done');
  assert.ok(hasBranch(`work/${it.id}`), 'the branch stays');
  assert.equal(t.git(shop, 'rev-parse', 'main'), before.head, 'nothing merged into main');
  assert.equal(serverRefs(), refs0, 'nothing pushed');
  // A worktree with a file not committed is kept (Accept removes only a clean one), and Accept says so.
  assert.equal(a.body.worktree?.removed, false, JSON.stringify(a.body));
  const ship = await get('/api/ship/p/shop');
  assert.equal(ship.status, 200, JSON.stringify(ship.body));
  const b = ship.body.branches.find((x) => x.name === `work/${it.id}`);
  assert.ok(b, JSON.stringify(ship.body.branches));
  assert.equal(b.title, 'commit hello.txt');
});

test('Remove the branch: a commit only there keeps it, with why; Drop of a task without commits removes branch and worktree', async () => {
  const kept = await addTask('commit kept.txt');
  await doIt(kept);
  await settled(kept);
  // Its file left changed: the worktree keeps it.
  let rm = await post(`/api/work/items/${kept.id}/remove-branch`, {});
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  assert.equal(rm.body.removed, false);
  assert.match(rm.body.why, /files changed/);
  assert.ok(hasBranch(`work/${kept.id}`));
  // With the worktree clean, the commit only on that branch keeps it.
  const dir = t.git(shop, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).find((d) => d.includes(`work-${kept.id}`));
  fs.rmSync(path.join(dir, 'kept.txt.draft'));
  rm = await post(`/api/work/items/${kept.id}/remove-branch`, {});
  assert.equal(rm.body.removed, false);
  assert.match(rm.body.why, /1 commit of its own/);
  assert.ok(hasBranch(`work/${kept.id}`), 'never deleted with a commit only there');

  const plain = await addTask('slow 50');
  await doIt(plain);
  await settled(plain);
  assert.ok(hasBranch(`work/${plain.id}`));
  const dropped = await post(`/api/work/items/${plain.id}/status`, { at: (await itemOf(plain.id)).at, status: 'dropped' });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
  assert.deepEqual(dropped.body.branch, { removed: true, branch: `work/${plain.id}` });
  assert.equal(hasBranch(`work/${plain.id}`), false);
  const again = await post(`/api/work/items/${plain.id}/remove-branch`, {});
  assert.equal(again.body.removed, false, 'nothing left to remove');
  assert.match(again.body.why, /no record of its branch/);
  assert.equal((await post('/api/work/items/no-such-task/remove-branch', {})).status, 404);
  assert.equal((await post(`/api/work/items/${plain.id}/remove-branch`, { force: true })).status, 400, 'it takes nothing');
});

test('"In the project\'s folder itself": the stand-in commits in the checkout, on its branch, as before', async () => {
  const it = await addTask('commit inplace.txt');
  const { r } = await doIt(it, { inFolder: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.run.branch, null);
  const end = await settled(it);
  assert.equal(end.state, 'done');
  assert.equal(t.git(shop, 'log', '-1', '--format=%s', 'main'), 'Add inplace.txt');
  assert.equal(hasBranch(`work/${it.id}`), false, 'no branch made');
  assert.equal((await post(`/api/work/items/${it.id}/do`, { at: 0, seen: 'x', inFolder: 'yes' })).status, 400);
});
