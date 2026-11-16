// Two full clones of one repository in one project are a person's choice, not a leftover: the map lists both, a
// fresh computer clones both, and the map and project.json stay the same through every round of upkeep and
// `workspace map` between two computers. Nothing is dropped or left out because of its address; a stale entry is
// taken out with `hoprig workspace forget <project>/<dir>`, which also keeps restore from cloning it from project.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-clones');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hoprig.mjs');

const urls = { brain: w.bare('brain'), dup: w.bare('dup'), pj: w.bare('pj'), web: w.bare('web') };
const A = w.computer('a');
const B = w.computer('b');
const brain = (c) => path.join(c.ws, 'ai_brain');
const push = (dir, msg) => {
  w.sh(dir, 'add', '-A');
  w.sh(dir, 'commit', '-q', '-m', msg);
  w.sh(dir, 'push', '-q');
};
const pull = (dir) => w.sh(dir, 'pull', '-q', '--ff-only');
const mapText = (c) => fs.readFileSync(M.mapFile(c.ws), 'utf8');
const manifestText = (c) => fs.readFileSync(path.join(c.projects, 'pj', 'project.json'), 'utf8');
const reposOf = (map, name) => map.projects.find((p) => p.name === name).repos.map((r) => r.dir).sort();
const restoreOn = async (c) => {
  c.use();
  const { ui } = await quietUi();
  return restoreWorkspace(urls.brain, { ui, dir: c.ws, projects: c.projects });
};

test('computer A keeps two full clones of one repository in a project, with and without a project.json', async () => {
  A.use();
  w.clone(urls.brain, brain(A));
  const dup = w.clone(urls.dup, path.join(A.projects, 'dup'));
  fs.writeFileSync(path.join(dup, '.gitignore'), '/code/*\n');
  push(dup, 'ignore code');
  w.clone(urls.web, path.join(dup, 'code', 'web'));
  w.clone(urls.web, path.join(dup, 'code', 'web-2'));
  const pj = w.clone(urls.pj, path.join(A.projects, 'pj'));
  fs.writeFileSync(path.join(pj, '.gitignore'), '/code/*\n');
  fs.writeFileSync(path.join(pj, 'project.json'), JSON.stringify({ name: 'pj', repos: [{ dir: 'code/web', url: urls.web }], memories: {} }, null, 2) + '\n');
  push(pj, 'project.json');
  w.clone(urls.web, path.join(pj, 'code', 'web'));
  w.clone(urls.web, path.join(pj, 'code', 'web-2'));
  const r = await M.updateMap({ dir: A.ws, projects: A.projects }); // `workspace map`
  assert.deepEqual([reposOf(r.map, 'dup'), reposOf(r.map, 'pj')], [['code/web', 'code/web-2'], ['code/web', 'code/web-2']]);
  assert.deepEqual(r.manifests, [{ project: 'pj', added: ['code/web-2'], dropped: [] }], 'a repository found here is added, though another entry has its address');
  assert.deepEqual(r.worktrees, []);
  push(pj, 'project.json: web-2');
  push(brain(A), 'map');
});

test('a fresh computer B clones both: the map and project.json are restored as they are', async () => {
  const r = await restoreOn(B);
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.filter((e) => e.kind === 'repo').map((e) => [e.label, e.result]), [
    ['dup/code/web', 'cloned'], ['dup/code/web-2', 'cloned'], ['pj/code/web', 'cloned'], ['pj/code/web-2', 'cloned'],
  ]);
  for (const d of ['dup/code/web', 'dup/code/web-2', 'pj/code/web', 'pj/code/web-2']) assert.ok(M.sameUrl(w.sh(path.join(B.projects, d), 'config', '--get', 'remote.origin.url'), urls.web), d);
});

