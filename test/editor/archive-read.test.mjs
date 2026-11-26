// Files' own tar reader (src/editor/tarread.mjs): on Windows the system's tar cannot name an entry whose name has
// letters outside the system's code page, so Files reads such a .tar.gz itself. Here, on any system, unpack() is told to
// use it (`own`): Files' own writer's archive and one this computer's tar made with GNU long names come back with the
// same names and bytes, and archives made of the test's own bytes that are hostile or damaged are each refused with
// nothing written. The choice of the reader is given Windows' answer (its tar's words) here.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { which } from '../../src/setup/system.mjs';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-read-')));
test.after(() => fs.rmSync(box, { recursive: true, force: true }));
const { paxRecord, ustarHeader, writeTarGz } = await import('../../src/editor/tarwrite.mjs');
const { ENTRIES_MAX, ownWanted, sameListing, unpack } = await import('../../src/editor/archive.mjs');
const { listTar } = await import('../../src/editor/tarread.mjs');

const BIG = crypto.randomBytes(200_000);
const LONG = `${'क'.repeat(66)}.t`; // 200 bytes
const TREE = { 'नमस्ते.txt': 'Devanagari\n', '文件夹/': null, '文件夹/数据.bin': BIG, '文件夹/空.txt': '', '😀 smile.txt': 'emoji\n', [LONG]: 'long\n', 'plain/': null, 'plain/a.txt': 'A\n' };

