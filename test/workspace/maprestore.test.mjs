// The workspace map, restore, sync and sync --with, with local bare repositories as the git server and temporary
// homes as computers: computer A builds a workspace and its map, B restores it from the brain's address alone, then
// both keep in step. Nothing leaves this computer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld();
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const { syncWith, peerInfo } = await import('../../src/workspace/peer.mjs');
const { setPlaces } = await import('../../src/workspace/places.mjs');
const { TREE } = await import('../../src/workspace/layout.mjs');
const { putMachine } = await import('../../src/machines/store.mjs');

const A = w.computer('alex');
const B = w.computer('box2');
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const urls = {};
const listing = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).filter((p) => !p.split(path.sep).includes('.git')).sort();
const head = (dir) => w.sh(dir, 'rev-parse', 'HEAD');
const byLabel = (r, label) => r.repos.find((x) => x.label === label);

test('computer A: the map lists the brain, a project with its code repositories, another repository; never a private folder or a token', async () => {
  A.use();
  urls.brain = w.bare('brain');
  w.clone(urls.brain, path.join(A.ws, 'ai_brain'));
  urls.shop = w.bare('shop');
  const shop = w.clone(urls.shop, path.join(A.projects, 'shop'));
  for (const n of ['shop-web', 'shop-api', 'shop-docs']) w.clone((urls[n] = w.bare(n)), path.join(shop, 'code', n));
  fs.writeFileSync(path.join(shop, '.gitignore'), '/code/*\n!/code/.gitignore\n');
  fs.writeFileSync(path.join(shop, 'project.json'), JSON.stringify({ name: 'shop', repos: [{ dir: 'code/shop-web', url: urls['shop-web'] }, { dir: 'code/shop-api', url: urls['shop-api'] }], memories: { '.': 'ai_brain/claude-memory' } }, null, 2));
  w.commit(shop, 'ai_brain/claude-memory/stack.md', '---\nname: Stack\n---\n');
  w.sh(shop, 'push', '-q');
  // A code repository that is not on a git server, a private folder that must stay unseen, an address with a token.
  const local = path.join(shop, 'code', 'local-only');
  fs.mkdirSync(local, { recursive: true });
  w.sh(local, 'init', '-q');
  w.commit(local, 'x.md', 'x');
  fs.mkdirSync(path.join(A.projects, 'no-ai'), { recursive: true });
  w.sh(path.join(A.projects, 'no-ai'), 'init', '-q');
  const secret = w.clone((urls.secret = w.bare('secret')), path.join(A.projects, 'secret'));
  w.sh(secret, 'remote', 'set-url', 'origin', `https://alex:${TOKEN}@git.example.test/team/secret.git`);
  w.clone((urls.tool = w.bare('tool')), path.join(A.ws, 'git', 'tool'));
  // A toolchain checkout under development/, on its "stable" channel: a tool, not the owner's work.
  urls.sdk = w.bare('sdk');
  const seed = w.clone(urls.sdk, path.join(w.root, 'sdk-seed'));
  w.sh(seed, 'switch', '-q', '-c', 'stable');
  w.commit(seed, 'VERSION', '1.0\n');
  w.sh(seed, 'push', '-q', 'origin', 'stable');
  const sdkA = w.clone(urls.sdk, path.join(A.ws, 'development', 'sdk', 'kit'));
  w.sh(sdkA, 'switch', '-q', 'stable');
  fs.mkdirSync(path.join(A.ws, 'credentials', 'x'), { recursive: true });
  w.sh(path.join(A.ws, 'credentials', 'x'), 'init', '-q');

  const dry = await M.updateMap({ dir: A.ws, projects: A.projects, dryRun: true });
  assert.equal(fs.existsSync(M.mapFile(A.ws)), false, 'a dry run writes nothing');
  assert.equal(dry.diff.created, true);
  const r = await M.updateMap({ dir: A.ws, projects: A.projects });
  const map = JSON.parse(fs.readFileSync(M.mapFile(A.ws), 'utf8'));
  assert.equal(map.brain.url, urls.brain);
  assert.deepEqual(map.projects.map((p) => p.name), ['secret', 'shop']);
  assert.equal(map.projects[0].url, urls.secret, 'stored without the user and token');
  assert.ok(!fs.readFileSync(M.mapFile(A.ws), 'utf8').includes(TOKEN));
  assert.deepEqual(map.projects[1].repos, [
    { dir: 'code/local-only', url: null }, { dir: 'code/shop-api', url: urls['shop-api'] }, { dir: 'code/shop-docs', url: urls['shop-docs'] }, { dir: 'code/shop-web', url: urls['shop-web'] },
  ]);
  assert.deepEqual(map.others, [{ dir: 'development/sdk/kit', url: urls.sdk, branch: 'stable', sync: false }, { dir: 'git/tool', url: urls.tool, branch: 'main' }], 'credentials/ is never looked into');
  assert.deepEqual(r.tools, ['development/sdk/kit'], 'everything under development/ is a tool: restored, never synced');
  assert.deepEqual(map.projects[1].memories, { '.': 'ai_brain/claude-memory' }, 'the memory links travel with the map');
  assert.equal(map.config, undefined, 'the default projects folder is not written');
  const st = await M.mapStatus({ dir: A.ws, projects: A.projects });
  assert.deepEqual(st.entries.filter((e) => e.tool).map((e) => e.label), ['development/sdk/kit']);
  assert.ok(r.notes.some((n) => /local-only: not on a git server yet/.test(n)));
  assert.deepEqual(r.manifests, [{ project: 'shop', added: ['code/shop-docs'], dropped: [] }], 'project.json gets the repository it lacked');
  assert.ok(JSON.parse(fs.readFileSync(path.join(shop, 'project.json'), 'utf8')).repos.some((x) => x.dir === 'code/shop-docs'));
  assert.match(r.commit, /git -C .* add workspace\.json && git -C .* commit/);
  assert.equal((await M.updateMap({ dir: A.ws, projects: A.projects })).diff.same, true, 'a second run: nothing changed');
  // project.json is part of the project: commit it there, as the person would.
  w.sh(shop, 'add', 'project.json');
  w.sh(shop, 'commit', '-q', '-m', 'Add shop-docs');
  w.sh(shop, 'push', '-q');
});

