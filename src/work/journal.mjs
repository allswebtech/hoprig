// The journal of a save of the Work file: what the save is about to do, written to Hoprig's state folder and flushed
// to disk before it changes anything in the repository, deleted only when the save is done (or the owner says to drop
// it). It holds the repository, the branch, the commit the branch was on, the server's commit, the list the save
// writes (the merged list, when the server changed the list too), this computer's list as it was, and the owner's
// choices. Version 2: a merge also keeps his list in the repository right after this record is written (kept.mjs),
// so the recovery can tell "nothing was changed yet" from "the file was put back". A save that was killed half way (a crash, a power cut, a dashboard stopped) is finished from it the next
// time anything looks at the Work list (resume.mjs). Never inside the repository: git never sees it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';

export const JOURNAL_FOLDER = 'work-journal';

/** The Work file's path with its folder's links resolved, so the page and the command name one journal. */
function realFile(file) {
  try {
    return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    return path.resolve(file);
  }
}

const nameOf = (file) => `${crypto.createHash('sha256').update(realFile(file)).digest('hex').slice(0, 24)}.json`;
const pathOf = (file) => path.join(stateDir(), JOURNAL_FOLDER, nameOf(file));
/** Where the journal is, as the owner is told it: inside Hoprig's state folder. */
export const keptAt = (file) => `${JOURNAL_FOLDER}/${nameOf(file)}`;

/** Write the journal whole and flush it (and its folder) to disk: after this returns it is there after a crash. */
export function writeJournal(file, record) {
  const target = pathOf(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify({ v: 2, at: new Date().toISOString(), ...record }, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  try {
    const d = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  } catch {
    /* a folder cannot be opened for this on every system (Windows): the rename is as far as it goes there */
  }
}

/** The journal of the Work file `file`: its record, { unreadable: true }, or null when there is none. */
export function readJournal(file) {
  let text;
  try {
    text = fs.readFileSync(pathOf(file), 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? null : { unreadable: true };
  }
  try {
    const r = JSON.parse(text);
    return r && (r.v === 1 || r.v === 2) && typeof r.top === 'string' && typeof r.rel === 'string' ? r : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}

/** Delete the journal (its save is done, or the owner dropped it). → whether there was one. */
export function dropJournal(file) {
  const p = pathOf(file);
  const was = fs.existsSync(p);
  fs.rmSync(p, { force: true });
  return was;
}

/**
 * Write `text` to `target` whole and flush it (and its folder) to disk, as writeJournal does: the record of an Accept
 * of a plan (planstore.mjs) is written so too. Mode 600.
 */
export function writeSynced(target, text) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  try {
    const d = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(d);
    } finally {
      fs.closeSync(d);
    }
  } catch {
    /* not on every system (Windows) */
  }
}
