// Files for the chat's composer: the @ picker's search inside the chat's folder, and the files of a message (what
// the upload route saved) turned into what the coding tool reads: a picture goes in as an image, any other file is
// named in the text (@path) and read by the coding tool itself.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { within } from '../server/folders.mjs';

const LIST_MAX = 20_000; // files of one folder looked at
const SHOWN_MAX = 50;
const CACHE_MS = 10_000;
const SKIP = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv', 'venv', 'target']);
const cache = new Map(); // folder → { at, files }

/** The folder's files, relative: git's list (tracked and untracked, not ignored) where it is a repository, else a walk. */
function listFiles(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd, timeout: 5000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, out) => {
      if (!err) return resolve(out.split('\n').filter(Boolean).slice(0, LIST_MAX));
      const files = [];
      const walk = (dir, rel, depth) => {
        if (files.length >= LIST_MAX || depth > 8) return;
        let names = [];
        try {
          names = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const d of names) {
          if (files.length >= LIST_MAX) return;
          const r = rel ? `${rel}/${d.name}` : d.name;
          if (d.isDirectory()) {
            if (!SKIP.has(d.name)) walk(path.join(dir, d.name), r, depth + 1);
          } else if (d.isFile()) files.push(r);
        }
      };
      walk(cwd, '', 0);
      resolve(files);
    });
  });
}

/** How well `file` matches `q`: the letters of q in order, better when in the file's name and close together; -1 when not. */
function score(file, q) {
  const f = file.toLowerCase();
  const name = f.slice(f.lastIndexOf('/') + 1);
  if (name.startsWith(q)) return 1000 - f.length;
  if (name.includes(q)) return 800 - f.length;
  if (f.includes(q)) return 600 - f.length;
  let at = -1;
  let gaps = 0;
  for (const ch of q) {
    const n = f.indexOf(ch, at + 1);
    if (n < 0) return -1;
    if (at >= 0) gaps += n - at - 1;
    at = n;
  }
  return 300 - gaps - f.length / 10;
}

/** The @ picker: up to 50 files of `cwd` (paths relative to it) that match `q`, best first. Folders too, by their path. */
export async function searchFiles(cwd, q) {
  const now = Date.now();
  let hit = cache.get(cwd);
  if (!hit || now - hit.at > CACHE_MS) {
    hit = { at: now, files: await listFiles(cwd) };
    cache.set(cwd, hit);
    if (cache.size > 50) cache.delete(cache.keys().next().value);
  }
  const query = String(q || '').trim().toLowerCase().replace(/^@/, '');
  if (!query) return hit.files.slice(0, SHOWN_MAX);
  return hit.files.map((f) => [f, score(f, query)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).slice(0, SHOWN_MAX).map(([f]) => f);
}

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const IMAGE_MAX = 5 * 1024 * 1024; // the Messages API's limit for one image
const ATTACH_MAX = 10;

/**
 * The files of a message, each a path the upload route returned. Only files inside `uploadsDir` (the chat folder's
 * uploads folder, real path) are taken. → { images: [{ mime, data }], mentions: ["@path"], attachments: [{ type, name, mime }] }
 */
export function readAttachments(list, { cwd, uploadsDir }) {
  const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!Array.isArray(list) || list.length > ATTACH_MAX) throw fail(`a message takes up to ${ATTACH_MAX} files`);
  let dir;
  try {
    dir = fs.realpathSync(uploadsDir);
  } catch {
    if (list.length) throw fail('upload the file first');
    return { images: [], mentions: [], attachments: [] };
  }
  const out = { images: [], mentions: [], attachments: [] };
  for (const a of list) {
    const p = a && typeof a.path === 'string' ? a.path : null;
    if (!p || !path.isAbsolute(p) || p.includes('\0')) throw fail('bad file');
    let real;
    try {
      real = fs.realpathSync(p);
    } catch {
      throw fail('that file is gone; upload it again');
    }
    if (!within(real, dir) || real === dir || !fs.statSync(real).isFile()) throw fail('only files uploaded to this chat can be attached');
    const name = path.basename(real);
    const mime = IMAGE_TYPES[path.extname(real).toLowerCase()];
    if (mime && fs.statSync(real).size <= IMAGE_MAX) {
      out.images.push({ mime, data: fs.readFileSync(real).toString('base64') });
      out.attachments.push({ type: 'image', name, mime });
    } else {
      const rel = path.relative(fs.realpathSync(cwd), real).split(path.sep).join('/');
      out.mentions.push(`@${/\s/.test(rel) ? `"${rel}"` : rel}`);
      out.attachments.push({ type: 'file', name, mime: mime || '' });
    }
  }
  return out;
}
