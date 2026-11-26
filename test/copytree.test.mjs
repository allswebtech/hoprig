// Hoprig's own copy of a folder tree by the names' bytes (src/copytree.mjs), in temporary folders: what it keeps, what
// it does not copy, and what it refuses. The proof that follows a copy (src/adopt/proof.mjs) judges the last test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyTree } from '../src/copytree.mjs';
import { sameTime, treeDiff, treeOf } from '../src/adopt/proof.mjs';
import { ODD_NAMES_SKIP, oddNamesWork } from './oddnames.mjs';

const POSIX = process.platform !== 'win32' ? false : 'POSIX modes, links and names';
const fresh = () => fs.mkdtempSync(path.join(os.tmpdir(), 'copytree-'));
const mode = (p) => fs.lstatSync(p).mode & 0o7777;
const named = (dir, ...bytes) => Buffer.concat([Buffer.from(`${dir}/`), ...bytes.map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b)))]);
/** Every mode below `d` writable again, so the folder can be removed. */
function writable(d) {
  if (!fs.existsSync(d)) return;
  const walk = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    fs.chmodSync(p, (st.mode & 0o777) | 0o700);
    if (st.isDirectory()) for (const n of fs.readdirSync(p, { encoding: 'buffer' })) walk(Buffer.concat([Buffer.from(p), Buffer.from('/'), n]));
  };
  walk(d);
}
const cleanup = (d) => { writable(d); fs.rmSync(d, { recursive: true, force: true }); };

test('a file: its content, its mode (600, 755, read-only) and its times', { skip: POSIX }, (t) => {
  const d = fresh();
  t.after(() => cleanup(d));
  const src = path.join(d, 'src');
  fs.mkdirSync(src);
  for (const [n, m] of [['secret', 0o600], ['run.sh', 0o755], ['readonly', 0o444]]) {
    fs.writeFileSync(path.join(src, n), `${n}\n`);
    fs.chmodSync(path.join(src, n), m);
    fs.utimesSync(path.join(src, n), 1_700_000_000.25, 1_700_000_100.75);
  }
  copyTree(src, path.join(d, 'dst'));
  for (const [n, m] of [['secret', 0o600], ['run.sh', 0o755], ['readonly', 0o444]]) {
    const a = fs.statSync(path.join(src, n));
    const b = fs.statSync(path.join(d, 'dst', n));
    assert.equal(fs.readFileSync(path.join(d, 'dst', n), 'utf8'), `${n}\n`, n);
    assert.equal(mode(path.join(d, 'dst', n)), m, n);
    assert.ok(sameTime(a.mtimeMs, b.mtimeMs) && Math.abs(a.mtimeMs - b.mtimeMs) < 2, `${n} mtime ${a.mtimeMs} ${b.mtimeMs}`);
    assert.ok(Math.abs(a.atimeMs - b.atimeMs) < 2, `${n} atime`);
  }
});