test('addresses: a token never gets into the map; a map from a repository is checked strictly', () => {
  assert.equal(M.mapUrl(`https://alex:${TOKEN}@git.example.test/team/x.git`), 'https://git.example.test/team/x.git');
  assert.throws(() => M.mapUrl(`https://git.example.test/${TOKEN}/x.git`), /secret/);
  assert.throws(() => M.mapUrl('file:///etc/passwd'), /not a git address/);
  assert.throws(() => M.mapUrl('/srv/git/x.git'), /not a git address/);
  const ok = { version: 1, brain: { url: null }, projects: [{ name: 'shop', url: null, repos: [{ dir: 'code/web', url: null }] }], others: [{ dir: 'git/tool', url: null }] };
  assert.equal(M.validateMap(ok).ok, true);
  for (const bad of [
    { ...ok, version: 2 }, { ...ok, extra: 1 },
    { ...ok, projects: [{ name: '../x', url: null, repos: [] }] }, { ...ok, projects: [{ name: 'no-ai', url: null, repos: [] }] },
    { ...ok, projects: [{ name: 'shop', url: null, repos: [{ dir: '../../etc', url: null }] }] },
    { ...ok, projects: [{ name: 'shop', url: null, repos: [{ dir: '/etc', url: null }] }] },
    { ...ok, projects: [{ name: 'shop', url: null, repos: [{ dir: 'code/x', url: 'file:///etc' }] }] },
    { ...ok, projects: [{ name: 'shop', url: null, repos: [{ dir: 'code/x', url: null, branch: '--force' }] }] },
    { ...ok, others: [{ dir: 'credentials/k', url: null }] }, { ...ok, others: [{ dir: 'ai_brain/x', url: null }] }, { ...ok, others: [{ dir: '.ssh', url: null }] },
  ]) assert.equal(M.validateMap(bad).ok, false, JSON.stringify(bad));
});

