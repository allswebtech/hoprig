// Safe unpacking (src/pcsetup/unpack.mjs) with the computer's own tar and unzip, on tiny archives made here: a good
// archive lands in its one top folder; an absolute name, a `..`, a link or a hard link that leaves, or a second top
// folder is refused BEFORE anything is unpacked (the folder stays empty).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tarOf, tarXzOf, zipOf } from './archives.mjs';
import { FetchError } from '../../src/pcsetup/fetchkit.mjs';
import { checkTar, missingTools, runTool, tarCommand, unpackChecked, walkInside } from '../../src/pcsetup/unpack.mjs';

// Windows: the product starts the system's own tar by its full path (unpack.mjs tarCommand), which the seal refuses
// unless it is named here; elsewhere tar is started by its name and nothing is added.
if (process.platform === 'win32') process.env.HOPRIG_SEAL_REAL = [process.env.HOPRIG_SEAL_REAL, 'tar'].filter(Boolean).join(','); // seal: the system's own tar unpacks the test's tiny archives, as it does for the kit

const GOOD = [
  { name: 'flutter/', type: 'dir' },
  { name: 'flutter/bin/', type: 'dir' },
  { name: 'flutter/bin/flutter', type: 'file', data: '#!/bin/sh\necho hi\n', mode: 0o755 },
  { name: 'flutter/version', type: 'file', data: '3.50.1\n' },
  { name: 'flutter/bin/dart', type: 'link', link: 'flutter' },
  { name: 'flutter/lib/', type: 'dir' },
  { name: 'flutter/lib/up', type: 'link', link: '../bin/flutter' },
];

const place = (tc) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'unpack-'));
  tc.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.mkdirSync(path.join(d, 'into'));
  return d;
};

test('a good .tar.xz and a good .zip unpack into their one top folder, links kept inside', async (tc) => {
  for (const [kind, bytes] of [['tar.xz', tarXzOf(GOOD)], ['zip', zipOf(GOOD)]]) {
    const d = place(tc);
    const file = path.join(d, `a.${kind}`);
    fs.writeFileSync(file, bytes);
    const top = await unpackChecked(file, kind, path.join(d, 'into'), 'flutter');
    assert.equal(top, path.join(d, 'into', 'flutter'));
    assert.equal(fs.readFileSync(path.join(top, 'version'), 'utf8'), '3.50.1\n');
    // Windows' tar and unzip write a link as a plain file where the account may not make links (a real Windows run:
    // readlink of it said EINVAL); every other system keeps it a link, and so does Windows where it makes one.
    const dart = path.join(top, 'bin', 'dart');
    if (process.platform !== 'win32' || fs.lstatSync(dart).isSymbolicLink()) assert.equal(fs.readlinkSync(dart), 'flutter', kind);
    else assert.ok(fs.lstatSync(dart).isFile(), `${kind}: the link is there as a file, inside its folder`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(top, 'bin', 'flutter')).mode & 0o111, 0o111, `${kind}: the program stays a program`);
  }
});

const BAD = {
  'an absolute path': [{ name: '/flutter/x', type: 'file', data: 'x' }],
  'a ..': [{ name: 'flutter/../../x', type: 'file', data: 'x' }],
  'a name outside the top folder': [{ name: 'flutter/a', type: 'file' }, { name: 'other/b', type: 'file' }],
  'a link that points outside': [{ name: 'flutter/', type: 'dir' }, { name: 'flutter/out', type: 'link', link: '../../outside' }],
  'a link with an absolute target': [{ name: 'flutter/', type: 'dir' }, { name: 'flutter/out', type: 'link', link: '/etc/passwd' }],
  'a link to the top folder\'s neighbour': [{ name: 'flutter/', type: 'dir' }, { name: 'flutter/out', type: 'link', link: '../flutter2' }],
};
const BAD_TAR_ONLY = {
  'a hard link to outside': [{ name: 'flutter/', type: 'dir' }, { name: 'flutter/h', type: 'hard', link: '/etc/passwd' }],
  'a hard link with ..': [{ name: 'flutter/', type: 'dir' }, { name: 'flutter/h', type: 'hard', link: '../x' }],
};

