// One folder name, two computers: on A it is a linked worktree (a second checkout of another repository), on B a full
// clone on its own branch. "A worktree here" does not prove "a leftover everywhere", so nothing leaves the map
// because of it: through several rounds of the upkeep and of `workspace map` on both computers, sharing the map
// through the brain's git server, the map and every project.json stay byte for byte the same and the branch stays.
// Restore and sync on A leave the worktree alone and say so; a fresh computer clones the repository on its branch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-samename');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const { WORKTREE_LEFT, WORKTREE_WHY } = await import('../../src/workspace/layout.mjs');

const urls = { brain: w.bare('brain'), br: w.bare('br'), np: w.bare('np'), app: w.bare('app'), tool: w.bare('tool') };
// The repository has a second branch, "dev", which B keeps checked out in a full clone.
for (const u of [urls.app, urls.tool]) {
  const seed = w.clone(u, path.join(w.root, 'seed', path.basename(u)));
  w.sh(seed, 'checkout', '-q', '-b', 'dev');
  w.commit(seed, 'DEV.md', 'dev\n');
  w.sh(seed, 'push', '-q', 'origin', 'dev');
}
const A = w.computer('a');
const B = w.computer('b');
const brain = (c) => path.join(c.ws, 'ai_brain');
const pull = (dir) => w.sh(dir, 'pull', '-q', '--ff-only');
const push = (dir, msg) => {
  w.sh(dir, 'add', '-A');
  w.sh(dir, 'commit', '-q', '-m', msg);
  w.sh(dir, 'push', '-q');
};
const ignoreCode = (dir) => {
  fs.writeFileSync(path.join(dir, '.gitignore'), '/code/*\n');
  push(dir, 'ignore code');
};
const mapText = (c) => fs.readFileSync(M.mapFile(c.ws), 'utf8');
const manifestText = (c) => fs.readFileSync(path.join(c.projects, 'br', 'project.json'), 'utf8');
const head = (dir) => w.sh(dir, 'symbolic-ref', '--short', 'HEAD');
const WT = ['br/code/app-dev', 'np/code/app-dev', 'git/tool-dev'];

test('B: full clones on "dev" under three folder names; its `workspace map` writes the first map', async () => {
  B.use();
  w.clone(urls.brain, brain(B));
  // br: its project.json names code/app-dev on branch dev. np: no project.json, the map alone speaks for it.
  const br = w.clone(urls.br, path.join(B.projects, 'br'));
  fs.writeFileSync(path.join(br, 'project.json'), JSON.stringify({ name: 'br', repos: [{ dir: 'code/app', url: urls.app }, { dir: 'code/app-dev', url: urls.app, branch: 'dev' }], memories: {} }, null, 2) + '\n');
  fs.writeFileSync(path.join(br, '.gitignore'), '/code/*\n');
  push(br, 'project.json');
  const np = w.clone(urls.np, path.join(B.projects, 'np'));
  ignoreCode(np);
  for (const p of [br, np]) {
    w.clone(urls.app, path.join(p, 'code', 'app'));
    w.sh(w.clone(urls.app, path.join(p, 'code', 'app-dev')), 'checkout', '-q', 'dev');
  }
  w.clone(urls.tool, path.join(B.ws, 'git', 'tool'));
  w.sh(w.clone(urls.tool, path.join(B.ws, 'git', 'tool-dev')), 'checkout', '-q', 'dev');
  const r = await M.updateMap({ dir: B.ws, projects: B.projects });
  const repos = (n) => r.map.projects.find((p) => p.name === n).repos;
  assert.deepEqual(repos('br'), [{ dir: 'code/app', url: urls.app }, { dir: 'code/app-dev', url: urls.app, branch: 'dev' }]);
  assert.deepEqual(repos('np').map((x) => x.dir), ['code/app', 'code/app-dev']);
  assert.deepEqual(r.map.others, [{ dir: 'git/tool', url: urls.tool, branch: 'main' }, { dir: 'git/tool-dev', url: urls.tool, branch: 'dev' }]);
  assert.deepEqual(r.manifests, []);
  push(brain(B), 'the first map');
});

