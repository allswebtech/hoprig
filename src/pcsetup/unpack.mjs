// Safe unpacking of a checked toolchain archive into an empty temporary folder, with the computer's own `tar` (Flutter's
// .tar.xz) and `unzip` (a .zip), started as programs with array arguments: no new dependency.
//
//   1. The archive's list of entries is read FIRST and every entry checked: under the one top folder the kit expects,
//      no absolute path, no `..`, no link whose target leaves the top folder, no hard link to outside it, nothing but
//      files, folders and links. A tar that had to strip a leading `/` or `../` from a name or a link target says so,
//      and that refuses the archive too.
//   2. Then it is unpacked into the empty folder, without the archive's owners (tar --no-same-owner; unzip -n never
//      writes over a file).
//   1b. The sizes the list gives are summed: above the kit's ceiling, or above the free space of the disk, nothing is
//      unpacked (an archive that inflates far beyond its download would fill the disk of the workspace).
//   3. The result is walked with lstat once more: every link must still point inside, and nothing else is there.
// A refusal throws a FetchError (fetchkit.mjs); the caller removes the temporary folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FetchError, sizeWords } from './fetchkit.mjs';

const LIST_LIMIT = 64 << 20;
const UNPACK_MS = 30 * 60_000;

/** Run a program (array arguments, no input): { ok, code, stdout, stderr }. Output past the limit fails it. */
export function runTool(argv, { timeout = UNPACK_MS, env = process.env, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ ok: false, code: null, stdout: '', stderr: e.message });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let over = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    // A stop ends the program at once, not when it is done (the caller removes what it wrote).
    const stop = () => child.kill('SIGTERM');
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > LIST_LIMIT) {
        over = true;
        child.kill('SIGTERM');
      } else out.push(c);
    });
    child.stderr.on('data', (c) => err.length < 200 && err.push(c));
    child.on('error', (e) => err.push(Buffer.from(e.message)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', stop);
      resolve({ ok: code === 0 && !over, code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
  });
}

/** The programs an archive of this kind needs here, missing ones named: [] when all are on PATH. */
export function missingTools(kind, sys) {
  const want = kind === 'zip' ? ['unzip'] : sys.platform === 'darwin' ? ['tar'] : ['tar', 'xz'];
  return want.filter((b) => !sys.has(b));
}

/** Does `rel` (posix, relative) stay inside the top folder `top`? */
const underTop = (rel, top) => rel === top || rel.startsWith(`${top}/`);

/** One entry's name: plain, relative, under `top`. */
function checkName(name, top) {
  const n = name.replace(/\/+$/, '');
  if (!n || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new FetchError('unpack', `the archive holds an absolute path (${name.slice(0, 200)}): refused`);
  if (n.split('/').includes('..')) throw new FetchError('unpack', `the archive holds a path with .. (${name.slice(0, 200)}): refused`);
  if (/[\0\\]/.test(n)) throw new FetchError('unpack', `the archive holds a name Hoprig does not take (${JSON.stringify(n.slice(0, 200))}): refused`);
  if (!underTop(path.posix.normalize(n), top)) throw new FetchError('unpack', `the archive holds ${n.slice(0, 200)}, outside its ${top}/ folder: refused`);
  return path.posix.normalize(n);
}

/** A link at `rel` whose `target` is relative to its own folder: it must stay under `top`. */
function checkLinkTarget(rel, target, top) {
  if (!target || target.startsWith('/')) throw new FetchError('unpack', `the archive holds a link that points outside (${rel} → ${target.slice(0, 200)}): refused`);
  const to = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
  if (to.startsWith('../') || to === '..' || !underTop(to, top)) throw new FetchError('unpack', `the archive holds a link that points outside (${rel} → ${target.slice(0, 200)}): refused`);
}

/** The names a listing gives, one per line (tar's default quoting turns a newline in a name into \n). */
const linesOf = (text) => text.split('\n').filter((l) => l !== '');

/** An entry's size in a listing line: GNU tar's "mode owner/group size …", bsdtar's "mode links owner group size …", unzip -Z's "mode version system size …". */
function sizeIn(line, kind) {
  const m = kind === 'zip' ? /^\S+\s+\S+\s+\S+\s+(\d+)\s/.exec(line) : /^\S+\s+\S+\/\S+\s+(\d+)\s/.exec(line) || /^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s/.exec(line);
  if (!m) throw new FetchError('unpack', `the size of an entry could not be read (${line.slice(0, 200)}): refused`);
  return Number(m[1]);
}

/**
 * Read and check a tar archive's entries: `tar -tf` gives the names, `tar -tvf` (the same order) the type and a link's
 * target, found after the known name (" -> target" for a link, " link to target" for a hard link).
 */
export async function checkTar(file, top, run = runTool) {
  const names = await run(['tar', '-t', '-f', file]);
  const long = await run(['tar', '-t', '-v', '-f', file]);
  if (!names.ok || !long.ok) throw new FetchError('unpack', `tar could not read the archive (${String(names.stderr || long.stderr).trim().split('\n').pop() || 'no reason given'})`);
  if (/Removing leading/i.test(`${names.stderr}\n${long.stderr}`)) throw new FetchError('unpack', 'the archive holds an absolute path or a .. in a name or a link: refused');
  const ns = linesOf(names.stdout);
  const ls = linesOf(long.stdout);
  if (!ns.length || ns.length !== ls.length) throw new FetchError('unpack', 'the archive\'s list of entries could not be read whole: refused');
  let bytes = 0;
  for (const [i, name] of ns.entries()) {
    const rel = checkName(name, top);
    const line = ls[i];
    const type = line[0];
    bytes += sizeIn(line, 'tar');
    const linkAt = line.lastIndexOf(` ${name} -> `);
    const hardAt = line.lastIndexOf(` ${name} link to `);
    if (type === 'l') {
      if (linkAt < 0) throw new FetchError('unpack', `the archive's link ${rel} could not be read: refused`);
      checkLinkTarget(rel, line.slice(linkAt + name.length + 5), top);
    } else if (type === 'h' || ((type === '-') && hardAt >= 0 && !line.endsWith(` ${name}`))) {
      if (hardAt < 0) throw new FetchError('unpack', `the archive's hard link ${rel} could not be read: refused`);
      const target = line.slice(hardAt + name.length + 10);
      if (target.startsWith('/') || target.split('/').includes('..') || !underTop(path.posix.normalize(target), top)) throw new FetchError('unpack', `the archive holds a hard link to outside (${rel} → ${target.slice(0, 200)}): refused`);
    } else if (type !== '-' && type !== 'd') {
      throw new FetchError('unpack', `the archive holds ${rel}, which is neither a file, a folder nor a link: refused`);
    } else if (!line.endsWith(` ${name}`)) {
      throw new FetchError('unpack', `the archive's entry ${rel} could not be read: refused`);
    }
  }
  return { entries: ns.length, bytes };
}

/** Escape a name for unzip's own pattern matching ([, *, ? are patterns there). */
const zipPattern = (name) => name.replace(/[[*?]/g, (c) => `[${c}]`);

/** Read and check a zip archive's entries: `unzip -Z1` the names, `unzip -Z` (the same order) the type; a link's target is its content. */
export async function checkZip(file, top, run = runTool) {
  const names = await run(['unzip', '-Z1', file]);
  const long = await run(['unzip', '-Z', file]);
  if (!names.ok || !long.ok) throw new FetchError('unpack', `unzip could not read the archive (${String(names.stderr || long.stderr).trim().split('\n').pop() || 'no reason given'})`);
  const ns = linesOf(names.stdout);
  // `unzip -Z`: two lines before the entries, one summary line after them.
  const ls = linesOf(long.stdout).slice(2, 2 + ns.length);
  if (!ns.length || ls.length !== ns.length) throw new FetchError('unpack', 'the archive\'s list of entries could not be read whole: refused');
  let bytes = 0;
  for (const [i, name] of ns.entries()) {
    const rel = checkName(name, top);
    const line = ls[i];
    if (!line.endsWith(` ${name}`)) throw new FetchError('unpack', `the archive's entry ${rel} could not be read: refused`);
    bytes += sizeIn(line, 'zip');
    if (line[0] === 'l') {
      const t = await run(['unzip', '-p', file, zipPattern(name)]);
      if (!t.ok) throw new FetchError('unpack', `the archive's link ${rel} could not be read: refused`);
      checkLinkTarget(rel, t.stdout, top);
    } else if (!['-', 'd', '?'].includes(line[0])) {
      throw new FetchError('unpack', `the archive holds ${rel}, which is neither a file, a folder nor a link: refused`);
    }
  }
  return { entries: ns.length, bytes };
}

/** The bytes free for this user on the disk that holds `dir` (null when it cannot be read). */
export function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** Walk `dir` with lstat (links never followed): every link points inside `dir`, nothing but files, folders, links. */
export function walkInside(dir) {
  const root = path.resolve(dir);
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        const t = fs.readlinkSync(p);
        const to = path.resolve(path.dirname(p), t);
        if (path.isAbsolute(t) || !(to === root || to.startsWith(root + path.sep))) throw new FetchError('unpack', `after unpacking, ${path.relative(root, p)} points outside: refused`);
      } else if (st.isDirectory()) stack.push(p);
      else if (!st.isFile()) throw new FetchError('unpack', `after unpacking, ${path.relative(root, p)} is neither a file, a folder nor a link: refused`);
    }
  }
}