for (const [what, entries] of Object.entries({ ...BAD, ...BAD_TAR_ONLY })) {
  for (const kind of BAD_TAR_ONLY[what] ? ['tar.xz'] : ['tar.xz', 'zip']) {
    test(`refused before unpacking (${kind}): ${what}`, async (tc) => {
      const d = place(tc);
      const file = path.join(d, `a.${kind}`);
      fs.writeFileSync(file, kind === 'zip' ? zipOf(entries) : tarOf(entries));
      await assert.rejects(unpackChecked(file, kind, path.join(d, 'into'), 'flutter'), (e) => e instanceof FetchError && e.code === 'unpack');
      assert.deepEqual(fs.readdirSync(path.join(d, 'into')), [], 'nothing was unpacked');
      assert.deepEqual(fs.readdirSync(d).sort(), [`a.${kind}`, 'into'], 'nothing was written beside it');
    });
  }
}

test('the walk after unpacking refuses a link that leaves, and anything that is not a file, folder or link', (tc) => {
  const d = place(tc);
  const into = path.join(d, 'into');
  fs.mkdirSync(path.join(into, 'flutter'));
  fs.symlinkSync('../../..', path.join(into, 'flutter', 'up'));
  assert.throws(() => walkInside(into), (e) => e.code === 'unpack');
  fs.unlinkSync(path.join(into, 'flutter', 'up'));
  fs.symlinkSync('.', path.join(into, 'flutter', 'here'));
  walkInside(into);
});

test('an archive that unpacks past its ceiling, or past the free space of the disk, is refused before anything is unpacked', async (tc) => {
  const big = [{ name: 'flutter/', type: 'dir' }, { name: 'flutter/a', type: 'file', data: 'x'.repeat(4000) }, { name: 'flutter/b', type: 'file', data: 'y'.repeat(3000) }];
  for (const [kind, bytes] of [['tar.xz', tarXzOf(big)], ['zip', zipOf(big)]]) {
    const d = place(tc);
    const file = path.join(d, `a.${kind}`);
    fs.writeFileSync(file, bytes);
    const into = path.join(d, 'into');
    await assert.rejects(unpackChecked(file, kind, into, 'flutter', { most: 6999 }), (e) => e instanceof FetchError && e.code === 'size' && /unpacks to 7 kB, more than Hoprig.s ceiling/.test(e.message), kind);
    assert.deepEqual(fs.readdirSync(into), [], `${kind}: nothing unpacked`);
    await assert.rejects(unpackChecked(file, kind, into, 'flutter', { most: 7000, free: () => 6000 }), (e) => e.code === 'size' && /free/.test(e.message), kind);
    assert.deepEqual(fs.readdirSync(into), [], `${kind}: nothing unpacked`);
    const top = await unpackChecked(file, kind, into, 'flutter', { most: 7000, free: () => 7000 });
    assert.equal(fs.readFileSync(path.join(top, 'b'), 'utf8').length, 3000, `${kind}: at the ceiling it lands`);
  }
});

test('a stop ends the unpacking program at once, and unpackChecked says it was stopped', async (tc) => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  const r = await runTool(['sleep', '30'], { signal: ac.signal });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 5000, 'ended at the stop, not after 30 seconds');
  const d = place(tc);
  const file = path.join(d, 'a.tar.xz');
  fs.writeFileSync(file, tarXzOf(GOOD));
  const ac2 = new AbortController();
  // The listing goes through; the stop comes while tar unpacks.
  const run = (argv, o) => (argv.includes('-x') ? (ac2.abort(), runTool(['sleep', '30'], o)) : runTool(argv, o));
  await assert.rejects(unpackChecked(file, 'tar.xz', path.join(d, 'into'), 'flutter', { run, signal: ac2.signal }), (e) => e instanceof FetchError && e.code === 'stopped');
});

