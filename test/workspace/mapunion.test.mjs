// The map is the union of the workspace across computers: two temporary computers with different projects update
// it in turn through the brain's bare repository, and nothing is lost. Only forget takes something out; a present
// project's own project.json may drop one of its code repositories; nothing is "removed" merely for not being here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-union');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');

const C1 = w.computer('alex');
const C2 = w.computer('box2');
const urls = { brain: w.bare('brain') };
const brain = (c) => path.join(c.ws, 'ai_brain');
const project = (c, name, { manifest = null, kids = [] } = {}) => {
  const root = w.clone((urls[name] = w.bare(name)), path.join(c.projects, name));
  for (const k of kids) w.clone((urls[k] = urls[k] || w.bare(k)), path.join(root, 'code', k));
  if (manifest) {
    fs.writeFileSync(path.join(root, '.gitignore'), '/code/*\n');
    fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ name, repos: manifest.map((k) => ({ dir: `code/${k}`, url: urls[k] })), memories: {} }));
    w.sh(root, 'add', '-A');
    w.sh(root, 'commit', '-q', '-m', 'manifest');
  }
  return root;
};
const share = (c, msg) => {
  w.sh(brain(c), 'add', 'workspace.json');
  w.sh(brain(c), 'commit', '-q', '-m', msg);
  w.sh(brain(c), 'push', '-q', 'origin', 'HEAD:main');
};
const pull = (c) => w.sh(brain(c), 'pull', '-q', '--ff-only', 'origin', 'main');
const names = (m) => m.projects.map((p) => p.name).sort();

test('two computers with different projects: after both update the map, it holds the union and nothing was lost', async () => {
  C1.use();
  w.clone(urls.brain, brain(C1));
  project(C1, 'one', { manifest: ['one-web'], kids: ['one-web'] });
  w.clone((urls.tool = w.bare('tool')), path.join(C1.ws, 'git', 'tool'));
  await M.updateMap({ dir: C1.ws, projects: C1.projects });
  share(C1, 'map from alex');

  C2.use();
  w.clone(urls.brain, brain(C2));
  project(C2, 'two');
  project(C2, 'three', { kids: ['three-x'] });
  const dry = await M.updateMap({ dir: C2.ws, projects: C2.projects, dryRun: true });
  assert.deepEqual(dry.diff.removed, [], 'nothing is removed merely for not being here');
  assert.deepEqual(dry.notHere.sort(), ['git/tool', 'one', 'one/code/one-web']);
  assert.deepEqual(dry.diff.added.sort(), ['three', 'three/code/three-x', 'two']);
  const r = await M.updateMap({ dir: C2.ws, projects: C2.projects });
  assert.deepEqual(names(r.map), ['one', 'three', 'two']);
  assert.deepEqual(r.map.others.map((o) => o.dir), ['git/tool']);
  share(C2, 'map from box2');

  C1.use();
  pull(C1);
  const back = await M.updateMap({ dir: C1.ws, projects: C1.projects });
  assert.deepEqual(names(back.map), ['one', 'three', 'two'], 'the other computer\'s projects stay');
  assert.equal(back.diff.same, true);
  assert.deepEqual(back.map.projects.find((p) => p.name === 'one').repos.map((x) => x.dir), ['code/one-web']);
});

test('forget on one computer stays forgotten after the other one\'s map', async () => {
  C1.use();
  const f = M.forget('two', C1.ws);
  assert.equal(f.wasInMap, true);
  share(C1, 'forget two');
  C2.use();
  pull(C2);
  const r = await M.updateMap({ dir: C2.ws, projects: C2.projects });
  assert.deepEqual(names(r.map), ['one', 'three'], 'two is on this disk but stays out');
  assert.deepEqual(r.map.skip, ['two']);
  assert.ok(fs.existsSync(path.join(C2.projects, 'two')), 'no file was touched');
  assert.equal(r.diff.same, true, 'nothing to commit: the map already says it all');
});

test('a code repository missing here stays; one dropped by a present project\'s own project.json is taken out, and said so', async () => {
  // "three" has no project.json: its repository folder going away here does not take it out of the map.
  C2.use();
  fs.rmSync(path.join(C2.projects, 'three', 'code', 'three-x'), { recursive: true, force: true });
  const kept = await M.updateMap({ dir: C2.ws, projects: C2.projects, dryRun: true });
  assert.deepEqual(kept.notHere.sort(), ['git/tool', 'one', 'one/code/one-web', 'three/code/three-x']);
  assert.deepEqual(kept.diff.removed, []);
  // "one" is here and its project.json no longer names one-web (and the folder is gone): its project.json wins.
  C1.use();
  pull(C1);
  const root = path.join(C1.projects, 'one');
  fs.writeFileSync(path.join(root, 'project.json'), JSON.stringify({ name: 'one', repos: [], memories: {} }));
  fs.rmSync(path.join(root, 'code', 'one-web'), { recursive: true, force: true });
  const r = await M.updateMap({ dir: C1.ws, projects: C1.projects });
  assert.deepEqual(r.takenOut, [{ project: 'one', dir: 'code/one-web' }]);
  assert.deepEqual(r.diff.removed, ['one/code/one-web']);
  assert.deepEqual(names(r.map), ['one', 'three']);
});

test('a computer without a brain remote or with another projects folder never blanks what the map says', () => {
  const cur = { version: 1, config: { projectsDir: 'code' }, brain: { url: urls.brain }, projects: [{ name: 'one', url: urls.one, repos: [], memories: { '.': 'mem' } }], others: [] };
  const scan = { map: { version: 1, brain: { url: null }, projects: [{ name: 'one', url: null, repos: [] }], others: [] }, sources: { one: 'found' } };
  const m = M.mergeMap(cur, scan).map;
  assert.equal(m.brain.url, urls.brain);
  assert.deepEqual(m.config, { projectsDir: 'code' });
  assert.equal(m.projects[0].url, urls.one);
  assert.deepEqual(m.projects[0].memories, { '.': 'mem' });
});