test('forget: out of the map, and `map` does not add it back; no file is touched', async () => {
  const r = M.forget('secret', A.ws);
  assert.equal(r.wasInMap, true);
  assert.ok(fs.existsSync(path.join(A.projects, 'secret')));
  const again = await M.updateMap({ dir: A.ws, projects: A.projects });
  assert.ok(!again.map.projects.some((p) => p.name === 'secret'));
  assert.deepEqual(again.map.skip, ['secret']);
  // A repository that was deleted on the server: restore lists it as failed and goes on.
  const m = M.readMap(A.ws).map;
  m.others.push({ dir: 'git/gone', url: w.url('gone') });
  M.writeMap(m, A.ws);
  w.sh(path.join(A.ws, 'ai_brain'), 'add', 'workspace.json');
  w.sh(path.join(A.ws, 'ai_brain'), 'commit', '-q', '-m', 'Add the workspace map');
  w.sh(path.join(A.ws, 'ai_brain'), 'push', '-q');
});

test('restore --dry-run on a fresh computer: the whole plan, nothing written', async () => {
  const C = w.computer('fresh');
  C.use();
  const { ui } = await quietUi();
  const p = await restoreWorkspace(urls.brain, { ui, dryRun: true, dir: C.ws, projects: C.projects });
  assert.deepEqual(p.plan.map((e) => [e.label, e.action]), [
    ['ai_brain', 'clone'], ['shop', 'clone'], ['shop/code/local-only', 'no-address'], ['shop/code/shop-api', 'clone'], ['shop/code/shop-docs', 'clone'], ['shop/code/shop-web', 'clone'], ['development/sdk/kit', 'clone'], ['git/gone', 'clone'], ['git/tool', 'clone'],
  ]);
  assert.ok(p.folders.length >= 5);
  assert.equal(fs.existsSync(C.ws), false);
});

test('restore into an empty home: the tree, every repository with its commits, the memory linked; one unreachable repository does not stop the rest; twice = no change', async () => {
  B.use();
  // Something of B's own where the map puts a repository: left alone.
  fs.mkdirSync(path.join(B.ws, 'git', 'tool'), { recursive: true });
  fs.writeFileSync(path.join(B.ws, 'git', 'tool', 'mine.txt'), 'mine');
  const { ui } = await quietUi();
  const r = await restoreWorkspace(urls.brain, { ui, dir: B.ws, projects: B.projects });
  const result = Object.fromEntries(r.plan.map((e) => [e.label, e.result]));
  assert.equal(result.ai_brain, 'cloned');
  for (const k of ['shop', 'shop/code/shop-web', 'shop/code/shop-api', 'shop/code/shop-docs']) assert.equal(result[k], 'cloned', k);
  assert.match(result['shop/code/local-only'], /^skipped: not on a git server yet/);
  assert.match(result['git/gone'], /^failed: /);
  assert.match(result['git/tool'], /^left alone: a folder that is not this repository/);
  assert.equal(r.ok, false, 'a failed repository makes the run not ok');
  assert.equal(fs.readFileSync(path.join(B.ws, 'git', 'tool', 'mine.txt'), 'utf8'), 'mine');
  for (const f of TREE) assert.ok(fs.existsSync(path.join(B.ws, f.rel)), f.rel);
  for (const n of ['shop-web', 'shop-api', 'shop-docs']) assert.equal(head(path.join(B.projects, 'shop', 'code', n)), head(path.join(A.projects, 'shop', 'code', n)));
  assert.equal(head(path.join(B.projects, 'shop')), head(path.join(A.projects, 'shop')));
  const link = path.join(B.claude, 'projects', path.join(B.projects, 'shop').replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(B.projects, 'shop', 'ai_brain', 'claude-memory')));
  assert.ok(!fs.existsSync(path.join(B.projects, 'secret')), 'a forgotten project is not restored');
  assert.equal(result['development/sdk/kit'], 'cloned', 'a tool is restored like any other repository');
  assert.equal(w.sh(path.join(B.ws, 'development', 'sdk', 'kit'), 'branch', '--show-current'), 'stable', 'on its mapped branch');

  const before = listing(B.ws);
  const again = await restoreWorkspace(urls.brain, { ui, dir: B.ws, projects: B.projects });
  assert.deepEqual(again.plan.filter((e) => e.result === 'cloned'), [], 'nothing is cloned twice');
  assert.equal(Object.fromEntries(again.plan.map((e) => [e.label, e.result])).ai_brain, 'here');
  assert.deepEqual(listing(B.ws), before);
});

