// Files' archives, with the computer's own tar (Linux, macOS and Windows 10 and later have one; no new dependency):
// pack a selection of one folder into a .tar.gz next to it, and unpack an archive into a new folder next to it. Every
// argument is an array item, never a shell string, and names come after "--". An archive is listed before it is
// unpacked and refused when an entry would land outside the new folder (an absolute path, ".."), is a link (a link
// written first and then written through is the classic way out of the folder), or lies in git's folder or a private
// one: a downloaded archive must not bring a .git whose settings run a program when git looks at the folder, and
// nothing in Files writes where it never shows. A .zip is read with unzip where the computer has it (GNU tar cannot
// read zip; the tar of macOS and Windows can); a computer with neither says so.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../server/platform/common.mjs';
import { clipBytes, freeName, pathList, placeNew } from './manage.mjs';
import { checkName, fail, isGitName, isPrivateName, locate, mayChangeFolder } from './paths.mjs';

const TIMEOUT = 10 * 60_000;
export const ENTRIES_MAX = 50_000;
export const ARCHIVE = /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|zip)$/i;
// The tar of the computer, with the user's own settings (names in their language come out as they are). Neither it
// nor unzip ever gets the dashboard's terminal: an archive with a password would ask for it there and wait.
const tar = (args, timeout = TIMEOUT) => run('tar', args, { timeout, env: { ...process.env }, noTerminal: true });
const unzip = (args, timeout = TIMEOUT) => run('unzip', args, { timeout, env: { ...process.env }, noTerminal: true });
const missing = (r) => /ENOENT/.test(r.stderr || '');
const noTar = missing;
const ZIP = /\.zip$/i;

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
  // "<name>.tar.gz" and its temporary ".<name>.tar.gz.<8 hex>.tmp" stay within the disk's 255 bytes.
  const file = freeName(dir, `${clipBytes(base.replace(/\.tar\.gz$/i, ''), 200)}.tar.gz`);
  const out = locate(path.join(dir, file), roots, { mode: 'new', typed: false });
  const tmp = path.join(dir, `.${file}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const r = await tar(['-czf', tmp, '--exclude=.git', '-C', dir, '--', ...list.map((a) => path.basename(a.abs))]);
  if (!r.ok) {
    fs.rmSync(tmp, { force: true });
    if (noTar(r)) throw fail(409, 'this computer has no tar, which packing needs');
    throw fail(409, `tar could not pack it: ${clip(r.stderr)}`);
  }
  placeNew(tmp, out.abs); // never over a file that appeared meanwhile
  return { path: out.abs };
}

const clip = (s) => String(s || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);

/** Why the entry names `names` (tar -tf) must not be unpacked, or null. */
export function badEntries(names) {
  if (names.length > ENTRIES_MAX) return `it holds more than ${ENTRIES_MAX} entries`;
  for (const n of names) {
    if (/^([\\/]|[A-Za-z]:)/.test(n)) return `"${n.slice(0, 80)}" would land outside the folder`;
    const parts = n.split(/[\\/]/);
    if (parts.includes('..')) return `"${n.slice(0, 80)}" would land outside the folder`;
    if (parts.some((x) => isGitName(x))) return `"${n.slice(0, 80)}" is in git's own folder, whose settings can run programs`;
    if (parts.some((x) => isPrivateName(x))) return `"${n.slice(0, 80)}" is in a private folder, which Files never writes`;
  }
  return null;
}

/** Why the long listing (tar -tvf) must not be unpacked: a link (symbolic or hard), or null. */
export function linkEntries(lines) {
  const l = lines.find((x) => /^[lh]/.test(x) || / link to /.test(x));
  return l ? 'it holds links, which are not unpacked here: unpack it in a terminal' : null;
}

/**
 * Why zipinfo's long listing (unzip -Z) must not be unpacked: an entry with a password, or null. Its fifth column is
 * "t" (text) or "b" (binary), in capitals when the entry is encrypted.
 */
export function lockedEntries(lines) {
  const l = lines.find((x) => /^\S+\s+\S+\s+\S+\s+\d+\s+[TB][xX-]?\s/.test(x));
  return l ? 'it is protected by a password, which Files does not ask for: unpack it in a terminal' : null;
}

/**
 * The program that reads archive `file`: { list(), long(), extract(into) }, each → run()'s { ok, stdout, stderr }.
 * A .zip: unzip where it is installed (zipinfo's long lines start with the mode, "l" for a link), else tar. The
 * archive's path is absolute, so it is never read as an option.
 */
async function reader(file) {
  if (ZIP.test(file)) {
    const probe = await unzip(['-Z1', file], 120_000);
    if (!missing(probe)) {
      return {
        tool: 'unzip',
        list: async () => probe,
        long: () => unzip(['-Z', file], 120_000),
        locked: lockedEntries,
        // -n: never over a file; -P '': an entry with a password fails at once, it is never asked for.
        extract: (into) => unzip(['-q', '-n', '-P', '', file, '-d', into]),
      };
    }
  }
  return {
    tool: 'tar',
    list: () => tar(['-tf', file], 120_000),
    long: () => tar(['-tvf', file], 120_000),
    extract: (into) => tar(['--no-same-owner', '-xf', file, '-C', into]),
  };
}

/** Unpack the archive at `p` into a new folder next to it, named after it. Returns { path, entries }. */
export async function unpack(p, roots) {
  const a = locate(p, roots);
  if (!fs.statSync(a.abs).isFile() || !ARCHIVE.test(a.abs)) throw fail(400, 'that is not an archive Files unpacks (.tar, .tar.gz, .tgz, .tar.bz2, .tar.xz, .zip)');
  const rd = await reader(a.abs);
  const names = await rd.list();
  if (!names.ok) {
    if (missing(names)) throw fail(409, `this computer has no ${rd.tool}, which unpacking needs`);
    const hint = ZIP.test(a.abs) && rd.tool === 'tar' ? ' (installing unzip lets Files unpack .zip files)' : '';
    throw fail(409, `this computer's ${rd.tool} cannot unpack it${hint}: ${clip(names.stderr)}`);
  }
  const list = names.stdout.split('\n').filter(Boolean);
  const long = await rd.long();
  const lines = long.ok ? long.stdout.split('\n') : null;
  const why = badEntries(list) || (lines ? linkEntries(lines) || (rd.locked && rd.locked(lines)) : 'it could not be listed');
  if (why) throw fail(409, `it is not unpacked: ${why}`);
  const dir = path.dirname(a.abs);
  const stem = path.basename(a.abs).replace(ARCHIVE, '') || 'Archive';
  const out = locate(path.join(dir, freeName(dir, stem)), roots, { mode: 'new', typed: false });
  fs.mkdirSync(out.abs);
  const r = await rd.extract(out.abs);
  if (!r.ok) {
    fs.rmSync(out.abs, { recursive: true, force: true });
    throw fail(409, `${rd.tool} could not unpack it: ${clip(r.stderr)}`);
  }
  return { path: out.abs, entries: list.length };
}
