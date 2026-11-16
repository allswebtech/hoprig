// A linked git worktree (`git worktree add`) is a second checkout of another repository, often a session's
// temporary one: it is never a repository of the workspace map, wherever the map is built or updated, and entries
// of an existing map that are worktrees are dropped at the next update. A submodule stays what it was: a repository.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-worktree');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { isLinkedWorktree } = await import('../../src/workspace/layout.mjs');
const { discoverChildren } = await import('../../src/pcsetup/workspace.mjs');

const C = w.computer('wt');
C.use();
const urls = { brain: w.bare('brain'), app: w.bare('app'), web: w.bare('app-web'), lib: w.bare('lib'), tool: w.bare('tool'), two: w.bare('two'), twoWeb: w.bare('two-web') };
w.clone(urls.brain, path.join(C.ws, 'ai_brain'));
const app = w.clone(urls.app, path.join(C.projects, 'app'));
const web = w.clone(urls.web, path.join(app, 'code', 'app-web'));
w.sh(app, 'submodule', 'add', '-q', urls.lib, 'code/lib');
w.sh(web, 'worktree', 'add', '-q', '-b', 'try', path.join(app, 'code', 'app-web-wt'));
const tool = w.clone(urls.tool, path.join(C.ws, 'git', 'tool'));
w.sh(tool, 'worktree', 'add', '-q', '-b', 'try', path.join(C.ws, 'git', 'tool-wt'));
w.sh(app, 'worktree', 'add', '-q', '-b', 'try', path.join(C.projects, 'app-wt'));
// A project whose own project.json names a worktree (written by an older map that took it for a repository).
const two = w.clone(urls.two, path.join(C.projects, 'two'));
const twoWeb = w.clone(urls.twoWeb, path.join(two, 'code', 'two-web'));
w.sh(twoWeb, 'worktree', 'add', '-q', '-b', 'try', path.join(two, 'code', 'two-web-wt'));
fs.writeFileSync(path.join(two, 'project.json'), JSON.stringify({ name: 'two', repos: [{ dir: 'code/two-web', url: urls.twoWeb }, { dir: 'code/two-web-wt', url: urls.twoWeb }], memories: {} }));
// Worktrees of a repository the map does not have (it lives outside the workspace): only their folder tells.
const ext = w.clone(w.bare('ext'), path.join(w.root, 'outside', 'ext'));
w.sh(ext, 'worktree', 'add', '-q', '-b', 'in-app', path.join(app, 'code', 'ext-wt'));
w.sh(ext, 'worktree', 'add', '-q', '-b', 'in-git', path.join(C.ws, 'git', 'ext-wt'));
w.sh(ext, 'worktree', 'add', '-q', '-b', 'as-project', path.join(C.projects, 'ext-wt'));

test('a linked worktree is told apart from a repository and from a submodule, also after it was pruned', () => {
  assert.equal(isLinkedWorktree(path.join(app, 'code', 'app-web-wt')), true);
  assert.equal(isLinkedWorktree(path.join(C.projects, 'app-wt')), true);
  assert.equal(isLinkedWorktree(path.join(app, 'code', 'lib')), false, 'a submodule (.git file into modules/) is not a worktree');
  assert.ok(fs.statSync(path.join(app, 'code', 'lib', '.git')).isFile());
  assert.equal(isLinkedWorktree(web), false);
  assert.equal(isLinkedWorktree(path.join(C.ws, 'nothing')), false);
  const gone = path.join(w.root, 'pruned');
  fs.mkdirSync(gone);
  fs.writeFileSync(path.join(gone, '.git'), `gitdir: ${path.join(web, '.git', 'worktrees', 'old')}\n`);
  assert.equal(isLinkedWorktree(gone), true);
});

test('a project\'s code repositories: the worktree is not one, the submodule is', async () => {
  assert.deepEqual((await discoverChildren(app)).map((c) => c.dir), ['code/app-web', 'code/lib']);
});

test('building the map leaves every linked worktree out (project repositories, projects, other repositories, a project.json)', async () => {
  const r = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.deepEqual(r.map.projects.map((p) => p.name), ['app', 'two']);
  const repos = (n) => r.map.projects.find((p) => p.name === n).repos.map((x) => x.dir);
  assert.deepEqual(repos('app'), ['code/app-web', 'code/lib']);
  assert.deepEqual(repos('two'), ['code/two-web']);
  assert.deepEqual(r.map.others.map((o) => o.dir), ['git/tool']);
  assert.deepEqual(r.worktrees, []);
});