test('restore refuses a brain folder that is another repository, and changes nothing', async () => {
  const C = w.computer('other');
  C.use();
  fs.mkdirSync(path.join(C.ws, 'ai_brain'), { recursive: true });
  w.sh(path.join(C.ws, 'ai_brain'), 'init', '-q');
  const { ui } = await quietUi();
  await assert.rejects(restoreWorkspace(urls.brain, { ui, dir: C.ws, projects: C.projects }), (e) => e.status === 409 && /is not the brain/.test(e.message));
  assert.deepEqual(fs.readdirSync(C.ws), ['ai_brain']);
  await assert.rejects(restoreWorkspace('not an address', { ui, dir: C.ws }), (e) => e.status === 400);
});

test('sync: behind → fast-forward, unsaved work stays; ahead → listed, pushed only with --push; diverged, or unsaved work in the same file → listed with the command, nothing changed', async () => {
  // A changes things and pushes them.
  A.use();
  w.commit(path.join(A.projects, 'shop', 'code', 'shop-web'), 'a.md', 'from A');
  w.sh(path.join(A.projects, 'shop', 'code', 'shop-web'), 'push', '-q');
  w.commit(path.join(A.projects, 'shop'), 'decisions.md', 'from A');
  w.sh(path.join(A.projects, 'shop'), 'push', '-q');
  w.commit(path.join(A.ws, 'ai_brain'), 'learnings.md', 'from A');
  w.sh(path.join(A.ws, 'ai_brain'), 'push', '-q');
  // A new release of the tool on its server: sync must not fetch it, let alone move to it.
  const seed = path.join(w.root, 'sdk-seed');
  w.commit(seed, 'VERSION', '2.0\n');
  w.sh(seed, 'push', '-q', 'origin', 'stable');
  // B: a commit of its own in shop-api (ahead), one in the parent (diverged), an unsaved change in the brain in the
  // very file A changed (in the way), and an unsaved file in shop-web that A's commit does not touch (stays).
  B.use();
  const kitB = path.join(B.ws, 'development', 'sdk', 'kit');
  const kitBefore = w.sh(kitB, 'for-each-ref');
  const api = path.join(B.projects, 'shop', 'code', 'shop-api');
  w.commit(api, 'b.md', 'from B');
  const parentB = w.commit(path.join(B.projects, 'shop'), 'notes.md', 'from B');
  const brainB = head(path.join(B.ws, 'ai_brain'));
  fs.writeFileSync(path.join(B.ws, 'ai_brain', 'learnings.md'), 'unsaved');
  fs.writeFileSync(path.join(B.projects, 'shop', 'code', 'shop-web', 'scratch.md'), 'unsaved');

  const dry = await syncAll({ dir: B.ws, projects: B.projects, dryRun: true });
  assert.deepEqual(byLabel(dry, 'shop/code/shop-web').did, ['would pull 1, unless they touch your 1 uncommitted change']);
  assert.notEqual(head(path.join(B.projects, 'shop', 'code', 'shop-web')), head(path.join(A.projects, 'shop', 'code', 'shop-web')), 'a dry run changes nothing');

  const r = await syncAll({ dir: B.ws, projects: B.projects });
  assert.equal(r.repos[0].label, 'ai_brain', 'the brain first');
  assert.deepEqual(byLabel(r, 'shop/code/shop-web').did, ['pulled 1 (your 1 uncommitted change stays)']);
  assert.equal(head(path.join(B.projects, 'shop', 'code', 'shop-web')), head(path.join(A.projects, 'shop', 'code', 'shop-web')));
  assert.equal(fs.readFileSync(path.join(B.projects, 'shop', 'code', 'shop-web', 'scratch.md'), 'utf8'), 'unsaved', 'unsaved work is still there after the fast-forward');
  assert.equal(byLabel(r, 'shop/code/shop-web').todo[0].kind, 'uncommitted');
  assert.equal(byLabel(r, 'shop/code/shop-api').todo[0].kind, 'to-push');
  assert.equal(byLabel(r, 'shop').todo[0].kind, 'diverged');
  assert.match(byLabel(r, 'shop').todo[0].command, /pull --rebase/);
  assert.equal(head(path.join(B.projects, 'shop')), parentB, 'diverged: not touched');
  assert.equal(byLabel(r, 'ai_brain').todo[0].kind, 'pull-blocked');
  assert.match(byLabel(r, 'ai_brain').todo[0].command, /stash && .* pull --ff-only && .* stash pop/);
  assert.equal(head(path.join(B.ws, 'ai_brain')), brainB, 'unsaved work in the same file: not touched');
  assert.equal(fs.readFileSync(path.join(B.ws, 'ai_brain', 'learnings.md'), 'utf8'), 'unsaved');
  assert.deepEqual(byLabel(r, 'git/gone').todo[0].kind, 'missing');
  assert.deepEqual(r.tools, ['development/sdk/kit']);
  assert.equal(byLabel(r, 'development/sdk/kit'), undefined, 'a tool is not fetched or fast-forwarded');

  assert.equal(w.sh(kitB, 'for-each-ref'), kitBefore, 'the tool was not even fetched');
  const pushed = await syncAll({ dir: B.ws, projects: B.projects, push: true });
  assert.deepEqual(byLabel(pushed, 'shop/code/shop-api').did, ['pushed 1']);
  assert.equal(w.sh(path.join(w.server, 'team', 'shop-api.git'), 'rev-parse', 'main'), head(api));
});