function make(dir, tree) {
  for (const [rel, body] of Object.entries(tree)) {
    const p = path.join(dir, ...rel.split('/'));
    if (rel.endsWith('/')) fs.mkdirSync(p, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
  }
  return dir;
}

function read(dir, rel = '') {
  const out = {};
  for (const n of fs.readdirSync(path.join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${n}` : n;
    if (fs.lstatSync(path.join(dir, r)).isDirectory()) Object.assign(out, { [`${r}/`]: null }, read(dir, r));
    else out[r] = fs.readFileSync(path.join(dir, r));
  }
  return out;
}
const asBytes = (tree) => Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, v === null ? null : Buffer.from(v)]));
const under = (top, tree) => Object.fromEntries(Object.entries(tree).map(([k, v]) => [`${top}/${k}`, v]));

let n = 0;
/** A folder of its own with this archive in it (gzip of `raw`). → the archive's path */
function placed(raw, name = 'a.tar.gz') {
  const dir = path.join(box, `case-${++n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, name), name.endsWith('.tar') ? raw : zlib.gzipSync(raw));
  return path.join(dir, name);
}

const pad = (b) => (b.length % 512 ? Buffer.concat([b, Buffer.alloc(512 - (b.length % 512))]) : b);
/** A tar of the test's own bytes: [{ name, data?, type?, linkname?, pax? }], then the two empty blocks. */
function tarOf(entries, { end = true } = {}) {
  const parts = [];
  for (const e of entries) {
    if (e.pax) {
      const data = Buffer.from(Object.entries(e.pax).map(([k, v]) => paxRecord(k, v)).join(''));
      parts.push(ustarHeader({ name: 'PaxHeader/x', size: data.length, type: 'x' }), pad(data));
    }
    if (e.rawPax) parts.push(ustarHeader({ name: 'PaxHeader/x', size: e.rawPax.length, type: 'x' }), pad(e.rawPax));
    const data = Buffer.from(e.data ?? '');
    parts.push(ustarHeader({ name: e.name, size: e.size ?? data.length, type: e.type ?? '0', linkname: e.linkname ?? '' }), pad(data));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

test('Files\' own writer\'s archive of names in several scripts: the own reader gives back the same names and bytes', async () => {
  const dir = make(path.join(box, 'own', 'sel'), TREE);
  const out = path.join(box, 'own', 'own.tar.gz');
  await writeTarGz(path.dirname(dir), ['sel'], out);
  const r = await unpack(out, [box], { own: true });
  assert.deepEqual(read(r.path), { 'sel/': null, ...asBytes(under('sel', TREE)) });
  assert.equal(r.entries, Object.keys(TREE).length + 1);
});

/**
 * How this computer's tar is asked for GNU long names (././@LongLink), or null: GNU tar (Linux) says --format=gnu,
 * bsdtar (macOS, Windows) --format gnutar. Asked once, from `tar --version`.
 */
function gnuFormat() {
  if (!which('tar')) return null;
  let v = '';
  try {
    v = execFileSync('tar', ['--version'], { encoding: 'utf8' });
  } catch {
    return null;
  }
  return /GNU tar/.test(v) ? ['--format=gnu'] : /bsdtar|libarchive/.test(v) ? ['--format', 'gnutar'] : null;
}
const GNU = gnuFormat();
// macOS' tar adds "._" entries for a file with extended attributes unless told not to: these tests compare names.
const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };

test('an archive this computer\'s tar made with GNU long names comes back with the same names and bytes', { skip: (process.platform === 'win32' && 'the first tar on PATH there may be Git\'s GNU tar, which takes C:\\… for a host (the test below proves long names with its own bytes)') || (!GNU && 'this computer\'s tar makes no archive with GNU long names (the test below proves them with the test\'s own bytes)') }, async () => {
  const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}`;
  const dir = make(path.join(box, 'gnu', 'sel'), { ...TREE, [`${deep}/${LONG}`]: 'deep\n' });
  const out = path.join(box, 'gnu', 'gnu.tar.gz');
  execFileSync('tar', [...GNU, '-czf', out, '-C', path.dirname(dir), 'sel'], { env: tarEnv });
  const raw = zlib.gunzipSync(fs.readFileSync(out));
  assert.ok(raw.includes(Buffer.from('././@LongLink')), 'the archive holds GNU long names');
  const r = await unpack(out, [box], { own: true });
  assert.deepEqual(read(path.join(r.path, 'sel')), read(dir));
});

test('GNU long names (types L and K) made of the test\'s own bytes are read, on every system', async () => {
  const long = (type, text) => {
    const data = Buffer.from(`${text}\0`);
    return [ustarHeader({ name: '././@LongLink', size: data.length, type }), pad(data)];
  };
  const name = `${'d'.repeat(70)}/${'नमस्ते'.repeat(10)}.txt`; // past ustar's 100 bytes
  const linkTo = `${'t'.repeat(150)}.txt`;
  const raw = Buffer.concat([
    ...long('L', name), ustarHeader({ name: name.slice(0, 99), size: 3, type: '0' }), pad(Buffer.from('hi\n')),
    ...long('K', linkTo), ...long('L', `${'l'.repeat(120)}`), ustarHeader({ name: 'l', type: '2', linkname: linkTo.slice(0, 99) }),
    Buffer.alloc(1024),
  ]);
  const file = placed(raw);
  const entries = await listTar(file, { windows: false });
  assert.deepEqual(entries.map((e) => [e.name, e.type, e.linkname]), [[name, '0', ''], ['l'.repeat(120), '2', linkTo]]);
  // Through unpack: the link is refused as today; without it the long name comes back with its bytes.
  await assert.rejects(unpack(file, [box], { own: true }), (e) => e.status === 409 && /holds links/.test(e.message));
  const only = placed(Buffer.concat([...long('L', name), ustarHeader({ name: name.slice(0, 99), size: 3, type: '0' }), pad(Buffer.from('hi\n')), Buffer.alloc(1024)]));
  const r = await unpack(only, [box], { own: true });
  assert.deepEqual(read(r.path), { [`${'d'.repeat(70)}/`]: null, [name]: Buffer.from('hi\n') });
});

// Each refused before anything is written: only the archive stays in its folder.
const hostile = {
  'a name with ..': [[{ name: '../x', data: 'x' }], /would land outside the folder/],
  'an absolute name': [[{ name: '/tmp/x', data: 'x' }], /would land outside the folder/],
  'a drive and a backslash': [[{ name: 'C:\\x', data: 'x' }], /has a character Windows does not allow/],
  'a drive-relative name': [[{ name: 'C:x', data: 'x' }], /has a character Windows does not allow/],
  'a pax path that escapes': [[{ name: 'ok.txt', data: 'x', pax: { path: 'a/../../evil' } }], /"a\/\.\.\/\.\.\/evil" would land outside the folder/],
  'a link': [[{ name: 'a.txt', data: 'A' }, { name: 'ln', type: '2', linkname: 'a.txt' }], /holds links/],
  'a hard link': [[{ name: 'a.txt', data: 'A' }, { name: 'h', type: '1', linkname: 'a.txt' }], /holds links/],
  'a device': [[{ name: 'dev', type: '3' }], /"dev" is neither a file, a folder nor a link/],
  'two names that differ only by case': [[{ name: 'Read.txt', data: 'a' }, { name: 'read.txt', data: 'b' }], /"read\.txt" and "Read\.txt" would be one file on Windows/],
  'two names that differ only by a trailing dot': [[{ name: 'b.txt', data: 'a' }, { name: 'b.txt.', data: 'b' }], /"b\.txt\." has a part that ends in a dot or a blank/],
  'a folder whose name ends in a blank': [[{ name: 'dir /a.txt', data: 'a' }], /"dir \/a\.txt" has a part that ends in a dot or a blank/],
  'a device name': [[{ name: 'docs/aux.txt', data: 'a' }], /"docs\/aux\.txt" has a part that is a device name of Windows/],
  'a device name with a blank before its ending': [[{ name: 'con .txt', data: 'a' }], /has a part that is a device name of Windows/],
  'a device name with two blanks': [[{ name: 'aux  .js', data: 'a' }], /has a part that is a device name of Windows/],
  'the console input device': [[{ name: 'CONIN$', data: 'a' }], /has a part that is a device name of Windows/],
  'the console output device': [[{ name: 'conout$', data: 'a' }], /has a part that is a device name of Windows/],
  'a device name in capitals': [[{ name: 'COM1', data: 'a' }], /has a part that is a device name of Windows/],
  'a character Windows does not allow': [[{ name: 'a|b.txt', data: 'x' }], /has a character Windows does not allow/],
  'git\'s folder': [[{ name: '.git/config', data: 'x' }], /git's own folder/],
  'a pax size that is not only digits': [[{ name: 'a.txt', data: 'x', pax: { size: '1e0' } }], /the size of "a\.txt" in it is not a size/],
  'an empty pax size': [[{ name: 'a.txt', data: '', pax: { size: '' } }], /the size of "a\.txt" in it is not a size/],
  'a folder without a name': [[{ name: '/', type: '5' }], /an entry in it has no name/],
  'a file without a name': [[{ name: '', data: 'x' }], /an entry in it has no name/],
  'a size larger than the archive holds': [[{ name: 'a.txt', data: 'x', pax: { size: '999999999999' } }], /cut off/],
};
for (const [what, [entries, why]] of Object.entries(hostile)) {
  test(`refused by the own reader, nothing written: ${what}`, async () => {
    const file = placed(tarOf(entries));
    await assert.rejects(unpack(file, [box], { own: true }), (e) => e.status === 409 && /^it is not unpacked: /.test(e.message) && why.test(e.message));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  });
}

test('refused by the own reader, nothing written: a wrong header checksum, a cut-off archive, a pax record with a wrong length, more entries than the limit', async () => {
  const good = tarOf([{ name: 'a.txt', data: 'A'.repeat(2000) }, { name: 'b.txt', data: 'B' }]);
  const bad = Buffer.from(good);
  bad[512 + 2048 + 10] ^= 0x01; // a byte of b.txt's header (after a.txt's header and its 2000 bytes, padded)
  const cases = {
    checksum: [bad, /checksum in it is wrong/],
    cut: [good.subarray(0, 1200), /cut off/],
    pax: [tarOf([{ name: 'a.txt', data: 'x', rawPax: Buffer.from('30 path=x\n') }]), /pax record in it has a wrong length/],
    count: [tarOf(Array.from({ length: ENTRIES_MAX + 1 }, (_, i) => ({ name: `f${i}` }))), new RegExp(`more than ${ENTRIES_MAX} entries`)],
  };
  for (const [what, [raw, why]] of Object.entries(cases)) {
    const file = placed(raw);
    await assert.rejects(unpack(file, [box], { own: true }), (e) => e.status === 409 && why.test(e.message), what);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)], what);
  }
  // The same good archive is read: the cases above are refused for what they are.
  const ok = await unpack(placed(good), [box], { own: true });
  assert.deepEqual(read(ok.path), { 'a.txt': Buffer.from('A'.repeat(2000)), 'b.txt': Buffer.from('B') });
});

test('Windows: the own reader is chosen only when the system tar cannot name an entry, and only for a .tar, .tar.gz or .tgz', () => {
  const failed = { ok: false, stdout: '', stderr: 'tar.exe: Archive entry has empty or unreadable filename ... skipping.\ntar.exe: Error exit delayed from previous errors.' };
  assert.equal(ownWanted('C:\\d\\all.tar.gz', failed, 'win32'), 'own');
  assert.equal(ownWanted('C:\\d\\all.tgz', failed, 'win32'), 'own');
  assert.equal(ownWanted('C:\\d\\all.tar', failed, 'win32'), 'own');
  assert.equal(ownWanted('C:\\d\\all.tar.gz', { ok: true, stdout: 'a/??.txt\nb.txt\n' }, 'win32'), 'check', 'a name with "?": the own reader lists it too');
  assert.equal(ownWanted('C:\\d\\all.zip', { ok: true, stdout: 'Why?.mp3\n' }, 'win32'), null, 'not a tar: as before');
  assert.equal(ownWanted('C:\\d\\all.zip', failed, 'win32'), 'words');
  assert.equal(ownWanted('C:\\d\\all.tar.xz', failed, 'win32'), 'words');
  assert.equal(ownWanted('C:\\d\\all.tar.gz', { ok: true, stdout: 'a.txt\nb/\n' }, 'win32'), null, 'a listing that works: the system tar, as before');
  assert.equal(ownWanted('C:\\d\\all.tar.gz', { ok: false, stderr: 'tar.exe: Error opening archive' }, 'win32'), null, 'another failure keeps its own words');
  for (const platform of ['linux', 'darwin']) assert.equal(ownWanted('/d/all.tar.gz', failed, platform), null, platform);
});

test('the own reader refuses while it lists: a name over 4096 bytes at once, its names past 8 MB together, the entry after the limit', async () => {
  // 30 entries of 1 MB names: a small archive whose names would fill memory.
  const big = tarOf(Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, pax: { path: `${'x'.repeat(999_992)}${i}` } })));
  const t0 = Date.now();
  await assert.rejects(unpack(placed(big), [box], { own: true }), (e) => e.status === 409 && /a name in it is longer than 4096 bytes/.test(e.message));
  assert.ok(Date.now() - t0 < 5000, `refused at once: ${Date.now() - t0} ms`);
  // 3000 names of 4000 bytes: 12 MB together.
  const many = tarOf(Array.from({ length: 3000 }, (_, i) => ({ name: `f${i}`, pax: { path: `${String(i).padStart(4, '0')}${'y'.repeat(3996)}` } })));
  await assert.rejects(unpack(placed(many), [box], { own: true }), (e) => e.status === 409 && /its names together are longer than 8 MB/.test(e.message));
  // The limit, then a damaged header: the listing stops at the limit, before it reaches the damage.
  const raw = tarOf(Array.from({ length: ENTRIES_MAX + 1 }, (_, i) => ({ name: `f${i}` })), { end: false });
  const damaged = Buffer.concat([raw, Buffer.alloc(512, 0x41), Buffer.alloc(1024)]);
  await assert.rejects(unpack(placed(damaged), [box], { own: true }), (e) => e.status === 409 && new RegExp(`more than ${ENTRIES_MAX} entries`).test(e.message));
});

test('the own reader skips global pax headers, caps pax records and long names at 16 MB together, and keeps its time limits', async () => {
  // 17 global headers of 1 MB records each: refused past 16 MB, quickly, without reading their records.
  const g = Buffer.from('6 a=b\n'.repeat(174_762));
  const globals = Buffer.concat([...Array.from({ length: 17 }, () => [ustarHeader({ name: 'PaxGlobal', size: g.length, type: 'g' }), pad(g)]).flat(), tarOf([{ name: 'a.txt', data: 'A' }])]);
  const t0 = Date.now();
  await assert.rejects(unpack(placed(globals), [box], { own: true }), (e) => e.status === 409 && /pax records and long names together are larger than 16 MB/.test(e.message));
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  // The limits handed in: a smaller cap, and no time at all for the listing, then for the unpacking.
  const small = tarOf([{ name: 'a.txt', data: 'A', pax: { comment: 'c'.repeat(600_000) } }, { name: 'b.txt', data: 'B', pax: { comment: 'c'.repeat(600_000) } }]);
  await assert.rejects(unpack(placed(small), [box], { own: true, ownLimits: { specialMax: 1 << 20 } }), (e) => e.status === 409 && /larger than 1 MB/.test(e.message));
  const good = tarOf([{ name: 'a.txt', data: 'A' }]);
  await assert.rejects(unpack(placed(good), [box], { own: true, ownLimits: { listMs: -1 } }), (e) => e.status === 409 && /reading it took longer than/.test(e.message));
  const file = placed(good);
  await assert.rejects(unpack(file, [box], { own: true, ownLimits: { extractMs: -1 } }), (e) => e.status === 409 && /^it is not unpacked: reading it took longer than/.test(e.message));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)], 'the half-made folder is removed');
});

test('Windows: a "?" in the system tar\'s listing goes the own way only where the archive\'s names differ from it', async () => {
  // Windows' answers: tar writes a letter it cannot convert as "?"; a real "?" is listed as it is.
  assert.equal(sameListing('a/??.txt\nb/\n', ['a/नम.txt', 'b/']), false, 'a letter tar could not convert: the own way');
  assert.equal(sameListing('Why?.mp3\nb/\n', ['Why?.mp3', 'b']), true, 'a real "?": the system tar, as before');
  assert.equal(sameListing('a.txt\n', ['a.txt', 'b.txt']), false);
});

test('Windows\' answer with this computer\'s tar: a real "?" in a name from Linux is unpacked by the system tar as before, not refused', { skip: (process.platform === 'win32' && 'a "?" cannot be in a Windows name: the test above gives its answers') || (!which('tar') && 'no tar here') }, async () => {
  const dir = make(path.join(box, 'q', 'sel'), { 'Why?.mp3': 'song\n' });
  const out = path.join(box, 'q', 'q.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', dir, 'Why?.mp3'], { env: tarEnv });
  const r = await unpack(out, [box], { platform: 'win32' });
  assert.deepEqual(read(r.path), { 'Why?.mp3': Buffer.from('song\n') });
});

test('a damaged gzip is refused in words with 409; gzip is told by its first bytes, not by the name', async () => {
  const raw = tarOf([{ name: 'a.txt', data: 'A'.repeat(5000) }]);
  const gz = zlib.gzipSync(raw);
  const cut = placed(gz.subarray(0, gz.length - 30), 'cut.tar');
  fs.writeFileSync(cut, gz.subarray(0, gz.length - 30)); // a .tar.gz cut short (written as is)
  const cutGz = path.join(path.dirname(cut), 'cut.tar.gz');
  fs.renameSync(cut, cutGz);
  await assert.rejects(unpack(cutGz, [box], { own: true }), (e) => e.status === 409 && /^it is not unpacked: it is damaged or not a tar archive \(/.test(e.message));
  // A .tgz that holds a plain tar, and a .tar that holds gzip: read for what they are.
  const plainTgz = placed(raw, 'plain.tar');
  fs.renameSync(plainTgz, path.join(path.dirname(plainTgz), 'plain.tgz'));
  const a = await unpack(path.join(path.dirname(plainTgz), 'plain.tgz'), [box], { own: true });
  assert.deepEqual(read(a.path), { 'a.txt': Buffer.from('A'.repeat(5000)) });
  const gzTar = placed(gz, 'zipped.tar');
  fs.writeFileSync(gzTar, gz);
  const b = await unpack(gzTar, [box], { own: true });
  assert.deepEqual(read(b.path), { 'a.txt': Buffer.from('A'.repeat(5000)) });
});

test('a file dated before 1970 (GNU tar writes its time as a negative base-256 number) is unpacked; only its time is not kept', async () => {
  const raw = tarOf([{ name: 'old.txt', data: 'old\n' }]);
  const h = raw.subarray(0, 512);
  h.fill(0xff, 136, 148); // mtime -1
  let sum = 0;
  h.fill(0x20, 148, 156);
  for (const x of h) sum += x;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const r = await unpack(placed(raw), [box], { own: true });
  assert.deepEqual(read(r.path), { 'old.txt': Buffer.from('old\n') });
});

test('a backslash in a name is a separator, as Windows reads it: "a\\b.txt" lands in the folder a', async () => {
  const r = await unpack(placed(tarOf([{ name: 'a\\b.txt', data: 'b\n' }])), [box], { own: true });
  assert.deepEqual(read(r.path), { 'a/': null, 'a/b.txt': Buffer.from('b\n') });
});

test('a header with the signed checksum old tars wrote is read, when its name has bytes past ASCII', async () => {
  const raw = tarOf([{ name: 'नमस्ते.txt', data: 'hi\n' }]);
  const h = raw.subarray(0, 512);
  h.fill(0x20, 148, 156);
  let signed = 0;
  for (const x of h) signed += x > 127 ? x - 256 : x;
  h.write(`${signed.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const r = await unpack(placed(raw), [box], { own: true });
  assert.deepEqual(read(r.path), { 'नमस्ते.txt': Buffer.from('hi\n') });
});

test('a file entry whose name ends in "/" is a folder, as tar reads it; its bytes are passed over', async () => {
  const r = await unpack(placed(tarOf([{ name: 'x/', data: 'ignored bytes' }, { name: 'x/a.txt', data: 'A\n' }])), [box], { own: true });
  assert.deepEqual(read(r.path), { 'x/': null, 'x/a.txt': Buffer.from('A\n') });
});

test('a header with a negative size (base-256) is refused as not well formed, a special one too', async () => {
  for (const type of ['g', 'x', '0']) {
    const h = ustarHeader({ name: 'neg', size: 0, type });
    h.fill(0xff, 124, 136);
    h[125] = 0x00; // FF 00 FF…FF: a large negative number
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const x of h) sum += x;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    const file = placed(Buffer.concat([h, tarOf([{ name: 'a.txt', data: 'A' }])]));
    await assert.rejects(unpack(file, [box], { own: true }), (e) => e.status === 409 && /a header of it is not well formed/.test(e.message), type);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)], type);
  }
});