test('worktree entries of an existing map are dropped at the next update; a repository only missing here stays', async () => {
  const m = M.readMap(C.ws).map;
  const a = m.projects.find((p) => p.name === 'app');
  a.repos.push({ dir: 'code/app-web-wt', url: urls.web }); // its folder here is a worktree
  a.repos.push({ dir: 'code/app-web-gone', url: urls.web }); // a worktree that was removed: same address as code/app-web
  a.repos.push({ dir: 'code/app-api', url: w.url('app-api') }); // on another computer only: kept
  m.projects.push({ name: 'app-wt', url: urls.app, repos: [] });
  m.projects.push({ name: 'elsewhere', url: w.url('elsewhere'), repos: [] });
  m.others.push({ dir: 'git/tool-wt', url: urls.tool });
  // Worktrees of a repository the map does not have: no address here to compare with, only their folder tells.
  a.repos.push({ dir: 'code/ext-wt', url: w.url('ext') });
  m.projects.push({ name: 'ext-wt', url: w.url('ext'), repos: [] });
  m.others.push({ dir: 'git/ext-wt', url: w.url('ext') });
  // A project or another repository under a name this computer does not have, with the address of one it has (the
  // same repository under another name on another computer): kept, or two computers would keep undoing each other.
  m.projects.push({ name: 'app-old-name', url: urls.app, repos: [] });
  m.others.push({ dir: 'git/tool-old', url: urls.tool });
  M.writeMap(m, C.ws);
  const r = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  const linked = ['app-wt', 'app/code/app-web-wt', 'app/code/ext-wt', 'ext-wt', 'git/ext-wt', 'git/tool-wt'];
  assert.deepEqual([...r.worktrees].sort(), linked);
  assert.deepEqual(r.twins, [{ label: 'app/code/app-web-gone', same: 'app/code/app-web' }], 'gone: not called a linked worktree');
  assert.deepEqual([...r.diff.removed].sort(), [...linked, 'app/code/app-web-gone'].sort());
  assert.deepEqual(r.map.projects.find((p) => p.name === 'app').repos.map((x) => x.dir).sort(), ['code/app-api', 'code/app-web', 'code/lib']);
  assert.deepEqual(r.map.projects.map((p) => p.name).sort(), ['app', 'app-old-name', 'elsewhere', 'two']);
  assert.deepEqual(r.map.others.map((o) => o.dir).sort(), ['git/tool', 'git/tool-old']);
  assert.deepEqual([...r.notHere].sort(), ['app-old-name', 'app/code/app-api', 'elsewhere', 'git/tool-old']);
  const again = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.equal(again.diff.same, true, 'nothing comes back');
});

test('a worktree named in a project.json is left out after it was removed, and `workspace map` takes it out of that file', async () => {
  w.sh(twoWeb, 'worktree', 'remove', path.join(two, 'code', 'two-web-wt'));
  assert.equal(fs.existsSync(path.join(two, 'code', 'two-web-wt')), false);
  const m = M.readMap(C.ws).map;
  m.projects.find((p) => p.name === 'two').repos.push({ dir: 'code/two-web-wt', url: urls.twoWeb }); // an older map wrote it
  M.writeMap(m, C.ws);
  const look = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.deepEqual(look.map.projects.find((p) => p.name === 'two').repos.map((x) => x.dir), ['code/two-web']);
  assert.deepEqual([look.worktrees, look.twins], [[], [{ label: 'two/code/two-web-wt', same: 'two/code/two-web' }]]);
  assert.ok(!look.notHere.includes('two/code/two-web-wt'), 'dropped, not kept as "not on this computer"');
  const manifest = () => JSON.parse(fs.readFileSync(path.join(two, 'project.json'), 'utf8')).repos.map((x) => x.dir);
  assert.deepEqual(manifest(), ['code/two-web', 'code/two-web-wt'], 'the upkeep leaves project.json alone');
  const r = await M.updateMap({ dir: C.ws, projects: C.projects });
  assert.deepEqual(r.manifests, [{ project: 'two', added: [], dropped: ['code/two-web-wt'] }]);
  assert.deepEqual(manifest(), ['code/two-web'], 'a fresh computer no longer clones the repository twice');
  // A repository named in project.json that is only on another computer, with an address no repository here has: kept.
  const j = JSON.parse(fs.readFileSync(path.join(two, 'project.json'), 'utf8'));
  j.repos.push({ dir: 'code/two-api', url: w.url('two-api') });
  fs.writeFileSync(path.join(two, 'project.json'), JSON.stringify(j));
  const again = await M.updateMap({ dir: C.ws, projects: C.projects });
  assert.deepEqual(again.map.projects.find((p) => p.name === 'two').repos.map((x) => x.dir).sort(), ['code/two-api', 'code/two-web']);
  assert.deepEqual(again.manifests, []);
});