/**
 * Unpack `file` (kind 'tar.xz' or 'zip') into the empty folder `into`, checked before and after: → the path of its
 * top folder `top` inside `into`. `most`: the most it may unpack to (bytes, the sum of its entries' sizes); it must
 * also fit in the free space of the disk.
 */
export async function unpackChecked(file, kind, into, top, { run = runTool, signal, most = Infinity, free = freeBytes } = {}) {
  const stopped = () => new FetchError('stopped', 'the install was stopped', 'Start it again when you want it.');
  const go = (argv) => run(argv, { signal });
  let size;
  try {
    size = (kind === 'zip' ? await checkZip(file, top, go) : await checkTar(file, top, go)).bytes;
  } catch (e) {
    throw signal && signal.aborted ? stopped() : e;
  }
  if (size > most) throw new FetchError('size', `the archive unpacks to ${sizeWords(size, false)}, more than Hoprig's ceiling of ${sizeWords(most, false)} for it: refused, nothing was unpacked`);
  const room = free(into);
  if (room !== null && size > room) throw new FetchError('size', `the archive unpacks to ${sizeWords(size, false)}, and the disk has ${sizeWords(room, false)} free: nothing was unpacked`, 'Make room on the disk, then run this again.');
  const r = kind === 'zip'
    ? await go(['unzip', '-q', '-n', file, '-d', into])
    : await go(['tar', '-x', '-f', file, '-C', into, '--no-same-owner']);
  if (signal && signal.aborted) throw stopped();
  if (!r.ok) throw new FetchError('unpack', `${kind === 'zip' ? 'unzip' : 'tar'} could not unpack it (${String(r.stderr).trim().split('\n').pop() || `exit ${r.code}`})`, 'Check that there is room on the disk, then run it again.');
  walkInside(into);
  const names = fs.readdirSync(into);
  if (names.length !== 1 || names[0] !== top || !fs.lstatSync(path.join(into, top)).isDirectory()) throw new FetchError('unpack', `the archive did not unpack into one ${top}/ folder: refused`);
  return path.join(into, top);
}