test('a folder: its mode and times set after its content, so a read-only folder is copied whole', { skip: POSIX }, (t) => {
  const d = fresh();
  t.after(() => cleanup(d));
  const src = path.join(d, 'src');
  fs.mkdirSync(path.join(src, 'ro', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(src, 'ro', 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(src, 'ro', 'inner', 'b.txt'), 'b\n');
  fs.utimesSync(path.join(src, 'ro', 'inner'), 1_700_000_000, 1_700_000_200.5);
  fs.utimesSync(path.join(src, 'ro'), 1_700_000_000, 1_700_000_300.5);
  fs.chmodSync(path.join(src, 'ro', 'inner'), 0o500);
  fs.chmodSync(path.join(src, 'ro'), 0o555);
  copyTree(src, path.join(d, 'dst'));
  const dst = path.join(d, 'dst', 'ro');
  assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(fs.readFileSync(path.join(dst, 'inner', 'b.txt'), 'utf8'), 'b\n');
  if (process.platform !== 'win32') assert.equal(mode(dst), 0o555, 'read-only afterwards');
  if (process.platform !== 'win32') assert.equal(mode(path.join(dst, 'inner')), 0o500);
  assert.ok(Math.abs(fs.statSync(dst).mtimeMs - fs.statSync(path.join(src, 'ro')).mtimeMs) < 2, 'its time, set after its content');
  assert.ok(Math.abs(fs.statSync(path.join(dst, 'inner')).mtimeMs - fs.statSync(path.join(src, 'ro', 'inner')).mtimeMs) < 2);
});

test('a symbolic link stays a link with the same target bytes and is never followed', { skip: POSIX }, (t) => {
  const d = fresh();
  t.after(() => cleanup(d));
  const src = path.join(d, 'src');
  fs.mkdirSync(path.join(src, 'real'), { recursive: true });
  fs.writeFileSync(path.join(src, 'real', 'inside.txt'), 'x\n');
  fs.writeFileSync(path.join(src, 'file.txt'), 'f\n');
  fs.symlinkSync('file.txt', path.join(src, 'to-file'));
  fs.symlinkSync('real', path.join(src, 'to-folder'));
  fs.symlinkSync('nowhere/at/all', path.join(src, 'dangling'));
  const oddTarget = Buffer.concat([Buffer.from('odd'), Buffer.from([0xff]), Buffer.from('target')]);
  fs.symlinkSync(oddTarget, path.join(src, 'odd-target'));
  copyTree(src, path.join(d, 'dst'));
  const dst = path.join(d, 'dst');
  for (const [n, target] of [['to-file', Buffer.from('file.txt')], ['to-folder', Buffer.from('real')], ['dangling', Buffer.from('nowhere/at/all')], ['odd-target', oddTarget]]) {
    assert.ok(fs.lstatSync(path.join(dst, n)).isSymbolicLink(), n);
    assert.ok(fs.readlinkSync(path.join(dst, n), { encoding: 'buffer' }).equals(target), n);
  }
  // The link to a folder was not walked: only the folder itself holds the file.
  assert.deepEqual(fs.readdirSync(dst).sort(), ['dangling', 'file.txt', 'odd-target', 'real', 'to-file', 'to-folder']);
});

test('names: the byte 0xFF, UTF-8 that is not ASCII, a space, a newline, a leading dash', { skip: POSIX }, (t) => {
  const d = fresh();
  t.after(() => cleanup(d));
  const src = path.join(d, 'src');
  fs.mkdirSync(src);
  // The names that are not UTF-8 only where the disk takes them (APFS refuses them: ODD_NAMES_SKIP); the rest always.
  const oddOk = oddNamesWork({ dir: src });
  if (!oddOk) t.diagnostic(`the names with the bytes 0xFF and 0xFE are skipped: ${ODD_NAMES_SKIP}`);
  const names = [...(oddOk ? [Buffer.concat([Buffer.from('bad'), Buffer.from([0xff, 0xfe]), Buffer.from('.txt')])] : []), Buffer.from('café नमस्ते.txt'), Buffer.from('with space.txt'), Buffer.from('new\nline.txt'), Buffer.from('-leading-dash')];
  names.forEach((n, i) => fs.writeFileSync(named(src, n), `${i}\n`));
  if (oddOk) {
    fs.mkdirSync(named(src, Buffer.from([0xff]), 'dir'));
    fs.writeFileSync(named(src, Buffer.from([0xff]), 'dir/', Buffer.from([0xfe]), 'x'), 'deep\n');
  }
  copyTree(src, path.join(d, 'dst'));
  const dst = path.join(d, 'dst');
  names.forEach((n, i) => assert.equal(fs.readFileSync(named(dst, n), 'utf8'), `${i}\n`, n.toString('hex')));
  if (oddOk) assert.equal(fs.readFileSync(named(dst, Buffer.from([0xff]), 'dir/', Buffer.from([0xfe]), 'x'), 'utf8'), 'deep\n');
  assert.equal(treeDiff(treeOf(src), treeOf(dst)).length, 0, 'the proof finds the copy the same');
});

test('the probe for names that are not UTF-8: false where the disk refuses them (EILSEQ, APFS), any other error thrown', { skip: POSIX }, (t) => {
  const d = fresh();
  t.after(() => cleanup(d));
  const refuse = (code) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(oddNamesWork({ dir: d, write: refuse('EILSEQ') }), false, 'APFS: such a name cannot exist');
  assert.throws(() => oddNamesWork({ dir: d, write: refuse('EACCES') }), (e) => e.code === 'EACCES');
  assert.equal(oddNamesWork({ dir: d }), process.platform === 'darwin' ? false : true, 'Linux takes any bytes');
});

test('a socket and a pipe are not copied; the rest of the folder is', { skip: POSIX }, async (t) => {
  const d = fresh();
  const srv = net.createServer();
  t.after(() => { srv.close(); cleanup(d); });
  const src = path.join(d, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'a.txt'), 'a\n');
  await new Promise((r) => srv.listen(path.join(src, 'sock'), r));
  const fifo = spawnSync('mkfifo', [path.join(src, 'pipe')]); // a pipe in the test's own folder
  copyTree(src, path.join(d, 'dst'));
  assert.deepEqual(fs.readdirSync(path.join(d, 'dst')), ['a.txt'], fifo.status === 0 ? 'neither the socket nor the pipe' : 'not the socket (no mkfifo here)');
});

test('a destination that is there already is refused and left as it is: a file, a link, a folder', { skip: POSIX }, (t) => {
  const d = fresh();
  t.after(() => cleanup(d));
  fs.writeFileSync(path.join(d, 'new'), 'new\n');
  fs.writeFileSync(path.join(d, 'old'), 'old\n');
  assert.throws(() => copyTree(path.join(d, 'new'), path.join(d, 'old')), (e) => e.code === 'ERR_FS_CP_EEXIST');
  assert.equal(fs.readFileSync(path.join(d, 'old'), 'utf8'), 'old\n');
  fs.symlinkSync('old', path.join(d, 'link'));
  assert.throws(() => copyTree(path.join(d, 'new'), path.join(d, 'link')), (e) => e.code === 'ERR_FS_CP_EEXIST');
  assert.equal(fs.readlinkSync(path.join(d, 'link')), 'old');
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src', 'x'), 'x\n');
  fs.mkdirSync(path.join(d, 'there'));
  assert.throws(() => copyTree(path.join(d, 'src'), path.join(d, 'there')), (e) => e.code === 'ERR_FS_CP_EEXIST');
  assert.deepEqual(fs.readdirSync(path.join(d, 'there')), [], 'nothing merged into it');
  assert.throws(() => copyTree(path.join(d, 'src'), path.join(d, 'src', 'inside')), (e) => e.code === 'ERR_FS_CP_EINVAL', 'never into itself');
});

test('an error in the middle is thrown as it comes, and what was copied until then stays', { skip: POSIX || (process.getuid && process.getuid() === 0 && 'root reads everything') }, (t) => {
  const d = fresh();
  t.after(() => cleanup(d));
  const src = path.join(d, 'src');
  fs.mkdirSync(src);
  for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(src, n), `${n}\n`);
  fs.chmodSync(path.join(src, 'b'), 0);
  const order = fs.readdirSync(src);
  assert.throws(() => copyTree(src, path.join(d, 'dst')), (e) => e.code === 'EACCES');
  const before = order.slice(0, order.indexOf('b'));
  assert.deepEqual(fs.readdirSync(path.join(d, 'dst')).sort(), before.sort(), 'the entries copied before the unreadable one');
});

test('200 files in the last half millisecond of a second: the copy and the proof find each the same', { skip: POSIX }, (t) => {
  const d = fresh();
  t.after(() => cleanup(d));
  const src = path.join(d, 'src');
  fs.mkdirSync(src);
  for (let i = 0; i < 200; i++) {
    const f = path.join(src, `f${i}`);
    fs.writeFileSync(f, String(i));
    const s = 1_795_000_000 + i + 0.9995 + (i % 5) * 0.0001;
    fs.utimesSync(f, s, s);
  }
  copyTree(src, path.join(d, 'dst'));
  const a = treeOf(src);
  const b = treeOf(path.join(d, 'dst'));
  assert.equal(Object.keys(a.entries).length, 200);
  assert.deepEqual(treeDiff(a, b), [], '200 of 200 the same');
});
