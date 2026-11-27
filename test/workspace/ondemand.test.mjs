// A project comes to a computer only when its owner asks for it. On temporary homes with local bare repositories:
// restore on a second home gets the brain, the credentials repository, a group's own repository and the other
// repositories, NO project, and names each one; `get` brings a project's parent, its code repositories and its
// memory link; a get cut off in the middle (a clone killed half way) is finished by the next run, the cut-off clone
// moved aside under a dated name and never deleted; a repository the server no longer has is named with git's own
// reason and the rest goes on; the upkeep leaves a project with unpushed work (and one behind its server) exactly as
// it was; sync and status treat "in the map, not on this computer" as the normal state; `get --list` says who has
// what; the per-place switch pushes a branch that is not the default one, never the default branch, and never over
// the server's branch (behind, rewritten, somebody else's of the same name, removed there, a server that cannot be asked).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-ondemand');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const C = await import('../../src/workspace/computer.mjs');
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const { pushBranches } = await import('../../src/workspace/branchpush.mjs');
const { main } = await import('../../src/workspace/cli.mjs');
const { getMain } = await import('../../src/pcsetup/getproject.mjs');
const { capture } = await import('../../src/setup/system.mjs');

// The server: a brain whose map has two projects (one with a code repository and memory), a group that is a
// repository, another repository, a credentials repository, and a project whose code repository is gone.
const u = { brain: w.bare('brain', { empty: true }), creds: w.bare('creds'), kits: w.bare('kits'), tool: w.bare('tool'), shopParent: w.bare('shop-workspace'), shopApi: w.bare('shop-api'), blog: w.bare('blog'), gone: 'https://git.example.test/team/never-there.git' };
const A = w.computer('alpha');
A.use();
const brainA = path.join(A.ws, 'ai_brain');
w.sh(w.root, 'clone', '-q', u.brain, brainA);
fs.writeFileSync(path.join(brainA, 'BRAIN.md'), '# brain\n');
// shop's parent knows its code repository and memory (project.json), as `project new` makes it.
const seed = w.clone(u.shopParent, path.join(w.root, 'seed-shop'));
w.commit(seed, 'project.json', JSON.stringify({ name: 'shop', repos: [{ dir: 'code/shop-api', url: u.shopApi }, { dir: 'code/old-api', url: u.gone }], memories: { '.': 'ai_brain/claude-memory' } }, null, 2));
w.commit(seed, 'ai_brain/claude-memory/MEMORY.md', '# shop memory\n');
w.commit(seed, '.gitignore', '/code/*\n');
w.sh(seed, 'push', '-q');
const map = {
  version: 2,
  brain: { url: u.brain },
  credentials: { url: u.creds },
  groups: [{ dir: 'kits', url: u.kits, holds: [{ dir: 'builds' }] }],
  projects: [
    { name: 'shop', url: u.shopParent, memories: { '.': 'ai_brain/claude-memory' }, repos: [{ dir: 'code/shop-api', url: u.shopApi }, { dir: 'code/old-api', url: u.gone }] },
    { name: 'blog', url: u.blog, repos: [] },
  ],
  others: [{ dir: 'git/tool', url: u.tool }],
};
fs.writeFileSync(path.join(brainA, 'workspace.json'), JSON.stringify(map, null, 2) + '\n');
w.sh(brainA, 'add', '-A');
w.sh(brainA, 'commit', '-q', '-m', 'map');
w.sh(brainA, 'push', '-q', '-u', 'origin', 'main');

const B = w.computer('beta');
const q = async () => (await quietUi()).ui;
const real = (d) => fs.existsSync(path.join(d, '.git'));

test('restore on a second home: the brain, the credentials, the group\'s repository and the others; NO project, each named', async () => {
  B.use();
  const ui = await q();
  const r = await restoreWorkspace(u.brain, { ui, dir: B.ws, projects: B.projects });
  assert.equal(r.ok, true, JSON.stringify(r.plan));
  for (const d of ['ai_brain', 'credentials', 'kits', 'git/tool']) assert.ok(real(path.join(B.ws, d)), `${d} is cloned`);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(B.ws, 'credentials')).mode & 0o777, 0o700, 'only its owner opens the credentials');
  for (const p of ['shop', 'blog']) assert.equal(fs.existsSync(path.join(B.projects, p)), false, `${p} is not cloned`);
  assert.deepEqual(r.notHere, ['shop', 'blog']);
  assert.ok(r.plan.filter((e) => e.action === 'notHere').every((e) => /in the map, not on this computer: hoprig get /.test(e.result)));
  // The command line says them as the normal state, with the command.
  const cli = await quietUi();
  assert.equal(await main(['restore', u.brain, '--yes'], { ui: cli.ui, write: () => {} }), 0);
  assert.match(cli.text(), /in the map, not on this computer \(a project comes when you ask for it\):  hoprig get shop  ·  hoprig get blog/);
});