test('the map and project.json stay the same after every round of upkeep and `workspace map` between A and B', async () => {
  const map0 = mapText(A);
  const manifest0 = manifestText(A);
  assert.deepEqual([mapText(B), manifestText(B)], [map0, manifest0]);
  for (let round = 1; round <= 3; round++) {
    for (const c of [B, A]) {
      c.use();
      pull(brain(c));
      pull(path.join(c.projects, 'pj'));
      // The upkeep (project.json left alone), then `workspace map` (which may rewrite project.json).
      for (const manifests of [false, true]) {
        const r = await M.updateMap({ dir: c.ws, projects: c.projects, manifests });
        const where = `round ${round}, computer ${path.basename(c.home)}, manifests ${manifests}`;
        assert.deepEqual([r.diff.same, r.otherChanges, r.manifests, r.worktrees, r.takenOut, r.notHere], [true, false, [], [], [], []], where);
        assert.equal(mapText(c), map0, where);
        assert.equal(manifestText(c), manifest0, where);
        assert.equal(w.sh(brain(c), 'status', '--porcelain'), '', `${where}: nothing to commit in the brain`);
        assert.equal(w.sh(path.join(c.projects, 'pj'), 'status', '--porcelain'), '', `${where}: nothing to commit in the project`);
      }
    }
  }
});

test('an entry not on this computer stays, also with the address of one that is; only forget takes it out (from the command line)', async () => {
  A.use();
  // What an older version wrote: a worktree of the project, removed since. Its address is code/web's.
  const m = M.readMap(A.ws).map;
  m.projects.find((p) => p.name === 'dup').repos.push({ dir: 'code/web-wt', url: urls.web });
  M.writeMap(m, A.ws);
  const pj = path.join(A.projects, 'pj');
  const j = JSON.parse(fs.readFileSync(path.join(pj, 'project.json'), 'utf8'));
  j.repos.push({ dir: 'code/web-wt', url: urls.web });
  fs.writeFileSync(path.join(pj, 'project.json'), JSON.stringify(j, null, 2) + '\n');
  push(pj, 'project.json: an older map\'s worktree');
  const kept = await M.updateMap({ dir: A.ws, projects: A.projects });
  assert.deepEqual([reposOf(kept.map, 'dup'), reposOf(kept.map, 'pj')], [['code/web', 'code/web-2', 'code/web-wt'], ['code/web', 'code/web-2', 'code/web-wt']]);
  assert.deepEqual([kept.worktrees, kept.manifests], [[], []]);
  assert.deepEqual(kept.notHere, ['dup/code/web-wt'], 'pj/code/web-wt is named by its project.json, so the scan has it');

  const cli = (...args) => execFileSync(process.execPath, [BIN, 'workspace', ...args], { env: { ...process.env, ...A.env, HOPRIG_WORKSPACE_DIR: A.ws, NO_COLOR: '1' }, encoding: 'utf8' });
  assert.match(cli('forget', 'dup/code/web-wt'), /dup\/code\/web-wt is out of the map/);
  assert.match(cli('forget', 'pj/code/web-wt'), /pj\/code\/web-wt is out of the map/);
  const after = await M.updateMap({ dir: A.ws, projects: A.projects });
  assert.deepEqual([reposOf(after.map, 'dup'), reposOf(after.map, 'pj')], [['code/web', 'code/web-2'], ['code/web', 'code/web-2']], 'not added back, also from project.json');
  assert.deepEqual(after.map.skip, ['dup/code/web-wt', 'pj/code/web-wt']);
  assert.deepEqual([after.diff.same, after.manifests, after.notHere], [true, [], []]);
  assert.ok(fs.existsSync(path.join(pj, 'code', 'web')), 'no file was touched');
  push(brain(A), 'forget');

  // A fresh computer clones neither: not from the map, not from the project.json that still names one.
  const C = w.computer('c');
  const r = await restoreOn(C);
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.filter((e) => e.kind === 'repo').map((e) => e.label), ['dup/code/web', 'dup/code/web-2', 'pj/code/web', 'pj/code/web-2']);
  assert.equal(fs.existsSync(path.join(C.projects, 'pj', 'code', 'web-wt')), false);
  assert.equal(fs.existsSync(path.join(C.projects, 'dup', 'code', 'web-wt')), false);

  // On computer B, the forgotten entries do not come back either.
  B.use();
  pull(brain(B));
  pull(path.join(B.projects, 'pj'));
  const b = await M.updateMap({ dir: B.ws, projects: B.projects });
  assert.deepEqual([b.diff.same, b.manifests, reposOf(b.map, 'pj')], [true, [], ['code/web', 'code/web-2']]);
});

test('forget names a code repository by <project>/<dir>; an unknown one is said so', () => {
  A.use();
  assert.deepEqual(M.forget('dup/code/nothing', A.ws).wasInMap, false);
  assert.throws(() => M.forget('../dup', A.ws), /name a project, a code repository/);
});
