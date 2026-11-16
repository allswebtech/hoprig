// The code editor's server side, as a feature: { name, routes, start }. The page (Monaco, VS Code's editor core) is in
// web/editor/; its files come from node_modules (static.mjs). Every request names `root`, the folder the editor was
// opened on (inside the dashboard's roots); paths inside it are relative (paths.mjs checks them all).
//
//   GET  /api/code/tree?root&dir                      one level: { entries: [{ name, kind, link?, size? }], truncated }
//   GET  /api/code/file?root&path                     { text, version, size, eol } | { binary, version, size } | 413
//   POST /api/code/file { root, path, text, version } save over `version` only (409 { code: 'changed', version });
//                                                     version null: a new file
//   POST /api/code/create { root, path, kind }        a new empty file or folder ('file' | 'dir')
//   POST /api/code/rename { root, from, to }          never over something that exists
//   POST /api/code/delete { root, path, confirm }     confirm must be true
//   GET  /api/code/search?root&q&regex&case&word&include&exclude   { engine, matches, truncated, timedOut }
//   GET  /api/code/git/status?root                    { repo, branch, upstream, ahead, behind, staged, changes, untracked, conflicts }
//   GET  /api/code/git/diff?root&path&staged          the two sides of a file for the diff editor
//   POST /api/code/git/stage | unstage { root, paths }
//   POST /api/code/git/discard { root, paths, confirm }   tracked files back to their staged state, new files deleted
//   POST /api/code/git/commit { root, message, amend? }
//   GET  /api/code/git/log?root&n&path                the newest commits
//   GET  /api/code/git/branches?root                  the branches (read only)
//
// Who may: the owner's login, or another computer's token through the relay (the same owner looking at this
// computer: a session there runs commands as this user already, so the files add no new power). Tia's token is
// refused: she opens the editor for the owner (a link), she does not read or write files through it.
import { stateDir } from '../paths.mjs';
import { resolveRoots } from '../server/folders.mjs';
import { cleanupVscode } from './cleanup.mjs';
import { MAX_BYTES, create, readFile, remove, rename, tree, writeFile } from './files.mjs';
import { commit, diffSides, discard, gitBranches, gitLog, gitStatus, stage, unstage } from './git.mjs';
import { fail } from './paths.mjs';
import { search } from './search.mjs';

// A save carries the whole file as JSON text: room for the size limit and its escapes.
const BODY_MAX = MAX_BYTES * 2 + 64 * 1024;

/** A JSON body up to `max` bytes (the server's own reader stops at 64 KB, too small for a file). */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return reject(fail(415, 'send JSON'));
    if (Number(req.headers['content-length'] || 0) > max) return reject(fail(413, 'too large'));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(fail(413, 'too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(b && typeof b === 'object' && !Array.isArray(b) ? b : {});
      } catch {
        reject(fail(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const flag = (q, k) => ['1', 'true', 'yes'].includes(String(q.get(k) || '').toLowerCase());

/** `opts` (tests): cleanup (false: skip the one-time cleanup, or its options), searchEnv (PATH without rg). */
export function editorFeature(sctx, opts = {}) {
  const roots = () => resolveRoots(sctx.config().server.roots);
  const notTia = (req) => {
    if (/^Bearer\s+tia_/i.test(String((req.headers && req.headers.authorization) || ''))) throw fail(403, 'the editor\'s files are the owner\'s; Tia opens the editor with a link');
  };
  const body = async (req) => {
    notTia(req);
    return readBody(req, BODY_MAX);
  };
  const get = (fn) => async (req, m, q) => {
    notTia(req);
    return fn(q);
  };
  const post = (fn) => async (req) => fn(await body(req));

  const routes = [
    ['GET', /^\/api\/code\/tree$/, get((q) => tree(q.get('root'), q.get('dir'), roots()))],
    ['GET', /^\/api\/code\/file$/, get((q) => readFile(q.get('root'), q.get('path'), roots()))],
    ['POST', /^\/api\/code\/file$/, post((b) => writeFile(b.root, b.path, b.text, b.version, roots()))],
    ['POST', /^\/api\/code\/create$/, post((b) => create(b.root, b.path, b.kind, roots()))],
    ['POST', /^\/api\/code\/rename$/, post((b) => rename(b.root, b.from, b.to, roots()))],
    ['POST', /^\/api\/code\/delete$/, post((b) => remove(b.root, b.path, b.confirm, roots()))],
    ['GET', /^\/api\/code\/search$/, get((q) => search(q.get('root'), {
      q: q.get('q'), regex: flag(q, 'regex'), caseSensitive: flag(q, 'case'), word: flag(q, 'word'),
      include: q.get('include') || '', exclude: q.get('exclude') || '',
    }, roots(), { env: opts.searchEnv }))],
    ['GET', /^\/api\/code\/git\/status$/, get((q) => gitStatus(q.get('root'), roots()))],
    ['GET', /^\/api\/code\/git\/diff$/, get((q) => diffSides(q.get('root'), q.get('path'), flag(q, 'staged'), roots()))],
    ['POST', /^\/api\/code\/git\/stage$/, post((b) => stage(b.root, b.paths, roots()))],
    ['POST', /^\/api\/code\/git\/unstage$/, post((b) => unstage(b.root, b.paths, roots()))],
    ['POST', /^\/api\/code\/git\/discard$/, post((b) => discard(b.root, b.paths, b.confirm, roots()))],
    ['POST', /^\/api\/code\/git\/commit$/, post((b) => commit(b.root, b.message, b.amend, roots()))],
    ['GET', /^\/api\/code\/git\/log$/, get((q) => gitLog(q.get('root'), q.get('n'), q.get('path'), roots()))],
    ['GET', /^\/api\/code\/git\/branches$/, get((q) => gitBranches(q.get('root'), roots()))],
  ];

  return {
    name: 'editor',
    routes,
    start() {
      if (opts.cleanup === false) return;
      // In the background: starting the dashboard never waits for a folder of hundreds of MB to be removed.
      cleanupVscode(stateDir(), { config: sctx.config, saveConfig: sctx.saveConfig, ...(opts.cleanup || {}) })
        .catch((e) => console.error(`VS Code Server cleanup: ${e.message}`));
    },
  };
}
