// A linked git worktree (`git worktree add`) is a second checkout of another repository, often a session's
// temporary one: it is never a repository of the workspace map, wherever the map is built or updated, and an entry
// of an existing map whose folder here is a worktree is dropped at the next update. Nothing is dropped by its
// address: an entry whose folder is not here stays (the union), whatever its address. A submodule stays a repository.
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

test('entries whose folder here is a worktree are dropped at the next update; an entry not here stays, whatever its address', async () => {
  const m = M.readMap(C.ws).map;
  const a = m.projects.find((p) => p.name === 'app');
  a.repos.push({ dir: 'code/app-web-wt', url: urls.web }); // its folder here is a worktree
  a.repos.push({ dir: 'code/app-web-gone', url: urls.web }); // not here, the address of code/app-web: kept (a leftover or a wanted clone?)
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
  assert.deepEqual([...r.diff.removed].sort(), linked, 'only what is a worktree on this disk');
  assert.deepEqual(r.map.projects.find((p) => p.name === 'app').repos.map((x) => x.dir).sort(), ['code/app-api', 'code/app-web', 'code/app-web-gone', 'code/lib']);
  assert.deepEqual(r.map.projects.map((p) => p.name).sort(), ['app', 'app-old-name', 'elsewhere', 'two']);
  assert.deepEqual(r.map.others.map((o) => o.dir).sort(), ['git/tool', 'git/tool-old']);
  assert.deepEqual([...r.notHere].sort(), ['app-old-name', 'app/code/app-api', 'app/code/app-web-gone', 'elsewhere', 'git/tool-old']);
  const again = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.equal(again.diff.same, true, 'nothing comes back');
});

test('`workspace map` takes a worktree out of the project.json that names it; a code repository whose folder is gone stays until forget', async () => {
  const manifest = () => JSON.parse(fs.readFileSync(path.join(two, 'project.json'), 'utf8')).repos.map((x) => x.dir);
  const look = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.deepEqual([look.manifests, manifest()], [[{ project: 'two', added: [], dropped: ['code/two-web-wt'] }], ['code/two-web', 'code/two-web-wt']], 'the upkeep leaves project.json alone');
  const r = await M.updateMap({ dir: C.ws, projects: C.projects });
  assert.deepEqual(r.manifests, [{ project: 'two', added: [], dropped: ['code/two-web-wt'] }]);
  assert.deepEqual(manifest(), ['code/two-web'], 'a fresh computer does not clone the worktree');
  // The worktree is removed; a map an older version wrote still names it. Its project is here and its project.json
  // no longer names it: that file is the truth for the project (as before), not the address.
  w.sh(twoWeb, 'worktree', 'remove', path.join(two, 'code', 'two-web-wt'));
  const m = M.readMap(C.ws).map;
  m.projects.find((p) => p.name === 'two').repos.push({ dir: 'code/two-web-wt', url: urls.twoWeb });
  M.writeMap(m, C.ws);
  const out = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.deepEqual([out.takenOut, out.worktrees], [[{ project: 'two', dir: 'code/two-web-wt' }], []]);
  // Without a project.json, an entry whose folder is gone stays (this disk cannot tell it from a clone kept on another
  // computer) until the person runs  hoprig workspace forget app/code/app-web-gone.
  assert.equal(M.forget('app/code/app-web-gone', C.ws).wasInMap, true);
  const after = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.deepEqual(after.map.projects.find((p) => p.name === 'app').repos.map((x) => x.dir).sort(), ['code/app-api', 'code/app-web', 'code/lib']);
  assert.deepEqual([after.diff.same, after.map.skip], [true, ['app/code/app-web-gone']]);
});
