// Root writes into the user's home after the switch (the catch-up, the job's mirror, the gateway's provider files),
// while the user's dashboard runs: a process of the user's can change that home at any moment. So no write of root's
// there follows a link: every folder from the home down is looked at with lstat (a missing one is made, mode 700, and
// given to the user), a new file is opened with O_EXCL and O_NOFOLLOW, an append with O_NOFOLLOW on a plain file of one
// name, and a whole file is written as a temporary file of a random name beside it and renamed over it (a rename
// replaces a link, never what it points to). Not covered: a folder swapped for a link between the look and the open
// (Node has no openat).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { O_WRONLY, O_CREAT, O_EXCL, O_APPEND } = fs.constants;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Thrown when something in the way is not a plain folder or file: nothing was written through it. */
export class NotPlain extends Error {}

/**
 * Every folder from `home` down to `dir` is a real folder, never a link. `make`: a missing one is made (mode 700) and
 * `own(path)` gives it to the user. Throws NotPlain.
 */
export function plainDirs(home, dir, { make = false, own = () => {} } = {}) {
  const rel = path.relative(home, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new NotPlain(`${dir} is not inside ${home}`);
  if (!fs.lstatSync(home).isDirectory()) throw new NotPlain(`${home} is not a plain folder`);
  let at = home;
  for (const part of rel ? rel.split(path.sep) : []) {
    at = path.join(at, part);
    let st;
    try {
      st = fs.lstatSync(at);
    } catch (e) {
      if (e.code !== 'ENOENT' || !make) throw e;
      fs.mkdirSync(at, { mode: 0o700 }); // fails on anything put there meanwhile
      own(at);
      continue;
    }
    if (!st.isDirectory()) throw new NotPlain(`${at} is not a plain folder (a link, or a file)`);
  }
}

/** A new file `file` in the user's home with `data`: never through a link, never over anything there. */
export function createIn(home, file, data, { mode = 0o600, own = () => {} } = {}) {
  plainDirs(home, path.dirname(file), { make: true, own });
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | NOFOLLOW, mode);
  try {
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  own(file);
}

/** `data` added to the end of the plain file `file` (one name, no link) in the user's home. */
export function appendIn(home, file, data) {
  plainDirs(home, path.dirname(file));
  const fd = fs.openSync(file, O_WRONLY | O_APPEND | NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new NotPlain(`${file} is not a plain file of one name`);
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

/** `file` in the user's home replaced whole by `data`: a temporary file of a random name beside it, renamed over it. */
export function replaceIn(home, file, data, { mode = 0o600, own = () => {} } = {}) {
  plainDirs(home, path.dirname(file), { make: true, own });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  createIn(home, tmp, data, { mode, own });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
