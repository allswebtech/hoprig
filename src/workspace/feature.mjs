// The workspace and the AI brain in the dashboard, as a server feature: { name, routes }.
//
//   GET  /api/workspace                 the tree: what is there, what each folder is for (workspaceStatus)
//   POST /api/workspace/setup { dryRun? }   create only what is missing; returns what was done (workspaceSetup)
//   GET  /api/brain                     what the AI knows: the index (brainIndex)
//   GET  /api/brain/item?id=<id>        the text of one item of that index (brainRead), size-capped, secrets masked
//   GET  /api/workspace/map             the map and, per repository, here | missing | different | unmapped; saved:
//                                       { unsaved, command? } (the map differs from the brain's last commit)
//   POST /api/workspace/map { dryRun? }                 write the map from what is on disk (never commits)
//   POST /api/workspace/map/commit                      save workspace.json, only it, in the brain's history
//                                                       (what the commitMap switch does; refused over staged changes;
//                                                       { done, already } when there is nothing to save)
//   POST /api/workspace/restore { url, dryRun? }        dryRun: the plan at once; else a background job
//   POST /api/workspace/sync { memory?, push?, with?, dryRun? }   a background job
//   GET  /api/workspace/job?from=N      the background job: { kind, running, lines, next, result }
//   POST /api/workspace/settings { dir?, projects? }    where the workspace and the projects folder are (nothing moves)
//   POST /api/workspace/forget { name }                 out of the map (no file is touched)
//   GET  /api/workspace/git             git name and e-mail set?, gh installed?, the GitHub account, the brain's remote
//   POST /api/workspace/git/identity { name, email }   the name and e-mail on commits (git config --global)
//   POST /api/workspace/git/signin      the GitHub sign-in without a terminal (gh's device flow, ghsignin.mjs):
//                                       { state, code, url }: the page shows the one-time code, the owner confirms it
//                                       on GitHub's own page, gh finishes by itself (then gh auth setup-git)
//   GET  /api/workspace/git/signin      how far it is: { state: idle | starting | code | done | failed | expired |
//                                       cancelled, code, url, account, error }
//   POST /api/workspace/git/signin/cancel   stop waiting for the code
//   POST /api/workspace/git/brain { owner?, name? }   the AI brain into a new PRIVATE GitHub repository, pushed with
//                                       its map (a background job, GET /api/workspace/job)
// No GitHub password and no token ever goes through these: GitHub asks on its own page, the token stays in gh.
//
// Behind the owner's login like every /api route, or another dashboard's machine token (the relay: the same owner
// looking at this computer). Tia's token is refused here. The page never sends a path for the brain view (only an
// id from the index); folders it sends for settings are checked like any typed folder.
import { jobUi, tildeText } from '../pcsetup/feature.mjs';
import { brainIndex, brainRead } from './brain.mjs';
import { capture, stream } from '../setup/system.mjs';
import { githubSignin } from './ghsignin.mjs';
import { gitState, startNew } from './gitstep.mjs';
import { projectsIn, workspaceDir, workspaceStatus } from './layout.mjs';
import { forget, mapSaved, mapStatus, updateMap } from './map.mjs';
import { syncWith } from './peer.mjs';
import { commitMap } from './upkeep.mjs';
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

  const signin = opts.signin || githubSignin();
  const NAME_OK = /^[^\0-\x1f\x7f"\\<>]{1,100}$/;
  const EMAIL_OK = /^[^\s@<>"\\]{1,64}@[A-Za-z0-9.-]{1,190}$/;
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
    ['POST', /^\/api\/workspace\/map\/commit$/, async (req) => {
      ownerOnly(req);
      keys(await sctx.readJson(req), []);
      const run = opts.run ? { run: opts.run } : {};
      // Nothing changed since the brain's last commit (or no map, or no git): nothing to save, and that is fine.
      if (!(await mapSaved({ dir: places().dir, ...run })).unsaved) return { done: true, already: true };
      const r = await commitMap({ dir: places().dir, ...run });
      if (!r.done) throw fail(409, r.staged ? 'the AI brain has other staged changes; nothing was saved, so they stay as they are' : `it could not be saved: ${tildeText(r.why)}`);
      return { done: true };
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
      };
    }],
    ['POST', /^\/api\/workspace\/git\/identity$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['name', 'email']);
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      const email = typeof b.email === 'string' ? b.email.trim() : '';
      if (!NAME_OK.test(name)) throw fail(400, 'a name is 1 to 100 characters, without quotes or < >');
      if (!EMAIL_OK.test(email)) throw fail(400, 'that does not look like an e-mail address');
      const run = opts.run || capture;
      for (const [k, val] of [['user.name', name], ['user.email', email]]) {
        const r = await run(['git', 'config', '--global', k, val]);
        if (!r.ok) throw fail(500, `git could not save it: ${(r.stderr || r.error || '').trim().split('\n').pop()}`);
      }
      return { name, email };
    }],
    ['POST', /^\/api\/workspace\/git\/signin$/, async (req) => {
      ownerOnly(req);
      keys(await sctx.readJson(req), []);
      return signin.start();
    }],
    ['GET', /^\/api\/workspace\/git\/signin$/, async (req) => {
      ownerOnly(req);
      return signin.state();
    }],
    ['POST', /^\/api\/workspace\/git\/signin\/cancel$/, async (req) => {
      ownerOnly(req);
      await sctx.readJson(req);
      return signin.cancel();
    }],
    ['POST', /^\/api\/workspace\/git\/brain$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['owner', 'name']);
      if (b.owner !== undefined && (typeof b.owner !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(b.owner))) throw fail(400, 'owner is a GitHub account name');
      if (b.name !== undefined && (typeof b.name !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(b.name))) throw fail(400, 'a repository name is letters, digits, ".", "_" and "-"');
      const dir = places().dir;
      const st = await (opts.gitState || gitState)({ dir });
      if (!st.gh.signedIn) throw fail(409, 'sign in to GitHub first');
      if (st.brain.remote) throw fail(409, 'the AI brain is on a git server already');
      return startJob('brain', async (onLine) => {
        const { ui } = jobUi(onLine);
        const ok = await (opts.startNew || startNew)(ui, { st, run: opts.run || capture, term: opts.stream || stream, dir, owner: b.owner || null, name: b.name || 'ai_brain' });
        return { ok: ok === true };
      });
    }],
  ];
  return { name: 'workspace', routes };
}