test('a listing whose lines end with \\r\\n (Windows\' tar) is read as the same entries', async () => {
  const names = ['flutter/', 'flutter/bin/dart', 'flutter/out'];
  const long = ['drwxr-xr-x  0 dev dev       0 Jan  1  2026 flutter/', 'lrwxrwxrwx  0 dev dev       0 Jan  1  2026 flutter/bin/dart -> flutter', 'lrwxrwxrwx  0 dev dev       0 Jan  1  2026 flutter/out -> ../../..'];
  // `tar -t -f` gives the names, `tar -t -v -f` the long lines: the first `n` of each, every line ended by \r\n.
  const run = (n) => async (argv) => ({ ok: true, stdout: `${(argv.includes('-v') ? long : names).slice(0, n).join('\r\n')}\r\n`, stderr: '' });
  assert.deepEqual(await checkTar('x.tar', 'flutter', run(2)), { entries: 2, bytes: 0 });
  await assert.rejects(checkTar('x.tar', 'flutter', run(3)), /a link that points outside \(flutter\/out → \.\.\/\.\.\/\.\.\)/);
});

test('Windows: the system\'s own tar by its full path; without it a GNU tar is told the path is local; elsewhere tar', async () => {
  const asked = [];
  const run = (stdout) => async (argv) => (asked.push(argv.join(' ')), { ok: true, code: 0, stdout, stderr: '' });
  const env = { SystemRoot: 'C:\\Windows', Path: 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32' }; // seal: a made-up Windows PATH handed to a pure function
  const own = 'C:\\Windows\\System32\\tar.exe';
  assert.deepEqual(await tarCommand(run(''), { platform: 'win32', env, exists: (f) => f === own }), [own]);
  assert.deepEqual(asked, [], 'the system\'s own tar: nothing asked');
  assert.deepEqual(await tarCommand(run('tar (GNU tar) 1.35\n'), { platform: 'win32', env, exists: () => false }), ['tar', '--force-local']);
  assert.deepEqual(await tarCommand(run('bsdtar 3.7.7 - libarchive 3.7.7\n'), { platform: 'win32', env, exists: () => false }), ['tar']);
  assert.deepEqual(asked, ['tar --version', 'tar --version']);
  for (const platform of ['linux', 'darwin']) assert.deepEqual(await tarCommand(async () => assert.fail('nothing asked'), { platform }), ['tar']);
  // The words reach every start of the unpacking: the list, the long list and the unpacking itself.
  const seen = [];
  const lines = { '-t -f': 'flutter/\n', '-t -v -f': 'drwxr-xr-x  0 dev dev 0 Jan  1  2026 flutter/\n' };
  await assert.rejects(unpackChecked('C:\\a.tar.xz', 'tar.xz', 'C:\\into', 'flutter', { tar: [own], free: () => null, run: async (argv) => {
    seen.push(argv);
    const key = argv.slice(1, -1).join(' ');
    return argv.includes('-x') ? { ok: false, code: 2, stdout: '', stderr: 'made-up failure' } : { ok: true, code: 0, stdout: lines[key] || '', stderr: '' };
  } }), /tar could not unpack it \(made-up failure\)/);
  assert.deepEqual(seen.map((a) => a[0]), [own, own, own]);
});

test('a missing tar, xz or unzip is named', () => {
  const sys = (have) => ({ platform: 'linux', has: (b) => have.includes(b) });
  assert.deepEqual(missingTools('tar.xz', sys(['tar'])), ['xz']);
  assert.deepEqual(missingTools('zip', sys([])), ['unzip']);
  assert.deepEqual(missingTools('tar.xz', { platform: 'darwin', has: () => true }), []);
});
