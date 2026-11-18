// Groups (map version 2) on one computer: a workspace with the default projects folder, a plain group "client-work"
// and a group that is a repository, "kits", holding "packs" (members that come with the group's repository) and
// "builds" (each member a repository of its own). Every place that took one projects folder takes all of them: the
// scan, writing and reading the map, status, sync, the memory links, the lists, and a name is unique in its place.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-groups');
test.after(() => w.cleanup());
const C = w.computer('g');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const G = await import('../../src/workspace/groups.mjs');
const W = await import('../../src/workspace/where.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { projectSlug } = await import('../../src/sessions.mjs');

const U = (n) => w.url(n);
['brain', 'shop-workspace', 'shop', 'acme-shop', 'acme-blog', 'blog-theme', 'blog-build', 'site-build'].forEach((n) => w.bare(n));
// The group's repository: its own files and memory, a member of packs tracked by it, and the ignore lines.
w.bare('kits', { empty: true });
const seed = path.join(w.root, 'kits-seed');
fs.mkdirSync(seed);
w.sh(seed, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(seed, 'AGENTS.md'), '# kits\n');
fs.mkdirSync(path.join(seed, 'ai_brain', 'claude-memory'), { recursive: true });
fs.writeFileSync(path.join(seed, 'ai_brain', 'claude-memory', 'MEMORY.md'), '- kits\n');
fs.mkdirSync(path.join(seed, 'packs', 'blog'), { recursive: true });
fs.writeFileSync(path.join(seed, 'packs', 'blog', 'project.json'), JSON.stringify({ name: 'blog', repos: [{ dir: 'code/blog-theme', url: U('blog-theme') }], memories: {} }));
fs.writeFileSync(path.join(seed, '.gitignore'), '/packs/*/code/\n/builds/*/\n');
w.sh(seed, 'add', '-A');
w.sh(seed, 'commit', '-q', '-m', 'Start kits');
w.sh(seed, 'push', '-q', path.join(w.server, 'team', 'kits.git'), 'main');

w.clone(U('brain'), path.join(C.ws, 'ai_brain'));
saveConfig({ projectsDir: C.projects });
const shop = w.clone(U('shop-workspace'), path.join(C.projects, 'shop'));
w.clone(U('shop'), path.join(shop, 'code', 'shop'));
const cw = path.join(C.ws, 'client-work');
const cwShop = w.clone(U('acme-shop'), path.join(cw, 'shop'));
w.clone(U('acme-blog'), path.join(cw, 'blog'));
w.sh(cwShop, 'worktree', 'add', '-q', '-b', 'try', path.join(cw, 'shop-wt')); // never a project of the map
const kits = w.clone(U('kits'), path.join(C.ws, 'kits'));
w.sh(kits, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
w.clone(U('blog-theme'), path.join(kits, 'packs', 'blog', 'code', 'blog-theme'));
w.clone(U('blog-build'), path.join(kits, 'builds', 'blog'));
const site = w.clone(U('site-build'), path.join(kits, 'builds', 'site'));
fs.mkdirSync(path.join(site, 'ai_brain', 'claude-memory'), { recursive: true }); // a member with memory of its own

const groups = [{ dir: 'client-work' }, { dir: 'kits', url: U('kits'), memories: { '.': 'ai_brain/claude-memory' }, holds: [{ dir: 'packs', parent: 'group' }, { dir: 'builds' }] }];
M.writeMap({ version: 2, brain: { url: U('brain') }, groups, projects: [], others: [] }, C.ws);
const ctx = { dir: C.ws, projects: C.projects };

test('scan and write: every place is mapped, a group\'s folder or member is never an "other", a worktree never a project', async () => {
  const r = await M.updateMap({ ...ctx, manifests: false });
  assert.deepEqual(r.map.projects.map(M.refOf).sort(), ['client-work/blog', 'client-work/shop', 'kits/builds/blog', 'kits/builds/site', 'kits/packs/blog', 'shop']);
  assert.deepEqual(r.map.others, [], 'nothing of a group is listed a second time as another repository');
  const blog = r.map.projects.find((p) => M.refOf(p) === 'kits/packs/blog');
  assert.equal(blog.url, null, 'it comes with the group\'s repository');
  assert.deepEqual(blog.repos, [{ dir: 'code/blog-theme', url: U('blog-theme') }]);
  assert.equal(r.map.projects.find((p) => M.refOf(p) === 'client-work/shop').url, U('acme-shop'));
  assert.equal(r.map.version, 2);
  assert.deepEqual(r.map.groups, groups);
  // read back: the same map, and a second round changes nothing
  const back = M.readMap(C.ws);
  assert.deepEqual(back.map, M.normalizeMap(r.map));
  const again = await M.updateMap({ ...ctx, manifests: false });
  assert.equal(again.diff.same && !again.otherChanges, true);
});

test('status: the group\'s repository and every project are here; a member that git would take is warned about', async () => {
  const st = await M.mapStatus(ctx);
  const state = Object.fromEntries(st.entries.map((e) => [`${e.kind}:${e.label}`, e.state]));
  assert.equal(state['group:kits'], 'here');
  for (const k of ['project:shop', 'project:client-work/shop', 'project:kits/builds/site', 'repo:kits/packs/blog/code/blog-theme']) assert.equal(state[k], 'here', k);
  assert.equal(st.entries.find((e) => e.label === 'client-work/shop').path, cwShop);
  assert.deepEqual(st.groups, [], 'the ignore file keeps every member out');
  fs.writeFileSync(path.join(kits, '.gitignore'), '/packs/*/code/\n');
  const bad = await M.mapStatus(ctx);
  assert.deepEqual(bad.groups[0].unignored, ['builds/blog', 'builds/site']);
  assert.deepEqual(bad.groups[0].missingLines, ['/builds/*/']);
  w.sh(kits, 'checkout', '-q', '--', '.gitignore');
});

test('a `git add -A` in the group\'s repository takes no member', () => {
  fs.writeFileSync(path.join(kits, 'packs', 'blog', 'notes.md'), 'tracked by the group\n');
  w.sh(kits, 'add', '-A');
  const staged = w.sh(kits, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  assert.deepEqual(staged, ['packs/blog/notes.md']);
  w.sh(kits, 'reset', '-q');
  fs.rmSync(path.join(kits, 'packs', 'blog', 'notes.md'));
});

test('sync: the group\'s repository (its members left out of its changes), and each project in every place', async () => {
  // Something new on the server for a project of the plain group and for the group's repository.
  const other = w.clone(U('acme-shop'), path.join(w.root, 'other-acme'));
  w.commit(other, 'b.txt', 'b');
  w.sh(other, 'push', '-q');
  const k2 = w.clone(U('kits'), path.join(w.root, 'other-kits'));
  w.commit(k2, 'TOOLS.md', 'tools');
  w.sh(k2, 'push', '-q');
  const r = await syncAll(ctx);
  const by = Object.fromEntries(r.repos.map((x) => [x.label, x]));
  assert.deepEqual(by.kits.did, ['pulled 1']);
  assert.deepEqual(by.kits.todo, [], 'no member counts as an uncommitted change of the group');
  assert.deepEqual(by['client-work/shop'].did, ['pulled 1']);
  for (const l of ['shop', 'shop/code/shop', 'client-work/blog', 'kits/builds/blog', 'kits/builds/site', 'kits/packs/blog/code/blog-theme']) assert.ok(by[l], l);
  assert.equal(by['kits/packs/blog'], undefined, 'a member that comes with the group has no repository of its own to sync');
});

test('memory: the group\'s own folder and members without memory use the group\'s; a member with its own keeps it', async () => {
  const done = await G.linkGroupMemories(M.readMap(C.ws).map, ctx);
  const link = (dir) => fs.realpathSync(path.join(C.claude, 'projects', projectSlug(dir), 'memory'));
  const groupMem = fs.realpathSync(path.join(kits, 'ai_brain', 'claude-memory'));
  assert.equal(link(kits), groupMem, 'a session started in the group\'s own folder');
  assert.equal(link(path.join(kits, 'packs', 'blog')), groupMem);
  assert.equal(link(path.join(kits, 'packs', 'blog', 'code', 'blog-theme')), groupMem, 'a code folder of a member');
  assert.equal(link(path.join(kits, 'builds', 'blog')), groupMem);
  assert.equal(link(site), fs.realpathSync(path.join(site, 'ai_brain', 'claude-memory')), 'its own memory');
  assert.ok(done.every((d) => d.done !== 'conflict'));
  const again = await G.linkGroupMemories(M.readMap(C.ws).map, ctx);
  assert.ok(again.every((d) => d.done === 'already'), 'running it again changes nothing');
  // The group's own link pointing elsewhere: a conflict whose fix names the group, never "<name>".
  const own = path.join(C.claude, 'projects', projectSlug(kits), 'memory');
  const was = fs.readlinkSync(own);
  fs.rmSync(own);
  fs.symlinkSync(path.join(w.root, 'elsewhere'), own);
  try {
    const plan = await G.planGroupMemories(M.readMap(C.ws).map, ctx, { only: 'kits' });
    const mine = plan.find((p) => p.group === 'kits');
    assert.equal(mine.action, 'conflict');
    assert.match(mine.fix, /&& hoprig project link kits$/);
  } finally {
    fs.rmSync(own);
    fs.symlinkSync(was, own);
  }
});

test('a name is unique in its place: <name> or <place>/<name>; forget of one never hides its namesake', async () => {
  const m = M.readMap(C.ws).map;
  assert.throws(() => G.findProject(m, 'shop'), (e) => e.status === 409 && e.choices.join() === 'projects/shop,client-work/shop', 'a bare name in two places: both forms');
  assert.equal(M.refOf(G.findProject(m, 'projects/shop')), 'shop', 'the projects folder\'s own, as projects/<name>');
  assert.equal(M.refOf(G.findProject(m, 'site')), 'kits/builds/site', 'a name in one place works bare');
  assert.equal(M.refOf(G.findProject(m, 'client-work/shop')), 'client-work/shop');
  assert.throws(() => G.findProject(m, 'blog'), (e) => e.status === 409 && e.choices.length === 3);
  assert.throws(() => M.forget('blog', C.ws), /in 3 places: say which one/);
  assert.equal((await W.projectDirFor('client-work/shop')).root, cwShop);
  await assert.rejects(W.projectDirFor('blog'), (e) => e.status === 409);
  const r = M.forget('kits/builds/blog', C.ws);
  assert.equal(r.wasInMap, true);
  const after = await M.updateMap({ ...ctx, manifests: false });
  const refs = after.map.projects.map(M.refOf);
  assert.ok(!refs.includes('kits/builds/blog'), 'not added back by the scan');
  assert.ok(refs.includes('client-work/blog') && refs.includes('kits/packs/blog'), 'its namesakes stay');
  assert.deepEqual(after.map.skip, ['kits/builds/blog']);
  assert.ok(fs.existsSync(path.join(kits, 'builds', 'blog')), 'no file is touched');
});

test('one project, one place: a folder with the address of a project the map has elsewhere is not added a second time', async () => {
  w.clone(U('acme-shop'), path.join(C.projects, 'acme-shop'));
  const r = await M.updateMap({ ...ctx, manifests: false });
  assert.ok(!r.map.projects.some((p) => p.name === 'acme-shop'));
  assert.ok(r.notes.some((n) => /acme-shop has the address of client-work\/shop/.test(n)));
  fs.rmSync(path.join(C.projects, 'acme-shop'), { recursive: true, force: true });
  const bad = M.readMap(C.ws).map;
  bad.projects.push({ name: 'twin', url: U('acme-shop'), repos: [] });
  assert.throws(() => M.writeMap(bad, C.ws), /same address/);
});

test('the dashboard\'s project list, the new-session list and Tia\'s list: every place, ids as <place>/<name>', async () => {
  const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
  const sctx = { readJson: async (req) => req.body || {}, backend: { list: async () => [], create: async () => {} }, deck: { launcher: () => ['node', 'x'] } };
  const f = pcsetupFeature(sctx, { projectsDir: () => C.projects });
  const route = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/pcsetup/projects'));
  const d = await route[2](Readable.from([]), null, new URLSearchParams());
  assert.deepEqual(d.places.map((p) => p.id), ['', 'client-work', 'kits/packs', 'kits/builds']);
  assert.deepEqual(d.workspaces.map((x) => x.id).sort(), ['kits/packs/blog', 'projects/shop'], 'projects/shop: a group has a shop too');
  assert.deepEqual(d.repos.filter((x) => !x.worktree).map((x) => x.id).sort(), ['client-work/blog', 'client-work/shop', 'kits/builds/blog', 'kits/builds/site'], 'plain repositories of every place');
  assert.deepEqual(d.repos.filter((x) => x.worktree).map((x) => x.id), ['client-work/shop-wt'], 'a worktree is shown, marked as one');
  const member = d.workspaces.find((x) => x.id === 'kits/packs/blog');
  assert.deepEqual(member.repos.map((r) => r.rel), ['code/blog-theme'], 'no parent row for a member that comes with the group');
  assert.equal(d.repos.find((x) => x.id === 'client-work/shop').dir, cwShop);

});

test('restore on a second computer: the group\'s repository first, then every place; get fetches by place', async () => {
  const brain = path.join(C.ws, 'ai_brain');
  w.sh(brain, 'add', 'workspace.json');
  w.sh(brain, 'commit', '-q', '-m', 'map');
  w.sh(brain, 'push', '-q', 'origin', 'HEAD:main');
  const D = w.computer('g2');
  D.use();
  process.env.HOPRIG_WORKSPACE_DIR = D.ws;
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const { quietUi } = await import('./gitfix.mjs');
  const q = await quietUi();
  const r = await restoreWorkspace(U('brain'), { ui: q.ui, dir: D.ws, projects: D.projects });
  const res = Object.fromEntries(r.plan.map((e) => [e.label, e.result]));
  assert.equal(res.kits, 'cloned');
  assert.ok(r.plan.findIndex((e) => e.label === 'kits') < r.plan.findIndex((e) => e.label.startsWith('kits/')), 'the group before its members');
  for (const l of ['client-work/shop', 'kits/builds/site', 'kits/packs/blog/code/blog-theme', 'shop']) assert.equal(res[l], 'cloned', l);
  assert.equal(res['kits/packs/blog'], undefined, 'a member that comes with the group is not cloned on its own');
  assert.ok(fs.existsSync(path.join(D.ws, 'client-work', 'shop', '.git')));
  assert.ok(fs.existsSync(path.join(D.ws, 'kits', 'packs', 'blog', 'project.json')), 'its files came with the group');
  assert.ok(fs.existsSync(path.join(D.ws, 'kits', 'packs', 'blog', 'code', 'blog-theme', '.git')));
  assert.equal(fs.realpathSync(path.join(D.claude, 'projects', projectSlug(path.join(D.ws, 'kits')), 'memory')), fs.realpathSync(path.join(D.ws, 'kits', 'ai_brain', 'claude-memory')));
  // get by place: a member's code repository again, and a project of the plain group into its group's folder.
  fs.rmSync(path.join(D.ws, 'kits', 'packs', 'blog', 'code'), { recursive: true, force: true });
  fs.rmSync(path.join(D.ws, 'client-work', 'shop'), { recursive: true, force: true });
  const { getProject } = await import('../../src/pcsetup/getproject.mjs');
  const g1 = await getProject('kits/packs/blog', { ui: q.ui, dir: D.projects });
  assert.equal(g1.ok, true, g1.message);
  assert.ok(fs.existsSync(path.join(D.ws, 'kits', 'packs', 'blog', 'code', 'blog-theme', '.git')));
  const g2 = await getProject('client-work/shop', { ui: q.ui, dir: D.projects });
  assert.equal(g2.ok, true, g2.message);
  assert.equal(g2.dir, path.join(D.ws, 'client-work', 'shop'));
  assert.ok(!fs.existsSync(path.join(D.projects, 'shop', 'client-work')));
  const g3 = await getProject('blog', { ui: q.ui, dir: D.projects });
  assert.equal(g3.result, 'refused', 'a bare name in two places is never guessed');
  assert.ok(g3.choices.length >= 2);
  const { loadConfig } = await import('../../src/config.mjs');
  assert.equal(loadConfig().projectsDir, D.projects, 'a group\'s folder is never remembered as the projects folder');
  C.use();
  process.env.HOPRIG_WORKSPACE_DIR = C.ws;
});

test('the page lists a linked worktree as before, marked as a worktree, though the map never has it', async () => {
  const { pcsetupFeature } = await import('../../src/pcsetup/feature.mjs');
  const app = w.clone(w.bare('app'), path.join(C.projects, 'app'));
  w.sh(app, 'worktree', 'add', '-q', '-b', 'try', path.join(C.projects, 'app-wt'));
  const f = pcsetupFeature({ readJson: async () => ({}) }, { projectsDir: () => C.projects });
  const [, , fn] = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/pcsetup/projects'));
  const d = await fn(Readable.from([]), null, new URLSearchParams());
  const wt = d.repos.find((r) => r.id === 'app-wt');
  assert.ok(wt, 'still on the page: its sessions stay with it');
  assert.equal(wt.worktree, true);
  assert.ok(!(await M.updateMap({ ...ctx, manifests: false })).map.projects.some((p) => p.name === 'app-wt'), 'never in the map');
});

test('sync --memory commits a member\'s own memory folder where the group\'s repository tracks it', async () => {
  const blogMem = path.join(kits, 'packs', 'blog', 'ai_brain', 'claude-memory');
  fs.mkdirSync(blogMem, { recursive: true });
  fs.writeFileSync(path.join(blogMem, 'MEMORY.md'), '- blog notes\n');
  const pj = path.join(kits, 'packs', 'blog', 'project.json');
  fs.writeFileSync(pj, JSON.stringify({ name: 'blog', repos: [{ dir: 'code/blog-theme', url: U('blog-theme') }], memories: { '.': 'ai_brain/claude-memory' } }));
  w.sh(kits, 'add', 'packs/blog/project.json');
  w.sh(kits, 'commit', '-q', '-m', 'blog keeps its own memory');
  await M.updateMap({ ...ctx, manifests: false });
  const r = await syncAll({ ...ctx, memory: true });
  assert.ok(r.memory.some((x) => x.label === 'kits' && x.committed), JSON.stringify(r.memory));
  assert.equal(w.sh(kits, 'log', '-1', '--format=%s'), 'Update AI memory');
  assert.match(w.sh(kits, 'show', '--name-only', '--format=', 'HEAD'), /packs\/blog\/ai_brain\/claude-memory\/MEMORY\.md/);
});

test('the AI brain view lists the projects of every place, by <place>/<name>', async () => {
  const { brainIndex } = await import('../../src/workspace/brain.mjs');
  const { foldersHere } = await import('../../src/workspace/where.mjs');
  fs.writeFileSync(path.join(cwShop, 'AGENTS.md'), '# acme shop\n');
  const ix = brainIndex({ dir: C.ws, projects: C.projects, groups: (await foldersHere(ctx)).folders });
  const names = ix.projects.map((p) => p.name);
  assert.ok(names.includes('client-work/shop') && names.includes('kits/packs/blog'), names.join(', '));
  const acme = ix.projects.find((p) => p.name === 'client-work/shop');
  assert.equal(acme.agents.id, 'project:client-work+shop:agents');
  const blog = ix.projects.find((p) => p.name === 'kits/packs/blog');
  assert.equal(blog.memory.count, 1);
});
