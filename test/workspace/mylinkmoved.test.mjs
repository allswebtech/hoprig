// A link the owner named as his own (hoprig workspace mylink add) is followed only while it points where it did when
// he named it. A group's repository that tracks the link can point it elsewhere with a pull: from then on it is not the
// link he named, so it is not followed (nothing is synced or pushed through it) until he names it again. Temporary
// homes and local bare repositories only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-mylink-moved');
test.after(() => w.cleanup());
const OUT = path.join(w.root, 'OUT');
for (const n of ['brain', 'kits', 'acme', 'x', 'other']) w.bare(n);
// The owner's own disk holds a checkout of x; another repository of his, in a folder named x too, has a commit he has
// not pushed.
const disk = path.join(w.root, 'DISK', 'acmecode');
w.clone(w.url('x'), path.join(disk, 'x'));
const other = w.clone(w.url('other'), path.join(OUT, 'other', 'x'));
w.commit(other, 'LOCAL.md', 'mine, not to be pushed\n');
// The group's repository tracks builds/acme/code -> the owner's disk (its members are ignored).
const seed = w.clone(w.url('kits'), path.join(w.root, 'seed-kits'));
fs.writeFileSync(path.join(seed, '.gitignore'), '/builds/*/\n');
fs.mkdirSync(path.join(seed, 'builds', 'acme'), { recursive: true });
fs.symlinkSync(disk, path.join(seed, 'builds', 'acme', 'code'));
w.sh(seed, 'add', '-A');
w.sh(seed, 'add', '-f', 'builds/acme/code');
w.sh(seed, 'commit', '-qm', 'link');
w.sh(seed, 'push', '-q', 'origin', 'main');

const B = w.computer('b');
B.use();
process.env.HOPRIG_WORKSPACE_DIR = B.ws;
w.clone(w.url('brain'), path.join(B.ws, 'ai_brain'));
const M = await import('../../src/workspace/map.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const I = await import('../../src/workspace/inside.mjs');
saveConfig({ projectsDir: B.projects });
fs.mkdirSync(B.projects, { recursive: true });
const kits = w.clone(w.url('kits'), path.join(B.ws, 'kits'));
// The member acme is a repository of its own in the folder the group's clone already made (code is there).
const acme = path.join(kits, 'builds', 'acme');
w.sh(acme, 'init', '-q', '-b', 'main');
w.sh(acme, 'remote', 'add', 'origin', w.url('acme'));
w.sh(acme, 'fetch', '-q', 'origin');
w.sh(acme, 'reset', '-q', 'origin/main');
w.sh(acme, 'checkout', '-q', '--', '.');
w.sh(acme, 'branch', '-q', '--set-upstream-to=origin/main');
M.writeMap({ version: 2, brain: { url: w.url('brain') }, groups: [{ dir: 'kits', url: w.url('kits'), holds: [{ dir: 'builds' }] }], projects: [{ name: 'acme', in: 'kits/builds', url: w.url('acme'), repos: [{ dir: 'code/x', url: w.url('x') }] }], others: [] }, B.ws);
const ctx = { dir: B.ws, projects: B.projects };
const todoOf = (s) => s.repos.find((r) => r.label === 'kits/builds/acme/code/x').todo;
const commits = () => w.sh(path.join(w.server, 'team', 'other.git'), 'rev-list', '--all', '--count');

test('the owner\'s own link is followed while it points where it did; a pull that points it elsewhere stops that', async () => {
  assert.match(todoOf(await syncAll(ctx))[0].why, /not followed: .*code leaves its folder through a link/);
  const code = path.join(acme, 'code');
  const r = I.addMyLink(code);
  assert.deepEqual([r.added, r.to], [true, fs.realpathSync(disk)]);
  assert.deepEqual(I.myLinkEntries(), [{ path: code, to: fs.realpathSync(disk) }], 'the target is kept with the path');
  assert.deepEqual(todoOf(await syncAll(ctx)), [], 'followed while it points there');

  // The group's repository points the same tracked link at another folder, where another repository has a commit of its own.
  fs.unlinkSync(path.join(seed, 'builds', 'acme', 'code'));
  fs.symlinkSync(path.join(OUT, 'other'), path.join(seed, 'builds', 'acme', 'code'));
  w.sh(seed, 'add', '-f', 'builds/acme/code');
  w.sh(seed, 'commit', '-qm', 'point it elsewhere');
  w.sh(seed, 'push', '-q', 'origin', 'main');
  const before = commits();
  const s = await syncAll({ ...ctx, push: true });
  assert.deepEqual(s.repos.find((x) => x.label === 'kits').did, ['pulled 1']);
  assert.equal(fs.readlinkSync(code), path.join(OUT, 'other'), 'the pull pointed it elsewhere');
  const t = todoOf(s);
  assert.match(t[0].why, /your own link, but it points to .*OUT[\\/]other now/);
  assert.equal(t[0].command, I.myLinkCommand(code));
  assert.equal(commits(), before, 'nothing was pushed from the folder it points to now');
  assert.ok(I.leaves(kits, path.join(code, 'x')).now, 'leaves() says where it points now');
  const st = await M.mapStatus(ctx);
  assert.ok(!st.mylinks.includes(code), 'status no longer lists it as followed');
  assert.match(st.links.find((l) => l.path === code).what, /points to .*OUT[\\/]other now/);

  // Named again, the new place is kept and followed.
  const again = I.addMyLink(code);
  assert.deepEqual([again.added, again.moved, again.to], [true, fs.realpathSync(disk), path.join(OUT, 'other')]);
  assert.equal(I.leaves(kits, path.join(code, 'x')), null);
});

test('an entry without the place it pointed to (written by hand) is never followed', () => {
  const code = path.join(acme, 'code');
  saveConfig({ workspaceLinks: [code] });
  assert.deepEqual(I.myLinkEntries(), []);
  assert.ok(I.leaves(kits, path.join(code, 'x')));
});

test('mylink add says when a repository tracks the link', async () => {
  saveConfig({ workspaceLinks: [] });
  const { main } = await import('../../src/workspace/cli.mjs');
  let out = '';
  const code = await main(['mylink', 'add', path.join(acme, 'code'), '--json'], { write: (x) => (out += x) });
  assert.equal(code, 0, out);
  assert.equal(JSON.parse(out).trackedBy, fs.realpathSync(kits));
});
