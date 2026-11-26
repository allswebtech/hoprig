// Files' own tar.gz writer (src/editor/tarwrite.mjs): on Windows the system's tar ends with an access violation on a
// name with letters outside the system's code page, so such a pack goes through Hoprig's own writer there. Here its
// archive of names in several scripts is read back by this computer's tar, by Files' own unpack, and by a reader of the
// test's own (headers, checksums and pax records), with the same names and bytes. The choice of the writer is given
// Windows' answer here; one test runs the real pack on Windows only.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { which } from '../../src/setup/system.mjs';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-own-')));
test.after(() => fs.rmSync(box, { recursive: true, force: true }));
const { ownPacker, paxRecord, writeTarGz } = await import('../../src/editor/tarwrite.mjs');
const { pack, unpack } = await import('../../src/editor/archive.mjs');

const LONG = `${'क'.repeat(66)}.t`; // 200 bytes
const BIG = crypto.randomBytes(300_000);
/** The tree: path → content (a string or bytes); a path ending in "/" is a folder. */
const TREE = {
  'नमस्ते.txt': 'Devanagari\n',
  '文件夹/': null,
  '文件夹/数据.bin': BIG,
  '文件夹/空.txt': '',
  '😀 smile.txt': 'emoji\n',
  [LONG]: 'long\n',
  'plain/': null,
  'plain/a.txt': 'A\n',
};
const QUOTED = `it's a "q".txt`; // not on Windows, which keeps no " in a name

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

/** Every file and folder under `dir`: { 'a/': null, 'a/b.txt': <bytes> }, "/" between the parts. */
function read(dir, rel = '') {
  const out = {};
  for (const n of fs.readdirSync(path.join(dir, rel)).sort()) {
    const r = rel ? `${rel}/${n}` : n;
    const st = fs.lstatSync(path.join(dir, r));
    if (st.isDirectory()) Object.assign(out, { [`${r}/`]: null }, read(dir, r));
    else out[r] = fs.readFileSync(path.join(dir, r));
  }
  return out;
}

const asBytes = (tree) => Object.fromEntries(Object.entries(tree).map(([k, v]) => [k, v === null ? null : Buffer.from(v)]));

/**
 * The test's own tar reader: gunzip, then each 512-byte header (its checksum checked), a pax record's path, linkpath
 * and size for the entry after it. → { name: { type, data, linkname } }
 */
