// Tiny archives for the unpack and download tests, written byte by byte so that a test can hold any entry a hostile
// archive could (an absolute name, a `..`, a link or a hard link out) without a tool that would refuse to make it.
//   tarOf([{ name, type: 'file' | 'dir' | 'link' | 'hard', data?, link? }]) → Buffer (plain ustar)
//   zipOf([{ name, type: 'file' | 'dir' | 'link', data?, link? }]) → Buffer (stored, no compression)
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const TYPE = { file: '0', hard: '1', link: '2', dir: '5' };

function header(e) {
  const h = Buffer.alloc(512);
  const put = (s, at, len) => h.write(String(s), at, len, 'utf8');
  const oct = (n, len) => `${n.toString(8).padStart(len - 1, '0')}\0`;
  const data = e.type === 'file' ? Buffer.from(e.data || '') : Buffer.alloc(0);
  put(e.name, 0, 100);
  put(oct(e.type === 'dir' ? 0o755 : e.mode || 0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(data.length, 12), 124, 12);
  put(oct(0, 12), 136, 12);
  put('        ', 148, 8);
  put(TYPE[e.type], 156, 1);
  put(e.link || '', 157, 100);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return { h, data };
}

export function tarOf(entries) {
  const parts = [];
  for (const e of entries) {
    const { h, data } = header(e);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** The same archive compressed with the computer's own xz (Flutter's archives are .tar.xz). */
export const tarXzOf = (entries) => execFileSync('xz', ['-z', '-c'], { input: tarOf(entries) });

export function zipOf(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.type === 'dir' && !e.name.endsWith('/') ? `${e.name}/` : e.name);
    const data = e.type === 'link' ? Buffer.from(e.link) : Buffer.from(e.data || '');
    const crc = zlib.crc32(data);
    const mode = e.type === 'link' ? 0o120777 : e.type === 'dir' ? 0o40755 : e.mode || 0o100644;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4); // made on Unix: the mode below is read
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((mode << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    local.push(lh, name, data);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
