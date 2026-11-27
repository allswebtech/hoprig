// Mends of the review of the look: no hook of an incoming commit runs by itself, and a session open in a repository is
// seen when the workspace is reached through a link. Local git server and made-up computers; nothing real.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assert, dropWorld, reset } from './dropfix.mjs';

const w = await dropWorld('instepmend', { labels: ['desk', 'peer'], group: true });
test.after(() => w.cleanup());
const [D, P] = w.computers;
const I = await import('../../src/workspace/instep.mjs');
const api = path.join(D.shop, 'code', 'shop-api');
const peerApi = path.join(P.shop, 'code', 'shop-api');
const head = (d) => w.sh(d, 'rev-parse', 'HEAD');
const tmp = () => path.join(w.root, `looks-${Math.random().toString(36).slice(2)}.json`);
async function fresh() {
  await reset(P);
  await reset(D);
  D.use();
}

test('a hook the incoming commit brings does not run during the look', async () => {
  await fresh();
  const marker = path.join(w.root, 'ran-by-itself.txt');
  // the repository uses a tracked hooks folder (a common "setup git hooks" script does this)
  w.sh(api, 'config', 'core.hooksPath', '.githooks');
  fs.mkdirSync(path.join(peerApi, '.githooks'), { recursive: true });
  fs.writeFileSync(path.join(peerApi, '.githooks', 'post-merge'), `#!/bin/sh\necho made-up > '${marker}'\n`, { mode: 0o755 });
  w.sh(peerApi, 'add', '.githooks/post-merge');
  w.sh(peerApi, 'commit', '-q', '-m', 'hook');
  w.sh(peerApi, 'push', '-q');
  const before = head(api);
  await I.lookProjects({ dir: D.ws, projects: D.projects, ff: { projects: true }, busy: () => false, file: tmp() });
  assert.notEqual(head(api), before, 'moved');
  assert.ok(!fs.existsSync(marker), 'a hook of the incoming commit ran by itself');
});

test('a session open in a repository is seen when the projects folder is reached through a link', async () => {
  await fresh();
  const link = path.join(w.root, 'linked-ws');
  try { fs.symlinkSync(D.ws, link); } catch { /* there */ }
  const lp = path.join(link, path.relative(D.ws, D.projects));
  const linkedApi = path.join(lp, 'shop', 'code', 'shop-api');
  // a session's cwd is its real folder (the start route takes insideRoots, real paths)
  const busy = I.sessionOpenIn([fs.realpathSync(api)]);
  w.commit(peerApi, `p${Date.now()}.txt`, 'x\n');
  w.sh(peerApi, 'push', '-q');
  const before = head(api);
  const r = await I.lookProjects({ dir: link, projects: lp, ff: { projects: true }, busy, file: tmp() });
  assert.equal(head(api), before, 'moved under an open session');
});


for (const [folder, moves] of [['plain-place', true], ['credentials', false]]) {
  test(`the look ${moves ? 'moves' : 'leaves alone'} a project that stands in ${folder}`, async () => {
    await fresh();
    // the whole projects folder stands in that place (a map can name any folder for its projects)
    const place = path.join(D.ws, folder, 'projects');
    fs.mkdirSync(path.dirname(place), { recursive: true });
    fs.renameSync(D.projects, place);
    const real = path.join(place, 'shop', 'code', 'shop-api');
    w.commit(peerApi, `s${Date.now()}.txt`, 'x\n');
    w.sh(peerApi, 'push', '-q');
    const before = head(real);
    await I.lookProjects({ dir: D.ws, projects: place, ff: { projects: true }, busy: () => false, file: tmp() });
    fs.renameSync(place, D.projects);
    assert.equal(head(path.join(D.projects, 'shop', 'code', 'shop-api')) !== before, moves, moves ? 'the control did not move' : 'a repository in the credentials folder was moved by the look');
  });
}
