// Files' archives, with the computer's own tar (Linux, macOS and Windows 10 and later have one; no new dependency):
// pack a selection of one folder into a .tar.gz next to it, and unpack an archive into a new folder next to it. Every
// argument is an array item, never a shell string, and names come after "--". An archive is listed before it is
// unpacked and refused when an entry would land outside the new folder (an absolute path, "..") or is a link (a link
// written first and then written through is the classic way out of the folder). A computer whose tar cannot read a
// kind of archive (GNU tar and zip) says so.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../server/platform/common.mjs';
import { freeName, pathList } from './manage.mjs';
import { checkName, fail, locate, mayChangeFolder } from './paths.mjs';

const TIMEOUT = 10 * 60_000;
export const ENTRIES_MAX = 50_000;
export const ARCHIVE = /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|zip)$/i;
// The tar of the computer, with the user's own settings (names in their language come out as they are).
const tar = (args, timeout = TIMEOUT) => run('tar', args, { timeout, env: { ...process.env } });
const noTar = (r) => /ENOENT/.test(r.stderr || '');

/**
 * Pack `paths` (all in one folder) into "<name>.tar.gz" in that folder; `name` defaults to the one item's name or
 * "Archive". Git's folders inside are left out. Returns { path }.
 */
export async function pack(paths, roots, { name } = {}) {
  const list = pathList(paths).map((p) => locate(p, roots, { mode: 'entry' }));
  const dir = path.dirname(list[0].abs);
  if (list.some((a) => path.dirname(a.abs) !== dir)) throw fail(400, 'pack things of one folder at a time');
  for (const a of list) mayChangeFolder(a.abs);
  const base = name === undefined || name === null || name === '' ? (list.length === 1 ? path.basename(list[0].abs) : 'Archive') : checkName(String(name));
  const file = freeName(dir, `${base.replace(/\.tar\.gz$/i, '')}.tar.gz`);
  const out = locate(path.join(dir, file), roots, { mode: 'new' });
  const tmp = path.join(dir, `.${file}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const r = await tar(['-czf', tmp, '--exclude=.git', '-C', dir, '--', ...list.map((a) => path.basename(a.abs))]);
  try {
    if (!r.ok) {
      if (noTar(r)) throw fail(409, 'this computer has no tar, which packing needs');
      throw fail(409, `tar could not pack it: ${clip(r.stderr)}`);
    }
    fs.linkSync(tmp, out.abs); // never over a file that appeared meanwhile
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { path: out.abs };
}

const clip = (s) => String(s || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);

/** Why the entry names `names` (tar -tf) must not be unpacked, or null. */
export function badEntries(names) {
  if (names.length > ENTRIES_MAX) return `it holds more than ${ENTRIES_MAX} entries`;
  for (const n of names) {
    if (/^([\\/]|[A-Za-z]:)/.test(n)) return `"${n.slice(0, 80)}" would land outside the folder`;
    if (n.split(/[\\/]/).includes('..')) return `"${n.slice(0, 80)}" would land outside the folder`;
  }
  return null;
}

/** Why the long listing (tar -tvf) must not be unpacked: a link (symbolic or hard), or null. */
export function linkEntries(lines) {
  const l = lines.find((x) => /^[lh]/.test(x) || / link to /.test(x));
  return l ? 'it holds links, which are not unpacked here: unpack it in a terminal' : null;
}

/** Unpack the archive at `p` into a new folder next to it, named after it. Returns { path }. */
export async function unpack(p, roots) {
  const a = locate(p, roots);
  if (!fs.statSync(a.abs).isFile() || !ARCHIVE.test(a.abs)) throw fail(400, 'that is not an archive Files unpacks (.tar, .tar.gz, .tgz, .tar.bz2, .tar.xz, .zip)');
  const names = await tar(['-tf', a.abs], 120_000);
  if (!names.ok) {
    if (noTar(names)) throw fail(409, 'this computer has no tar, which unpacking needs');
    throw fail(409, `this computer's tar cannot unpack it: ${clip(names.stderr)}`);
  }
  const list = names.stdout.split('\n').filter(Boolean);
  const long = await tar(['-tvf', a.abs], 120_000);
  const why = badEntries(list) || (long.ok ? linkEntries(long.stdout.split('\n')) : 'it could not be listed');
  if (why) throw fail(409, `it is not unpacked: ${why}`);
  const dir = path.dirname(a.abs);
  const stem = path.basename(a.abs).replace(ARCHIVE, '') || 'Archive';
  const out = locate(path.join(dir, freeName(dir, stem)), roots, { mode: 'new' });
  fs.mkdirSync(out.abs);
  const r = await tar(['--no-same-owner', '-xf', a.abs, '-C', out.abs]);
  if (!r.ok) {
    fs.rmSync(out.abs, { recursive: true, force: true });
    throw fail(409, `tar could not unpack it: ${clip(r.stderr)}`);
  }
  return { path: out.abs, entries: list.length };
}
