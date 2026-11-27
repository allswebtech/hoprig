// The one removal that stays held even in "Allow everything": a delete Hoprig reads FOR CERTAIN as removing the whole
// home folder, the workspace, a folder of projects or the root of the disk (wall.mjs wipesWhole). Anything it cannot
// read for certain is not a hit: in that mode nothing else is held.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { wipesWhole } = await import('../src/wall.mjs');

const POSIX = { skip: process.platform === 'win32' && 'the floor reads POSIX folders only' };
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-wipe-')));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const home = path.join(tmp, 'home', 'ann');
const ws = path.join(home, 'Workspace');
const projects = path.join(ws, 'projects');
const shop = path.join(projects, 'shop');
for (const d of [path.join(shop, 'dist'), path.join(home, '.cache', 'x'), path.join(shop, 'node_modules')]) fs.mkdirSync(d, { recursive: true });

const places = (cwd = shop) => ({ cwd, home, workspace: ws, projects: [projects], hoprig: [], own: shop, relative: true });
const hit = (command, cwd) => wipesWhole({ command, places: places(cwd) });

test('what is read for certain as wiping a whole home, workspace, projects folder or disk is a hit', POSIX, () => {
  assert.equal(hit('rm -rf ~'), 'home');
  assert.equal(hit('rm -rf $HOME'), 'home');
  assert.equal(hit('rm -rf "${HOME}"'), 'home');
  assert.equal(hit('rm -rf /'), 'disk');
  assert.equal(hit('rm -rf /*'), 'disk');
  assert.equal(hit('sudo rm -rf /'), 'disk');
  assert.equal(hit('sudo -u root rm -rf --no-preserve-root /'), 'disk');
  assert.equal(hit('rm -rf ~/Workspace'), 'workspace');
  assert.equal(hit('rm -rf ~/Workspace/projects'), 'projects');
  assert.equal(hit('rm -rf ~/Workspace/projects/*'), 'projects');
  assert.equal(hit('rm -rf ~/*'), 'home');
  assert.equal(hit(`rm -rf ${path.dirname(home)}`), 'home');
  assert.equal(hit(`rm -rf ${home}`), 'home');
  assert.equal(hit('cd ~/Workspace && rm -rf projects'), 'projects');
  assert.equal(hit('cd ~/Workspace; rm -rf projects/'), 'projects');
  assert.equal(hit('rm -rf ..', shop), 'projects');
  assert.equal(hit('rm -rf ../', shop), 'projects');
  assert.equal(hit('rm -rf *', projects), 'projects');
  assert.equal(hit('rm -r -f -- ~'), 'home');
  assert.equal(hit('ls && rm -rf ~'), 'home');
  assert.equal(hit('rm -rf node_modules ~'), 'home');
});

test('everything else, even a risky delete, is not a hit: nothing else is held in that mode', POSIX, () => {
  for (const c of [
    'rm -rf node_modules', 'rm -rf dist', 'rm -rf ~/Workspace/projects/shop/dist', 'rm -rf ~/.cache/x', 'rm -rf ~/.cache/*',
    'rm -rf "$DIR"', 'rm -rf $(pwd)', 'rm -rf ${HOME%/}', 'cd $X && rm -rf *', 'cd "$(dirname x)" && rm -rf ..',
    'find ~ -delete', 'ls ~', 'echo rm -rf ~', 'git rm -r ~/x', 'rm ~/Workspace/notes.txt', 'rm -rf ~/Work*', 'rm -rf ~/Workspace/projects/shop/*',
    'ls | xargs rm -rf', 'rm -rf',
    "cd ~/proj/tmp && python3 - <<'EOF'\nimport shutil\nshutil.rmtree('/')\nEOF",
  ]) assert.equal(hit(c), null, c);
  assert.equal(hit('rm -rf *', shop), null);
  assert.equal(hit('rm -rf ..', null), null);
  assert.equal(hit('rm -rf `echo ~`'), null);
});

test('a command that cannot be read at all, or no command, is no hit', () => {
  assert.equal(wipesWhole({ command: 'x'.repeat(200_000), places: places() }), null);
  assert.equal(wipesWhole({ command: null, places: places() }), null);
  assert.equal(wipesWhole({}), null);
});

test('the real place counts: a link to the home folder is the home folder', POSIX, () => {
  const link = path.join(tmp, 'linkhome');
  fs.symlinkSync(home, link);
  assert.equal(hit(`rm -rf ${link}`), 'home');
});