test('status: "in the map, not on this computer" is a group of its own with hoprig get; sync does not list it', async () => {
  B.use();
  const st = await M.mapStatus({ dir: B.ws, projects: B.projects });
  const of = (l) => st.entries.find((e) => e.label === l);
  assert.deepEqual([of('shop').state, of('shop').fix, of('shop/code/shop-api').state, of('blog').state], ['notHere', 'hoprig get shop', 'notHere', 'notHere']);
  assert.equal(of('git/tool').state, 'here');
  const ui = await quietUi();
  await main(['status'], { ui: ui.ui, write: () => {} });
  assert.match(ui.text(), /In the map, not on this computer {2}a project comes to a computer when you ask for it/);
  assert.match(ui.text(), /shop .*get it with {2}hoprig get shop/);
  assert.doesNotMatch(ui.text(), /shop\/code\/shop-api/, 'its code repositories come with it: one line');
  const s = await syncAll({ dir: B.ws, projects: B.projects });
  assert.deepEqual(s.notHere.sort(), ['blog', 'shop']);
  assert.ok(!s.repos.some((x) => ['shop', 'blog', 'shop/code/shop-api'].includes(x.label)), 'not listed as something to do');
  assert.equal(s.todo, 0, JSON.stringify(s.repos));
});

test('get brings the parent, its code repositories and its memory link; the gone repository is named with git\'s reason and the rest goes on', async () => {
  B.use();
  const ui = await quietUi();
  const code = await getMain(['shop'], { ui: ui.ui, write: () => {}, dir: B.projects });
  assert.equal(code, 1, 'one code repository failed');
  const shop = path.join(B.projects, 'shop');
  assert.ok(real(shop) && real(path.join(shop, 'code', 'shop-api')));
  assert.match(ui.text(), /code\/old-api: clone failed \(.*(not found|does not appear|not exist).*\)/i);
  const mem = path.join(B.claude, 'projects');
  assert.ok(fs.readdirSync(mem).some((d) => fs.lstatSync(path.join(mem, d, 'memory')).isSymbolicLink()), 'the memory link is made');
});

