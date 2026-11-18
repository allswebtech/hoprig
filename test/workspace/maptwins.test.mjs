// One folder the map cannot take (a name that differs from another's in its place only in letter case, which is one
// folder on macOS and Windows) never stops the map: the upkeep leaves that folder out, says it each round, and still
// records, commits and pushes everything else. Status names it. Temporary homes and local bare repositories only.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-maptwins');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const { main } = await import('../../src/workspace/cli.mjs');
const { saveConfig } = await import('../../src/config.mjs');

const A = w.computer('alex');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
saveConfig({ projectsDir: A.projects });
const o = { dir: A.ws, projects: A.projects };
const brain = w.clone(w.bare('brain'), path.join(A.ws, 'ai_brain'));
w.clone(w.bare('shop'), path.join(A.projects, 'shop'));
w.bare('shop-web');
await M.updateMap(o);
w.sh(brain, 'add', 'workspace.json');
w.sh(brain, 'commit', '-q', '-m', 'map');
w.sh(brain, 'push', '-q', 'origin', 'HEAD');

test('a folder that differs from another only in letter case is left out and said; the rest of the map is recorded and pushed', { skip: process.platform !== 'linux' && 'two such folders exist only where letter case counts' }, async () => {
  w.clone(w.url('shop-web'), path.join(A.projects, 'Shop'));
  w.clone(w.url('shop-web'), path.join(A.projects, 'shop', 'code', 'shop-web'));
  const r = await upkeepMap({ ...o, commit: true, push: true });
  assert.equal(r.skipped, undefined, JSON.stringify(r));
  assert.equal(r.changed, true);
  assert.deepEqual([r.commit && r.commit.done, r.pushed && r.pushed.done], [true, true], JSON.stringify(r));
  const m = M.readMap(A.ws).map;
  assert.ok(m.projects.find((p) => p.name === 'shop').repos.some((x) => x.dir === 'code/shop-web'), 'the code repository is recorded');
  assert.ok(!m.projects.some((p) => p.name === 'Shop'), 'the twin is not');
  assert.ok(r.needs.some((n) => /^Shop is not put into the map: shop and Shop differ only in letter case.*; rename or move one of the folders/.test(n)), r.needs.join('\n'));
  // The next round has nothing new to write, and says it again.
  const again = await upkeepMap({ ...o, commit: true, push: true });
  assert.equal(again.changed, false);
  assert.ok(again.needs.some((n) => /^Shop is not put into the map/.test(n)));
  const q = await quietUi();
  await main(['status'], { ui: q.ui, write: () => {} });
  assert.match(q.text(), /Shop is not put into the map: .*rename or move one of the folders/);
  assert.doesNotMatch(q.text(), /the map cannot be written now/);
});
