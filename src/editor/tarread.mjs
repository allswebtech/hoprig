// Files' own tar reader, for Windows only: the system's tar there cannot name an entry whose name has letters outside
// the system's code page ("Archive entry has empty or unreadable filename"), so archive.mjs reads such a .tar, .tar.gz
// or .tgz with this one, and only then. It reads ustar with pax records (path, linkpath, size) and GNU's long names
// (././@LongLink, types L and K), through gzip, streamed, in two passes: the first reads every header (each checksum
// checked, nothing written) and gives the entries to archive.mjs, which checks them as it checks the system tar's
// listing; the second writes the folders and files into the empty folder it is given. A link is listed as a link (and
// refused by archive.mjs, as today); a device, a pipe or another kind is refused by name. A name Windows cannot hold (a
// character it does not allow, or one that differs from another entry's only by its letter case or a trailing dot or
// space, which Windows would write over each other) is refused by name before anything is written.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { fail } from './paths.mjs';

const BLOCK = 512;
const META_MAX = 1 << 20; // a pax record block or a GNU long name: at most 1 MB
const refuse = (why) => fail(409, `it is not unpacked: ${why}`);

/** Exactly-sized reads from a stream of Buffers. */
class Bytes {
  constructor(stream) {
    this.it = stream[Symbol.asyncIterator]();
    this.buf = Buffer.alloc(0);
    this.done = false;
  }

  async fill(n) {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : r.value;
    }
  }

  async read(n) {
    await this.fill(n);
    const out = this.buf.subarray(0, Math.min(n, this.buf.length));
    this.buf = this.buf.subarray(out.length);
    return out;
  }

  /** `n` bytes in the pieces they come in; the archive ending first is a cut-off archive. */
  async *pieces(n) {
    let left = n;
    while (left > 0) {
      if (this.late) this.late();
      if (!this.buf.length) await this.fill(1);
      if (!this.buf.length) throw refuse('the archive ends in the middle of an entry (it is cut off)');
      const take = Math.min(left, this.buf.length);
      yield this.buf.subarray(0, take);
      this.buf = this.buf.subarray(take);
      left -= take;
    }
  }

  async skip(n) {
    for await (const piece of this.pieces(n)) void piece;
  }
}

const field = (h, a, b) => {
  const s = h.subarray(a, b);
  const z = s.indexOf(0);
  return s.subarray(0, z < 0 ? s.length : z).toString('utf8');
};

/**
 * A numeric field: octal digits, or GNU's base-256 when its first byte has the high bit (0xff first: a negative number,
 * in two's complement, as GNU tar writes a time before 1970).
 */
function number(h, a, b) {
  if (h[a] === 0xff) {
    let n = 0;
    for (let i = a; i < b; i++) n = n * 256 + (0xff - h[i]);
    return -(n + 1);
  }
  if (h[a] & 0x80) {
    let n = h[a] & 0x7f;
    for (let i = a + 1; i < b; i++) n = n * 256 + h[i];
    return n;
  }
  const t = field(h, a, b).trim();
  if (t && !/^[0-7]+$/.test(t)) throw refuse('a header of it is not well formed');
  return t ? parseInt(t, 8) : 0;
}

/** pax records "<length> <key>=<value>\n", each length checked. → { key: value } */
export function paxRecords(data) {
  const out = {};
  let o = 0;
  while (o < data.length) {
    const sp = data.indexOf(0x20, o);
    const lenText = sp > o ? data.subarray(o, sp).toString('ascii') : '';
    const len = /^\d+$/.test(lenText) ? Number(lenText) : NaN;
    if (!(len > 0) || o + len > data.length || data[o + len - 1] !== 0x0a) throw refuse('a pax record in it has a wrong length');
    const rec = data.subarray(sp + 1, o + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq <= 0) throw refuse('a pax record in it is not well formed');
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    o += len;
  }
  return out;
}

