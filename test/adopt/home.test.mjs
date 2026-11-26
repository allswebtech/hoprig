// The look over the home folder (src/adopt/home.mjs) on a made-up home: projects at depths 1 to 5 (the fifth is past
// the budget's depth, and the answer says so), installed packages, a hidden folder, a private folder with a project
// in it (never entered, never named), the system's own place, the workspace (counted), a link to the home's parent and
// a link loop (named, never entered), a folder it cannot read (counted), and budgets that end the look early. It reads
// folder names only (no file is opened) and the whole home is the same afterwards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeTree } from '../workspace/helpers.mjs';
import { snapshot } from './fixture.mjs';
import { lookHome, placesOf } from '../../src/adopt/home.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-home-')));
test.after(() => {
  try {
    fs.chmodSync(path.join(root, 'home', 'locked'), 0o755);
  } catch {
    /* not made */
  }
  fs.rmSync(root, { recursive: true, force: true });
});
const home = path.join(root, 'home');
const ws = path.join(home, 'Workspace');
writeTree(home, {
  Makefile: 'all:\n', // the home itself is never a project
  'shop/package.json': '{}\n', // depth 1
  'shop/src/inner/package.json': '{}\n', // inside a project found: never gone into
  'code/blog/.git/HEAD': 'ref: refs/heads/main\n', // depth 2, a repository
  'code/node_modules/lib/package.json': '{}\n',
  'work/client/api/go.mod': 'module api\n', // depth 3
  'a/b/c/deep4/Cargo.toml': '[package]\n', // depth 4
  'a/b/c/d/deep5/pyproject.toml': '[project]\n', // depth 5: past the budget's depth
  '.hidden/proj/package.json': '{}\n',
  'no-ai/with-project/package.json': '{}\n',
  'snap/app/package.json': '{}\n',
  'Workspace/projects/alpha/package.json': '{}\n',
  'Workspace/projects/beta/README.md': '# beta\n',
  'locked/inside/package.json': '{}\n',
});
fs.symlinkSync('..', path.join(home, 'up'));
fs.symlinkSync('loop2', path.join(home, 'loop1'));
fs.symlinkSync('loop1', path.join(home, 'loop2'));
const canLock = process.platform !== 'win32' && process.getuid && process.getuid() !== 0;
const before = snapshot(home);
// Where a folder cannot be locked (Windows keeps no POSIX modes; root reads all), the locked folder's project is found.
const LOCKED = canLock ? [] : [['locked/inside', 2, false]];
const NOT_ENTERED = ['shop/src', 'code/node_modules', '.hidden', 'no-ai', 'snap', 'Workspace/projects/alpha', 'up', 'loop1', 'loop2', ...(canLock ? ['locked/inside'] : [])];

/** Runs `fn` while every folder listing and every file open is written down. */
async function watched(fn) {
  const listed = [];
  const opened = [];
  const saved = { readdir: fs.promises.readdir, readdirSync: fs.readdirSync, open: fs.promises.open, readFile: fs.promises.readFile, openSync: fs.openSync, readFileSync: fs.readFileSync };
  fs.promises.readdir = (p, ...a) => (listed.push(String(p)), saved.readdir.call(fs.promises, p, ...a));
  fs.readdirSync = (p, ...a) => (listed.push(String(p)), saved.readdirSync.call(fs, p, ...a));
  fs.promises.open = (p, ...a) => (opened.push(String(p)), saved.open.call(fs.promises, p, ...a));
  fs.promises.readFile = (p, ...a) => (opened.push(String(p)), saved.readFile.call(fs.promises, p, ...a));
  fs.openSync = (p, ...a) => (opened.push(String(p)), saved.openSync.call(fs, p, ...a));
  fs.readFileSync = (p, ...a) => (opened.push(String(p)), saved.readFileSync.call(fs, p, ...a));
  try {
    return { r: await fn(), listed, opened };
  } finally {
    Object.assign(fs.promises, { readdir: saved.readdir, open: saved.open, readFile: saved.readFile });
    Object.assign(fs, { readdirSync: saved.readdirSync, openSync: saved.openSync, readFileSync: saved.readFileSync });
  }
}

const rel = (p) => path.relative(home, p).split(path.sep).join('/'); // with '/' on every system

