// group add never drops an entry of the map: an "other" repository in the new group's folder that fits as a project
// (or as the group's own repository) becomes one, every other one stays an "other" repository, and the output says
// which is which. A repository in a group's folder that is no member is mapped as another repository and is named
// by the "git would take it" warning of a group that is a repository.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-groupothers');
test.after(() => w.cleanup());
const C = w.computer('go');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const { main } = await import('../../src/workspace/cli.mjs');
const { saveConfig } = await import('../../src/config.mjs');

w.clone(w.bare('brain'), path.join(C.ws, 'ai_brain'));
saveConfig({ projectsDir: C.projects });
fs.mkdirSync(C.projects, { recursive: true });
w.clone(w.bare('foo'), path.join(C.ws, 'client-work', 'misc', 'foo'));
w.clone(w.bare('notes'), path.join(C.ws, 'client-work', 'notes'));
const kits = w.clone(w.bare('kits'), path.join(C.ws, 'kits'));
w.clone(w.bare('stray'), path.join(kits, 'stray'));
const run = async (args) => {
  const q = await quietUi();
  let out = '';
  const code = await main(args, { ui: q.ui, write: (s) => (out += s) });
  return { code, text: q.text(), out };
};

test('setup: an older map lists them all as other repositories, and one that is not on this computer', async () => {
  await run(['map']);
  const m = M.readMap(C.ws).map;
  m.others.push({ dir: 'client-work/gone', url: w.url('gone') }); // seen on another computer only
  M.writeMap(m, C.ws);
  assert.equal((await run(['map', '--upgrade', '--yes'])).code, 0);
  assert.deepEqual(M.readMap(C.ws).map.others.map((o) => o.dir).sort(), ['client-work/gone', 'client-work/misc/foo', 'client-work/notes', 'kits']);
});

test('a plain group: what fits as a project becomes one, the rest stays, nothing is lost, and each is said', async () => {
  const r = await run(['group', 'add', 'client-work']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /client-work\/notes: the project client-work\/notes/);
  assert.match(r.text, /client-work\/gone: the project client-work\/gone/);
  assert.match(r.text, /client-work\/misc\/foo: stays another repository/);
  const m = M.readMap(C.ws).map;
  assert.deepEqual(m.projects.map(M.refOf).sort(), ['client-work/gone', 'client-work/notes']);
  assert.equal(m.projects.find((p) => p.name === 'gone').url, w.url('gone'), 'not on this computer, still in the map');
  assert.deepEqual(m.others.map((o) => o.dir).sort(), ['client-work/misc/foo', 'kits']);
});

test('a group that is a repository: its folder becomes the group\'s repository; a tool folder in it stays and is warned about', async () => {
  const r = await run(['group', 'add', 'kits', '--repo', w.url('kits'), '--holds', 'builds', '--yes']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /kits: the group's own repository/);
  const again = await M.updateMap({ dir: C.ws, projects: C.projects, manifests: false });
  assert.ok(again.map.others.some((o) => o.dir === 'kits/stray'), 'a repository in the group that is no member is another repository');
  assert.ok(again.map.others.some((o) => o.dir === 'client-work/misc/foo'));
  const st = await M.mapStatus({ dir: C.ws, projects: C.projects });
  assert.deepEqual(st.groups.find((g) => g.dir === 'kits').unignored, ['stray'], 'git would take it into the group');
});

test('a repository where the group\'s folder is, added without --repo, is refused and nothing changes', async () => {
  const m = M.readMap(C.ws).map;
  m.others.push({ dir: 'tools', url: w.url('tools') });
  M.writeMap(m, C.ws);
  const before = fs.readFileSync(M.mapFile(C.ws), 'utf8');
  const r = await run(['group', 'add', 'tools']);
  assert.equal(r.code, 1);
  assert.match(r.text, /tools is a repository .*--repo/);
  assert.equal(fs.readFileSync(M.mapFile(C.ws), 'utf8'), before);
});