test('A: the same folder names are linked worktrees of the full clones next to them', () => {
  A.use();
  w.clone(urls.brain, brain(A));
  for (const n of ['br', 'np']) {
    const p = w.clone(urls[n], path.join(A.projects, n));
    const app = w.clone(urls.app, path.join(p, 'code', 'app'));
    // br's on the branch B keeps ("dev"), np's on a session's own branch.
    if (n === 'br') w.sh(app, 'worktree', 'add', '-q', path.join(p, 'code', 'app-dev'), 'dev');
    else w.sh(app, 'worktree', 'add', '-q', '-b', 'try', path.join(p, 'code', 'app-dev'), 'origin/dev');
  }
  const tool = w.clone(urls.tool, path.join(A.ws, 'git', 'tool'));
  w.sh(tool, 'worktree', 'add', '-q', path.join(A.ws, 'git', 'tool-dev'), 'dev');
  assert.equal(fs.statSync(path.join(A.projects, 'br', 'code', 'app-dev', '.git')).isFile(), true);
});

test('several rounds of the upkeep and of `workspace map` on A and B: the map and project.json never change, the branch stays', async () => {
  const map0 = mapText(B);
  const manifest0 = manifestText(B);
  assert.match(manifest0, /"branch": "dev"/);
  for (let round = 1; round <= 3; round++) {
    for (const c of [A, B]) {
      c.use();
      for (const d of [brain(c), path.join(c.projects, 'br'), path.join(c.projects, 'np')]) pull(d);
      const where = `round ${round}, computer ${path.basename(c.home)}`;
      const up = await upkeepMap({ dir: c.ws, projects: c.projects, commit: true });
      assert.deepEqual([up.changed, up.lines], [false, []], `${where}: the upkeep`);
      const r = await M.updateMap({ dir: c.ws, projects: c.projects }); // `workspace map`, which may write project.json
      assert.deepEqual([r.diff.same, r.otherChanges, r.manifests, r.takenOut], [true, false, [], []], `${where}: workspace map`);
      // On A, what the map has and A has only as a worktree is "not on this computer" (br/code/app-dev is named by
      // br's own project.json, so the scan has it from there).
      assert.deepEqual(r.notHere, c === A ? ['np/code/app-dev', 'git/tool-dev'] : [], where);
      assert.equal(mapText(c), map0, `${where}: the map`);
      assert.equal(manifestText(c), manifest0, `${where}: br/project.json`);
      for (const d of [brain(c), path.join(c.projects, 'br'), path.join(c.projects, 'np')]) assert.equal(w.sh(d, 'status', '--porcelain'), '', `${where}: nothing to commit in ${path.basename(d)}`);
    }
  }
  assert.deepEqual([head(path.join(B.projects, 'br', 'code', 'app-dev')), head(path.join(A.projects, 'br', 'code', 'app-dev'))], ['dev', 'dev']);
  const st = await M.mapStatus({ dir: A.ws, projects: A.projects });
  // A code repository of a project is "in the map, not on this computer" (notHere); another repository is missing.
  for (const l of WT) assert.equal(st.entries.find((e) => e.label === l).state, l.startsWith('git/') ? 'missing' : 'notHere', `${l}: listed as not on A`);
});

test('restore and sync on A leave each worktree alone and say so in one line; the map stays', async () => {
  A.use();
  const map0 = mapText(A);
  const gitFiles = WT.map((l) => fs.readFileSync(path.join(l.startsWith('git/') ? A.ws : A.projects, l, '.git'), 'utf8'));
  const { ui, text } = await quietUi();
  const r = await restoreWorkspace(urls.brain, { withProjects: true, ui, dir: A.ws, projects: A.projects });
  assert.equal(r.ok, true);
  for (const l of WT) {
    const e = r.plan.find((x) => x.label === l);
    assert.deepEqual([e.action, e.result], ['different', `left alone: ${WORKTREE_WHY}`], l);
    assert.ok(text().includes(`${l}: ${WORKTREE_LEFT}`), `${l}: said in one line`);
    assert.equal(`${e.result}\n${text()}`.split('\n').filter((x) => x.includes(l)).every((x) => x.split('left alone').length === 2), true, `${l}: "left alone" once a line`);
  }
  const s = await syncAll({ dir: A.ws, projects: A.projects });
  for (const l of WT) assert.deepEqual(s.repos.find((x) => x.label === l), { label: l, did: [WORKTREE_LEFT], todo: [] }, l);
  assert.deepEqual(WT.map((l) => fs.readFileSync(path.join(l.startsWith('git/') ? A.ws : A.projects, l, '.git'), 'utf8')), gitFiles, 'never cloned over');
  assert.deepEqual([head(path.join(A.projects, 'br', 'code', 'app-dev')), head(path.join(A.projects, 'np', 'code', 'app-dev'))], ['dev', 'try']);
  assert.equal((await M.updateMap({ dir: A.ws, projects: A.projects })).diff.same, true);
  assert.equal(mapText(A), map0);
});

