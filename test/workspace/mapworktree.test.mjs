// A linked git worktree (`git worktree add`) is a second checkout of another repository, often a session's
// temporary one: a scan never adds one, wherever the map is built or updated. An entry the map (or a project.json)
// already has whose folder here is a worktree is kept and counts as not on this computer: the same folder name may be
// a full clone on another computer. Only `workspace forget` takes it out. A submodule stays a repository.
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

test('building the map adds no linked worktree found here (project repositories, projects, other repositories)', async () => {
  const r = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.deepEqual(r.map.projects.map((p) => p.name), ['app', 'two']);
  const repos = (n) => r.map.projects.find((p) => p.name === n).repos.map((x) => x.dir);
  assert.deepEqual(repos('app'), ['code/app-web', 'code/lib']);
  assert.deepEqual(repos('two'), ['code/two-web', 'code/two-web-wt'], 'what project.json names stays: the scan did not find it');
  assert.deepEqual(r.map.others.map((o) => o.dir), ['git/tool']);
});

const linked = ['app-wt', 'app/code/app-web-wt', 'app/code/ext-wt', 'ext-wt', 'git/ext-wt', 'git/tool-wt'];

test('an entry whose folder here is a worktree is kept and listed as not on this computer, like any entry not here', async () => {
  const m = M.readMap(C.ws).map;
  const a = m.projects.find((p) => p.name === 'app');
  a.repos.push({ dir: 'code/app-web-wt', url: urls.web }); // its folder here is a worktree (a full clone elsewhere?)
  a.repos.push({ dir: 'code/app-web-gone', url: urls.web }); // not here, the address of code/app-web: kept (a leftover or a wanted clone?)
  a.repos.push({ dir: 'code/app-api', url: w.url('app-api') }); // on another computer only: kept
  m.projects.push({ name: 'app-wt', url: urls.app, repos: [] });
  m.projects.push({ name: 'elsewhere', url: w.url('elsewhere'), repos: [] });
  m.others.push({ dir: 'git/tool-wt', url: urls.tool });
  // Worktrees of a repository the map does not have: kept the same way.
  a.repos.push({ dir: 'code/ext-wt', url: w.url('ext') });
  m.projects.push({ name: 'ext-wt', url: w.url('ext'), repos: [] });
  m.others.push({ dir: 'git/ext-wt', url: w.url('ext') });
  // A project or another repository under a name this computer does not have, with the address of one it has (the
  // same repository under another name on another computer): kept, or two computers would keep undoing each other.
  m.projects.push({ name: 'app-old-name', url: urls.app, repos: [] });
  m.others.push({ dir: 'git/tool-old', url: urls.tool });
  M.writeMap(m, C.ws);
  const before = fs.readFileSync(M.mapFile(C.ws), 'utf8');
  for (const manifests of [false, true]) {
    const r = await M.updateMap({ dir: C.ws, projects: C.projects, manifests });
    assert.deepEqual([r.diff.same, r.diff.removed, r.takenOut, r.manifests, r.otherChanges], [true, [], [], [], false], `manifests ${manifests}: nothing leaves the map`);
    assert.equal('worktrees' in r, false);
    assert.deepEqual([...r.notHere].sort(), ['app-old-name', 'app/code/app-api', 'app/code/app-web-gone', ...linked, 'elsewhere', 'git/tool-old'].sort());
    assert.equal(fs.readFileSync(M.mapFile(C.ws), 'utf8'), before);
  }
  const st = await M.mapStatus({ dir: C.ws, projects: C.projects });
  const state = (l) => st.entries.find((e) => e.label === l).state;
  for (const l of [...linked, 'two/code/two-web-wt']) assert.equal(state(l), 'missing', `${l}: a worktree here is not this entry`);
  assert.deepEqual([state('app/code/app-web'), state('app/code/lib'), state('git/tool')], ['here', 'here', 'here']);
});

test('`workspace map` leaves a project.json that names a worktree as it is; forget removes a stale entry', async () => {
  const manifestText = () => fs.readFileSync(path.join(two, 'project.json'), 'utf8');
  const manifest0 = manifestText();
  const r = await M.updateMap({ dir: C.ws, projects: C.projects });
  assert.deepEqual([r.manifests, r.diff.same, manifestText()], [[], true, manifest0], 'project.json and the map stay');
  // The one rule from before: a project here whose project.json no longer names a code repository the map has
  // (and whose folder is not here) loses it.
  const m = M.readMap(C.ws).map;
  m.projects.find((p) => p.name === 'two').repos.push({ dir: 'code/two-old', url: urls.twoWeb });
  M.writeMap(m, C.ws);
  const out = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.deepEqual(out.takenOut, [{ project: 'two', dir: 'code/two-old' }]);
  // Stale entries go only with  hoprig workspace forget <entry>, also one named by a project.json; no file is touched.
  for (const l of [...linked, 'two/code/two-web-wt', 'app/code/app-web-gone']) assert.equal(M.forget(l, C.ws).wasInMap, true, l);
  const after = await M.updateMap({ dir: C.ws, projects: C.projects });
  assert.deepEqual(after.map.projects.map((p) => p.name).sort(), ['app', 'app-old-name', 'elsewhere', 'two']);
  assert.deepEqual(after.map.projects.find((p) => p.name === 'app').repos.map((x) => x.dir).sort(), ['code/app-api', 'code/app-web', 'code/lib']);
  assert.deepEqual(after.map.projects.find((p) => p.name === 'two').repos.map((x) => x.dir), ['code/two-web']);
  assert.deepEqual(after.map.others.map((o) => o.dir).sort(), ['git/tool', 'git/tool-old']);
  assert.deepEqual([after.diff.same, after.manifests, manifestText()], [true, [], manifest0]);
  assert.ok(fs.existsSync(path.join(two, 'code', 'two-web-wt', '.git')), 'the worktree itself is untouched');
});

test('mergeMap honours a forgotten <project>/<dir> as it honours a forgotten project', () => {
  const cur = { version: 1, brain: { url: null }, projects: [{ name: 'p', url: null, repos: [{ dir: 'code/a', url: null }, { dir: 'code/b', url: null }] }], others: [], skip: ['p/code/b'] };
  const scan = { map: { version: 1, brain: { url: null }, projects: [{ name: 'p', url: null, repos: [{ dir: 'code/a', url: null }] }], others: [] }, sources: { p: 'found' } };
  const r = M.mergeMap(cur, scan);
  assert.deepEqual([r.map.projects[0].repos.map((x) => x.dir), r.notHere], [['code/a'], []]);
});
