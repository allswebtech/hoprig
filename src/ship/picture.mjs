// A picture of the paths a project keeps (live.keep): per path whether it is there, how many files, how many bytes,
// and one hash over the names and hashes of its files. Taken before a go-live and after it, and compared. Never a
// file's content: the hashes of single files (to name the files that changed) are kept only in Hoprig's state folder
// (mode 600), never shown, never in the journal. Links are not followed (a link is its target's name).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FILES_MAX = 50_000;
const NAMES_SHOWN = 20;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fileHash(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(1 << 16);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** The picture of `keep` (paths relative to `base`): { paths: [{ path, exists, files, bytes, hash, cut? }], files }. */
export function takePicture(base, keep) {
  const files = {};
  const paths = [];
  for (const rel of keep) {
    const top = path.join(base, ...rel.split('/'));
    const entry = { path: rel, exists: false, files: 0, bytes: 0, hash: null };
    const mine = [];
    const add = (r, h, size) => {
      if (Object.keys(files).length >= FILES_MAX) {
        entry.cut = true;
        return;
      }
      files[r] = h;
      mine.push(`${r}\0${h}`);
      entry.files += 1;
      entry.bytes += size;
    };
    const walk = (abs, r) => {
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        return;
      }
      if (st.isSymbolicLink()) add(r, `link:${sha(fs.readlinkSync(abs))}`, 0);
      else if (st.isFile()) {
        try {
          add(r, fileHash(abs), st.size);
        } catch {
          add(r, 'unreadable', st.size);
        }
      } else if (st.isDirectory()) {
        let names = [];
        try {
          names = fs.readdirSync(abs).sort();
        } catch {
          add(`${r}/`, 'unreadable', 0);
          return;
        }
        for (const n of names) walk(path.join(abs, n), `${r}/${n}`);
      }
    };
    try {
      fs.lstatSync(top);
      entry.exists = true;
    } catch {
      /* not there */
    }
    if (entry.exists) walk(top, rel);
    entry.hash = entry.exists ? sha(mine.sort().join('\n')) : null;
    paths.push(entry);
  }
  return { paths, files };
}

/** What the journal and the page may show of a picture: no hash at all. */
export const shownPicture = (p) => p.paths.map(({ path: rel, exists, files, bytes, cut }) => ({ path: rel, exists, files, bytes, ...(cut ? { cut } : {}) }));

/** Compare two pictures: { same, changed: [{ path, what: 'added' | 'removed' | 'changed' }] (at most 20), more }. */
export function comparePictures(a, b) {
  const changed = [];
  const names = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  for (const n of [...names].sort()) {
    if (a.files[n] === b.files[n]) continue;
    changed.push({ path: n, what: !(n in a.files) ? 'added' : !(n in b.files) ? 'removed' : 'changed' });
  }
  for (const p of a.paths) {
    const q = b.paths.find((x) => x.path === p.path);
    if (q && p.exists !== q.exists && !changed.some((c) => c.path === p.path || c.path.startsWith(`${p.path}/`))) changed.push({ path: p.path, what: q.exists ? 'added' : 'removed' });
  }
  return { same: changed.length === 0, changed: changed.slice(0, NAMES_SHOWN), more: Math.max(0, changed.length - NAMES_SHOWN) };
}