test('a get cut off in the middle: the cut-off clone is moved aside under a dated name, never deleted, and the next run finishes', async () => {
  B.use();
  const api = path.join(B.projects, 'shop', 'code', 'shop-api');
  // What a killed `git clone` leaves: a repository with the address, and no commit checked out.
  fs.rmSync(api, { recursive: true, force: true });
  fs.mkdirSync(api, { recursive: true });
  w.sh(api, 'init', '-q');
  w.sh(api, 'remote', 'add', 'origin', u.shopApi);
  const ui = await quietUi();
  await getMain(['shop'], { ui: ui.ui, write: () => {}, dir: B.projects });
  assert.ok(real(api) && w.sh(api, 'rev-parse', 'HEAD'), 'cloned again, complete');
  const aside = fs.readdirSync(path.dirname(api)).filter((n) => n.startsWith('.shop-api.broken-'));
  assert.equal(aside.length, 1, 'kept aside once, never deleted');
  assert.match(aside[0], /^\.shop-api\.broken-\d{8}-\d{6}$/);
  assert.ok(!M.readMap(B.ws).map.projects.find((p) => p.name === 'shop').repos.some((r) => r.dir.includes('broken')), 'the map never takes it for a code repository');
  const st = await quietUi();
  await main(['status'], { ui: st.ui, write: () => {} });
  assert.match(st.text(), /\.shop-api\.broken-\d{8}-\d{6} {2}a clone that was cut off, kept aside/);
  // A third run moves nothing again: the clone is complete.
  await getMain(['shop'], { ui: (await quietUi()).ui, write: () => {}, dir: B.projects });
  assert.equal(fs.readdirSync(path.dirname(api)).filter((n) => n.startsWith('.shop-api.broken-')).length, 1);
  // A repository of the owner's own without a first commit (no address) is never moved.
  const mine = path.join(B.projects, 'shop', 'code', 'sketch');
  fs.mkdirSync(mine);
  w.sh(mine, 'init', '-q');
  assert.equal(await (await import('../../src/workspace/inside.mjs')).brokenClone(mine, u.shopApi), false);
  // The owner's own work on a branch with no commit yet, in a clone of the address: staged, or only a file beside
  // .git. Never moved aside: hoprig get leaves it where it is.
  const { brokenClone } = await import('../../src/workspace/inside.mjs');
  w.sh(api, 'checkout', '-q', '--orphan', 'site');
  fs.writeFileSync(path.join(api, 'draft.md'), 'my draft\n');
  w.sh(api, 'add', 'draft.md');
  assert.equal(await brokenClone(api, u.shopApi), false, 'staged work on a branch with no commit');
  await getMain(['shop'], { ui: (await quietUi()).ui, write: () => {}, dir: B.projects });
  assert.equal(fs.readFileSync(path.join(api, 'draft.md'), 'utf8'), 'my draft\n', 'left where it is');
  assert.equal(fs.readdirSync(path.dirname(api)).filter((n) => n.startsWith('.shop-api.broken-')).length, 1, 'nothing more moved aside');
  const fresh = path.join(B.projects, 'shop', 'code', 'fresh');
  fs.mkdirSync(fresh);
  w.sh(fresh, 'init', '-q');
  w.sh(fresh, 'remote', 'add', 'origin', u.shopApi);
  fs.writeFileSync(path.join(fresh, 'notes.md'), 'before my first commit\n');
  assert.equal(await brokenClone(fresh, u.shopApi), false, 'a file beside .git before the first commit');
  fs.rmSync(fresh, { recursive: true, force: true });
  w.sh(api, 'checkout', '-q', '-f', 'main');
  fs.rmSync(path.join(api, 'draft.md'), { force: true });
  // A clone killed while git wrote the files: the commit is there, the files written so far are, the index never
  // was. Cut off too.
  const tracked = w.sh(api, 'ls-files').split('\n').filter(Boolean);
  assert.ok(tracked.length > 0 && fs.existsSync(path.join(api, tracked[0])));
  fs.rmSync(path.join(api, '.git', 'index'));
  assert.equal(await brokenClone(api, u.shopApi), true, 'a commit and no index: killed while the files were written');
  await new Promise((r) => setTimeout(r, 1100)); // the name it is kept under is dated to the second
  await getMain(['shop'], { ui: (await quietUi()).ui, write: () => {}, dir: B.projects });
  assert.equal(fs.readdirSync(path.dirname(api)).filter((n) => n.startsWith('.shop-api.broken-')).length, 2, 'moved aside, never deleted');
  assert.ok(fs.existsSync(path.join(api, '.git', 'index')) && fs.existsSync(path.join(api, tracked[0])), 'cloned again, complete');
  assert.equal(w.sh(api, 'status', '--porcelain'), '', 'nothing half checked out');
});