test('sync --with another computer over SSH: pull only, the other side is never written', async () => {
  // A stand-in for ssh that runs the remote command here (two temporary homes on one computer).
  const fake = path.join(w.root, 'fake-ssh');
  fs.writeFileSync(fake, '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o|-p|-l) shift 2 ;; -*) shift ;; *) break ;; esac; done\nshift\nexec sh -c "$*"\n', { mode: 0o755 });
  A.use();
  const webA = path.join(A.projects, 'shop', 'code', 'shop-web');
  const newA = w.commit(webA, 'only-on-a.md', 'not pushed to the server');
  const refsA = w.sh(webA, 'for-each-ref');
  B.use();
  Object.assign(process.env, { GIT_SSH_COMMAND: fake, GIT_SSH_VARIANT: 'ssh' });
  try {
    const info = { name: 'box2', target: 'alex@box2', dir: A.ws, projectsDir: A.projects };
    const dry = await syncWith('box2', { info, dir: B.ws, projects: B.projects, dryRun: true });
    // B's shop-web still has the unsaved scratch.md of the test above: it stays, and does not stop the pull.
    assert.deepEqual(byLabel(dry, 'shop/code/shop-web').did, ['would get 1 from box2, unless they touch your 1 uncommitted change']);
    const r = await syncWith('box2', { info, dir: B.ws, projects: B.projects });
    assert.deepEqual(byLabel(r, 'shop/code/shop-web').did, ['got 1 from box2 (your 1 uncommitted change stays)']);
    assert.equal(fs.readFileSync(path.join(B.projects, 'shop', 'code', 'shop-web', 'scratch.md'), 'utf8'), 'unsaved');
    assert.equal(head(path.join(B.projects, 'shop', 'code', 'shop-web')), newA);
    assert.match(byLabel(r, 'shop/code/shop-api').notes[0], /here that box2 does not have/);
    assert.equal(byLabel(r, 'shop').todo[0].why.includes('both moved'), true);
    assert.equal(w.sh(webA, 'for-each-ref'), refsA, 'nothing was written on the other computer');
    assert.deepEqual(r.tools, ['development/sdk/kit']);
    assert.equal(byLabel(r, 'development/sdk/kit'), undefined, 'tools are not synced from another computer either');
  } finally {
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH_VARIANT;
  }
  // Only a computer added by SSH, with what its own Hoprig says.
  putMachine({ name: 'box2', via: 'ssh', target: 'alex@box2', remoteHost: '127.0.0.1', remotePort: 7433, token: 'x', added: 0 });
  putMachine({ name: 'web1', via: 'url', url: 'https://box.example.test', token: 'x', added: 0 });
  const remote = async () => ({ ok: true, result: { stdout: JSON.stringify({ dir: '/home/alex/Workspace', projectsDir: '/home/alex/Workspace/projects' }) } });
  assert.deepEqual(await peerInfo('box2', { remote }), { name: 'box2', target: 'alex@box2', dir: '/home/alex/Workspace', projectsDir: '/home/alex/Workspace/projects' });
  await assert.rejects(peerInfo('web1', { remote }), (e) => e.status === 400);
  await assert.rejects(peerInfo('nobody', { remote }), (e) => e.status === 404);
  await assert.rejects(peerInfo('box2', { remote: async () => ({ ok: true, result: { stdout: JSON.stringify({ dir: '/x; rm -rf ~', projectsDir: '/x' }) } }) }), (e) => e.status === 502);
});

