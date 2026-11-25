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
import { missingTools, runTool, unpackChecked, walkInside } from '../../src/pcsetup/unpack.mjs';

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
    assert.equal(fs.readlinkSync(path.join(top, 'bin', 'dart')), 'flutter');
    assert.equal(fs.statSync(path.join(top, 'bin', 'flutter')).mode & 0o111, 0o111, `${kind}: the program stays a program`);
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

test('a missing tar, xz or unzip is named', () => {
  const sys = (have) => ({ platform: 'linux', has: (b) => have.includes(b) });
  assert.deepEqual(missingTools('tar.xz', sys(['tar'])), ['xz']);
  assert.deepEqual(missingTools('zip', sys([])), ['unzip']);
  assert.deepEqual(missingTools('tar.xz', { platform: 'darwin', has: () => true }), []);
});
