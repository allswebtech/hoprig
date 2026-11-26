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
import { tarCommand } from '../pcsetup/unpack.mjs';
import { extractTar, listTar, longLine } from './tarread.mjs';
import { ownPacker, plainName, writeTarGz } from './tarwrite.mjs';
import { patiently } from '../replacefile.mjs';
import { run } from '../server/platform/common.mjs';
import { clipBytes, freeName, pathList, placeNew } from './manage.mjs';
import { checkName, fail, isGitName, isPrivateName, locate, mayChangeFolderAsync } from './paths.mjs';

const TIMEOUT = 10 * 60_000;
export const ENTRIES_MAX = 50_000;
export const ARCHIVE = /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|zip)$/i;
// The tar of the computer, with the user's own settings (names in their language come out as they are). Neither it
// nor unzip ever gets the dashboard's terminal: an archive with a password would ask for it there and wait.
// On Windows the system's own tar by its full path (pcsetup/unpack.mjs tarCommand): Git for Windows' GNU tar, often
// first on PATH, reads C:\… as a remote host. Asked once.
let tarWords = null;
const tar = async (args, timeout = TIMEOUT) => {
  const opts = { timeout, env: { ...process.env }, noTerminal: true };
  tarWords ||= await tarCommand(([cmd, ...a]) => run(cmd, a, { ...opts, timeout: 20_000 }));
  return run(tarWords[0], [...tarWords.slice(1), ...args], opts);
};
const unzip = (args, timeout = TIMEOUT) => run('unzip', args, { timeout, env: { ...process.env }, noTerminal: true });
// A program's output, line by line: Windows' tar and unzip end their lines with \r\n, and a kept \r would hide a last
// part such as ".git" or a private name from badEntries.
export const linesOf = (text) => String(text || '').split(/\r?\n/);
const missing = (r) => /ENOENT/.test(r.stderr || '');
const noTar = missing;
const ZIP = /\.zip$/i;

// Windows: the system's tar (bsdtar) reads its command line in the system's code page, where a letter beyond it becomes
// "?", and it ends with an access violation (0xC0000005) on such a name it finds while it walks a folder, long or short.
// So there a name to pack, or a folder's path, with a letter outside plain ASCII is packed by Files' own writer
// (tarwrite.mjs), and the system's tar packs only plain names. An archive of such a name is unpacked through a hard
// link of plain name, into a folder of plain name that then takes its own; a place whose own path has such a letter
// is said in words (NOT_PLAIN).
const plain = plainName;
const NOT_PLAIN = 'the tar of Windows cannot be given a name with letters outside its code page';

/**
 * Windows: the words for a tar that crashed while packing (it ended by an NTSTATUS error code, 0xC0000000 and above,
 * such as 0xC0000005, an access violation, and printed nothing), or null. Names outside plain ASCII never reach that
 * tar any more (tarwrite.mjs); this is for a crash on a plain name, such as a very long one. `staged`: names to name.
 */
export function crashWords(stderr, staged = [], platform = process.platform) {
  const m = /\(exit code (\d+)\)$/.exec(String(stderr || '').trim());
  if (platform !== 'win32' || !m || Number(m[1]) < 0xC0000000) return null;
  const which = staged.length === 1 ? ` ("${staged[0]}")` : '';
  return `it is not packed: Windows' own tar stopped on a file name it cannot handle${which}: one that is very long, or has letters outside the system's code page. Nothing was packed; rename the file with a shorter or plainer name, or pack it with another program`;
}