function readTar(gz) {
  const t = zlib.gunzipSync(gz);
  const out = {};
  let pax = {};
  for (let o = 0; o + 512 <= t.length;) {
    const h = t.subarray(o, o + 512);
    if (h.every((x) => x === 0)) break;
    const str = (a, b) => {
      const s = h.subarray(a, b);
      const z = s.indexOf(0);
      return s.subarray(0, z < 0 ? s.length : z).toString('utf8');
    };
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    assert.equal(parseInt(str(148, 156).trim(), 8), sum, `the checksum of the header at ${o}`);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    const data = Buffer.from(t.subarray(o + 512, o + 512 + size));
    o += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = {};
      let text = data.toString('utf8');
      while (text) {
        const len = Number(text.slice(0, text.indexOf(' ')));
        const rec = Buffer.from(text, 'utf8').subarray(0, len).toString('utf8');
        const kv = rec.slice(rec.indexOf(' ') + 1, -1);
        pax[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
        text = Buffer.from(text, 'utf8').subarray(len).toString('utf8');
      }
      continue;
    }
    const prefix = str(345, 500);
    const name = pax.path || (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    out[name] = { type, data, linkname: pax.linkpath || str(157, 257), mode: parseInt(str(100, 108).trim() || '0', 8) };
    pax = {};
  }
  return out;
}

const filesOf = (entries) => Object.fromEntries(Object.entries(entries).filter(([, e]) => e.type === '0' || e.type === '5').map(([k, e]) => [k, e.type === '5' ? null : e.data]));
/** The tree with each name under `top/`. */
const under = (top, tree) => Object.fromEntries(Object.entries(tree).map(([k, v]) => [`${top}/${k}`, v]));

test('a pax record counts its own length, also where the count gains a digit', () => {
  for (const v of ['x', 'a'.repeat(88), 'a'.repeat(89), 'a'.repeat(90), 'क'.repeat(40), 'b'.repeat(990)]) {
    const r = paxRecord('path', v);
    assert.equal(Buffer.byteLength(r), Number(r.slice(0, r.indexOf(' '))), v.slice(0, 10));
    assert.ok(r.endsWith(` path=${v}\n`));
  }
});

test('names in several scripts, a 200-byte one, a space and a quote: this computer\'s tar, Files\' unpack and the test\'s reader give back the same names and bytes', { skip: (process.platform === 'win32' && 'a name holds no " on Windows: the test below packs there') || (!which('tar') && 'no tar here') }, async () => {
  const dir = make(path.join(box, 'one', 'sel'), { ...TREE, [QUOTED]: 'quote\n', 'docs/a.txt': 'doc\n', 'docs/.git/HEAD': 'ref\n' });
  const out = path.join(box, 'one', 'own.tar.gz');
  await writeTarGz(path.dirname(dir), ['sel'], out);
  const want = { 'sel/': null, ...asBytes(under('sel', { ...TREE, [QUOTED]: 'quote\n', 'docs/': null, 'docs/a.txt': 'doc\n' })) };
  // The test's own reader: every header's checksum, and the pax names.
  const entries = readTar(fs.readFileSync(out));
  assert.deepEqual(filesOf(entries), want);
  assert.ok(Object.keys(entries).every((n) => !n.split('/').includes('.git')), 'git\'s folder is left out, as tar --exclude=.git does');
  // This computer's tar.
  const x = path.join(box, 'one', 'by-tar');
  fs.mkdirSync(x);
  execFileSync('tar', ['-xzf', out, '-C', x]);
  assert.deepEqual(read(x), want);
  // Files' own unpack (it lists and checks the archive with the computer's tar first).
  const r = await unpack(out, [box]);
  assert.deepEqual(read(r.path), want);
});

test('a link is written as a link, never followed; a pipe is refused by its name', { skip: (process.platform === 'win32' && 'links and pipes are made differently on Windows') || (!which('tar') && 'no tar here') }, async () => {
  const dir = make(path.join(box, 'links'), { 'नमस्ते.txt': 'Devanagari\n' });
  fs.symlinkSync('नमस्ते.txt', path.join(dir, 'लिंक'));
  fs.symlinkSync('/etc/hostname', path.join(dir, 'out'));
  const out = path.join(box, 'links.tar.gz');
  await writeTarGz(dir, ['नमस्ते.txt', 'लिंक', 'out'], out);
  const e = readTar(fs.readFileSync(out));
  assert.deepEqual([e['लिंक'].type, e['लिंक'].linkname, e.out.type, e.out.linkname], ['2', 'नमस्ते.txt', '2', '/etc/hostname']);
  const x = path.join(box, 'links-x');
  fs.mkdirSync(x);
  execFileSync('tar', ['-xzf', out, '-C', x]);
  assert.equal(fs.readlinkSync(path.join(x, 'लिंक')), 'नमस्ते.txt');
  if (which('mkfifo')) {
    execFileSync('mkfifo', [path.join(dir, 'पाइप')]);
    await assert.rejects(writeTarGz(dir, ['पाइप'], path.join(box, 'pipe.tar.gz')), (err) => err.status === 409 && /"पाइप" is neither a file, a folder nor a link/.test(err.message));
  }
});

test('Windows chooses Files\' own writer only for a name, a folder\'s path or a link outside plain ASCII; plain names and every other system keep the system\'s tar', async () => {
  const dir = make(path.join(box, 'choice'), { 'a.txt': 'A\n', 'plain/b.txt': 'B\n', 'deep/x/नमस्ते.txt': 'D\n', 'g/.git/文件': 'git\n', 'g/c.txt': 'C\n' });
  const win = { platform: 'win32' };
  assert.equal(await ownPacker(dir, ['a.txt', 'plain'], win), false, 'plain names: the system tar, as before');
  assert.equal(await ownPacker(dir, ['g'], win), false, 'a name inside git\'s folder, which is left out anyway');
  assert.equal(await ownPacker(dir, ['a.txt', 'deep'], win), true, 'a name deep inside a chosen folder');
  assert.equal(await ownPacker(path.join(dir, 'deep', 'x'), ['नमस्ते.txt'], win), true);
  const odd = make(path.join(box, 'फ़ोल्डर'), { 'a.txt': 'A\n' });
  assert.equal(await ownPacker(odd, ['a.txt'], win), true, 'the folder\'s own path');
  fs.symlinkSync('नमस्ते.txt', path.join(dir, 'ln'));
  assert.equal(await ownPacker(dir, ['ln'], win), true, 'a link whose target has such a letter');
  for (const platform of ['linux', 'darwin']) assert.equal(await ownPacker(path.join(dir, 'deep', 'x'), ['नमस्ते.txt'], { platform }), false, platform);
});

test('pack() with Windows\' answer packs such a name through the own writer: the archive takes its place and nothing is left beside it', { skip: process.platform === 'win32' && 'the real pack on Windows is the test below' }, async () => {
  const dir = make(path.join(box, 'packwin'), { 'नमस्ते.txt': 'Devanagari\n', '文件夹/数据.bin': BIG });
  const { path: archive } = await pack([path.join(dir, 'नमस्ते.txt'), path.join(dir, '文件夹')], [box], { name: 'दोनों', platform: 'win32' });
  assert.equal(archive, path.join(dir, 'दोनों.tar.gz'));
  assert.deepEqual(filesOf(readTar(fs.readFileSync(archive))), asBytes({ 'नमस्ते.txt': 'Devanagari\n', '文件夹/': null, '文件夹/数据.bin': BIG }));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['दोनों.tar.gz', 'नमस्ते.txt', '文件夹'].sort(), 'no temporary file is left');
});