test('the upkeep leaves a project with unpushed work, and one behind its server, exactly as it was', async () => {
  B.use();
  const shop = path.join(B.projects, 'shop');
  w.commit(shop, 'notes.md', 'unpushed work\n');
  const other = w.clone(u.shopParent, path.join(w.root, 'other-shop'));
  w.commit(other, 'server.md', 'on the server\n');
  w.sh(other, 'push', '-q');
  const api = path.join(shop, 'code', 'shop-api');
  const other2 = w.clone(u.shopApi, path.join(w.root, 'other-api'));
  w.commit(other2, 'new.md', 'new on the server\n');
  w.sh(other2, 'push', '-q');
  const before = { shop: w.sh(shop, 'rev-parse', 'HEAD'), shopRefs: w.sh(shop, 'for-each-ref'), api: w.sh(api, 'rev-parse', 'HEAD'), apiRefs: w.sh(api, 'for-each-ref'), server: w.sh(path.join(w.server, 'team', 'shop-workspace.git'), 'rev-parse', 'main') };
  // Every switch on: map, commit, memory, sync, push.
  const looked = await syncAll({ dir: B.ws, projects: B.projects, push: true, upkeep: true });
  await upkeepMap({ dir: B.ws, projects: B.projects, commit: true, push: true, memory: true });
  // What sits only here is still said (from the refs on disk): the owner keeps learning about unpushed work.
  assert.deepEqual(looked.repos.find((x) => x.label === 'shop').todo.map((t) => [t.why, t.command]), [['1 commit to push', 'hoprig sync shop --push']]);
  assert.equal(looked.repos.find((x) => x.label === 'shop/code/shop-api'), undefined, 'its server moved, but nothing here knows it yet: no fetch');
  assert.equal(w.sh(shop, 'rev-parse', 'HEAD'), before.shop);
  assert.equal(w.sh(shop, 'for-each-ref'), before.shopRefs, 'not even fetched');
  assert.equal(w.sh(api, 'rev-parse', 'HEAD'), before.api);
  assert.equal(w.sh(api, 'for-each-ref'), before.apiRefs);
  assert.equal(w.sh(path.join(w.server, 'team', 'shop-workspace.git'), 'rev-parse', 'main'), before.server, 'nothing pushed');
  // Once something here fetched it (the owner, his editor), a commit to pull is said too, and still not pulled.
  w.sh(api, 'fetch', '-q');
  const again = await syncAll({ dir: B.ws, projects: B.projects, push: true, upkeep: true });
  assert.match(again.repos.find((x) => x.label === 'shop/code/shop-api').todo[0].why, /^1 commit to pull \(as of its last fetch\)/);
  assert.equal(w.sh(api, 'rev-parse', 'HEAD'), before.api);
  // The notification of the upkeep carries them, told once.
  const WS = await import('../../src/automation/workspacesync.mjs');
  const notes = [];
  const ctx = { record: () => {}, notify: (x) => notes.push(x.message), save: () => {}, data: { saidOnDemand: true }, workspaceSync: (o) => syncAll({ dir: B.ws, projects: B.projects, upkeep: true, ...o }) };
  await WS.apply([{ type: 'sync', push: false }], ctx);
  assert.ok(notes.some((m) => /shop: 1 commit to push/.test(m) && /shop\/code\/shop-api: 1 commit to pull/.test(m)), notes.join('\n'));
  // The owner asks: one project is synced.
  const s = await syncAll({ dir: B.ws, projects: B.projects, only: 'shop' });
  assert.ok(s.repos.every((x) => x.label === 'shop' || x.label.startsWith('shop/')), 'only that project');
  assert.ok(!s.repos.some((x) => x.label === 'ai_brain' || x.label === 'kits'));
  assert.ok(s.repos.find((x) => x.label === 'shop/code/shop-api').did.some((d) => /pulled 1/.test(d)));
  // One project's sync never touches the brain, so it does not wait for the brain's lock (the upkeep holding it).
  const { tryRepoLock } = await import('../../src/work/lock.mjs');
  const release = await tryRepoLock(path.join(B.ws, 'ai_brain'), { who: 'upkeep' });
  assert.ok(release, 'the upkeep holds the brain');
  try {
    const t0 = Date.now();
    const one = await quietUi();
    await main(['sync', 'shop'], { ui: one.ui, write: () => {} });
    assert.ok(Date.now() - t0 < 10_000, `no wait for the brain's lock (${Date.now() - t0} ms)`);
    assert.doesNotMatch(one.text(), /in use/);
    assert.match(one.text(), /✓ shop\/code\/shop-api {2}main/, 'the project was synced');
  } finally {
    release();
  }
});

test('the per-place switch pushes committed work on another branch; the default branch never', async () => {
  B.use();
  const api = path.join(B.projects, 'shop', 'code', 'shop-api');
  w.sh(api, 'pull', '-q');
  w.commit(api, 'main-work.md', 'on main\n');
  w.sh(api, 'checkout', '-q', '-b', 'feature');
  w.commit(api, 'feature.md', 'on a branch\n');
  w.sh(api, 'checkout', '-q', 'main');
  const bare = path.join(w.server, 'team', 'shop-api.git');
  const mainBefore = w.sh(bare, 'rev-parse', 'main');
  assert.deepEqual((await pushBranches({ dir: B.ws, projects: B.projects, on: [] })).repos, [], 'off: nothing');
  const r = await pushBranches({ dir: B.ws, projects: B.projects, on: ['projects'] });
  assert.deepEqual(r.repos.find((x) => x.label === 'shop/code/shop-api').pushed, ['feature']);
  assert.equal(w.sh(bare, 'rev-parse', 'feature'), w.sh(api, 'rev-parse', 'feature'));
  assert.equal(w.sh(bare, 'rev-parse', 'main'), mainBefore, 'the default branch is never pushed by itself');
  const again = await pushBranches({ dir: B.ws, projects: B.projects, on: ['projects'] });
  assert.ok(!again.repos.some((x) => x.pushed.length), 'nothing new: nothing sent');
  // A branch pushed with its upstream, then removed on the server (merged) and pruned here: never put back.
  w.sh(api, 'checkout', '-q', '-b', 'merged');
  w.commit(api, 'merged.md', 'merged work\n');
  w.sh(api, 'push', '-q', '-u', 'origin', 'merged');
  w.sh(api, 'checkout', '-q', 'main');
  w.sh(bare, 'branch', '-D', 'merged');
  w.sh(api, 'fetch', '-q', '--prune');
  const gone = await pushBranches({ dir: B.ws, projects: B.projects, on: ['projects'] });
  const e = gone.repos.find((x) => x.label === 'shop/code/shop-api');
  assert.ok(!e.pushed.includes('merged'), 'not pushed back');
  assert.ok(e.todo.some((t) => /merged: its branch on the git server was removed, so it is not pushed by itself/.test(t.why)), JSON.stringify(e.todo));
  assert.equal(w.sh(bare, 'branch', '--list', 'merged'), '', 'the server keeps it removed');
  w.sh(api, 'branch', '-D', 'merged');
  // A branch with an upstream that is still there and only ahead: pushed as before, a plain push.
  w.sh(api, 'checkout', '-q', 'feature');
  w.commit(api, 'feature-more.md', 'more on the branch\n');
  w.sh(api, 'checkout', '-q', 'main');
  assert.ok((await pushBranches({ dir: B.ws, projects: B.projects, on: ['projects'] })).repos.find((x) => x.label === 'shop/code/shop-api').pushed.includes('feature'));
  assert.equal(w.sh(bare, 'rev-parse', 'feature'), w.sh(api, 'rev-parse', 'feature'));
});

