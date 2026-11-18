// The session rail's Changes card (src/chat/changes.mjs): what changed in a session's folder against the last
// commit, with its added and removed lines, and the new files git does not track yet. A temporary repository only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('changes');
test.after(() => box.cleanup());
const { folderChanges } = await import('../../src/chat/changes.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Alex', '-c', 'user.email=alex@box2', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });

test('the changes of a folder: +N −M of what git sees changed, and the new files it does not track', { skip: process.platform === 'win32' && 'POSIX paths' }, async () => {
  const dir = path.join(box.root, 'shop');
  fs.mkdirSync(dir);
  assert.deepEqual(await folderChanges(dir), { git: false }, 'not a repository: no card');
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'cart.js'), 'a\nb\nc\n');
  // No commit yet: what was added to the index is the change.
  git(dir, 'add', 'cart.js');
  const first = await folderChanges(dir);
  assert.deepEqual([first.git, first.files, first.added, first.removed], [true, 1, 3, 0]);
  git(dir, 'commit', '-q', '-m', 'one');
  assert.deepEqual(await folderChanges(dir), { git: true, files: 0, untracked: 0, added: 0, removed: 0, list: [] }, 'nothing changed');
  fs.writeFileSync(path.join(dir, 'cart.js'), 'a\nB\nc\nd\n'); // 2 added, 1 removed
  fs.writeFileSync(path.join(dir, 'new notes.md'), 'x\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
  fs.mkdirSync(path.join(dir, 'build'));
  fs.writeFileSync(path.join(dir, 'build', 'out.js'), 'ignored');
  const r = await folderChanges(dir);
  // A new file's lines count as added, as the timeline's "Wrote notes.md +1 −0" says them.
  assert.deepEqual([r.files, r.added, r.removed, r.untracked], [3, 4, 1, 2]);
  assert.deepEqual(r.list.map((x) => [x.path, x.added, x.removed, x.new]), [['cart.js', 2, 1, false], ['.gitignore', 1, 0, true], ['new notes.md', 1, 0, true]], 'an ignored file is no change');
});

test('a new file\'s lines: a text file\'s are counted, a binary file, a link and a very big file add none', { skip: process.platform === 'win32' && 'POSIX paths' }, async () => {
  const dir = path.join(box.root, 'fresh');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(dir, 'three.md'), 'a\nb\nc'); // no newline at the end: still 3 lines
  fs.writeFileSync(path.join(dir, 'pic.bin'), Buffer.from([0x89, 0x50, 0x00, 0x0a, 0x0a]));
  fs.symlinkSync('/etc/hostname', path.join(dir, 'outside')); // its target is never read
  fs.writeFileSync(path.join(dir, 'huge.log'), 'x\n'.repeat(3 * 1024 * 1024));
  const r = await folderChanges(dir);
  assert.deepEqual(Object.fromEntries(r.list.map((x) => [x.path, x.added])), { 'huge.log': 0, outside: 0, 'pic.bin': 0, 'three.md': 3 });
  assert.equal(r.added, 3);
});

test('a session in a subfolder of a repository: only that folder\'s changes, named from it', { skip: process.platform === 'win32' && 'POSIX paths' }, async () => {
  const repo = path.join(box.root, 'api');
  const sub = path.join(repo, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  git(repo, 'init', '-q');
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), 'a\n');
  fs.writeFileSync(path.join(sub, 'app.js'), 'x\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), 'a\nb\n'); // outside the session's folder
  fs.writeFileSync(path.join(repo, 'root-new.js'), 'r\n');
  fs.writeFileSync(path.join(sub, 'app.js'), 'y\n');
  fs.writeFileSync(path.join(sub, 'new.txt'), 'n\nn\n');
  const r = await folderChanges(sub);
  assert.deepEqual(r.list.map((x) => [x.path, x.added, x.removed, x.new]), [['app.js', 1, 1, false], ['new.txt', 2, 0, true]]);
  assert.deepEqual([r.files, r.untracked, r.added, r.removed], [2, 1, 3, 1], 'nothing of the files beside the folder');
});

test('a repository\'s own settings never start a program for the Changes card', { skip: process.platform === 'win32' && 'POSIX shell script' }, async () => {
  const dir = path.join(box.root, 'hostile');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  const marker = path.join(box.root, 'hostile-ran');
  const prog = path.join(box.root, 'hostile.sh');
  fs.writeFileSync(prog, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=we=ird diff=conv\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  for (const [k, x] of [['core.fsmonitor', prog], ['filter.we=ird.clean', prog], ['filter.we=ird.smudge', prog], ['filter.we=ird.process', prog],
    ['diff.conv.textconv', prog], ['diff.external', prog], ['core.hooksPath', box.root]]) git(dir, 'config', k, x);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
  const r = await folderChanges(dir);
  assert.ok(!fs.existsSync(marker), 'no program of the repository ran');
  assert.deepEqual(r.list.map((x) => [x.path, x.added, x.removed, x.new]), [['a.txt', 1, 0, false], ['b.txt', 1, 0, true]]);
});

test('the new files\' lines are counted up to a few megabytes in all: a folder of big unignored files is not read whole at every ask', async () => {
  const dir = path.join(box.root, 'built');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'empty');
  const mb = Buffer.alloc(1024 * 1024, 'x\n'); // 1 MiB of lines: the biggest new file that is counted
  for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(dir, `out${i}.txt`), mb);
  fs.writeFileSync(path.join(dir, 'out6.txt'), 'small\n'); // after the budget is spent: not read either
  const r = await folderChanges(dir);
  assert.equal(r.untracked, 6, 'every new file is still named');
  assert.equal(r.added, 4 * 524288, 'four of them fit in the 4 MiB the card reads; the rest add no lines');
  assert.deepEqual(r.list.map((x) => x.added), [524288, 524288, 524288, 524288, 0, 0]);
});
