// What the AI brain view may open. The page never sends a path: it names an item the index handed out, and every
// file is checked here again when it is listed and when it is read:
//   - its real path (links resolved) must stay inside the root it was listed under: no "..", no absolute path,
//     no link that leads out;
//   - no part of its path may be a private folder (no-ai, ignore, ai-ignore-dir), a credentials folder, a
//     dot-file or dot-folder, an .env file or a key file;
//   - it must be a plain text file (.md, .markdown, .txt) with no NUL byte in it.
// What is read is size-capped, and text that looks like a secret is masked (assistant/secrets.mjs) before it
// leaves the server.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../assistant/secrets.mjs';
import { PRIVATE_DIRS } from '../pcsetup/projects.mjs';

export const MAX_BYTES = 200 * 1024;
const TEXT_EXT = /\.(md|markdown|txt)$/i;
// Key and secret files by name: SSH keys, certificates and key stores, password databases, .env in any form.
const KEY_FILE = /^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|gpg|asc|kdbx|ovpn|ppk|env)$|^env$|^secrets?(\.|$)/i;

/** A path part that is never listed, opened or counted. */
export const blockedPart = (s) => s.startsWith('.') || PRIVATE_DIRS.includes(s) || /^credentials$/i.test(s) || KEY_FILE.test(s);

const parts = (rel) => rel.split(/[\\/]/).filter(Boolean);
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/** `child` is `root` or inside it (both real paths). */
export const within = (child, root) => child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/** A folder name or file name safe to list (and to use in an item id). */
export const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9 ._()+-]{0,150}$/;

/**
 * Check one file against its root. `root` is a folder, or (for a single known file such as the global rules) the
 * file itself. → { ok: true, real, size, mtime } or { ok: false, why }.
 */
export function checkFile(abs, root) {
  if (typeof abs !== 'string' || !path.isAbsolute(abs) || abs.includes('\0')) return { ok: false, why: 'not a file of the brain' };
  const rootReal = real(root);
  if (!rootReal) return { ok: false, why: 'not there' };
  // A single-file root (the global rules, which may be a link) admits that one file and nothing else.
  const fileRoot = fs.statSync(rootReal).isFile();
  const rel = fileRoot ? '' : path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, why: 'outside the brain' };
  const r = real(abs);
  if (!r) return { ok: false, why: 'not there' };
  if (fileRoot ? r !== rootReal : !within(r, rootReal)) return { ok: false, why: 'a link that leads outside the brain' };
  const shown = [...parts(rel), ...parts(path.relative(rootReal, r)), path.basename(abs), path.basename(r)];
  if (shown.some(blockedPart)) return { ok: false, why: 'private, a credential or a key file' };
  if (!TEXT_EXT.test(abs) || !TEXT_EXT.test(r)) return { ok: false, why: 'not a plain text file' };
  const st = fs.statSync(r);
  if (!st.isFile()) return { ok: false, why: 'not a file' };
  return { ok: true, real: r, size: st.size, mtime: st.mtime };
}

/**
 * Read a checked file: at most `max` bytes, never a file with a NUL byte (not text), secret-shaped text masked.
 * → { text, size, cut, masked } (throws with .status when refused).
 */
export function readChecked(abs, root, max = MAX_BYTES) {
  const c = checkFile(abs, root);
  if (!c.ok) throw Object.assign(new Error(`refused: ${c.why}`), { status: c.why === 'not there' ? 404 : 403 });
  const fd = fs.openSync(c.real, 'r');
  let buf;
  try {
    buf = Buffer.alloc(Math.min(c.size, max));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    buf = buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
  if (buf.includes(0)) throw Object.assign(new Error('refused: not a plain text file'), { status: 415 });
  const raw = buf.toString('utf8');
  const text = redact(raw);
  return { text, size: c.size, cut: c.size > max, masked: text !== raw, mtime: c.mtime };
}

/** Folder entries that may be listed: safe names, never a blocked one. */
export function listable(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => SAFE_NAME.test(d.name) && !blockedPart(d.name));
  } catch {
    return [];
  }
}