// The other branches of shop-api, its server copy, one round of the switch (its entry, or an empty one).
const apiDir = () => path.join(B.projects, 'shop', 'code', 'shop-api');
const apiBare = () => path.join(w.server, 'team', 'shop-api.git');
const apiRound = async () => (await pushBranches({ dir: B.ws, projects: B.projects, on: ['projects'] })).repos.find((x) => x.label === 'shop/code/shop-api') || { pushed: [], todo: [] };
const serverHas = (name) => w.sh(apiBare(), 'branch', '--list', name) !== '';

test('the per-place switch: a branch removed on the server and not pruned here is never put back (with an upstream, pushed by the upkeep, pushed without -u)', async () => {
  B.use();
  const api = apiDir();
  // git's plain fetch does not prune, and there is more work here after the server removed it: the branch here looks
  // only ahead of what this computer last saw. The server is asked which branches it has: it is never put back.
  for (const [name, how] of [['merged2', 'upstream'], ['pushedbyupkeep', 'upkeep'], ['pushedplain', 'plain']]) {
    w.sh(api, 'checkout', '-q', '-b', name, 'main');
    w.commit(api, `${name}.md`, 'merged work\n');
    if (how === 'upstream') w.sh(api, 'push', '-q', '-u', 'origin', name);
    else if (how === 'plain') w.sh(api, 'push', '-q', 'origin', name); // only origin/<branch> kept here, no upstream
    else assert.ok((await apiRound()).pushed.includes(name));
    w.sh(apiBare(), 'branch', '-D', name);
    w.sh(api, 'fetch', '-q');
    w.commit(api, `${name}-more.md`, 'more work after the merge\n');
    w.sh(api, 'checkout', '-q', 'main');
    const stale = await apiRound();
    assert.ok(!stale.pushed.includes(name), `${name}: not pushed back`);
    assert.ok(stale.todo.some((t) => t.why.startsWith(`${name}: its branch on the git server was removed, so it is not pushed by itself`) && / fetch --prune$/.test(t.command)), JSON.stringify(stale.todo));
    assert.equal(serverHas(name), false, `${name}: the server keeps it removed`);
    w.sh(api, 'branch', '-D', name);
  }
});

test('the per-place switch: a branch behind its server copy (another computer pushed two commits, a plain fetch here) is never pushed over it', async () => {
  B.use();
  const api = apiDir();
  w.sh(api, 'checkout', '-q', '-b', 'behind', 'main');
  w.commit(api, 'behind.md', 'one\n');
  w.sh(api, 'push', '-q', 'origin', 'behind'); // without -u: only origin/behind is kept here
  w.sh(api, 'checkout', '-q', 'main');
  const other = w.clone(u.shopApi, path.join(w.root, 'other-behind'));
  w.sh(other, 'checkout', '-q', 'behind');
  w.commit(other, 'behind-2.md', 'two\n');
  w.commit(other, 'behind-3.md', 'three\n');
  w.sh(other, 'push', '-q');
  const theirs = w.sh(apiBare(), 'rev-parse', 'behind');
  w.sh(api, 'fetch', '-q');
  const e = await apiRound();
  assert.ok(!e.pushed.includes('behind'), 'not pushed');
  assert.equal(w.sh(apiBare(), 'rev-parse', 'behind'), theirs, 'the other computer\'s commits stay on the server');
  assert.ok(e.todo.some((t) => t.why === 'behind and its branch on the git server have both moved, or it was rewritten here: not pushed' && / status$/.test(t.command)), JSON.stringify(e.todo));
  // The same with an upstream: nothing new here, nothing sent.
  w.sh(api, 'branch', '-q', '-u', 'origin/behind', 'behind');
  assert.ok(!(await apiRound()).pushed.includes('behind'));
  assert.equal(w.sh(apiBare(), 'rev-parse', 'behind'), theirs);
  w.sh(api, 'branch', '-D', 'behind');
});

