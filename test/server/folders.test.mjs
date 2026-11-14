import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import { browse, claudeFolders, insideRoots, isOwnFolder, recentFolders, resolveRoots } from '../../src/server/folders.mjs';
import { mounts, resolveStatic, WEB_DIR } from '../../src/server/static.mjs';

const box = sandbox();
test.after(() => box.cleanup());

const root = path.join(box.root, 'root');
const outside = path.join(box.root, 'outside');
fs.mkdirSync(path.join(root, 'proj', 'src'), { recursive: true });
fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(root, 'file.txt'), 'x');
fs.symlinkSync(outside, path.join(root, 'escape'));
fs.symlinkSync(path.join(root, 'proj'), path.join(root, 'proj-link'));
const roots = resolveRoots([root, '/does/not/exist', 'relative']);

test('roots: only existing absolute folders', () => {
  assert.deepEqual(roots, [fs.realpathSync(root)]);
});

test('path traversal is refused', () => {
  const r = fs.realpathSync(root);
  assert.equal(insideRoots(root, roots), r);
  assert.equal(insideRoots(path.join(root, 'proj', '..', '..', 'outside'), roots), null, '..');
  assert.equal(insideRoots(path.join(root, 'escape'), roots), null, 'symlink out of the root');
  assert.equal(insideRoots(path.join(root, 'proj-link'), roots), path.join(r, 'proj'), 'symlink inside is fine');
  assert.equal(insideRoots(path.join(root, 'file.txt'), roots), null, 'files are not folders');
  assert.equal(insideRoots(root + 'x', roots), null, 'prefix of the root name is not inside');
  assert.equal(insideRoots('relative', roots), null);
  assert.equal(insideRoots(path.join(root, 'a\0b'), roots), null);
  assert.equal(insideRoots(path.dirname(root), roots), null, 'parent of the root');
});

test('browse lists folders only, hidden on request, no escaping symlinks', () => {
  const b = browse(root, roots);
  assert.deepEqual(b.dirs.map((d) => d.name), ['proj', 'proj-link']);
  assert.equal(b.parent, null, 'no way up from a root');
  assert.deepEqual(browse(root, roots, { hidden: true }).dirs.map((d) => d.name), ['.hidden', 'proj', 'proj-link']);
  assert.equal(browse(path.join(root, 'proj'), roots).parent, fs.realpathSync(root));
  assert.equal(browse(outside, roots), null);
});

test('recent folders come from live sessions and Claude transcripts', () => {
  const proj = path.join(box.claude, 'projects', 'x');
  fs.mkdirSync(proj, { recursive: true });
  const cwd = path.join(root, 'proj', 'src');
  fs.writeFileSync(path.join(proj, '0b6c3c9e-1f7e-4e4b-9b1a-3f6a1e2d4c5b.jsonl'), JSON.stringify({ type: 'user', cwd }) + '\n');
  assert.equal(claudeFolders()[0].path, cwd);
  const rec = recentFolders([path.join(root, 'proj'), outside], roots);
  assert.deepEqual(rec.map((f) => [path.basename(f.path), f.live]), [['proj', true], ['src', false]]);
});

test('the product\'s own folders (Tia\'s working folders) are never offered as recent folders', () => {
  const work = path.join(process.env.HOPRIG_STATE_DIR, 'assistant', 'conversations', 'c1', 'work');
  fs.mkdirSync(work, { recursive: true });
  // Even when the state folder lies inside a root (the default root is the home folder) and Claude ran there.
  const both = resolveRoots([root, process.env.HOPRIG_STATE_DIR]);
  const rec = recentFolders([work, path.join(root, 'proj')], both);
  assert.ok(!rec.some((f) => f.path.startsWith(fs.realpathSync(process.env.HOPRIG_STATE_DIR))), JSON.stringify(rec));
  assert.ok(rec.some((f) => path.basename(f.path) === 'proj'));
  assert.equal(isOwnFolder(work), true);
  assert.equal(isOwnFolder(path.join(process.env.HOPRIG_CONFIG_DIR, 'x')), true, 'the settings folder too, made or not');
  assert.equal(isOwnFolder(path.join(root, 'proj')), false);
  assert.equal(isOwnFolder(`${process.env.HOPRIG_STATE_DIR}-other`), false, 'a name that only starts the same');
  assert.equal(isOwnFolder('relative/x'), false);
});

test('static files cannot escape web/ or the package folders', () => {
  assert.equal(resolveStatic('/index.html'), path.join(fs.realpathSync(WEB_DIR), 'index.html'));
  assert.equal(resolveStatic('/'), path.join(fs.realpathSync(WEB_DIR), 'index.html'));
  for (const bad of [
    '/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/vendor/xterm/../../../package.json',
    '/vendor/xterm/%2e%2e/%2e%2e/ws/package.json', '/%00index.html', '/a\\..\\b.js', '/%E0%A4%A.js', 'index.html',
    '/vendor/xterm/package.json', '/nope.js', '/vendor/xterm/README.md', '/vendor/xterm/lib/xterm.js.map',
  ]) {
    assert.equal(resolveStatic(bad), null, bad);
  }
  const table = mounts();
  assert.ok(table.some(([p]) => p === '/vendor/xterm/lib/'), 'xterm mounted');
  assert.ok(resolveStatic('/vendor/xterm/lib/xterm.mjs'));
  assert.ok(resolveStatic('/vendor/addon-fit/lib/addon-fit.mjs'));
  assert.ok(resolveStatic('/vendor/addon-unicode11/lib/addon-unicode11.mjs'));
  assert.ok(resolveStatic('/vendor/xterm/css/xterm.css'));
});