test('set: changes where the workspace and the projects folder are, moves nothing, shows the mv', () => {
  const D = w.computer('dee');
  D.use();
  fs.mkdirSync(path.join(D.home, 'Workspace'), { recursive: true });
  const r = setPlaces({ dir: '~/Code', projects: '~/Code/projects' }, { home: D.home });
  assert.deepEqual(r.changed.map((c) => [c.what, c.toPath]), [['workspace folder', path.join(D.home, 'Code')], ['projects folder', path.join(D.home, 'Code', 'projects')]]);
  assert.deepEqual(r.moves, [`mv "${path.join(D.home, 'Workspace')}" "${path.join(D.home, 'Code')}"`]);
  assert.ok(fs.existsSync(path.join(D.home, 'Workspace')), 'nothing was moved');
  const cfg = JSON.parse(fs.readFileSync(path.join(D.env.HOPRIG_CONFIG_DIR, 'config.json'), 'utf8'));
  assert.equal(cfg.workspaceDir, path.join(D.home, 'Code'));
  assert.equal(cfg.projectsDir, path.join(D.home, 'Code', 'projects'));
  assert.throws(() => setPlaces({ dir: 'relative/x' }, { home: D.home }), (e) => e.status === 400);
  assert.throws(() => setPlaces({}, { home: D.home }), (e) => e.status === 400);
});

test('restore after setup: the untouched starting brain is kept aside, an edited one is refused', async () => {
  const { workspaceSetup } = await import('../../src/workspace/setup.mjs');
  const E = w.computer('eve');
  E.use();
  await workspaceSetup({ cfg: { workspaceDir: E.ws } });
  const { ui } = await quietUi();
  const r = await restoreWorkspace(urls.brain, { ui, dir: E.ws, projects: E.projects });
  assert.equal(r.plan[0].result, 'cloned');
  assert.match(r.notes[0], /unused starting brain was kept as/);
  const aside = fs.readdirSync(E.ws).find((n) => n.startsWith('ai_brain.unused-'));
  assert.ok(aside && fs.existsSync(path.join(E.ws, aside, 'BRAIN.md')));
  assert.equal(w.sh(path.join(E.ws, 'ai_brain'), 'config', '--get', 'remote.origin.url'), urls.brain);
  assert.match(r.plan[0].why, /kept as/);
  assert.ok(!(await M.mapStatus({ dir: E.ws, projects: E.projects })).entries.some((e) => e.label.startsWith('ai_brain.')), 'a brain kept aside is not a repository of the map');

  const F = w.computer('fay');
  F.use();
  await workspaceSetup({ cfg: { workspaceDir: F.ws } });
  fs.appendFileSync(path.join(F.ws, 'ai_brain', 'learnings.md'), '- my own line\n');
  await assert.rejects(restoreWorkspace(urls.brain, { ui, dir: F.ws, projects: F.projects }), (e) => e.status === 409);
  assert.match(fs.readFileSync(path.join(F.ws, 'ai_brain', 'learnings.md'), 'utf8'), /my own line/);
});

