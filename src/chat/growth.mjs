// Who wrote a conversation's transcript last, as Delete must know it (deletes.mjs): a conversation someone else
// still writes is never moved to the trash, or it would be split between the trash and its folder.
//
// A session's OWN writes are known by the session alone: its turn end, its exit and its own control answers set
// chat.ownStat (reading.mjs knowSize), and nothing else does (a page's read of the file never does). Every other
// change of the file is someone else's: each look (a page's refresh, a delete's check) that sees the file differ from
// both the session's own state and the last look stamps the time it was seen, and a file whose time is not the
// session's own counts as written then. A stamp is kept per file for every reader, so a delete right after a page
// read the growth still sees it. What a look costs: one stat of one file.
import fs from 'node:fs';

export const WRITING_MS = 5000; // a conversation someone else wrote this recently may still be written
const SEEN_MAX = 5000;
const seen = new Map(); // file → { size, mtimeMs, at (when someone else last wrote it, as far as is known) }

const same = (a, b) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** The file's size and time now, or null (not there). */
export function statOf(file) {
  try {
    const s = fs.statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Look at `file`. own: { size, mtimeMs } as the session's own process left it (or null: none known). → { size,
 * mtimeMs, at (when someone else wrote it last: 0 when never seen) } or null when there is no file.
 */
export function look(file, own = null, now = Date.now()) {
  const st = statOf(file);
  if (!st) {
    seen.delete(file);
    return null;
  }
  const prev = seen.get(file);
  let at = prev ? prev.at : 0;
  if (!same(st, own)) {
    if (prev && !same(st, prev)) at = Math.max(at, now); // it changed since the last look: seen now
    at = Math.max(at, Math.min(st.mtimeMs, now)); // its time is not the session's own: written then (never later than now)
  }
  if (!prev && seen.size >= SEEN_MAX) seen.delete(seen.keys().next().value);
  seen.set(file, { ...st, at });
  return { ...st, at };
}

/** Someone else wrote `file` in the last `ms` (look() first). */
export const writtenNow = (l, ms = WRITING_MS, now = Date.now()) => !!l && now - l.at < ms;

/** The file is still as `expect` says (size and time): nobody wrote it since. */
export const unchanged = (file, expect) => same(statOf(file), expect);