test('a fresh computer clones every entry, the one on "dev" on its branch', async () => {
  const C = w.computer('c');
  C.use();
  const { ui } = await quietUi();
  const r = await restoreWorkspace(urls.brain, { withProjects: true, ui, dir: C.ws, projects: C.projects });
  assert.equal(r.ok, true);
  for (const l of WT) assert.equal(r.plan.find((x) => x.label === l).result, 'cloned', l);
  assert.deepEqual([head(path.join(C.projects, 'br', 'code', 'app-dev')), head(path.join(C.ws, 'git', 'tool-dev'))], ['dev', 'dev']);
});

// The rule from before the worktrees: a project here whose own project.json no longer names a code repository the map
// has, and whose folder is not here, loses it. A folder here that is a linked worktree is not "not here" for that rule:
// on the computer that has it as a full clone the scan adds it, so taking it out here would flip the map on every upkeep.
test('a project.json that does not name the folder, a worktree on D and a full clone on E: the upkeep never flips the map', async () => {
  const u = { brain: w.bare('brain-pj'), pt: w.bare('pt'), app: w.bare('app-pj') };
  {
    const seed = w.clone(u.pt, path.join(w.root, 'seed', 'pt'));
    fs.writeFileSync(path.join(seed, '.gitignore'), '/code/*\n');
    fs.writeFileSync(path.join(seed, 'project.json'), JSON.stringify({ name: 'pt', repos: [{ dir: 'code/app', url: u.app }], memories: {} }, null, 2) + '\n');
    push(seed, 'project.json names code/app only');
  }
  const D = w.computer('d');
  const E = w.computer('e');
  for (const c of [E, D]) {
    c.use();
    w.clone(u.brain, brain(c));
    const p = w.clone(u.pt, path.join(c.projects, 'pt'));
    const app = w.clone(u.app, path.join(p, 'code', 'app'));
    if (c === E) w.clone(u.app, path.join(p, 'code', 'x'));
    else w.sh(app, 'worktree', 'add', '-q', '-b', 'try', path.join(p, 'code', 'x'));
  }
  // The first map, on E (manifests off: project.json stays as it is and does not name code/x).
  E.use();
  const first = await M.updateMap({ dir: E.ws, projects: E.projects, manifests: false });
  assert.deepEqual(first.map.projects.find((p) => p.name === 'pt').repos.map((x) => x.dir), ['code/app', 'code/x']);
  push(brain(E), 'the first map');
  const map0 = mapText(E);
  const head0 = w.sh(brain(E), 'rev-parse', 'HEAD');
  const pj0 = fs.readFileSync(path.join(E.projects, 'pt', 'project.json'), 'utf8');
  for (let round = 1; round <= 3; round++) {
    for (const c of [D, E]) {
      c.use();
      pull(brain(c));
      const where = `round ${round}, computer ${path.basename(c.home)}`;
      const up = await upkeepMap({ dir: c.ws, projects: c.projects, commit: true, push: true });
      assert.deepEqual([up.changed, up.lines], [false, []], `${where}: the upkeep`);
      assert.equal(mapText(c), map0, `${where}: the map`);
      assert.equal(w.sh(brain(c), 'rev-parse', 'HEAD'), head0, `${where}: nothing committed`);
      for (const d of [brain(c), path.join(c.projects, 'pt')]) assert.equal(w.sh(d, 'status', '--porcelain'), '', `${where}: nothing to commit in ${path.basename(d)}`);
      assert.equal(fs.readFileSync(path.join(c.projects, 'pt', 'project.json'), 'utf8'), pj0, `${where}: project.json`);
    }
  }
  assert.equal(w.sh(path.join(w.server, 'team', 'brain-pj.git'), 'rev-parse', 'main'), head0, 'nothing reached the git server');
  D.use();
  const look = await M.updateMap({ dir: D.ws, projects: D.projects, dryRun: true, manifests: false });
  assert.deepEqual([look.takenOut, look.notHere, look.diff.same], [[], ['pt/code/x'], true], 'D: in the map, not on this computer');
  assert.equal((await M.mapStatus({ dir: D.ws, projects: D.projects })).entries.find((e) => e.label === 'pt/code/x').state, 'notHere');
  // The rule from before stays: with the folder absent on D, project.json takes the entry out there.
  w.sh(path.join(D.projects, 'pt', 'code', 'app'), 'worktree', 'remove', path.join(D.projects, 'pt', 'code', 'x'));
  const gone = await M.updateMap({ dir: D.ws, projects: D.projects, dryRun: true, manifests: false });
  assert.deepEqual([gone.takenOut, gone.diff.removed], [[{ project: 'pt', dir: 'code/x' }], ['pt/code/x']]);
});
