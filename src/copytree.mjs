// Copies a person's folder tree (or one file or link) by the names' BYTES. Every path is a Buffer, so a name that is
// not UTF-8 is copied on every supported Node: fs.cpSync of Node 22.11 turns such a name into another one and then
// fails on it (ENOENT). It does what Hoprig's copy with fs.cpSync({ recursive, preserveTimestamps, verbatimSymlinks,
// errorOnExist, force: false }) did:
//  - a file: its content, its mode, and (with `times`) its access and modification time, set to the precision Node
//    gives (a floating-point number of seconds);
//  - a folder: its content first, then (with `times`) its times, then its mode, so a read-only folder is copied whole
//    and is read-only afterwards;
//  - a symbolic link: a link with the same target bytes, never followed (a link to a folder is not walked);
//  - an entry that is none of these (a socket, a pipe): not copied, as fs.cpSync of Node 26 does (that of Node 22.11
//    stopped the whole copy on one with an internal error);
//  - a destination that is there already, a folder too: refused with ERR_FS_CP_EEXIST, never overwritten or merged
//    into (as fs.cpSync with errorOnExist does from Node 22.22.1, nodejs/node#60946; that of 22.11 copied into a
//    folder). An error in the middle is thrown as it comes; what was copied until then stays, for the caller.
// Not kept, as fs.cpSync did not keep them: hard links (each name becomes a file of its own), owners, extended
// attributes, holes in a file, a link's own times. A device file is read as a file, as fs.cpSync read it.
import fs from 'node:fs';
import path from 'node:path';

const SEP = Buffer.from(path.sep);
const bytes = (p) => (Buffer.isBuffer(p) ? p : Buffer.from(String(p)));
const shown = (b) => b.toString('utf8');

function cpError(code, message, dest) {
  return Object.assign(new Error(message), { code, syscall: 'cp', path: shown(dest) });
}
const taken = (dest) => cpError('ERR_FS_CP_EEXIST', `Target already exists: cp returned EEXIST (${shown(dest)} already exists)`, dest);

/**
 * Copy `from` to `to` (strings or Buffers). `times: false` leaves the copy's times as the copy made them. `skip`: a Set
 * of folders below `from` (absolute paths, as strings) that are not copied.
 */
export function copyTree(from, to, { times = true, skip = null } = {}) {
  const src = bytes(from);
  const dest = bytes(to);
  // A copy into itself would never end.
  if (dest.equals(src) || (dest.length > src.length && dest.subarray(0, src.length + SEP.length).equals(Buffer.concat([src, SEP])))) {
    throw cpError('ERR_FS_CP_EINVAL', `cannot copy ${shown(src)} to a subdirectory of self ${shown(dest)}`, dest);
  }
  copyEntry(src, dest, times, skip && skip.size ? skip : null);
}

function setTimes(src, dest) {
  // Read again now: reading the file for its copy changed its access time.
  const now = fs.lstatSync(src);
  fs.utimesSync(dest, now.atimeMs / 1000, now.mtimeMs / 1000);
}

function copyEntry(src, dest, times, skip) {
  const st = fs.lstatSync(src);
  const special = !st.isDirectory() && !st.isSymbolicLink() && !st.isFile() && !st.isCharacterDevice() && !st.isBlockDevice();
  if (special) return; // a socket or a pipe: not copied
  if (fs.lstatSync(dest, { throwIfNoEntry: false })) throw taken(dest);
  if (st.isDirectory()) {
    fs.mkdirSync(dest);
    for (const name of fs.readdirSync(src, { encoding: 'buffer' })) {
      const from = Buffer.concat([src, SEP, name]);
      if (skip && skip.has(shown(from)) && fs.lstatSync(from).isDirectory()) continue;
      copyEntry(from, Buffer.concat([dest, SEP, name]), times, skip);
    }
    if (times) setTimes(src, dest);
    fs.chmodSync(dest, st.mode & 0o7777);
    return;
  }
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src, { encoding: 'buffer' }), dest);
    return;
  }
  {
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
    if (times) setTimes(src, dest);
    fs.chmodSync(dest, st.mode & 0o7777);
  }
}