test('Windows, for real: pack() packs names in several scripts, and unpack() gives them back; the test\'s reader agrees', { skip: process.platform !== 'win32' && 'it runs Files\' pack and unpack on Windows itself; elsewhere the tests above and test/editor/archive-read.test.mjs give their answers' }, async () => {
  const dir = make(path.join(box, 'real'), TREE);
  const names = ['नमस्ते.txt', '文件夹', '😀 smile.txt', LONG, 'plain'];
  const { path: archive } = await pack(names.map((n) => path.join(dir, n)), [box], { name: 'सब' });
  assert.deepEqual(filesOf(readTar(fs.readFileSync(archive))), asBytes(TREE));
  // Unpacked by Files: the system tar lists it first (it cannot name these entries), then Files' own reader takes it.
  const copy = path.join(box, 'unpack-try');
  fs.mkdirSync(copy);
  fs.copyFileSync(archive, path.join(copy, 'all.tar.gz'));
  const was = process.env.HOPRIG_SEAL_REAL; // seal: kept, to be put back after this one unpack
  process.env.HOPRIG_SEAL_REAL = [was, 'tar'].filter(Boolean).join(','); // seal: unpack asks Windows' own tar to list an archive of the test's holding names outside its code page; the archive and the folder are the test's own
  const t0 = Date.now();
  try {
    const r = await unpack(path.join(copy, 'all.tar.gz'), [box]);
    console.log(`WINDIAG unpack: ok, ${r.entries} entries in ${Date.now() - t0} ms`);
    assert.deepEqual(read(r.path), asBytes(TREE));
  } catch (e) {
    console.log(`WINDIAG unpack: failed after ${Date.now() - t0} ms, status ${e.status ?? '-'}: ${String(e.message).slice(0, 400)}`);
    throw e;
  } finally {
    if (was === undefined) delete process.env.HOPRIG_SEAL_REAL; // seal: the system tar for this one unpack only
    else process.env.HOPRIG_SEAL_REAL = was; // seal: the value before this unpack
  }
});

