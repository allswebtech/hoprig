// The workspace and the AI brain in the dashboard, as a server feature: { name, routes }.
//
//   GET  /api/workspace                 the tree: what is there, what each folder is for (workspaceStatus)
//   POST /api/workspace/setup { dryRun? }   create only what is missing; returns what was done (workspaceSetup)
//   GET  /api/brain                     what the AI knows: the index (brainIndex)
//   GET  /api/brain/item?id=<id>        the text of one item of that index (brainRead), size-capped, secrets masked
//
// Behind the owner's login like every /api route, or another dashboard's machine token (the relay: the same owner
// looking at this computer). Tia's token is refused here. The page never sends a path: only an id from the index.
import { brainIndex, brainRead } from './brain.mjs';
import { projectsIn, workspaceDir, workspaceStatus } from './layout.mjs';
import { workspaceSetup } from './setup.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

/** `opts`: { dir } a workspace folder of its own (the demo), { projectsDir } (tests). */
export function workspaceFeature(sctx, opts = {}) {
  const cfg = () => {
    const c = { ...(sctx.config ? sctx.config() : {}) };
    if (opts.dir) c.workspaceDir = opts.dir;
    return c;
  };
  const where = () => {
    const c = cfg();
    return { cfg: c, ...(opts.projectsDir ? { projectsDir: opts.projectsDir() } : {}) };
  };
  const brainOpts = () => {
    const c = cfg();
    return { dir: workspaceDir(c), projects: opts.projectsDir ? opts.projectsDir() : projectsIn(c) };
  };
  const ownerOnly = (req) => {
    if (/^Bearer\s+tia_/i.test(String((req.headers && req.headers.authorization) || ''))) throw fail(403, 'the workspace is the owner\'s only');
  };
  const routes = [
    ['GET', /^\/api\/workspace$/, async (req) => {
      ownerOnly(req);
      return workspaceStatus(where());
    }],
    ['POST', /^\/api\/workspace\/setup$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') throw fail(400, 'dryRun is true or false');
      const r = await workspaceSetup({ ...where(), dryRun: b.dryRun === true });
      return { ...r, status: workspaceStatus(where()) };
    }],
    ['GET', /^\/api\/brain$/, async (req) => {
      ownerOnly(req);
      return brainIndex(brainOpts());
    }],
    ['GET', /^\/api\/brain\/item$/, async (req, m, q) => {
      ownerOnly(req);
      const id = q.get('id');
      if (!id || id.length > 400) throw fail(400, 'name an item: ?id= from /api/brain');
      return brainRead(id, brainOpts());
    }],
  ];
  return { name: 'workspace', routes };
}
