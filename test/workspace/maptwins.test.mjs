// A project lists each repository once (map.mjs twinsIn). A worktree an older map wrote into a project's committed
// project.json is not cloned on a fresh computer, also before anyone rewrote that file; a second checkout someone
// asked for (an entry with its own branch) stays in the map and in project.json and is cloned on its branch; and one
// repository under two names on two computers settles on one name instead of each computer undoing the other's map.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-twins');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');

const urls = { brain: w.bare('brain'), two: w.bare('two'), twoWeb: w.bare('two-web'), pair: w.bare('pair'), pairWeb: w.bare('pair-web') };
// two-web has a "release" branch: the second checkout someone asked for.
const seed = w.clone(urls.twoWeb, path.join(w.root, 'seed-two-web'));
w.sh(seed, 'switch', '-q', '-c', 'release');
w.commit(seed, 'RELEASE', '1\n');
w.sh(seed, 'push', '-q', 'origin', 'release');

const A = w.computer('a');
A.use();
w.clone(urls.brain, path.join(A.ws, 'ai_brain'));
const two = w.clone(urls.two, path.join(A.projects, 'two'));
const twoWeb = w.clone(urls.twoWeb, path.join(two, 'code', 'two-web'));
fs.writeFileSync(path.join(two, '.gitignore'), '/code/*\n');
const manifestOf = (root) => JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
const writeManifest = (root, repos) => {
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ name: path.basename(root), repos, memories: {} }, null, 2) + '\n');
  w.sh(root, 'add', '-A');
  w.sh(root, 'commit', '-q', '-m', 'project.json');
  w.sh(root, 'push', '-q');
};
const pushMap = () => {
  const brain = path.join(A.ws, 'ai_brain');
  w.sh(brain, 'add', '-A');
  w.sh(brain, 'commit', '-q', '-m', 'map');
  w.sh(brain, 'push', '-q');
};
const reposOf = (map, name) => map.projects.find((p) => p.name === name).repos.map((r) => r.dir).sort();
const restoreOn = async (name, opts = {}) => {
  const c = w.computer(name);
  c.use();
  const { ui, text } = await quietUi();
  const r = await restoreWorkspace(urls.brain, { ui, dir: c.ws, projects: c.projects, ...opts });
  A.use();
  return { c, r, text };
};

test('a worktree named in a committed project.json is not cloned on a fresh computer, though the upkeep left that file alone', async () => {
  w.sh(twoWeb, 'worktree', 'add', '-q', '-b', 'try', path.join(two, 'code', 'two-web-wt'));
  // What an older version wrote while the worktree was there: the map and the project's project.json both name it.
  writeManifest(two, [{ dir: 'code/two-web', url: urls.twoWeb }, { dir: 'code/two-web-wt', url: urls.twoWeb }]);
  M.writeMap({ version: 1, brain: { url: urls.brain }, projects: [{ name: 'two', url: urls.two, repos: [{ dir: 'code/two-web', url: urls.twoWeb }, { dir: 'code/two-web-wt', url: urls.twoWeb }] }], others: [] }, A.ws);
  w.sh(twoWeb, 'worktree', 'remove', path.join(two, 'code', 'two-web-wt'));
  const up = await M.updateMap({ dir: A.ws, projects: A.projects, manifests: false });
  assert.deepEqual(reposOf(up.map, 'two'), ['code/two-web']);
  assert.deepEqual(up.twins, [{ label: 'two/code/two-web-wt', same: 'two/code/two-web' }]);
  assert.deepEqual(up.worktrees, [], 'its folder is gone: not called a linked worktree');
  assert.deepEqual(manifestOf(two).repos.map((r) => r.dir), ['code/two-web', 'code/two-web-wt'], 'the upkeep leaves project.json alone');
  pushMap();
  const { c, r } = await restoreOn('b');
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.filter((e) => e.kind === 'repo').map((e) => [e.label, e.result]), [['two/code/two-web', 'cloned']]);
  assert.ok(r.notes.includes('two/code/two-web-wt: not cloned, it is the same repository as two/code/two-web'), r.notes.join('\n'));
  assert.equal(fs.existsSync(path.join(c.projects, 'two', 'code', 'two-web')), true);
  assert.equal(fs.existsSync(path.join(c.projects, 'two', 'code', 'two-web-wt')), false);
});

test('a map an older version wrote with the worktree in it: a fresh computer still gets the repository once', async () => {
  const m = M.readMap(A.ws).map;
  m.projects.find((p) => p.name === 'two').repos.push({ dir: 'code/two-web-wt', url: urls.twoWeb });
  M.writeMap(m, A.ws);
  pushMap();
  const { r } = await restoreOn('c', { dryRun: true });
  assert.deepEqual(r.plan.filter((e) => e.kind === 'repo').map((e) => [e.label, e.action]), [['two/code/two-web', 'clone']]);
  assert.ok(r.notes.includes('two/code/two-web-wt: not cloned, it is the same repository as two/code/two-web'));
});