test('a person can make a tool syncable again: map keeps "sync": true; a bad value is refused', async () => {
  A.use();
  const m = M.readMap(A.ws).map;
  m.others.find((o) => o.dir === 'development/sdk/kit').sync = true;
  M.writeMap(m, A.ws);
  const r = await M.updateMap({ dir: A.ws, projects: A.projects });
  assert.equal(r.map.others.find((o) => o.dir === 'development/sdk/kit').sync, true);
  assert.deepEqual(r.tools, []);
  const bad = { version: 1, others: [{ dir: 'development/x', url: null, sync: 'no' }] };
  assert.equal(M.validateMap(bad).ok, false);
});

test('the workspace config in the map: the projects folder relative to the workspace, memory links; restore applies them', async () => {
  // Computer G keeps its projects in <workspace>/code and has a project without project.json, memory in mem/.
  const G = w.computer('gus');
  G.use();
  const brainUrl = w.bare('brain-g');
  w.clone(brainUrl, path.join(G.ws, 'ai_brain'));
  const code = path.join(G.ws, 'code');
  const plain = w.clone(w.bare('plain'), path.join(code, 'plain'));
  const scan = await M.scanWorkspace({ dir: G.ws, projects: code, previous: M.emptyMap() });
  assert.deepEqual(scan.map.config, { projectsDir: 'code' });
  const outside = await M.scanWorkspace({ dir: G.ws, projects: path.join(G.home, 'elsewhere'), previous: M.emptyMap() });
  assert.equal(outside.map.config, undefined);
  assert.ok(outside.notes.some((n) => /outside the workspace/.test(n)), 'never a machine path');
  const m = { ...scan.map, projects: [{ name: 'plain', url: w.url('plain'), repos: [], memories: { '.': 'mem' } }] };
  M.writeMap(m, G.ws);
  const text = fs.readFileSync(M.mapFile(G.ws), 'utf8');
  assert.ok(!text.includes(G.home), 'no absolute path in the map');
  w.sh(path.join(G.ws, 'ai_brain'), 'add', 'workspace.json');
  w.sh(path.join(G.ws, 'ai_brain'), 'commit', '-q', '-m', 'map');
  w.sh(path.join(G.ws, 'ai_brain'), 'push', '-q', 'origin', 'HEAD:main');
  assert.ok(plain);
  for (const bad of [{ projectsDir: '../out' }, { projectsDir: '/abs' }, { projectsDir: 'credentials' }, { other: 1 }]) assert.equal(M.validateMap({ version: 1, config: bad }).ok, false, JSON.stringify(bad));
  assert.equal(M.validateMap({ version: 1, projects: [{ name: 'p', url: null, repos: [], memories: { '.': '../../.ssh' } }] }).ok, false);

  // A fresh computer with no projects folder chosen: restore puts the projects where the map says and links memory.
  const H = w.computer('hal');
  H.use();
  const { ui } = await quietUi();
  const r = await restoreWorkspace(brainUrl, { ui, dir: H.ws });
  assert.equal(r.projectsDir, path.join(H.ws, 'code'));
  assert.ok(fs.existsSync(path.join(H.ws, 'code', 'plain', '.git')));
  const link = path.join(H.claude, 'projects', path.join(H.ws, 'code', 'plain').replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(H.ws, 'code', 'plain', 'mem')), 'the map\'s memory link, not a guess');
  assert.equal(JSON.parse(fs.readFileSync(path.join(H.env.HOPRIG_CONFIG_DIR, 'config.json'), 'utf8')).projectsDir, path.join(H.ws, 'code'));
});
