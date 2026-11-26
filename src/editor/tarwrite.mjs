// Files' own tar.gz writer, for Windows only: the system's tar (bsdtar) ends with an access violation (0xC0000005) on a
// name with letters outside the system's code page, long or short, whether it is given the name or finds it while it
// walks a folder. archive.mjs uses this writer there only when a name to pack, or a part of the folder's own path, is
// outside plain ASCII; everything else goes through the system's tar as before.
//
// It writes what that tar writes for Files: ustar entries, a pax `path` (or `linkpath`, `size`) record before an entry
// whose name is not plain ASCII, is longer than ustar holds, or whose size is past ustar's 8 GB, all through gzip.
// Folders are walked in name order, a link is written as a link (never followed, as tar keeps it without -h), a file
// or folder named ".git" is left out (tar's --exclude=.git), and anything else (a device, a pipe, a socket) is refused
// by name. A file is streamed, never held in memory; one that changes size while it is read stops the pack.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { fail } from './paths.mjs';

const BLOCK = 512;
const USTAR_SIZE_MAX = 0o77777777777;
const ZEROS = Buffer.alloc(BLOCK);

/** Printable ASCII only: what Windows' tar is safe with. */
export const plainName = (s) => /^[\x20-\x7e]*$/.test(s);

/** A field of `width` bytes: octal digits, then NUL. */
const octal = (n, width) => `${Math.floor(n).toString(8).padStart(width - 1, '0')}\0`;

/** One pax record: "<length> <key>=<value>\n", the length counting itself. */
export function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const base = Buffer.byteLength(body);
  let len = base + String(base).length;
  if (String(len).length !== String(base).length) len = base + String(len).length;
  return `${len}${body}`;
}

/** A name for ustar's own field: plain ASCII, at most `max` bytes (the pax record carries the whole one). */
const fallback = (s, max) => s.replace(/[^\x20-\x7e]/g, '_').slice(0, max);
const fits = (s, max) => plainName(s) && Buffer.byteLength(s) <= max;

/** One ustar header block. */
export function ustarHeader({ name, mode = 0o644, size = 0, mtime = 0, type = '0', linkname = '' }) {
  const b = Buffer.alloc(BLOCK);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(mode & 0o7777, 8), 100, 'ascii');
  b.write(octal(0, 8), 108, 'ascii');
  b.write(octal(0, 8), 116, 'ascii');
  b.write(octal(size, 12), 124, 'ascii');
  b.write(octal(mtime, 12), 136, 'ascii');
  b.fill(0x20, 148, 156); // the checksum counts its own field as spaces
  b.write(type, 156, 'ascii');
  b.write(linkname, 157, 100, 'utf8');
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  let sum = 0;
  for (const x of b) sum += x;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return b;
}

const pad = (n) => (n % BLOCK ? Buffer.alloc(BLOCK - (n % BLOCK)) : null);

/** The blocks that start an entry: a pax header first when ustar cannot hold its name, link or size. */
function entryHead(e, n) {
  const recs = [];
  if (!fits(e.name, 100)) recs.push(paxRecord('path', e.name));
  if (e.linkname && !fits(e.linkname, 100)) recs.push(paxRecord('linkpath', e.linkname));
  if (e.size > USTAR_SIZE_MAX) recs.push(paxRecord('size', String(e.size)));
  const head = ustarHeader({ ...e, name: fits(e.name, 100) ? e.name : fallback(e.name, 100), linkname: e.linkname && !fits(e.linkname, 100) ? fallback(e.linkname, 100) : e.linkname, size: e.size > USTAR_SIZE_MAX ? 0 : e.size });
  if (!recs.length) return [head];
  const data = Buffer.from(recs.join(''), 'utf8');
  return [ustarHeader({ name: `PaxHeader/${n}`, mode: 0o644, size: data.length, mtime: e.mtime, type: 'x' }), data, pad(data.length), head].filter(Boolean);
}

/**
 * Every block of the archive of `names` (entries of folder `dir`), as Buffers, file data read as it is written.
 * `platform`: a link's target is written with "/" on Windows, as tar writes it.
 */