/** Whether the file starts as gzip does (1f 8b), whatever its name says. */
function gzipped(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const two = Buffer.alloc(2);
    return fs.readSync(fd, two, 0, 2, 0) === 2 && two[0] === 0x1f && two[1] === 0x8b;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The archive's entries, one at a time: { name, type, size, linkname, mtime, body() } (body: its bytes, streamed).
 * `ms`: how long it may take (the system tar's listing ends at 120 s); `specialMax`: the bytes of pax records and long
 * names together, past which it is refused.
 */
async function* walk(file, { ms = Infinity, specialMax = 16 << 20 } = {}) {
  const until = Date.now() + ms;
  const late = () => {
    if (Date.now() > until) throw refuse(`reading it took longer than ${Math.round(ms / 1000)} s`);
  };
  let special = 0;
  // Whether it is gzip is asked first, and the file stream gets its error path before anything else can throw: a
  // stream left without one would end the dashboard when its own open fails, or stay open.
  let gz;
  try {
    gz = gzipped(file);
  } catch (e) {
    throw refuse(`it could not be read (${e.code || e.message})`);
  }
  const src = fs.createReadStream(file);
  const stream = gz ? zlib.createGunzip() : src;
  src.on('error', (e) => stream.destroy(e));
  if (gz) src.pipe(stream);
  const b = new Bytes(stream);
  b.late = late;
  let pax = {};
  let longName = null;
  let longLink = null;
  try {
    for (let at = 0; ; at++) {
      late();
      const h = await b.read(BLOCK);
      if (!h.length) return; // the end, without its two empty blocks
      if (h.length < BLOCK) throw refuse(at === 0 ? 'it is not a tar archive (nor a gzip of one)' : 'the archive ends in the middle of a header (it is cut off)');
      if (h.every((x) => x === 0)) return;
      // The sum of the header's bytes, unsigned as POSIX says or signed as old tars of Sun and IRIX wrote it.
      let sum = 0;
      let signed = 0;
      for (let i = 0; i < BLOCK; i++) {
        const x = i >= 148 && i < 156 ? 0x20 : h[i];
        sum += x;
        signed += x > 127 ? x - 256 : x;
      }
      let said = NaN;
      try {
        said = number(h, 148, 156);
      } catch {
        /* not digits: no header */
      }
      if (said !== sum && said !== signed) throw refuse(at === 0 ? 'it is not a tar archive (nor a gzip of one)' : 'a header checksum in it is wrong (it is damaged)');
      const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
      const size = number(h, 124, 136);
      if (!Number.isSafeInteger(size) || size < 0) throw refuse('a header of it is not well formed'); // a negative size of any header
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
        if (size > META_MAX) throw refuse('a name or pax record in it is larger than 1 MB');
        special += size;
        if (special > specialMax) throw refuse(`its pax records and long names together are larger than ${specialMax >> 20} MB`);
        if (type === 'g') {
          await b.skip(padded); // global records: not used, so not read
          continue;
        }
        const data = Buffer.from(await b.read(size));
        if (data.length < size) throw refuse('the archive ends in the middle of an entry (it is cut off)');
        await b.skip(padded - size);
        if (type === 'x') pax = paxRecords(data);
        else if (type === 'L') longName = field(data, 0, data.length);
        else longLink = field(data, 0, data.length);
        continue;
      }
      const magic = field(h, 257, 263);
      const prefix = magic.startsWith('ustar') && magic !== 'ustar ' ? field(h, 345, 500) : '';
      const name = pax.path ?? longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
      const linkname = pax.linkpath ?? longLink ?? field(h, 157, 257);
      if (pax.size !== undefined && !/^\d+$/.test(pax.size)) throw refuse(`the size of "${name.slice(0, 80)}" in it is not a size`);
      const real = pax.size !== undefined ? Number(pax.size) : size;
      if (!Number.isSafeInteger(real) || real < 0) throw refuse(`the size of "${name.slice(0, 80)}" in it is not a size`);
      pax = {};
      longName = null;
      longLink = null;
      // A file entry whose name ends in "/" (or "\\", as Windows reads it) is a folder, as tar reads it (its bytes, if any, are passed over).
      const kind = (type === '0' || type === '7') && /[\\/]$/.test(name) ? '5' : type;
      const dataSize = kind === '0' || kind === '7' ? real : kind === '5' || kind === '1' || kind === '2' ? 0 : real;
      const stored = kind === '5' && type !== '5' ? real : dataSize;
      let used = false;
      const entry = { name, type: kind, size: dataSize, linkname, mtime: number(h, 136, 148), body: () => ((used = true), b.pieces(dataSize)) };
      yield entry;
      if (!used) await b.skip(dataSize);
      await b.skip(Math.ceil(stored / BLOCK) * BLOCK - dataSize);
    }
  } catch (e) {
    // A damaged gzip (zlib's words), or a file that cannot be read: refused in words, as the system tar's path does.
    throw e.status ? e : refuse(`it is damaged or not a tar archive (${String(e.message || e).slice(0, 120)})`);
  } finally {
    if (stream !== src) stream.destroy(); // the gunzip stream, which the file stream's end does not end
    src.destroy();
  }
}

// A character Windows keeps out of a name (":" would also write into a stream of the file), or a control character.
const BAD = /[<>:"|?*\x00-\x1f]/;
// Windows' device names, with or without an ending (blanks before it too): a file of such a name cannot be used there.
const DEVICE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)\s*(\..*)?$/i;
const key = (n) => n.replace(/^(\.\/)+/, '').replace(/[\\/]+$/, '').split(/[\\/]/).map((p) => p.replace(/[. ]+$/, '').toLowerCase()).join('/');

/**
 * Pass one: every entry of the archive, nothing written. → [{ name, type, size }] (a folder's name ends with "/").
 * Throws, in words, for a damaged or cut-off archive and (`windows`, the default) for a name Windows cannot hold.
 */
export async function listTar(file, { max = Infinity, nameMax = 4096, namesMax = 8 << 20, ms = 120_000, specialMax, windows = true } = {}) {
  const out = [];
  const seen = new Map();
  let bytes = 0;
  for await (const e of walk(file, { ms, specialMax })) {
    // Limits while it lists, as the system tar's listing has them (8 MB of output): never all names in memory first.
    if (out.length >= max) throw refuse(`it holds more than ${max} entries`);
    const size = Buffer.byteLength(e.name);
    if (size > nameMax) throw refuse(`a name in it is longer than ${nameMax} bytes`);
    bytes += size;
    if (bytes > namesMax) throw refuse(`its names together are longer than ${namesMax >> 20} MB`);
    const name = e.type === '5' && !e.name.endsWith('/') ? `${e.name}/` : e.name;
    if (!windows) {
      out.push({ name, type: e.type, size: e.size, linkname: e.linkname });
      continue;
    }
    if (!name.replace(/[\\/]+$/, '')) throw refuse('an entry in it has no name');
    if (!['0', '7', '5', '1', '2'].includes(e.type)) throw refuse(`"${name.slice(0, 80)}" is neither a file, a folder nor a link`);
    const parts = name.replace(/[\\/]+$/, '').split(/[\\/]/);
    if (parts.some((p) => BAD.test(p))) throw refuse(`"${name.slice(0, 80)}" has a character Windows does not allow in a name`);
    // Written through \\?\ paths, such names would become entries Explorer and cmd cannot open, rename or delete.
    if (parts.some((p) => p !== '.' && p !== '..' && /[. ]$/.test(p))) throw refuse(`"${name.slice(0, 80)}" has a part that ends in a dot or a blank, which Windows does not keep`);
    if (parts.some((p) => DEVICE.test(p))) throw refuse(`"${name.slice(0, 80)}" has a part that is a device name of Windows (such as CON, NUL, COM1)`);
    const k = key(name);
    const before = seen.get(k);
    if (before && !(before.type === '5' && e.type === '5')) throw refuse(`"${name.slice(0, 80)}" and "${before.name.slice(0, 80)}" would be one file on Windows (they differ only in letter case, or a trailing dot or space)`);
    seen.set(k, { name, type: e.type });
    out.push({ name, type: e.type, size: e.size, linkname: e.linkname });
  }
  return out;
}

/** A long listing line as bsdtar writes it (archive.mjs reads links and sizes from such lines). */
export const longLine = (e) => `${e.type === '5' ? 'd' : e.type === '2' ? 'l' : e.type === '1' ? 'h' : '-'}rw-r--r--  0 0 0 ${e.size} Jan  1  1970 ${e.name}${e.type === '2' ? ` -> ${e.linkname}` : e.type === '1' ? ` link to ${e.linkname}` : ''}`;

/**
 * Pass two: write the folders and files of the archive into the empty folder `into`, entry by entry as `entries`
 * (listTar) gave them; an archive that differs from that listing now stops it.
 */
export async function extractTar(file, into, entries, { ms = 10 * 60_000, specialMax } = {}) {
  const root = path.resolve(into);
  let i = 0;
  for await (const e of walk(file, { ms, specialMax })) {
    const want = entries[i++];
    const name = e.type === '5' && !e.name.endsWith('/') ? `${e.name}/` : e.name;
    if (!want || want.name !== name || want.type !== e.type || want.size !== e.size) throw new Error('the archive changed while it was unpacked');
    // Both separators, as Windows reads a name: a backslash in it is never a letter there.
    const target = path.resolve(root, ...name.replace(/[\\/]+$/, '').split(/[\\/]/));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`"${name.slice(0, 80)}" would land outside the folder`);
    if (e.type === '5') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (e.type !== '0' && e.type !== '7') throw new Error(`"${name.slice(0, 80)}" is not a file or a folder`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await pipeline(Readable.from(e.body()), fs.createWriteStream(target, { flags: 'wx' }));
    try {
      if (e.mtime > 0) fs.utimesSync(target, e.mtime, e.mtime);
    } catch {
      /* a time the disk does not take: the file keeps the time it was written at */
    }
  }
  if (i !== entries.length) throw new Error('the archive changed while it was unpacked');
}
