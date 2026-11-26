// Every caller that ACTS on the map's entries takes its folders from one function (groups.mjs mapTargets), which
// never follows a link a repository tracks. A group's repository commits `builds -> <a folder outside the workspace>`
// and the map has acme in kits/builds: sync (also with --push and from another computer), status, restore and get
// leave the repository outside exactly as it was; a project whose parent tracks `code -> …` and names code/x in its
// project.json is the same.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, overSsh, quietUi, sshCommand } from './gitfix.mjs';

const w = gitWorld('ws-synclinks');
test.after(() => w.cleanup());
const C = w.computer('c');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const { syncWith } = await import('../../src/workspace/peer.mjs');
const { saveConfig } = await import('../../src/config.mjs');

const outside = path.join(w.root, 'OUTSIDE');
fs.mkdirSync(outside);
w.bare('brain');
w.clone(w.url('brain'), path.join(C.ws, 'ai_brain'));
saveConfig({ projectsDir: C.projects });
// The hostile group repository: builds is a link to the outside folder.
const seed = w.clone(w.bare('kits'), path.join(w.root, 'seed-kits'));
fs.symlinkSync(outside, path.join(seed, 'builds'));
w.sh(seed, 'add', '-A');
w.sh(seed, 'commit', '-q', '-m', 'builds');
w.sh(seed, 'push', '-q', 'origin', 'main');
const kits = w.clone(w.url('kits'), path.join(C.ws, 'kits'));
// Outside: acme, one commit behind the server, and site with a commit only it has (only ahead: --push would push it).
w.bare('acme');
const acme = w.clone(w.url('acme'), path.join(outside, 'acme'));
const later = w.clone(w.url('acme'), path.join(w.root, 'seed-acme'));
w.commit(later, 'NEWS.md', 'newer\n');
w.sh(later, 'push', '-q', 'origin', 'main');
w.bare('site');
const site = w.clone(w.url('site'), path.join(outside, 'site'));
w.commit(site, 'MINE.md', 'only here\n');
// A project in the projects folder whose parent tracks code -> outside, with code/acme in its project.json.
const pseed = w.clone(w.bare('shop'), path.join(w.root, 'seed-shop'));
fs.symlinkSync(outside, path.join(pseed, 'code'));
fs.writeFileSync(path.join(pseed, 'project.json'), JSON.stringify({ name: 'shop', repos: [{ dir: 'code/acme', url: w.url('acme') }], memories: {} }));
w.sh(pseed, 'add', '-A');
w.sh(pseed, 'commit', '-q', '-m', 'shop');
w.sh(pseed, 'push', '-q', 'origin', 'main');
w.clone(w.url('shop'), path.join(C.projects, 'shop'));
M.writeMap({
  version: 2, brain: { url: w.url('brain') },
  groups: [{ dir: 'kits', url: w.url('kits'), holds: [{ dir: 'builds' }] }],
  projects: [
    { name: 'acme', in: 'kits/builds', url: w.url('acme'), repos: [] },
    { name: 'site', in: 'kits/builds', url: w.url('site'), repos: [] },
    { name: 'shop', url: w.url('shop'), repos: [{ dir: 'code/acme', url: w.url('acme') }] },
  ],
  others: [],
}, C.ws);
const ctx = { dir: C.ws, projects: C.projects };
const heads = () => [w.sh(acme, 'rev-parse', 'HEAD'), w.sh(site, 'rev-parse', 'HEAD'), w.sh(acme, 'for-each-ref'), w.sh(site, 'for-each-ref')].join('\n');
const before = heads();
const byLabel = (r, l) => r.repos.find((x) => x.label === l);

test('mapTargets: every entry behind the link carries why it is not followed', async () => {
  const { mapTargets } = await import('../../src/workspace/groups.mjs');
  const t = await mapTargets(M.readMap(C.ws).map, ctx);
  const blocked = t.filter((x) => x.blocked).map((x) => x.label).sort();
  assert.deepEqual(blocked, ['kits/builds/acme', 'kits/builds/site', 'shop/code/acme']);
  assert.ok(!t.find((x) => x.label === 'kits').blocked);
});

test('workspace sync, with --push too, never fetches, pulls or pushes through the link', async () => {
  const r = await syncAll({ ...ctx, push: true });
  for (const l of ['kits/builds/acme', 'kits/builds/site', 'shop/code/acme']) {
    const e = byLabel(r, l);
    assert.ok(e, `${l} is reported`);
    assert.deepEqual(e.did, [], l);
    assert.match(e.todo[0].why, /not followed: .*(builds|code) leaves its folder through a link/, l);
  }
  assert.equal(heads(), before, 'the repositories outside are exactly as they were');
  assert.equal(w.sh(path.join(w.server, 'team', 'site.git'), 'rev-list', '--count', 'main'), '1', 'nothing was pushed from outside');
  const dry = await syncAll({ ...ctx, dryRun: true });
  assert.match(byLabel(dry, 'kits/builds/acme').todo[0].why, /not followed/);
});

test('workspace sync --with another computer: nothing is fetched into a folder behind the link', async () => {
  const fake = path.join(w.root, 'fake-ssh');
  fs.writeFileSync(fake, '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o|-p|-l) shift 2 ;; -*) shift ;; *) break ;; esac; done\nshift\nexec sh -c "$*"\n', { mode: 0o755 });
  Object.assign(process.env, { GIT_SSH_COMMAND: sshCommand(fake), GIT_SSH_VARIANT: 'ssh' });
  try {
    const peer = path.join(w.root, 'peer');
    w.clone(w.url('acme'), path.join(peer, 'kits', 'builds', 'acme'));
    w.commit(path.join(peer, 'kits', 'builds', 'acme'), 'PEER.md', 'from the other computer\n');
    const r = await syncWith('box2', { ...ctx, info: { name: 'box2', target: 'alex@box2', dir: overSsh(peer), projectsDir: overSsh(path.join(peer, 'projects')) } });
    assert.match(byLabel(r, 'kits/builds/acme').todo[0].why, /not followed/);
    assert.equal(heads(), before);
  } finally {
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH_VARIANT;
  }
});

test('status calls them not followed, restore leaves them and get clones nothing into the place', async () => {
  const st = await M.mapStatus(ctx);
  assert.equal(st.entries.find((e) => e.label === 'kits/builds/acme').state, 'notFollowed');
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const q = await quietUi();
  q.ui.yes = true;
  const r = await restoreWorkspace(w.url('brain'), { withProjects: true, ui: q.ui, dir: C.ws, projects: C.projects, dryRun: true });
  assert.equal(r.plan.find((e) => e.label === 'kits/builds/acme').action, 'link');
  assert.ok(!r.plan.some((e) => 'base' in e || 'root' in e), 'restore\'s own field never reaches the output');
  const { getProject } = await import('../../src/pcsetup/getproject.mjs');
  w.bare('extra');
  const g = await getProject(w.url('extra'), { ui: q.ui, dir: C.projects, into: 'kits/builds', map: M.readMap(C.ws).map });
  assert.equal(g.result, 'refused', q.text());
  assert.match(g.message, /builds leaves its folder through a link: nothing was cloned/);
  assert.ok(!fs.existsSync(path.join(outside, 'extra')));
  assert.equal(heads(), before);
});