test('a file dated before 1970 is written as 1970, an archive this computer\'s tar reads', { skip: (process.platform === 'win32' && 'a time before 1970 is set differently there') || (!which('tar') && 'no tar here') }, async () => {
  const dir = make(path.join(box, 'old'), { 'पुराना.txt': 'old\n' });
  fs.utimesSync(path.join(dir, 'पुराना.txt'), -100, -100);
  const out = path.join(box, 'old.tar.gz');
  await writeTarGz(dir, ['पुराना.txt'], out);
  assert.match(execFileSync('tar', ['-tzvf', out], { encoding: 'utf8' }), /पुराना\.txt/);
  assert.deepEqual(filesOf(readTar(fs.readFileSync(out))), asBytes({ 'पुराना.txt': 'old\n' }));
});

test('Windows\' answer: a folder the choice cannot read (an error of the disk) is said in words, as a failed pack is', async () => {
  const dir = make(path.join(box, 'unreadable'), { 'sub/नमस्ते.txt': 'x\n' });
  // The first reading of the folder is pack's own check (mayChangeFolderAsync); the choice's, the second, fails.
  const real = fs.promises.readdir;
  let reads = 0;
  fs.promises.readdir = async function (p, ...rest) {
    if (String(p) === path.join(dir, 'sub') && ++reads > 1) throw Object.assign(new Error(`EIO: i/o error, scandir '${p}'`), { code: 'EIO' });
    return real.call(this, p, ...rest);
  };
  try {
    await assert.rejects(pack([path.join(dir, 'sub')], [box], { platform: 'win32' }), (e) => e.status === 409 && /^it is not packed: EIO/.test(e.message));
  } finally {
    fs.promises.readdir = real;
  }
  assert.deepEqual(fs.readdirSync(dir), ['sub'], 'nothing left beside it');
});

test('Windows\' answer: a folder is written as 0755 and a file as 0644 (0444 read-only), never with the 0666 Windows gives a folder', { skip: process.platform === 'win32' && 'the modes are made up here; on Windows they are what it gives' }, async () => {
  const dir = make(path.join(box, 'modes'), { 'फ़ोल्डर/a.txt': 'a\n', 'फ़ोल्डर/ro.txt': 'r\n' });
  fs.chmodSync(path.join(dir, 'फ़ोल्डर'), 0o666 | 0o100); // what Windows says of a folder, plus what lets this test read it
  fs.chmodSync(path.join(dir, 'फ़ोल्डर', 'a.txt'), 0o666);
  fs.chmodSync(path.join(dir, 'फ़ोल्डर', 'ro.txt'), 0o444);
  const win = path.join(box, 'modes-win.tar.gz');
  await writeTarGz(dir, ['फ़ोल्डर'], win, { platform: 'win32' });
  const w = readTar(fs.readFileSync(win));
  assert.deepEqual([w['फ़ोल्डर/'].mode, w['फ़ोल्डर/a.txt'].mode, w['फ़ोल्डर/ro.txt'].mode], [0o755, 0o644, 0o444]);
  // Every other system keeps the modes it has.
  const lin = path.join(box, 'modes-linux.tar.gz');
  await writeTarGz(dir, ['फ़ोल्डर'], lin, { platform: 'linux' });
  const l = readTar(fs.readFileSync(lin));
  assert.deepEqual([l['फ़ोल्डर/'].mode, l['फ़ोल्डर/a.txt'].mode, l['फ़ोल्डर/ro.txt'].mode], [0o766, 0o666, 0o444]);
});

test('Windows\' answer: the choice walks a large plain tree without holding the thread, and still stops at the first name outside ASCII', async () => {
  const tree = {};
  for (let i = 0; i < 40; i++) tree[`d${i}/f.txt`] = 'x';
  const dir = make(path.join(box, 'wide'), tree);
  const order = [];
  setImmediate(() => order.push('another turn'));
  const p = ownPacker(dir, fs.readdirSync(dir), { platform: 'win32' });
  assert.ok(p instanceof Promise, 'it answers later, not at once');
  order.push(await p);
  assert.deepEqual(order, ['another turn', false], 'other work ran while it walked');
  fs.writeFileSync(path.join(dir, 'd39', 'नमस्ते.txt'), 'x');
  assert.equal(await ownPacker(dir, fs.readdirSync(dir), { platform: 'win32' }), true);
});