test('a second checkout someone asked for (its own branch) stays in the map and in project.json, and is cloned on its branch', async () => {
  writeManifest(two, [{ dir: 'code/two-web', url: urls.twoWeb }, { dir: 'code/two-web-release', url: urls.twoWeb, branch: 'release' }]);
  const r = await M.updateMap({ dir: A.ws, projects: A.projects }); // `workspace map`, which may rewrite project.json
  assert.deepEqual(reposOf(r.map, 'two'), ['code/two-web', 'code/two-web-release']);
  assert.equal(r.map.projects.find((p) => p.name === 'two').repos.find((x) => x.dir === 'code/two-web-release').branch, 'release');
  assert.deepEqual([r.twins, r.worktrees, r.manifests], [[{ label: 'two/code/two-web-wt', same: 'two/code/two-web' }], [], []], 'the older map\'s worktree goes, the asked-for checkout stays');
  assert.deepEqual(manifestOf(two).repos.map((x) => x.dir), ['code/two-web', 'code/two-web-release'], 'project.json is not rewritten');
  pushMap();
  const { c, r: got } = await restoreOn('d');
  assert.deepEqual(got.plan.filter((e) => e.kind === 'repo').map((e) => [e.label, e.result]), [['two/code/two-web', 'cloned'], ['two/code/two-web-release', 'cloned']]);
  assert.equal(w.sh(path.join(c.projects, 'two', 'code', 'two-web-release'), 'branch', '--show-current'), 'release');
  assert.equal(w.sh(path.join(c.projects, 'two', 'code', 'two-web'), 'branch', '--show-current'), 'main');
});

test('one repository under two names on two computers settles on one name: no computer undoes the other\'s map', async () => {
  // Computer A has pair/code/web, computer E the same repository as pair/code/web-app. Both maps start from the
  // union an older version wrote. Each update's map goes to the other computer, as the brain's history carries it.
  const pairA = w.clone(urls.pair, path.join(A.projects, 'pair'));
  fs.writeFileSync(path.join(pairA, '.gitignore'), '/code/*\n');
  w.clone(urls.pairWeb, path.join(pairA, 'code', 'web'));
  const E = w.computer('e');
  E.use();
  w.clone(urls.brain, path.join(E.ws, 'ai_brain'));
  const pairE = w.clone(urls.pair, path.join(E.projects, 'pair'));
  w.clone(urls.pairWeb, path.join(pairE, 'code', 'web-app'));
  A.use();
  const m = M.readMap(A.ws).map;
  m.projects = m.projects.filter((p) => p.name !== 'pair');
  m.projects.push({ name: 'pair', url: urls.pair, repos: [{ dir: 'code/web', url: urls.pairWeb }, { dir: 'code/web-app', url: urls.pairWeb }] });
  M.writeMap(m, A.ws);
  const on = async (c, map) => {
    c.use();
    M.writeMap(map, c.ws);
    const r = await M.updateMap({ dir: c.ws, projects: c.projects, manifests: false });
    A.use();
    return r;
  };
  const a1 = await on(A, M.readMap(A.ws).map);
  assert.deepEqual(reposOf(a1.map, 'pair'), ['code/web']);
  assert.deepEqual(a1.twins, [{ label: 'pair/code/web-app', same: 'pair/code/web' }]);
  const e1 = await on(E, a1.map);
  assert.deepEqual(reposOf(e1.map, 'pair'), ['code/web'], 'computer E keeps the name the map has');
  assert.equal(e1.diff.same, true);
  assert.ok(e1.notes.some((n) => n.startsWith('pair/code/web-app: the same repository as pair/code/web')), e1.notes.join('\n'));
  const a2 = await on(A, e1.map);
  const e2 = await on(E, a2.map);
  assert.deepEqual([a2.diff.same, e2.diff.same], [true, true], 'nothing flips back and forth');
  // The other name, chosen in the project's project.json: every computer follows it.
  writeManifest(pairA, [{ dir: 'code/web-app', url: urls.pairWeb }]);
  w.sh(pairE, 'pull', '-q');
  const e3 = await on(E, e2.map);
  assert.deepEqual(reposOf(e3.map, 'pair'), ['code/web-app']);
  const a3 = await on(A, e3.map);
  assert.deepEqual(reposOf(a3.map, 'pair'), ['code/web-app']);
  assert.equal(a3.diff.same, true);
  const a4 = await M.updateMap({ dir: A.ws, projects: A.projects }); // `workspace map` on A: project.json stays as chosen
  assert.deepEqual(a4.manifests, []);
  assert.deepEqual(manifestOf(pairA).repos.map((r) => r.dir), ['code/web-app']);
});