test('the per-place switch: somebody else\'s branch of the same name, fetched here, and the owner\'s own made with --no-track: the server keeps theirs', async () => {
  B.use();
  const api = apiDir();
  const other = w.clone(u.shopApi, path.join(w.root, 'other-shared'));
  w.sh(other, 'checkout', '-q', '-b', 'shared');
  w.commit(other, 'theirs.md', 'their work\n');
  w.sh(other, 'push', '-q', 'origin', 'shared');
  const theirs = w.sh(apiBare(), 'rev-parse', 'shared');
  w.sh(api, 'fetch', '-q');
  w.sh(api, 'checkout', '-q', '--no-track', '-b', 'shared', 'main');
  w.commit(api, 'mine.md', 'my work\n');
  w.sh(api, 'checkout', '-q', 'main');
  const e = await apiRound();
  assert.ok(!e.pushed.includes('shared'), 'not pushed');
  assert.equal(w.sh(apiBare(), 'rev-parse', 'shared'), theirs, 'their commit stays on the server');
  assert.ok(e.todo.some((t) => t.why.startsWith('shared and its branch on the git server have both moved')), JSON.stringify(e.todo));
  w.sh(api, 'branch', '-D', 'shared');
});

test('the per-place switch: a branch amended here after the upkeep pushed it is never pushed over the server\'s', async () => {
  B.use();
  const api = apiDir();
  w.sh(api, 'checkout', '-q', '-b', 'amended', 'main');
  w.commit(api, 'amended.md', 'one\n', 'amended work');
  w.sh(api, 'checkout', '-q', 'main');
  assert.ok((await apiRound()).pushed.includes('amended'));
  const first = w.sh(apiBare(), 'rev-parse', 'amended');
  w.sh(api, 'checkout', '-q', 'amended');
  w.sh(api, 'commit', '-q', '--amend', '-m', 'amended work, reworded');
  w.sh(api, 'checkout', '-q', 'main');
  const e = await apiRound();
  assert.ok(!e.pushed.includes('amended'), 'not pushed');
  assert.equal(w.sh(apiBare(), 'rev-parse', 'amended'), first, 'the server keeps the commit it had');
  assert.ok(e.todo.some((t) => t.why.startsWith('amended and its upstream have both moved: not pushed')), JSON.stringify(e.todo));
  w.sh(api, 'branch', '-D', 'amended');
});

test('the per-place switch: the first push of a branch sets its upstream, so once removed on the server and pruned here it is never put back', async () => {
  B.use();
  const api = apiDir();
  w.sh(api, 'checkout', '-q', '-b', 'once', 'main');
  w.commit(api, 'once.md', 'one\n');
  w.sh(api, 'checkout', '-q', 'main');
  assert.ok((await apiRound()).pushed.includes('once'));
  assert.equal(w.sh(api, 'rev-parse', '--abbrev-ref', 'once@{upstream}'), 'origin/once', 'the repository remembers it was pushed');
  w.sh(apiBare(), 'branch', '-D', 'once');
  w.sh(api, 'fetch', '-q', '--prune');
  const e = await apiRound();
  assert.ok(!e.pushed.includes('once'), 'not pushed back');
  assert.ok(e.todo.some((t) => t.why.startsWith('once: its branch on the git server was removed')), JSON.stringify(e.todo));
  assert.equal(serverHas('once'), false, 'the server keeps it removed');
  w.sh(api, 'branch', '-D', 'once');
});

test('the per-place switch: a branch pushed by hand without -u gets its upstream on its next push, so once removed on the server and pruned here it is never put back', async () => {
  B.use();
  const api = apiDir();
  w.sh(api, 'checkout', '-q', '-b', 'byhand', 'main');
  w.commit(api, 'byhand.md', 'one\n');
  w.sh(api, 'push', '-q', 'origin', 'byhand'); // only origin/byhand kept here, no upstream
  w.commit(api, 'byhand-2.md', 'two\n');
  w.sh(api, 'checkout', '-q', 'main');
  assert.ok((await apiRound()).pushed.includes('byhand'));
  assert.equal(w.sh(api, 'rev-parse', '--abbrev-ref', 'byhand@{u}'), 'origin/byhand', 'the repository remembers it was pushed');
  w.sh(apiBare(), 'branch', '-D', 'byhand');
  w.sh(api, 'fetch', '-q', '--prune');
  w.sh(api, 'checkout', '-q', 'byhand');
  w.commit(api, 'byhand-3.md', 'three\n');
  w.sh(api, 'checkout', '-q', 'main');
  const e = await apiRound();
  assert.ok(!e.pushed.includes('byhand'), 'not pushed back');
  assert.equal(serverHas('byhand'), false, 'the server keeps it removed');
  w.sh(api, 'branch', '-D', 'byhand');
});

