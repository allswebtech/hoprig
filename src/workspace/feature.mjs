// The workspace and the AI brain in the dashboard, as a server feature: { name, routes }.
//
//   GET  /api/workspace                 the tree: what is there, what each folder is for (workspaceStatus)
//   POST /api/workspace/setup { dryRun? }   create only what is missing; returns what was done (workspaceSetup)
//   GET  /api/brain                     what the AI knows: the index (brainIndex)
//   GET  /api/brain/item?id=<id>        the text of one item of that index (brainRead), size-capped, secrets masked
//   GET  /api/workspace/map             the map and, per repository, here | missing | different | unmapped
//   POST /api/workspace/map { dryRun? }                 write the map from what is on disk (never commits)
//   POST /api/workspace/restore { url, dryRun? }        dryRun: the plan at once; else a background job
//   POST /api/workspace/sync { memory?, push?, with?, dryRun? }   a background job
//   GET  /api/workspace/job?from=N      the background job: { kind, running, lines, next, result }
//   POST /api/workspace/settings { dir?, projects? }    where the workspace and the projects folder are (nothing moves)
//   POST /api/workspace/forget { name }                 out of the map (no file is touched)
//   GET  /api/workspace/git             git name and e-mail set?, gh installed?, the GitHub account, the brain's remote
//   POST /api/workspace/git/terminal    opens a terminal session running `hoprig workspace git` (signing in is the
//                                       person's to do; the page never sees a code or a token)
//
// Behind the owner's login like every /api route, or another dashboard's machine token (the relay: the same owner
// looking at this computer). Tia's token is refused here. The page never sends a path for the brain view (only an
// id from the index); folders it sends for settings are checked like any typed folder.
import fs from 'node:fs';
import os from 'node:os';
import { jobUi, tildeText } from '../pcsetup/feature.mjs';
import { uniqueName } from '../server/validate.mjs';
import { brainIndex, brainRead } from './brain.mjs';
import { gitState } from './gitstep.mjs';
import { projectsIn, workspaceDir, workspaceStatus } from './layout.mjs';
import { forget, mapStatus, updateMap } from './map.mjs';
import { syncWith } from './peer.mjs';
import { setPlaces } from './places.mjs';
import { restoreWorkspace } from './restore.mjs';
import { workspaceSetup } from './setup.mjs';
import { syncAll } from './sync.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const LINES_MAX = 3000;
const bool = (v, what) => {
  if (v !== undefined && typeof v !== 'boolean') throw fail(400, `${what} is true or false`);
  return v === true;
};
const keys = (b, allowed) => {
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw fail(400, `"${String(k).slice(0, 30)}" is not something this takes`);
};

