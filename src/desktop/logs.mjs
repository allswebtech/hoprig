// The Logs app: the journal where there is one (Linux), read with a cursor, filtered by unit and priority; and the
// plain log files of the system's log folders (every OS), read from a byte offset. "Follow" in the page polls with
// the cursor or the offset: only the terminal has a socket through the relay to another computer.
//
// Files: only the readable regular files inside the OS's log folders are listed, and only a listed kind of file is
// read (the path is resolved and must stay inside one of those folders, so a link cannot lead out of them).
// Secrets that end up in a log line are masked as on the PC page (platform/common.mjs redact).
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../server/platform/common.mjs';
import { CURSOR_RE } from '../server/platform/linux-system.mjs';

export const LINES_MAX = 1000;
const FILES_MAX = 400;
const READ_MAX = 256 * 1024; // per call; a follow asks again from where this ended
const FIRST_MAX = 64 * 1024; // the first read of a file: its end
const fail = (status, message) => Object.assign(new Error(message), { status });

// Not text, or not readable as it is: rotated and packed copies, login records, the journal's own files.
const SKIP = /\.(gz|xz|bz2|zst|lz4|z|zip|journal|journal~|db|sqlite)$|^(wtmp|btmp|lastlog|faillog|utmp)(\.\d+)?$/i;

/** Every readable log file under `dirs` (two folders deep): [{ path, size, mtime }], newest first. */
export function listLogFiles(dirs) {
  const out = [];
  const walk = (dir, depth) => {
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (out.length >= FILES_MAX) return;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < 2 && d.name !== 'journal') walk(p, depth + 1);
      } else if (d.isFile() && !SKIP.test(d.name)) {
        try {
          fs.accessSync(p, fs.constants.R_OK);
          const st = fs.statSync(p);
          out.push({ path: p, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* not readable by this user: not listed */
        }
      }
    }
  };
  for (const d of dirs) walk(d, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** `p` as a file inside one of `dirs` after links are resolved, or null. */
export function insideLogDirs(p, dirs) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !path.isAbsolute(p)) return null;
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    return null;
  }
  for (const d of dirs) {
    let root;
    try {
      root = fs.realpathSync(d);
    } catch {
      continue;
    }
    const rel = path.relative(root, real);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return SKIP.test(path.basename(real)) ? null : real;
  }
  return null;
}

/**
 * Read a log file from byte `from` (null: its last 64 KiB, from a line start). { text, from, next, size, reset }:
 * `next` is where the next read starts; `reset` when the file is shorter than `from` (it was rotated or emptied).
 */
export function readLogFile(p, dirs, from = null) {
  const real = insideLogDirs(p, dirs);
  if (!real) throw fail(404, 'not found or not allowed');
  let fd;
  try {
    fd = fs.openSync(real, 'r');
  } catch {
    throw fail(404, 'not found or not allowed');
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw fail(404, 'not found or not allowed');
    let start = from === null ? Math.max(0, st.size - FIRST_MAX) : from;
    let reset = false;
    if (start > st.size) {
      start = 0;
      reset = true;
    }
    const len = Math.min(READ_MAX, st.size - start);
    const buf = Buffer.alloc(len);
    const got = len ? fs.readSync(fd, buf, 0, len, start) : 0;
    let chunk = buf.subarray(0, got);
    if (chunk.includes(0)) throw fail(415, 'that file is not text');
    let skip = 0;
    if (from === null && start > 0) {
      skip = chunk.indexOf(10) + 1; // begin at a whole line
      chunk = chunk.subarray(skip);
    }
    // Stop at the last whole line, unless nothing else would be read: a line still being written comes next time.
    const lastNl = chunk.lastIndexOf(10);
    const whole = lastNl >= 0 ? chunk.subarray(0, lastNl + 1) : start + skip + chunk.length >= st.size ? chunk : Buffer.alloc(0);
    const text = whole.toString('utf8').split('\n').map((l) => redact(l, 4000)).join('\n');
    return { path: real, text, from: start + skip, next: start + skip + whole.length, size: st.size, reset };
  } finally {
    fs.closeSync(fd);
  }
}

/** The page's journal query → checked values (a 400 for anything else). */
export function journalQuery(q, { unitOk }) {
  const get = (k) => (q && q.get(k)) || null;
  const scope = get('scope') || 'system';
  if (!['system', 'user'].includes(scope)) throw fail(400, 'scope is system or user');
  const unit = get('unit');
  if (unit !== null && !unitOk(unit)) throw fail(400, 'that is not a unit name');
  const pr = get('priority');
  const priority = pr === null ? null : Number(pr);
  if (priority !== null && !(Number.isInteger(priority) && priority >= 0 && priority <= 7)) throw fail(400, 'priority is 0 to 7');
  const lines = Math.max(1, Math.min(LINES_MAX, Number(get('lines')) || 200));
  const after = get('after');
  const before = get('before');
  for (const c of [after, before]) if (c !== null && !CURSOR_RE.test(c)) throw fail(400, 'that is not a journal cursor');
  if (after && before) throw fail(400, 'after or before, not both');
  return { scope, unit, priority, lines, after, before };
}