test('the per-place switch: a branch whose upstream is another branch here is left alone; that branch stays where it was, nothing is sent', async () => {
  B.use();
  const api = apiDir();
  const before = { feature: w.sh(api, 'rev-parse', 'feature'), server: w.sh(apiBare(), 'for-each-ref') };
  w.sh(api, 'branch', '-q', '--track', 'local-child', 'feature');
  w.sh(api, 'checkout', '-q', 'local-child');
  w.commit(api, 'local-child.md', 'one\n');
  w.sh(api, 'checkout', '-q', 'main');
  const e = await apiRound();
  assert.ok(!e.pushed.includes('local-child'), 'not pushed');
  assert.ok(!e.todo.some((t) => /local-child/.test(t.why)), JSON.stringify(e.todo));
  assert.equal(w.sh(api, 'rev-parse', 'feature'), before.feature, 'the tracked local branch stands where it was');
  assert.equal(w.sh(apiBare(), 'for-each-ref'), before.server, 'nothing sent to the server');
  w.sh(api, 'branch', '-D', 'local-child');
});

test('the per-place switch: a git server that cannot be asked: nothing of that repository is pushed, said once; the others are served', async () => {
  B.use();
  const api = apiDir();
  const shop = path.join(B.projects, 'shop');
  w.sh(shop, 'checkout', '-q', '-b', 'parentwork');
  w.commit(shop, 'parentwork.md', 'on the parent\n');
  w.sh(shop, 'checkout', '-q', 'main');
  for (const name of ['offline1', 'offline2']) {
    w.sh(api, 'checkout', '-q', '-b', name, 'main');
    w.commit(api, `${name}.md`, 'one\n');
  }
  w.sh(api, 'checkout', '-q', 'main');
  w.sh(api, 'remote', 'set-url', 'origin', path.join(w.root, 'no-such-server', 'shop-api.git'));
  try {
    const r = await pushBranches({ dir: B.ws, projects: B.projects, on: ['projects'] });
    const e = r.repos.find((x) => x.label === 'shop/code/shop-api');
    assert.deepEqual(e.pushed, [], 'nothing of it pushed');
    assert.equal(e.todo.filter((t) => /could not be asked which branches it has/.test(t.why)).length, 1, JSON.stringify(e.todo));
    assert.ok(!e.todo.some((t) => /^offline[12]/.test(t.why)), 'said once for the repository, not per branch');
    assert.ok(r.repos.find((x) => x.label === 'shop').pushed.includes('parentwork'), 'the other repositories are served');
    assert.equal(w.sh(path.join(w.server, 'team', 'shop-workspace.git'), 'rev-parse', 'parentwork'), w.sh(shop, 'rev-parse', 'parentwork'));
    assert.ok(!serverHas('offline1') && !serverHas('offline2'));
  } finally {
    w.sh(api, 'remote', 'set-url', 'origin', u.shopApi);
  }
  for (const name of ['offline1', 'offline2']) w.sh(api, 'branch', '-D', name);
});