test('a name ending in a backslash is a folder, and with a file of its name it is refused as one name', async () => {
  const r = await unpack(placed(tarOf([{ name: 'x\\' }, { name: 'x\\a.txt', data: 'A\n' }])), [box], { own: true });
  assert.deepEqual(read(r.path), { 'x/': null, 'x/a.txt': Buffer.from('A\n') });
  const file = placed(tarOf([{ name: 'x\\', data: '' }, { name: 'x', data: 'X' }]));
  await assert.rejects(unpack(file, [box], { own: true }), (e) => e.status === 409 && /would be one file on Windows/.test(e.message));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
});

test('Windows\' answer with this computer\'s tar: when the extra listing refuses an archive (its own caps), the system tar unpacks it as before', { skip: (process.platform === 'win32' && 'a "?" cannot be in a Windows name') || (!which('tar') && 'no tar here') }, async () => {
  // A real "what?.txt" behind pax records past the own reader's cap (given small here, as 16 MB is in use).
  const file = placed(tarOf([{ name: 'what?.txt', data: 'q\n', pax: { comment: 'c'.repeat(300_000) } }]));
  const r = await unpack(file, [box], { platform: 'win32', ownLimits: { specialMax: 100_000 } });
  assert.deepEqual(read(r.path), { 'what?.txt': Buffer.from('q\n') });
});

test('a file that is no archive but is named like one is said to be no tar archive, not cut off', async () => {
  // Random bytes whose checksum field is letters, and random bytes whose checksum field reads as a number.
  const lettered = crypto.randomBytes(4096);
  lettered.fill(0x41, 148, 156);
  const numbered = crypto.randomBytes(4096);
  numbered[148] = 0x80;
  for (const [name, bytes] of [['note.tar.gz', Buffer.from('just a note\n')], ['noise.tar', lettered], ['noise2.tar', numbered]]) {
    const dir = path.join(box, `noarch-${name}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, name), bytes);
    await assert.rejects(unpack(path.join(dir, name), [box], { own: true }), (e) => e.status === 409 && /^it is not unpacked: it is not a tar archive \(nor a gzip of one\)$/.test(e.message), name);
  }
});

test('an archive that is gone when the own reader opens it is refused in words, and leaves no stream behind to fail later', async () => {
  const gone = path.join(box, 'gone.tar.gz');
  await assert.rejects(listTar(gone), (e) => e.status === 409 && /^it is not unpacked: it could not be read \(ENOENT\)$/.test(e.message));
  // A stream whose own open fails without an error path would end the process here, a moment later.
  await new Promise((resolve) => setTimeout(resolve, 100));
});
