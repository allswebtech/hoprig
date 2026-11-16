// A project that keeps a code repository as a git submodule: cloning the project leaves the submodule's folder
// empty. Restore on a fresh computer clones the code repository into that empty folder (it says "cloned" only when
// the files are there), and a folder with something in it is never cloned into.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-submodule');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
const { cloneRepo } = await import('../../src/pcsetup/projects.mjs');

test('cloneRepo: into an empty folder it clones; a folder with something in it is left as it is', async () => {
  const u = w.bare('solo');
  const empty = path.join(w.root, 'into', 'solo');
  fs.mkdirSync(empty, { recursive: true });
  const c = await cloneRepo({ url: u, name: 'solo' }, path.dirname(empty), {});
  assert.deepEqual([c.ok, c.skipped], [true, undefined]);
  assert.ok(fs.existsSync(path.join(empty, 'README.md')));
  const full = path.join(w.root, 'into', 'full');
  fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, 'mine.txt'), 'mine');
  const again = await cloneRepo({ url: u, name: 'full' }, path.dirname(full), {});
  assert.deepEqual([again.ok, again.skipped], [true, true]);
  assert.deepEqual(fs.readdirSync(full), ['mine.txt']);
});

test('restore on a fresh computer: a submodule code repository is cloned into its empty folder, and a scan keeps it', async () => {
  const u = { brain: w.bare('brain'), p3: w.bare('p3'), lib: w.bare('lib') };
  const A = w.computer('a');
  A.use();
  w.clone(u.brain, path.join(A.ws, 'ai_brain'));
  const p3 = w.clone(u.p3, path.join(A.projects, 'p3'));
  w.sh(p3, 'submodule', 'add', '-q', u.lib, 'code/lib');
  w.sh(p3, 'commit', '-q', '-m', 'lib as a submodule');
  w.sh(p3, 'push', '-q');
  const first = await M.updateMap({ dir: A.ws, projects: A.projects });
  assert.deepEqual(first.map.projects.find((p) => p.name === 'p3').repos.map((r) => r.dir), ['code/lib']);
  const b = path.join(A.ws, 'ai_brain');
  w.sh(b, 'add', '-A');
  w.sh(b, 'commit', '-q', '-m', 'map');
  w.sh(b, 'push', '-q');

  const C = w.computer('c');
  C.use();
  const { ui } = await quietUi();
  const r = await restoreWorkspace(u.brain, { ui, dir: C.ws, projects: C.projects });
  const lib = path.join(C.projects, 'p3', 'code', 'lib');
  assert.equal(r.plan.find((x) => x.label === 'p3/code/lib').result, 'cloned');
  assert.ok(fs.existsSync(path.join(lib, 'README.md')), 'the files are there');
  assert.equal(w.sh(lib, 'config', '--get', 'remote.origin.url'), u.lib);
  const scan = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.deepEqual(scan.notHere, [], 'nothing of the map is missing on this computer');
  assert.equal(scan.diff.same, true);
});
