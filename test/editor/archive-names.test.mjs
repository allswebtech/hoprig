// Files' archives with names in any script on Windows (src/editor/archive.mjs pack, unpack): the tar of Windows reads
// its command line in the system's code page and crashes on such a name, so it never gets one: Files' own writer packs
// it (test/editor/archive-own.test.mjs), and an archive of such a name is unpacked through a link of plain name. The
// whole pack and unpack is played here with this computer's tar and Windows' answer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { which } from '../../src/setup/system.mjs';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-names-')));
test.after(() => fs.rmSync(box, { recursive: true, force: true }));
const { badEntries, crashWords, pack, packWords, unpack } = await import('../../src/editor/archive.mjs');
const NAME = `${'क'.repeat(12)}.txt`;
const plainArgs = (args) => args.every((a) => /^[\x20-\x7e]*$/.test(a));

test('tar is given plain names only: names after "--", git\'s folders left out; on Windows a name outside plain ASCII never reaches it', () => {
  const dir = 'C:\\Users\\me\\docs';
  const tmp = `${dir}\\.hoprig-pack.0123456789abcdef.tar.gz.tmp`;
  assert.deepEqual(packWords(dir, ['a.txt', '-x'], tmp), { args: ['-czf', tmp, '--exclude=.git', '-C', dir, '--', 'a.txt', '-x'] });
  // Such a name goes to Files' own writer on Windows (test/editor/archive-own.test.mjs), so tar's line stays plain.
  assert.ok(plainArgs(packWords(dir, ['a.txt'], tmp).args));
});

test('Windows\' plan, played with this computer\'s tar: the file goes in and comes back with its own name; nothing is left beside it', { skip: (process.platform === 'win32' && 'test/desktop/files.test.mjs packs with the system tar there') || (!which('tar') && 'no tar here') }, async () => {
  const dir = path.join(box, 'docs');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, NAME), 'mine\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A\n');
  const roots = [box];
  const { path: archive } = await pack([path.join(dir, NAME), path.join(dir, 'a.txt')], roots, { name: 'both', platform: 'win32' });
  assert.equal(archive, path.join(dir, 'both.tar.gz'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.txt', 'both.tar.gz', NAME].sort(), 'no folder of plain name is left');
  // An archive of such a name too: read through a link of plain name, into a folder that then takes its own name.
  const { path: one } = await pack([path.join(dir, NAME)], roots, { platform: 'win32' });
  assert.equal(path.basename(one), `${NAME}.tar.gz`);
  const r = await unpack(one, roots, { platform: 'win32' });
  assert.equal(r.path, path.join(dir, `${'क'.repeat(12)} (2).txt`), 'the file itself is still there: the next free name');
  assert.equal(fs.readFileSync(path.join(r.path, NAME), 'utf8'), 'mine\n', 'the file came back with its own name');
  const both = await unpack(archive, roots, { platform: 'win32' });
  assert.deepEqual(fs.readdirSync(both.path).sort(), ['a.txt', NAME].sort());
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.hoprig-')), [], 'no link or folder of plain name is left');
});

test('Windows: a tar that crashed while packing (an NTSTATUS code, no words) is said in words, with the file it stopped on', () => {
  const line = (code) => `Command failed: C:\\Windows\\System32\\tar.exe -czf C:\\d\\.hoprig-pack.1.tar.gz.tmp --exclude=.git -C C:\\d\\.hoprig-pack.2.d . (exit code ${code})`;
  const words = crashWords(line(3221225477), [NAME], 'win32');
  assert.match(words, new RegExp(`^it is not packed: Windows' own tar stopped on a file name it cannot handle \\("${NAME}"\\): one that is very long, or has letters outside the system's code page\\. Nothing was packed`));
  assert.doesNotMatch(words, /Command failed/);
  assert.match(crashWords(line(0xC00000FD), [NAME, 'b.txt'], 'win32'), /cannot handle: one that is very long/, 'several staged: none named');
  assert.equal(crashWords(line(1), [NAME], 'win32'), null, 'an ordinary failure keeps tar\'s own words');
  assert.equal(crashWords(line(3221225477), [NAME], 'linux'), null, 'elsewhere as before');
  assert.equal(crashWords('tar: x: Cannot stat', [NAME], 'win32'), null);
});

test('Windows\' plan: the move of the unpacked folder into place is tried again while Windows holds it, and a folder that cannot be moved is removed with retries', { skip: (process.platform === 'win32' && 'the refusals are made up here') || (!which('tar') && 'no tar here') }, async () => {
  const dir = path.join(box, 'busy');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, NAME), 'mine\n');
  const { path: archive } = await pack([path.join(dir, NAME)], [box], { name: 'नाम', platform: 'win32' });
  const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  const { renameSync, rmSync } = fs;
  try {
    // Held twice, then free: the unpack lands.
    let n = 0;
    fs.renameSync = function (from, to) {
      if (String(from).endsWith('.d') && n++ < 2) throw busy();
      return renameSync.call(this, from, to);
    };
    const r = await unpack(archive, [box], { platform: 'win32' });
    assert.equal(fs.readFileSync(path.join(r.path, NAME), 'utf8'), 'mine\n');
    // Held for good, and its removal refused once: a worded 409, and nothing of the unpacking left beside it.
    fs.renameSync = function (from, to) {
      if (String(from).endsWith('.d')) throw busy();
      return renameSync.call(this, from, to);
    };
    let m = 0;
    fs.rmSync = function (p, o) {
      if (String(p).endsWith('.d') && m++ < 1) throw busy();
      return rmSync.call(this, p, o);
    };
    await assert.rejects(unpack(archive, [box], { platform: 'win32' }), (e) => e.status === 409 && /^it could not be put in place: EBUSY/.test(e.message));
  } finally {
    Object.assign(fs, { renameSync, rmSync });
  }
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.startsWith('.hoprig-')), [], 'no folder of plain name is left');
});

test('Windows: a name it reads as git\'s folder or a private one is refused (a dot or blank at the end, a stream behind a colon, the short name)', () => {
  for (const n of ['proj/.git./config', 'proj/.git /config', 'proj/.GIT. ./hooks/pre-commit', 'proj/.git::$INDEX_ALLOCATION/config', 'proj/.git:x', 'proj/GIT~1/config', 'proj/git~2']) {
    assert.match(badEntries(['proj/', n], 'win32') || '', /Windows reads as git's own folder/, n);
    assert.equal(badEntries(['proj/', n], 'linux'), null, `${n}: another name everywhere else, as before`);
  }
  for (const n of ['proj/no-ai./a.md', 'proj/NO-AI /a.md', 'proj/no-ai::$DATA']) {
    assert.match(badEntries(['proj/', n], 'win32') || '', /Windows reads as a private folder/, n);
    assert.equal(badEntries(['proj/', n], 'linux'), null, n);
  }
  // Names that only look alike stay: a dot inside, a longer name, a file with a colon that is no stream of those.
  assert.equal(badEntries(['proj/.gitignore', 'proj/.git.d/x', 'proj/a.git/config', 'proj/git~x', 'proj/notes. ', 'proj/./a', 'proj/a:b'], 'win32'), null);
  assert.match(badEntries(['proj/.git/config'], 'win32'), /is in git's own folder/, 'the plain name keeps its own words');
});