test('the projects of a home to four levels down, and what it never enters, names or opens', async () => {
  const mode = fs.statSync(path.join(home, 'locked')).mode & 0o777;
  if (canLock) fs.chmodSync(path.join(home, 'locked'), 0);
  let w;
  try {
    w = await watched(() => lookHome({ home, skip: [ws], projects: path.join(ws, 'projects'), platform: 'linux' }));
  } finally {
    if (canLock) fs.chmodSync(path.join(home, 'locked'), mode);
  }
  const { r, listed, opened } = w;
  assert.deepEqual(r.found.map((f) => [rel(f.dir), f.depth, f.repo]), [['shop', 1, false], ['code/blog', 2, true], ...LOCKED, ['work/client/api', 3, false], ['a/b/c/deep4', 4, false]]);
  assert.equal(r.ended, 'depth', 'the project five levels down is past the budget, and the answer says depth ended it');
  assert.equal(r.inWorkspace, 2, 'the workspace\'s projects are counted as already there');
  assert.equal(r.privates, 1, 'the private folder is counted');
  assert.deepEqual(r.links.map(rel).sort(), ['loop1', 'loop2', 'up'], 'every link is named');
  if (canLock) assert.equal(r.unreadable, 1, 'the folder it cannot read is counted');
  const text = JSON.stringify(r);
  for (const word of ['no-ai', 'with-project', 'deep5', ...(canLock ? ['inside'] : []), '.hidden', 'alpha']) assert.ok(!text.includes(word), `${word} is not named`);
  for (const n of NOT_ENTERED) assert.ok(!listed.some((p) => p === path.join(home, n) || p.startsWith(path.join(home, n) + path.sep)), `${n} was never listed`);
  assert.deepEqual(listed.filter((p) => p.startsWith(ws)), [path.join(ws, 'projects')], 'of the workspace only its projects folder is listed, to count them');
  assert.deepEqual(opened, [], 'no file was opened');
  assert.deepEqual(snapshot(home), before, 'the whole home is the same afterwards');
});

test('on a Mac its own places are not entered either', async () => {
  writeTree(home, { 'Library/app/package.json': '{}\n' });
  try {
    const mac = await lookHome({ home, skip: [ws], platform: 'darwin' });
    assert.ok(!mac.found.some((f) => rel(f.dir).startsWith('Library')));
    const linux = await lookHome({ home, skip: [ws], platform: 'linux' });
    assert.ok(linux.found.some((f) => rel(f.dir) === 'Library/app'), 'on Linux a Library folder is the owner\'s own');
  } finally {
    fs.rmSync(path.join(home, 'Library'), { recursive: true, force: true });
  }
});

test('a home larger than the budget: the look ends, says which budget ended it, and has found the nearest first', async () => {
  // The home, its five folders, then a/b and code/blog: eight folders read, the two nearest projects found.
  const many = await lookHome({ home, skip: [ws], platform: 'linux', budget: { folders: 8 } });
  assert.equal(many.ended, 'folders');
  assert.equal(many.folders + many.unreadable, 8);
  assert.deepEqual(many.found.map((f) => rel(f.dir)), ['shop', 'code/blog']);
  let now = 0;
  const slow = await lookHome({ home, skip: [ws], platform: 'linux', budget: { ms: 3000 }, clock: () => (now += 1000) });
  assert.equal(slow.ended, 'time');
  const few = await lookHome({ home, skip: [ws], platform: 'linux', budget: { projects: 2 } });
  assert.equal(few.ended, 'projects');
  assert.deepEqual(few.found.map((f) => rel(f.dir)), ['shop', 'code/blog']);
  const all = await lookHome({ home, skip: [ws], platform: 'linux', budget: { depth: 6 } });
  assert.equal(all.ended, null, 'the whole home was looked at');
  assert.ok(all.found.some((f) => rel(f.dir) === 'a/b/c/d/deep5'));
});

test('a home spelled through a link and a workspace by its real path (or the other way round): the workspace is not entered', async () => {
  // As on a computer whose home folder is a link, or a Mac's /var and /private/var.
  const linked = path.join(root, 'linkhome');
  fs.symlinkSync(home, linked);
  try {
    const wsAt = (h) => path.join(h, 'Workspace');
    for (const [h, w] of [[linked, wsAt(home)], [home, wsAt(linked)]]) {
      const r = await lookHome({ home: h, skip: [w, path.join(w, 'projects')], projects: path.join(w, 'projects'), platform: 'linux' });
      const found = r.found.map((f) => path.relative(h, f.dir));
      assert.ok(!found.some((f) => f.startsWith('Workspace')), `the workspace was entered (home ${path.basename(h)}): ${found.join(', ')}`);
      assert.ok(found.includes('shop'), 'the home\'s own projects are still found, under the home as it was given');
      assert.equal(r.inWorkspace, 2);
    }
  } finally {
    fs.unlinkSync(linked);
  }
});

test('the places the scan looks in: a repository in a usual folder\'s project is that project; each folder taken once', () => {
  const at = (p) => path.join(home, p);
  const found = [{ dir: at('shop'), repo: false }, { dir: at('code/blog/web'), repo: true }, { dir: at('code/blog/api'), repo: true }, { dir: at('code/notes'), repo: true }, { dir: at('work/client/api'), repo: false }];
  assert.deepEqual(placesOf(found, [at('code')]).map((x) => [rel(x.dir), x.only.map(rel)]), [
    ['', ['shop']],
    ['code', ['code/blog', 'code/notes']],
    ['work/client', ['work/client/api']],
  ]);
  assert.deepEqual(placesOf(found, []).map((x) => [rel(x.dir), x.only.map(rel)]), [
    ['', ['shop']],
    ['code', ['code/notes']],
    ['code/blog', ['code/blog/api', 'code/blog/web']],
    ['work/client', ['work/client/api']],
  ]);
});
