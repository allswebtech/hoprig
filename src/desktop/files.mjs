// Files, the desktop's file manager (web/desktop/files.js), as routes of the desktop's feature. They stand on the code
// editor's file module (src/editor/: paths.mjs checks every path, manage.mjs, trash.mjs, archive.mjs), so the
// editor's protections hold here too. How far they reach is the dashboard's one setting (folders.mjs reachRoots).
// Behind the sign-in like their neighbours; another computer's Files goes through the hub (/m/<computer>/api/files/…),
// an upload as raw bytes on a path that ends in /upload (the hub's rule for raw bodies, machines/legs.mjs).
//
//   GET  /api/files/list?path=&hidden=1         one folder (no path: the top of the reach): { path, parent, top,
//                                                project, entries: [{ name, kind, link?, size, mtime }], truncated,
//                                                reach: { kind: home | everything, tops } }
//   GET  /api/files/raw?path=&download=1        the file's bytes: a download, or a picture shown (no download=1)
//   GET  /api/files/find?path=&q=&hidden=1      names holding q under path: { matches: [{ path, kind }], truncated, timedOut }
//   POST /api/files/upload?dir=&name=&replace=1  raw bytes; never over a file unless replace=1
//   POST /api/files/new { dir, name, kind: file | dir }
//   POST /api/files/rename { path, name }        in the same folder, never over something there
//   POST /api/files/move | copy { paths, to }    { done, failed }
//   POST /api/files/trash { paths }              into Hoprig's own trash: { done, failed }
//   GET  /api/files/trash                        { items: [{ id, name, from, at, kind, size }] }
//   POST /api/files/trash/restore { id }         put back where it came from: { path }
//   POST /api/files/trash/empty { confirm: true }
//   POST /api/files/pack { paths, name? }        a .tar.gz next to them: { path }
//   POST /api/files/unpack { path }              into a new folder next to it: { path }
//
// Tia's token is refused, as for the editor: she opens Files for the owner, she does not read or change files with it.
import path from 'node:path';
import { DEFAULT_UPLOAD_MAX_MB } from '../server/uploads.mjs';
import { reachRoots } from '../server/folders.mjs';
import { pack, unpack } from '../editor/archive.mjs';
import { create, rename } from '../editor/files.mjs';
import { findByName, listFolder, receive, sendFile, transfer } from '../editor/manage.mjs';
import { checkName, fail, locate } from '../editor/paths.mjs';
import { emptyTrash, listTrash, restore, toTrash } from '../editor/trash.mjs';

const flag = (q, k) => q.get(k) === '1' || q.get(k) === 'true';

export function filesRoutes(ctx) {
  const server = () => ctx.config().server || {};
  const roots = () => reachRoots(server());
  const notTia = (req) => {
    if (/^Bearer\s+tia_/i.test(String((req.headers && req.headers.authorization) || ''))) throw fail(403, 'Files is the owner\'s; Tia opens it with a link');
  };
  const get = (fn) => async (req, m, q, res) => {
    notTia(req);
    return fn(q, res, req);
  };
  const post = (fn) => async (req) => {
    notTia(req);
    return fn(await ctx.readJson(req));
  };
  /** The editor's functions take a root and a path inside it: a full path as that pair. */
  const pair = (p, mode) => {
    const at = locate(p, roots(), { mode });
    return { root: at.root, rel: at.rel };
  };

  return [
    ['GET', /^\/api\/files\/list$/, get((q) => {
      const r = roots();
      const s = server();
      return { ...listFolder(q.get('path') || r[0], r, { hidden: flag(q, 'hidden') }), reach: { kind: s.reach === 'everything' ? 'everything' : 'home', tops: r } };
    })],
    ['GET', /^\/api\/files\/raw$/, get((q, res) => sendFile(q.get('path'), roots(), res, { download: flag(q, 'download') }))],
    ['GET', /^\/api\/files\/find$/, get((q) => findByName(q.get('path'), q.get('q'), roots(), { hidden: flag(q, 'hidden') }))],
    ['POST', /^\/api\/files\/upload$/, async (req, m, q, res) => {
      notTia(req);
      const maxBytes = Math.max(1, Number(server().uploadMaxMB) || DEFAULT_UPLOAD_MAX_MB) * 1024 * 1024;
      return receive(req, q.get('dir'), q.get('name'), roots(), { replace: flag(q, 'replace'), maxBytes, res });
    }],
    ['POST', /^\/api\/files\/new$/, post((b) => {
      if (typeof b.dir !== 'string') throw fail(400, 'name the folder');
      const at = pair(path.join(b.dir, checkName(b.name)), 'new');
      const r = create(at.root, at.rel, b.kind, roots());
      return { path: path.join(at.root, ...r.path.split('/')), kind: r.kind };
    })],
    ['POST', /^\/api\/files\/rename$/, post((b) => {
      const from = pair(b.path, 'entry');
      const to = from.rel.includes('/') ? `${from.rel.slice(0, from.rel.lastIndexOf('/'))}/${checkName(b.name)}` : checkName(b.name);
      const r = rename(from.root, from.rel, to, roots());
      return { path: path.join(from.root, ...r.to.split('/')) };
    })],
    ['POST', /^\/api\/files\/move$/, post((b) => transfer(b.paths, b.to, roots()))],
    ['POST', /^\/api\/files\/copy$/, post((b) => transfer(b.paths, b.to, roots(), { copy: true }))],
    ['POST', /^\/api\/files\/trash$/, post((b) => toTrash(b.paths, roots()))],
    ['GET', /^\/api\/files\/trash$/, get(() => listTrash())],
    ['POST', /^\/api\/files\/trash\/restore$/, post((b) => restore(b.id, roots()))],
    ['POST', /^\/api\/files\/trash\/empty$/, post((b) => emptyTrash(b.confirm))],
    ['POST', /^\/api\/files\/pack$/, post((b) => pack(b.paths, roots(), { name: b.name }))],
    ['POST', /^\/api\/files\/unpack$/, post((b) => unpack(b.path, roots()))],
  ];
}
