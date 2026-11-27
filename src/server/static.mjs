// Static files: the page itself from web/, and xterm.js plus two of its addons and the code editor (monaco-editor)
// straight from node_modules (no CDN, no build step). A URL maps to a file only inside one of these folders and only
// for known file types.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

// The package folder of an npm package, found through its main file.
const pkgDir = (name, main) => {
  try {
    const file = require.resolve(name);
    return file.slice(0, file.lastIndexOf(path.sep + main) + 1) || path.dirname(file);
  } catch {
    return null;
  }
};

// The worker files of the editor: the file names carry a hash that changes with each version, so they are listed.
const WORKER_RE = /^(editor|ts|json|css|html)\.worker-[A-Za-z0-9_-]+\.js$/;
let monacoFound;

/**
 * monaco-editor as installed: { version, dir (the real min/vs folder), base (its URL, with the version in it, so the
 * files can be cached for good), workers: { editor, ts, json, css, html } (URLs) }, or null. Found once: an update
 * replaces the whole install, and the dashboard takes it up only when it restarts (Settings → Version and updates says so).
 */
export function monaco() {
  if (monacoFound !== undefined) return monacoFound;
  monacoFound = null;
  try {
    const vs = fs.realpathSync(path.dirname(require.resolve('monaco-editor'))); // <package>/min/vs/index.js
    const { version } = JSON.parse(fs.readFileSync(path.join(vs, '..', '..', 'package.json'), 'utf8'));
    if (!/^\d+\.\d+\.\d+$/.test(String(version))) return null;
    const base = `/vendor/monaco/${version}/vs/`;
    const workers = {};
    for (const n of fs.readdirSync(path.join(vs, 'assets')).sort()) {
      const m = WORKER_RE.exec(n);
      if (m && !workers[m[1]]) workers[m[1]] = `${base}assets/${n}`;
    }
    monacoFound = { version, dir: vs, base, workers };
  } catch {
    /* not installed: the editor page says so */
  }
  return monacoFound;
}

/** What the editor page needs to load monaco: the same object without the folder on disk. */
export function monacoManifest() {
  const m = monaco();
  return m ? { version: m.version, base: m.base, workers: m.workers } : null;
}

/**
 * URL prefix → folder. Order matters: the first matching prefix wins. Only the code and style folders of the
 * terminal packages are reachable, never their package.json or anything else in node_modules.
 */
export function mounts() {
  const xterm = pkgDir('@xterm/xterm', path.join('lib', 'xterm.js'));
  const fit = pkgDir('@xterm/addon-fit', path.join('lib', 'addon-fit.js'));
  const uni = pkgDir('@xterm/addon-unicode11', path.join('lib', 'addon-unicode11.js'));
  const out = [];
  if (xterm) out.push(['/vendor/xterm/lib/', path.join(xterm, 'lib')], ['/vendor/xterm/css/', path.join(xterm, 'css')]);
  if (fit) out.push(['/vendor/addon-fit/lib/', path.join(fit, 'lib')]);
  if (uni) out.push(['/vendor/addon-unicode11/lib/', path.join(uni, 'lib')]);
  // The editor's min build, without the two folders the page never asks for (AMD copies of the workers, translations).
  const mon = monaco();
  if (mon) out.push([mon.base, mon.dir, { skip: ['language', 'nls'] }]);
  out.push(['/', WEB_DIR]);
  return out;
}

export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
};

/** The file for a URL path, or null. Rejects encoded slashes, "..", NUL and anything outside the mount. */
export function resolveStatic(urlPath, table = mounts()) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\') || /%2f|%5c/i.test(urlPath)) return null;
  if (decoded.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  for (const [prefix, dir, { skip = [] } = {}] of table) {
    if (!decoded.startsWith(prefix)) continue;
    const rel = decoded.slice(prefix.length);
    if (skip.includes(rel.split('/')[0])) return null;
    const file = path.resolve(dir, rel || 'index.html');
    const root = path.resolve(dir) + path.sep;
    if (!file.startsWith(root)) return null;
    if (!TYPES[path.extname(file)]) return null;
    let real;
    try {
      real = fs.realpathSync(file);
      if (!real.startsWith(fs.realpathSync(dir) + path.sep) || !fs.statSync(real).isFile()) return null;
    } catch {
      return null;
    }
    return real;
  }
  return null;
}

/** True for a file whose URL carries its version (the editor's): it never changes under that URL. */
export function immutable(file) {
  const m = monaco();
  return Boolean(m) && file.startsWith(m.dir + path.sep);
}

export function sendFile(res, file, headOnly = false) {
  const type = TYPES[path.extname(file)];
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    // The page changes with each install; let the browser check every time (cheap on a LAN). The editor's files
    // (several MB) are kept for good: a new version comes under a new URL. "private": they are sent only after the
    // login, so a shared cache in front of the dashboard must not keep them.
    'Cache-Control': immutable(file) ? 'private, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(headOnly ? undefined : body);
}
