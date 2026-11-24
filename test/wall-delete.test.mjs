// A delete that is not plainly inside the session's own folder (places.own) is held. A delete inside the
// session's own folder goes through; one in another project, above the folder, by an absolute path outside it, or
// in Hoprig's own config or state folder is held. Reuses asking.mjs's mayDelete and plainDelete.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { wallHeld } = await import('../src/wall.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-walldel-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, 'home');
const ws = path.join(home, 'Workspace');
const projects = path.join(ws, 'projects');
const shop = path.join(projects, 'shop'); // the session's own folder
const blog = path.join(projects, 'blog');
const cfg = path.join(tmp, 'cfg');
const state = path.join(tmp, 'state');
for (const d of [path.join(shop, 'build'), blog, cfg, state]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(shop, 'build', 'x'), 'x');
fs.writeFileSync(path.join(shop, 'notes.txt'), 'n');
fs.writeFileSync(path.join(cfg, 'config.json'), '{}');

const places = (cwd) => ({ cwd, home, workspace: ws, projects: [projects], hoprig: [cfg, state], own: shop, relative: true });
const kind = (cmd, cwd = shop) => {
  const h = wallHeld({ tool: 'Bash', input: { command: cmd }, places: places(cwd) });
  return h ? h.kind : null;
};

test('a delete inside the session\'s own folder, and an ordinary command, go through', () => {
  assert.equal(kind('rm -rf build'), null);
  assert.equal(kind('rm notes.txt'), null);
  assert.equal(kind('rm -r build/'), null);
  assert.equal(kind('ls -la'), null);
  assert.equal(kind('cat notes.txt'), null);
});

test('a delete outside the session\'s own folder is held', () => {
  assert.equal(kind('rm -rf build', blog), 'delete outside'); // the shell stands in another project
  assert.equal(kind(`rm -rf ${path.join(home, 'secret')}`), 'delete outside');
  assert.equal(kind('rm -rf /etc/hosts'), 'delete outside');
  assert.equal(kind('rm ../blog/x'), 'delete outside'); // a target that climbs out
  assert.equal(kind('cd .. && rm -rf blog'), 'delete outside'); // chained, lands outside own
});

test('a delete after a cd that stays inside the session\'s own folder is not "outside"; an unreadable cd keeps it held', () => {
  // The cd target is read and lands inside the session's own folder: the delete there is judged from the new folder.
  assert.equal(kind('cd build && rm -rf dist'), null);
  assert.equal(kind('cd build && rm -rf x'), null);
  assert.equal(kind('cd ./build && rm -r cache/'), null);
  assert.equal(kind('cd build/sub && rm -rf x'), null);
  // The cd lands outside the folder, or the delete climbs out from the new folder: held.
  assert.equal(kind('cd build && rm -rf ../../blog'), 'delete outside');
  // Forms whose cd target cannot be read with certainty stay held (documented in docs/HANDS-OFF.md):
  assert.equal(kind('cd $DIR && rm -rf x'), 'delete outside'); // a variable target
  assert.equal(kind('cd "build" && rm -rf x'), 'delete outside'); // a quoted target
  assert.equal(kind('cd b* && rm -rf x'), 'delete outside'); // a glob target
  assert.equal(kind('cd - && rm -rf x'), 'delete outside'); // the previous folder
  assert.equal(kind('cd && rm -rf x'), 'delete outside'); // a bare cd (home)
  assert.equal(kind('pushd build && rm -rf x'), 'delete outside'); // pushd, not a plain cd
  assert.equal(kind('cd -P build && rm -rf x'), 'delete outside'); // cd with an option
});

test('a delete of Hoprig\'s own config or state is held wherever the shell stands', () => {
  assert.equal(kind('rm config.json', cfg), 'delete outside');
  assert.equal(kind(`rm -rf ${cfg}`, shop), 'delete outside');
  assert.equal(kind(`rm -rf ${state}`, shop), 'delete outside');
});

test('without places the delete kind is not judged (no folder context)', () => {
  assert.equal(wallHeld({ tool: 'Bash', input: { command: 'rm -rf /etc' } }), null);
});