/** `opts`: { dir } a workspace folder of its own (the demo), { projectsDir } (tests), { gitState, restore, sync, syncWith } stand-ins. */
export function workspaceFeature(sctx, opts = {}) {
  const cfg = () => {
    const c = { ...(sctx.config ? sctx.config() : {}) };
    if (opts.dir) c.workspaceDir = opts.dir;
    return c;
  };
  const places = () => {
    const c = cfg();
    return { dir: workspaceDir(c), projects: opts.projectsDir ? opts.projectsDir() : projectsIn(c) };
  };
  const where = () => ({ cfg: cfg(), ...(opts.projectsDir ? { projectsDir: opts.projectsDir() } : {}) });
  const ownerOnly = (req) => {
    if (/^Bearer\s+tia_/i.test(String((req.headers && req.headers.authorization) || ''))) throw fail(403, 'the workspace is the owner\'s only');
  };

  let job = null; // one background job at a time: { kind, running, lines, result }
  function startJob(kind, fn) {
    if (job && job.running) throw fail(409, `${job.kind} is still running; wait until it finishes`);
    const j = { kind, running: true, lines: [], result: null };
    job = j;
    const onLine = (l) => {
      for (const x of String(l).split('\n')) j.lines.push(tildeText(x));
      if (j.lines.length > LINES_MAX) j.lines.splice(0, j.lines.length - LINES_MAX);
    };
    Promise.resolve()
      .then(() => fn(onLine))
      .then((data) => (j.result = { ok: data.ok !== false && !(Array.isArray(data.repos) && data.repos.some((r) => r.todo && r.todo.length)), data }))
      .catch((e) => {
        j.result = { ok: false, error: tildeText(e.message), status: e.status || 500 };
        onLine(e.message);
      })
      .finally(() => (j.running = false));
    return { started: true, kind };
  }

  const routes = [
    ['GET', /^\/api\/workspace$/, async (req) => {
      ownerOnly(req);
      return workspaceStatus(where());
    }],
    ['POST', /^\/api\/workspace\/setup$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['dryRun']);
      const r = await workspaceSetup({ ...where(), dryRun: bool(b.dryRun, 'dryRun') });
      return { ...r, status: workspaceStatus(where()) };
    }],
    ['GET', /^\/api\/brain$/, async (req) => {
      ownerOnly(req);
      const p = places();
      return brainIndex({ dir: p.dir, projects: p.projects });
    }],
    ['GET', /^\/api\/brain\/item$/, async (req, m, q) => {
      ownerOnly(req);
      const id = q.get('id');
      if (!id || id.length > 400) throw fail(400, 'name an item: ?id= from /api/brain');
      const p = places();
      return brainRead(id, { dir: p.dir, projects: p.projects });
    }],
    ['GET', /^\/api\/workspace\/map$/, async (req) => {
      ownerOnly(req);
      return mapStatus(places());
    }],
    ['POST', /^\/api\/workspace\/map$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['dryRun']);
      return updateMap({ ...places(), dryRun: bool(b.dryRun, 'dryRun') });
    }],
    ['POST', /^\/api\/workspace\/restore$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['url', 'dryRun']);
      if (typeof b.url !== 'string' || !b.url.trim() || b.url.length > 300) throw fail(400, 'give the address of your AI brain');
      const restore = opts.restore || restoreWorkspace;
      // The projects folder is restore's to decide (this computer's choice, else the map's): only the workspace here.
      const p = { dir: places().dir, ...(opts.projectsDir ? { projects: opts.projectsDir() } : {}) };
      if (bool(b.dryRun, 'dryRun')) return restore(b.url.trim(), { ui: jobUi(() => {}).ui, dryRun: true, ...p });
      return startJob('restore', (onLine) => restore(b.url.trim(), { ui: jobUi(onLine).ui, ...p }));
    }],
    ['POST', /^\/api\/workspace\/sync$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['memory', 'push', 'with', 'dryRun']);
      const o = { memory: bool(b.memory, 'memory'), push: bool(b.push, 'push'), dryRun: bool(b.dryRun, 'dryRun') };
      const p = places();
      if (b.with !== undefined) {
        if (typeof b.with !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(b.with)) throw fail(400, 'name a computer from the list');
        if (o.push || o.memory) throw fail(400, 'with another computer it only gets commits (pull only)');
        return startJob('sync', (onLine) => (opts.syncWith || syncWith)(b.with, { ...p, dryRun: o.dryRun, onLine }));
      }
      return startJob('sync', (onLine) => (opts.sync || syncAll)({ ...p, ...o, onLine }));
    }],
    ['GET', /^\/api\/workspace\/job$/, async (req, m, q) => {
      ownerOnly(req);
      const j = job || { kind: null, running: false, lines: [], result: null };
      const from = Math.max(0, Math.min(j.lines.length, Number(q && q.get('from')) || 0));
      return { kind: j.kind, running: j.running, lines: j.lines.slice(from), next: j.lines.length, result: j.result };
    }],
    ['POST', /^\/api\/workspace\/settings$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['dir', 'projects']);
      for (const k of ['dir', 'projects']) if (b[k] !== undefined && (typeof b[k] !== 'string' || b[k].length > 1000)) throw fail(400, `${k} is a folder`);
      const r = setPlaces({ dir: b.dir, projects: b.projects });
      return { ...r, status: workspaceStatus(where()) };
    }],
    ['POST', /^\/api\/workspace\/forget$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['name']);
      return forget(b.name, places().dir);
    }],
    ['GET', /^\/api\/workspace\/git$/, async (req) => {
      ownerOnly(req);
      const s = await (opts.gitState || gitState)({ dir: places().dir });
      return {
        git: s.git,
        identity: { set: Boolean(s.identity.name && s.identity.email), name: s.identity.name, email: s.identity.email },
        gh: { installed: s.gh.installed, signedIn: s.gh.signedIn, account: s.gh.account },
        gitUsesGh: s.helper,
        brain: s.brain,
        start: { method: 'POST', path: '/api/workspace/git/terminal' },
      };
    }],
    ['POST', /^\/api\/workspace\/git\/terminal$/, async (req) => {
      ownerOnly(req);
      await sctx.readJson(req);
      if (!sctx.backend || !sctx.deck) throw fail(503, 'no terminals here');
      const taken = (await sctx.backend.list()).map((t) => t.session);
      const name = uniqueName('git-setup', taken);
      const dir = fs.existsSync(places().dir) ? places().dir : os.homedir();
      await sctx.backend.create({ name, dir, argv: [...sctx.deck.launcher(), 'workspace', 'git'] });
      return { session: name };
    }],
  ];
  return { name: 'workspace', routes };
}