test('the per-place switch never forces: no force option and no refspec with a leading plus in its source', () => {
  const src = fs.readFileSync(new URL('../../src/workspace/branchpush.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /--force/);
  assert.doesNotMatch(src, /['"`]\+(refs\/|\$\{|[A-Za-z:])/);
});

test('get --list: every entry of the map and where it is checked out, from the computers\' files', async () => {
  B.use();
  await C.setLabel('beta', { dir: B.ws, projects: B.projects });
  A.use();
  await C.setLabel('alpha', { dir: A.ws, projects: A.projects });
  // A's file says blog is there (another computer's word, as its file says it).
  const f = JSON.parse(fs.readFileSync(path.join(brainA, 'computers', 'alpha.json'), 'utf8'));
  fs.mkdirSync(path.join(B.ws, 'ai_brain', 'computers'), { recursive: true });
  fs.writeFileSync(path.join(B.ws, 'ai_brain', 'computers', 'alpha.json'), JSON.stringify({ ...f, here: ['blog'] }, null, 2));
  B.use();
  let out = '';
  assert.equal(await getMain(['--list', '--json'], { ui: (await quietUi()).ui, write: (s) => (out += s), dir: B.projects }), 0);
  const c = JSON.parse(out);
  const of = (n) => c.entries.find((e) => e.name === n);
  assert.deepEqual([of('shop').here, of('shop').on], [true, ['beta']]);
  assert.deepEqual([of('blog').here, of('blog').on], [false, ['alpha']]);
  assert.deepEqual([of('kits').kind, of('git/tool').kind], ['group', 'other']);
  const ui = await quietUi();
  await getMain(['--list'], { ui: ui.ui, write: () => {}, dir: B.projects });
  assert.match(ui.text(), /blog +alpha .*\(hoprig get blog\)/);
  assert.match(ui.text(), /cannot be seen from here/);
});

test('three hundred entries: get --list stays quick', async () => {
  B.use();
  const big = M.readMap(B.ws).map;
  for (let i = 0; i < 300; i++) big.projects.push({ name: `p${i}`, url: `https://git.example.test/team/p${i}.git`, repos: [] });
  M.writeMap(big, B.ws);
  const t0 = Date.now();
  let out = '';
  await getMain(['--list', '--json'], { ui: (await quietUi()).ui, write: (s) => (out += s), dir: B.projects });
  assert.equal(JSON.parse(out).entries.filter((e) => e.kind === 'project').length, 302);
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  void capture;
});

test('workspace auto: --memory and --push-branches <place>=on|off set the new switches, a bad value is refused', async () => {
  B.use();
  let out = '';
  const ui = await quietUi();
  assert.equal(await main(['auto', '--memory', 'on', '--push-branches', 'projects=on', '--json'], { ui: ui.ui, write: (s) => (out += s) }), 0);
  const j = JSON.parse(out);
  assert.deepEqual([j.memory, j.pushBranches], [true, { projects: true }]);
  out = '';
  assert.equal(await main(['auto', '--push-branches', 'projects=off', '--json'], { ui: ui.ui, write: (s) => (out += s) }), 0);
  assert.deepEqual(JSON.parse(out).pushBranches, {});
  const bad = await quietUi();
  assert.equal(await main(['auto', '--push-branches', 'projects'], { ui: bad.ui, write: () => {} }), 1);
  assert.match(bad.text(), /<place>=on or <place>=off/);
  const show = await quietUi();
  await main(['auto'], { ui: show.ui, write: () => {} });
  assert.match(show.text(), /a project is never merged, rebased or pushed by itself/);
  // The memory switch names everything it commits: the brain's memory folder and the groups' own.
  assert.match(show.text(), /memory: the memory folders of the AI brain and of your groups' own repositories are committed \(and only them\)/);
  assert.match(fs.readFileSync(new URL('../../web/workspace.js', import.meta.url), 'utf8'), /Commits the memory folders of the AI brain and of your groups\\' own repositories, and only them/);
});

test('the memory switch: the brain\'s memory folder and a group\'s own, and only them, are committed', async () => {
  B.use();
  const m = M.readMap(B.ws).map;
  m.groups[0].memories = { '.': 'ai_brain/claude-memory' };
  M.writeMap(m, B.ws);
  const kits = path.join(B.ws, 'kits');
  fs.mkdirSync(path.join(kits, 'ai_brain', 'claude-memory'), { recursive: true });
  fs.writeFileSync(path.join(kits, 'ai_brain', 'claude-memory', 'MEMORY.md'), '# kits memory\n');
  fs.writeFileSync(path.join(kits, 'notes.md'), 'not memory\n');
  const brain = path.join(B.ws, 'ai_brain');
  fs.mkdirSync(path.join(brain, 'claude-memory', 'home'), { recursive: true });
  fs.writeFileSync(path.join(brain, 'claude-memory', 'home', 'MEMORY.md'), '# home\n');
  fs.writeFileSync(path.join(brain, 'draft.md'), 'not memory\n');
  const r = await upkeepMap({ dir: B.ws, projects: B.projects, memory: true });
  assert.ok(r.lines.includes('The AI brain\'s memory was committed') && r.lines.includes('The memory of kits was committed'), r.lines.join('\n'));
  assert.equal(w.sh(kits, 'show', '--name-only', '--format=', 'HEAD'), 'ai_brain/claude-memory/MEMORY.md');
  assert.match(w.sh(kits, 'status', '--porcelain'), /\?\? notes\.md/, 'any other change is never committed silently');
  assert.match(w.sh(brain, 'status', '--porcelain'), /\?\? draft\.md/);
});
