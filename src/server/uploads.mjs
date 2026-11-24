// Files sent from the browser (a phone screenshot to show Claude a bug) go into one folder inside the session's
// working folder: <cwd>/<server.uploadsDir>. The name is cleaned, the size capped, and the file is never written
// outside that folder or over an existing file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_UPLOADS_DIR = '.uploads';
export const DEFAULT_UPLOAD_MAX_MB = 25;

/** server.uploadsDir must be a plain relative folder name (or a few of them), never absolute or with "..". */
export function uploadsDirName(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_UPLOADS_DIR;
  if (typeof v !== 'string' || path.isAbsolute(v) || v.includes('\0')) return null;
  const parts = v.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => p === '..' || p === '.')) return null;
  return parts.join(path.sep);
}

/** A safe file name: letters, digits, ".", "-", "_"; no leading dot; kept extension; at most 80 characters. */
export function cleanFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().normalize('NFKC');
  const clean = (t) => t.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_');
  const rawExt = path.extname(base);
  const ext = /^\.[A-Za-z0-9]{1,10}$/.test(rawExt) ? rawExt : '';
  const stem = clean(base.slice(0, base.length - ext.length)).replace(/^[._]+/, '').replace(/[._]+$/, '').slice(0, 80 - ext.length);
  return (stem || 'upload') + ext;
}

/**
 * Stream `req` into a new file under <cwd>/<dirName>. Resolves { path, name, size }. Rejects with .status set:
 * 413 when larger than maxBytes, 400 when the folder would leave cwd.
 */
export async function saveUpload(req, { cwd, dirName, fileName, maxBytes, ignoreFile = true }) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  const realCwd = fs.realpathSync(cwd);
  const dir = path.join(realCwd, dirName);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const realDir = fs.realpathSync(dir); // a symlinked uploads folder must still point inside cwd
  if (!realDir.startsWith(realCwd + path.sep)) throw fail(400, 'the uploads folder is not inside the session folder');
  // The folder sits inside a project: keep its files (screenshots, logs) out of that project's git history.
  if (ignoreFile) {
    try {
      fs.writeFileSync(path.join(realDir, '.gitignore'), '*\n', { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const name = `${stamp}-${crypto.randomBytes(2).toString('hex')}-${cleanFileName(fileName)}`;
  const file = path.join(realDir, name);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw fail(413, `the file is larger than ${Math.round(maxBytes / 1048576)} MB`);

  // "wx": fail instead of overwriting or following a symlink that already has this name.
  const out = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.unpipe(out);
          req.destroy();
          reject(fail(413, `the file is larger than ${Math.round(maxBytes / 1048576)} MB`));
        }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
  } catch (e) {
    // The file is opened asynchronously: wait until the stream is closed, or the removal could come first.
    await new Promise((resolve) => {
      out.once('close', resolve);
      out.destroy();
    });
    fs.rmSync(file, { force: true });
    throw e;
  }
  if (!size) {
    fs.rmSync(file, { force: true });
    throw fail(400, 'the file is empty');
  }
  return { path: file, name, size };
}

/** How long a file dropped or pasted on a session's terminal is kept: a week, then the next drop removes it. */
export const DROP_KEEP_MS = 7 * 24 * 3600_000;

/**
 * The folder for files dropped or pasted on a session's terminal: <stateDir>/drops, readable by its user only. Never
 * inside the session's repository; the path typed into the terminal is absolute, so the coding tool reads it there.
 */
export function dropsFolder(stateDir) {
  const dir = path.join(stateDir, 'drops');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** Remove what is older than `keepMs` in each session's folder under `dir`, and a session folder left empty. */
export function pruneDrops(dir, keepMs = DROP_KEEP_MS, now = Date.now()) {
  let removed = 0;
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const folder = path.join(dir, sub.name);
    let left = 0;
    for (const f of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, f.name);
      try {
        if (f.isFile() && now - fs.statSync(file).mtimeMs > keepMs) {
          fs.rmSync(file, { force: true });
          removed++;
        } else left++;
      } catch {
        left++; // gone meanwhile, or not ours to judge: kept
      }
    }
    if (!left) fs.rmSync(folder, { recursive: true, force: true });
  }
  return removed;
}
