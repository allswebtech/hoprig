// Nothing about one folder stops every write of the map. A project "notes" in the projects folder and a group
// "notes" are two folders and both are fine. The upkeep never throws: a map that cannot be written is skipped with
// its reason, and status says it. A duplicate address that came through a merge on the git server is used, and
// status names both entries with the forget to run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-noblock');
test.after(() => w.cleanup());
const C = w.computer('nb');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const { main } = await import('../../src/workspace/cli.mjs');
const ctx = { dir: C.ws, projects: C.projects };

w.clone(w.bare('brain'), path.join(C.ws, 'ai_brain'));
M.writeMap({ version: 2, brain: { url: w.url('brain') }, groups: [{ dir: 'notes' }], projects: [], others: [] }, C.ws);
w.clone(w.bare('notes'), path.join(C.projects, 'notes'));
w.clone(w.bare('acme'), path.join(C.ws, 'notes', 'acme'));

test('a project named like a group: both are mapped, and the upkeep writes the map', async () => {
  const u = await upkeepMap(ctx);
  assert.equal(u.skipped, undefined, JSON.stringify(u));
  assert.equal(u.changed, true);
  assert.deepEqual(M.readMap(C.ws).map.projects.map(M.refOf).sort(), ['notes', 'notes/acme']);
});

test('the upkeep never throws: a map that cannot be written is skipped with its reason, and status says it', async () => {
  // A clone of a group's repository in the projects folder is not added (one repository, one place).
  M.writeMap({ ...M.readMap(C.ws).map, groups: [...M.readMap(C.ws).map.groups, { dir: 'kits', url: w.url('kitsrepo') }] }, C.ws);
  w.clone(w.bare('kitsrepo'), path.join(C.projects, 'kits-copy'));
  const r = await M.updateMap({ ...ctx, manifests: false });
  assert.ok(!r.map.projects.some((p) => p.name === 'kits-copy'));
  assert.ok(r.notes.some((n) => /kits-copy has the address of kits/.test(n)));
  fs.rmSync(path.join(C.projects, 'kits-copy'), { recursive: true, force: true });
  // The brain's folder cannot be written: the upkeep says so and goes on, status says it too.
  w.clone(w.bare('fresh'), path.join(C.projects, 'fresh'));
  const brain = path.join(C.ws, 'ai_brain');
  fs.chmodSync(brain, 0o555);
  try {
    const u = await upkeepMap(ctx);
    assert.equal(u.changed, false);
    assert.match(u.skipped || '', /EACCES|permission/i);
    const st = await M.mapStatus(ctx);
    assert.ok(st.blocked && st.blocked.some((e) => /cannot be written/.test(e)), JSON.stringify(st.blocked));
    const q = await quietUi();
    await main(['status'], { ui: q.ui, write: () => {} });
    assert.match(q.text(), /the map cannot be written now/);
  } finally {
    fs.chmodSync(brain, 0o755);
  }
});

test('a duplicate address that came through a merge is used: the map is still written, status names both with the forget', async () => {
  const m = JSON.parse(fs.readFileSync(M.mapFile(C.ws), 'utf8'));
  m.projects.push({ name: 'acme-copy', url: w.url('acme'), repos: [] }); // as a merge on the git server could bring it
  fs.writeFileSync(M.mapFile(C.ws), JSON.stringify(m));
  const u = await upkeepMap(ctx);
  assert.equal(u.skipped, undefined, JSON.stringify(u));
  assert.ok(M.readMap(C.ws).map.projects.some((p) => p.name === 'fresh'), 'the map keeps being written');
  const st = await M.mapStatus(ctx);
  assert.deepEqual(st.duplicates.map((d) => d.entries.sort()), [['acme-copy', 'notes/acme']]);
  assert.match(st.duplicates[0].fix, /^hoprig workspace forget /);
  // A command still refuses to bring in a new one.
  const again = M.readMap(C.ws).map;
  again.projects.push({ name: 'third', in: 'notes', url: w.url('fresh'), repos: [] });
  assert.throws(() => M.writeMap(again, C.ws), /same address/);
});