async function* blocks(dir, names, platform) {
  let n = 0;
  async function* walk(rel) {
    if (rel.split('/').pop() === '.git') return; // tar's --exclude=.git
    const abs = path.join(dir, ...rel.split('/'));
    const st = fs.lstatSync(abs);
    const mtime = Math.max(0, Math.floor(st.mtimeMs / 1000)); // a time before 1970 is written as 1970: ustar has no sign
    // Windows gives a folder no execute bits (0o666), which on Linux or macOS no one could enter: there a folder is
    // written as 0755 and a file as 0644, or 0444 when it is read-only, as Windows' own tar writes them.
    const mode = platform === 'win32' ? (st.isDirectory() ? 0o755 : st.isSymbolicLink() ? 0o777 : st.mode & 0o200 ? 0o644 : 0o444) : st.mode & 0o7777;
    n += 1;
    if (st.isSymbolicLink()) {
      const to = fs.readlinkSync(abs);
      yield* entryHead({ name: rel, mode: mode || 0o777, mtime, type: '2', linkname: platform === 'win32' ? to.replaceAll('\\', '/') : to }, n);
    } else if (st.isDirectory()) {
      yield* entryHead({ name: `${rel}/`, mode: mode || 0o755, mtime, type: '5' }, n);
      for (const c of fs.readdirSync(abs).sort()) yield* walk(`${rel}/${c}`);
    } else if (st.isFile()) {
      yield* entryHead({ name: rel, mode: mode || 0o644, size: st.size, mtime, type: '0' }, n);
      let got = 0;
      if (st.size > 0) {
        for await (const chunk of fs.createReadStream(abs, { start: 0, end: st.size - 1 })) {
          got += chunk.length;
          yield chunk;
        }
      }
      if (got !== st.size) throw fail(409, `it is not packed: "${rel}" changed while it was packed; pack it again`);
      const p = pad(st.size);
      if (p) yield p;
    } else {
      throw fail(409, `it is not packed: "${rel}" is neither a file, a folder nor a link`);
    }
  }
  for (const name of names) yield* walk(name);
  yield ZEROS;
  yield ZEROS;
}

/** Pack `names` (entries of folder `dir`) into the new file `out`, a .tar.gz, streamed. */
export async function writeTarGz(dir, names, out, { platform = process.platform } = {}) {
  await pipeline(Readable.from(blocks(dir, names, platform)), zlib.createGzip(), fs.createWriteStream(out, { flags: 'wx' }));
}

/**
 * Windows only: whether `names` of folder `dir` go through this writer (true when the folder's own path, or any name
 * under them or a link's target, has a letter outside plain ASCII; folders are walked, links not followed, ".git" left
 * out as tar does). Asynchronous, so the dashboard keeps answering while a large tree is walked; it stops at the first
 * such name. A folder or link that cannot be read throws. Elsewhere, and for plain names, false: the system's tar packs
 * them as before.
 */
export async function ownPacker(dir, names, { platform = process.platform } = {}) {
  if (platform !== 'win32') return false;
  if (!plainName(dir)) return true;
  const folders = [];
  const links = [];
  for (const n of names) {
    if (n === '.git') continue;
    if (!plainName(n)) return true;
    let st;
    try {
      st = await fs.promises.lstat(path.join(dir, n));
    } catch {
      continue; // gone meanwhile: the pack says so
    }
    if (st.isSymbolicLink()) links.push(path.join(dir, n));
    else if (st.isDirectory()) folders.push(path.join(dir, n));
  }
  for (;;) {
    const link = links.pop();
    if (link !== undefined) {
      if (!plainName(await fs.promises.readlink(link))) return true;
      continue;
    }
    const folder = folders.pop();
    if (folder === undefined) return false;
    for (const d of await fs.promises.readdir(folder, { withFileTypes: true })) {
      if (d.name === '.git') continue;
      if (!plainName(d.name)) return true;
      if (d.isSymbolicLink()) links.push(path.join(folder, d.name));
      else if (d.isDirectory()) folders.push(path.join(folder, d.name));
    }
  }
}