/** A hard link of `from` at `to`, or a copy where the disk has no hard links. */
function linkOrCopy(from, to) {
  try {
    fs.linkSync(from, to);
  } catch {
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
}

/** tar's words for packing the entries `names` of folder `dir` into `tmp` (names after "--", git's folders left out). */
export function packWords(dir, names, tmp) {
  return { args: ['-czf', tmp, '--exclude=.git', '-C', dir, '--', ...names] };
}

/**
 * Pack `paths` (all in one folder) into "<name>.tar.gz" in that folder; `name` defaults to the one item's name or
 * "Archive". Git's folders inside are left out. Returns { path }. `platform`: for the tests.
 */
export async function pack(paths, roots, { name, platform = process.platform } = {}) {
  const list = pathList(paths).map((p) => locate(p, roots, { mode: 'entry' }));
  const dir = path.dirname(list[0].abs);
  if (list.some((a) => path.dirname(a.abs) !== dir)) throw fail(400, 'pack things of one folder at a time');
  for (const a of list) await mayChangeFolderAsync(a.abs);
  const base = name === undefined || name === null || name === '' ? (list.length === 1 ? path.basename(list[0].abs) : 'Archive') : checkName(String(name));
  // "<name>.tar.gz" stays within the disk's 255 bytes. Its temporary name, which tar is given, holds no letter of the
  // person's name: the tar of Windows reads its arguments in the system's code page, where a letter beyond it becomes
  // "?" and the file cannot be made. The person's name comes back with the move into place (placeNew).
  const file = freeName(dir, `${clipBytes(base.replace(/\.tar\.gz$/i, ''), 200)}.tar.gz`);
  const out = locate(path.join(dir, file), roots, { mode: 'new', typed: false });
  const tmp = path.join(dir, `.hoprig-pack.${crypto.randomBytes(8).toString('hex')}.tar.gz.tmp`);
  const names = list.map((a) => path.basename(a.abs));
  let own;
  try {
    own = await ownPacker(dir, names, { platform });
  } catch (e) {
    throw fail(409, `it is not packed: ${e.message}`); // a folder or link that cannot be read, in the same words
  }
  if (own) {
    try {
      await writeTarGz(dir, names, tmp, { platform });
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e.status ? e : fail(409, `it is not packed: ${e.message}`);
    }
  } else {
    const r = await tar(packWords(dir, names, tmp).args);
    if (!r.ok) {
      fs.rmSync(tmp, { force: true });
      if (noTar(r)) throw fail(409, 'this computer has no tar, which packing needs');
      const why = crashWords(r.stderr, names.length === 1 ? names : [], platform);
      if (why) throw fail(409, why);
      throw fail(409, `tar could not pack it: ${clip(r.stderr)}`);
    }
  }
  placeNew(tmp, out.abs); // never over a file that appeared meanwhile
  return { path: out.abs };
}

const mb = (n) => `${Math.ceil(n / 1048576)} MB`;
// The last two lines, at most 300 characters: a long one keeps its end, where the reason is ("Command failed: <the
// whole command line> (exit code 1)").
const clip = (s) => {
  const t = linesOf(String(s || '').trim()).slice(-2).join(' ');
  return t.length > 300 ? `…${t.slice(-299)}` : t;
};

// Spellings that reach git's folder or a private one on Windows although they are not its name: Windows drops dots
// and blanks at the end of a name (".git." is ".git"), reads what stands behind a colon as a stream of the file before
// it (".git::$INDEX_ALLOCATION" is the folder), and may know ".git" by a short name too ("GIT~1").
const winPart = (x) => String(x).replace(/:.*$/s, '').replace(/[. ]+$/, '');
const WIN_SHORT_GIT = /^git~\d+$/i;

/** Why the entry names `names` (tar -tf) must not be unpacked, or null. `platform`: Windows' other spellings too. */
export function badEntries(names, platform = process.platform) {
  const win = platform === 'win32';
  if (names.length > ENTRIES_MAX) return `it holds more than ${ENTRIES_MAX} entries`;
  for (const n of names) {
    if (/^([\\/]|[A-Za-z]:)/.test(n)) return `"${n.slice(0, 80)}" would land outside the folder`;
    const parts = n.split(/[\\/]/);
    if (parts.includes('..')) return `"${n.slice(0, 80)}" would land outside the folder`;
    if (parts.some((x) => isGitName(x))) return `"${n.slice(0, 80)}" is in git's own folder, whose settings can run programs`;
    if (parts.some((x) => isPrivateName(x))) return `"${n.slice(0, 80)}" is in a private folder, which Files never writes`;
    if (win && parts.some((x) => isGitName(winPart(x), true) || WIN_SHORT_GIT.test(winPart(x)))) return `"${n.slice(0, 80)}" is a name Windows reads as git's own folder, whose settings can run programs`;
    if (win && parts.some((x) => isPrivateName(winPart(x), true))) return `"${n.slice(0, 80)}" is a name Windows reads as a private folder, which Files never writes`;
  }
  return null;
}

/** Why the long listing (tar -tvf) must not be unpacked: a link (symbolic or hard), or null. */
export function linkEntries(lines) {
  const l = lines.find((x) => /^[lh]/.test(x) || / link to /.test(x));
  return l ? 'it holds links, which are not unpacked here: unpack it in a terminal' : null;
}

/**
 * The bytes an archive unpacks to, from its long listing (zipinfo -Z, GNU tar -tvf, bsdtar -tvf), or null when the
 * listing has no size this reads.
 */
export function listedBytes(lines) {
  const SIZE = [
    /^\S+\s+\S+\s+\S+\s+(\d+)\s+[tbTB][xX-]?\s/, // zipinfo: mode, version, system, size, text/binary
    /^\S+\s+\S+\s+(\d+)\s+\d{4}-\d\d-\d\d\s/, // GNU tar: mode, owner/group, size, date
    /^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+[A-Z][a-z]{2}\s/, // bsdtar: mode, links, owner, group, size, month
  ];
  let total = 0;
  let found = false;
  for (const l of lines) {
    const m = SIZE.map((re) => re.exec(l)).find(Boolean);
    if (!m) continue;
    found = true;
    total += Number(m[1]);
  }
  return found ? total : null;
}

/** The bytes free for this user on the disk of `dir`, or null where the computer does not say. */
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
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

/**
 * Windows: whether an archive's listing (`listing`, the system tar's -tf answer) shows names that tar cannot give: it
 * failed with "empty or unreadable filename" → 'own' (a .tar, .tar.gz or .tgz: Files' own reader, tarread.mjs) or
 * 'words' (another kind: said in words); or it gave a name with "?", which is either a real "?" (an archive from Linux
 * or macOS) or a letter outside the system's code page as that tar writes it → 'check' (a .tar, .tar.gz or .tgz: the
 * own reader lists it too, headers only, and is used only when its names differ: sameListing). null: as before, also
 * on every other system.
 */
export function ownWanted(archive, listing, platform = process.platform) {
  if (platform !== 'win32' || !listing) return null;
  const tarKind = /\.(tar|tar\.gz|tgz)$/i.test(archive);
  if (listing.ok) return tarKind && linesOf(listing.stdout).some((n) => n.includes('?')) ? 'check' : null;
  if (!/empty or unreadable filename/i.test(String(listing.stderr || ''))) return null;
  return tarKind ? 'own' : 'words';
}

/** Whether the system tar's listing (its -tf output) names exactly the entries Files' own reader read (`names`). */
export function sameListing(stdout, names) {
  const strip = (n) => n.replace(/\/+$/, '');
  const theirs = linesOf(stdout).filter(Boolean).map(strip);
  return theirs.length === names.length && theirs.every((n, i) => n === strip(names[i]));
}

/**
 * Files' own reader of a .tar, .tar.gz or .tgz in the same form as reader()'s (tarread.mjs). `limits`: { listMs,
 * extractMs, specialMax } (the tests give short ones); the listing ends at 120 s as the system tar's, the unpacking
 * at 10 minutes.
 */
function ownReader(file, limits = {}) {
  let entries = null;
  return {
    tool: 'tar',
    list: async () => {
      entries = await listTar(file, { max: ENTRIES_MAX, ms: limits.listMs ?? 120_000, specialMax: limits.specialMax });
      return { ok: true, stdout: entries.map((e) => e.name).join('\n'), stderr: '' };
    },
    long: async () => ({ ok: true, stdout: entries.map(longLine).join('\n'), stderr: '' }),
    extract: async (into) => {
      try {
        await extractTar(file, into, entries, { ms: limits.extractMs ?? TIMEOUT, specialMax: limits.specialMax });
        return { ok: true, stdout: '', stderr: '' };
      } catch (e) {
        return { ok: false, stdout: '', stderr: e.message, words: e.status ? e.message : null }; // its own words as they are
      }
    },
  };
}

/**
 * Unpack the archive at `p` into a new folder next to it, named after it. Returns { path, entries }. `platform`: for
 * the tests. On Windows an archive whose name has a letter outside plain ASCII is read through a hard link of plain
 * name, into a folder of plain name that then takes the archive's own (see NOT_PLAIN).
 */
export async function unpack(p, roots, { platform = process.platform, own = false, ownLimits = {} } = {}) {
  const a = locate(p, roots);
  if (!fs.statSync(a.abs).isFile() || !ARCHIVE.test(a.abs)) throw fail(400, 'that is not an archive Files unpacks (.tar, .tar.gz, .tgz, .tar.bz2, .tar.xz, .zip)');
  const odd = platform === 'win32' && !plain(path.basename(a.abs));
  if (odd && !plain(path.dirname(a.abs))) throw fail(409, `it is not unpacked: ${NOT_PLAIN}, and the path of this folder has one (${path.dirname(a.abs)})`);
  const hex = crypto.randomBytes(8).toString('hex');
  const via = odd ? path.join(path.dirname(a.abs), `.hoprig-unpack.${hex}${ARCHIVE.exec(a.abs)[0].toLowerCase()}`) : null;
  if (via) linkOrCopy(a.abs, via);
  try {
    return await unpackFrom(a, via || a.abs, roots, odd ? path.join(path.dirname(a.abs), `.hoprig-unpack.${hex}.d`) : null, { platform, own, ownLimits });
  } finally {
    // Best effort: a link that is held a moment by another program must not turn a finished unpack into an error.
    try {
      if (via) patiently(() => fs.rmSync(via, { force: true }), platform);
    } catch {
      /* left behind: a link of a plain name beside the archive, no copy of its bytes */
    }
  }
}

// `file`: the archive tar is given (a.abs, or its link of plain name); `into`: a folder of plain name to unpack into
// first, then moved to the archive's own name (null: unpacked there at once). `own`: Files' own reader at once (the
// tests); else on Windows when the system tar cannot name its entries (ownWanted). Every check below is the same.
async function unpackFrom(a, file, roots, into, { platform = process.platform, own = false, ownLimits = {} } = {}) {
  let rd = own ? ownReader(file, ownLimits) : await reader(file);
  let names = await rd.list();
  const want = own ? null : ownWanted(a.abs, names, platform);
  if (want === 'words') throw fail(409, 'it is not unpacked: Windows\' own tar cannot read the names in this archive (letters outside the system\'s code page); Files unpacks such names from a .tar.gz, .tgz or .tar');
  let differs = false;
  if (want === 'check') {
    try {
      differs = !sameListing(names.stdout, (await listTar(file, { max: ENTRIES_MAX, ms: ownLimits.listMs ?? 120_000, specialMax: ownLimits.specialMax, windows: false })).map((e) => e.name));
    } catch {
      differs = false; // the extra listing refused it: the system tar, as before, checked on its own listing below
    }
  }
  if (want === 'own' || differs) {
    rd = ownReader(file, ownLimits);
    names = await rd.list();
  }
  if (!names.ok) {
    if (missing(names)) throw fail(409, `this computer has no ${rd.tool}, which unpacking needs`);
    const hint = ZIP.test(a.abs) && rd.tool === 'tar' ? ' (installing unzip lets Files unpack .zip files)' : '';
    throw fail(409, `this computer's ${rd.tool} cannot unpack it${hint}: ${clip(names.stderr)}`);
  }
  const list = linesOf(names.stdout).filter(Boolean);
  const long = await rd.long();
  const lines = long.ok ? linesOf(long.stdout) : null;
  const why = badEntries(list, platform) || (lines ? linkEntries(lines) || (rd.locked && rd.locked(lines)) : 'it could not be listed');
  if (why) throw fail(409, `it is not unpacked: ${why}`);
  const dir = path.dirname(a.abs);
  // An archive that unpacks to more than the disk has free is refused before it fills the disk.
  const need = listedBytes(lines);
  const free = freeBytes(dir);
  if (need !== null && free !== null && need > free) throw fail(409, `it is not unpacked: it holds ${mb(need)} and the disk has ${mb(free)} free`, { code: 'disk-full' });
  const stem = path.basename(a.abs).replace(ARCHIVE, '') || 'Archive';
  const out = locate(path.join(dir, freeName(dir, stem)), roots, { mode: 'new', typed: false });
  const at = into || out.abs;
  fs.mkdirSync(at);
  const r = await rd.extract(at);
  if (!r.ok) {
    fs.rmSync(at, { recursive: true, force: true });
    throw fail(409, r.words || `${rd.tool} could not unpack it: ${clip(r.stderr)}`);
  }
  if (into) {
    // Right after many files are written, a scanner or the indexer of Windows may still hold one: the move is tried
    // again for a while there (patiently), and a folder that cannot be moved is removed with retries.
    try {
      patiently(() => fs.renameSync(into, out.abs), platform);
    } catch (e) {
      let left = '';
      try {
        patiently(() => fs.rmSync(into, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), platform);
      } catch {
        left = `; ${into} is left behind and can be removed`;
      }
      throw fail(409, `it could not be put in place: ${e.message}${left}`);
    }
  }
  return { path: out.abs, entries: list.length };
}
