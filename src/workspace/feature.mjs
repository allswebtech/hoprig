// The workspace and the AI brain in the dashboard, as a server feature: { name, routes }.
//
//   GET  /api/workspace                 the tree: what is there, what each folder is for (workspaceStatus)
//   POST /api/workspace/setup { dryRun? }   create only what is missing; returns what was done (workspaceSetup)
//   GET  /api/brain                     what the AI knows: the index (brainIndex)
//   GET  /api/brain/item?id=<id>        the text of one item of that index (brainRead), size-capped, secrets masked
//   GET  /api/workspace/link            what linking each coding tool's folders to the brain would do (link.mjs planLink):
//                                       { brain (it exists), entries: [{ id, tool, tools, what, link, target, action,
//                                       words, why? }], tools: [{ id, name, state: linked|todo|left, todo, left }],
//                                       todo, already }
//   POST /api/workspace/link {}         do it (applyLink); each entry with `done` or `error`; a conflict is left alone
//   GET  /api/workspace/map             the map and, per repository, here | missing | different | unmapped; saved:
//                                       { unsaved, command? } (the map differs from the brain's last commit)
//   POST /api/workspace/map { dryRun? }                 write the map from what is on disk (never commits)
//   POST /api/workspace/map/commit                      save workspace.json, only it, in the brain's history
//                                                       (what the commitMap switch does; refused over staged changes;
//                                                       { done, already } when there is nothing to save)
//   POST /api/workspace/restore { url, dryRun?, withProjects? }  dryRun: the plan at once; else a background job; no
//                                                       project is cloned unless withProjects
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
//   GET  /api/workspace/computers       this computer's label (or a suggestion) and which computer has what
//   POST /api/workspace/label { label, again? }   give this computer its label (once); 409 code ETAKEN for a label
//                                       another computer's file holds (again: this computer IS that one, set up again)
//   GET  /api/workspace/whohas         which computer has what (whohas.mjs): every place's entries, here and only in
//                                       the map, each computer's file with when it was written; read only
//   GET  /api/workspace/find?in=<place> what the hosting site has that fits a place's naming rule (read only, no --add)
//   POST /api/workspace/drop/check { name }   drop's --check (read only); from the owner's own page also a one-use
//                                       ticket for the sheet (dropweb.mjs)
//   POST /api/workspace/drop { ticket, work?, defaults?, typed? }   the drop: the owner's own page only (whomay.mjs)
//   POST /api/workspace/group { dir, repo?, holds?, dryRun?, writeIgnore? }   group add (groupcmd.mjs); a real one:
//                                       the owner's own page only; a dry run says what goes into the map
//   POST /api/workspace/group/remove { dir, dryRun? }   out of the map, never its folder (the owner's own page only)
//   GET  /api/workspace/rules           the "Your workspace" text for coding sessions and its file's state
//   POST /api/workspace/rules {}        write it (the owner's own page only; never by a group add itself)
//   GET  /api/workspace/git/brains      the owner's brains on GitHub that hold a map: { signedIn, brains: [{ owner, name, url }],
//                                       error? } (error: GitHub could not be asked, so no new workspace is offered)
//   POST /api/workspace/git/brain { owner?, name? }   the AI brain into a new PRIVATE GitHub repository, pushed with
//                                       its map (a background job, GET /api/workspace/job)
//   GET  /api/workspace/git/brain       its files not saved to its git server yet: { count, files, more, repo, ahead,
//                                       behind, upstream } (brainsave.mjs)
//   POST /api/workspace/mylink { path, dryRun? }   "This link is mine" on a project's page: the same step as
//                                       `hoprig workspace mylink add <path>` (inside.mjs addMyLink); dryRun: where it
//                                       leads, nothing saved (the sheet before his yes)
//   POST /api/workspace/git/brain/moveout { files }   the owner's yes on the save sheet's key refusal: the named files
//                                       the save refuses are moved to the folder beside the brain the sheet named
//                                       (brainmove.mjs), never deleted; each name is checked again here
//   POST /api/workspace/git/brain { save: true, seen }   the owner's yes: save them and upload, a background job; the
//                                       owner's own page only; refused when the files are not those his sheet showed
// No GitHub password and no token ever goes through these: GitHub asks on its own page, the token stays in gh.
//
// Behind the owner's login like every /api route, or another dashboard's machine token (the relay: the same owner
// looking at this computer). Tia's token is refused here. The page never sends a path for the brain view (only an
// id from the index); folders it sends for settings are checked like any typed folder.
import fs from 'node:fs';
import path from 'node:path';
import { jobUi, tildeText } from '../pcsetup/feature.mjs';
import { brainIndex, brainRead } from './brain.mjs';
import { foldersHere } from './where.mjs';
import { findTool } from '../codetools/index.mjs';
import { applyLink, planLink, planWords } from './link.mjs';
import { capture, stream } from '../setup/system.mjs';
import { githubSignin } from './ghsignin.mjs';
import { brainCandidates, gitState, startNew } from './gitstep.mjs';
import { brainChanges, saveBrain } from './brainsave.mjs';
import { moveOut } from './brainmove.mjs';
import { addMyLink } from './inside.mjs';
import { brainDir, projectsIn, workspaceDir, workspaceStatus } from './layout.mjs';
import { forget, mapSaved, mapStatus, updateMap } from './map.mjs';
import { syncWith } from './peer.mjs';
import { commitMap } from './upkeep.mjs';
import { setPlaces } from './places.mjs';
import { restoreWorkspace } from './restore.mjs';
import { workspaceSetup } from './setup.mjs';
import { syncAll } from './sync.mjs';
import { withRepoLock } from '../work/lock.mjs';
import { tokenIdOf } from '../machines/index.mjs';
import { pageDrop } from './dropweb.mjs';
import { ownerPageOnly } from './whomay.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
/** `fn` holding the AI brain's lock (src/work/lock.mjs), waiting a moment for the upkeep or a save; else 409. */
const brainLocked = (dir, fn) => withRepoLock(path.join(dir, 'ai_brain'), fn, { wait: 2_000 });
/** A dry run writes nothing, not even the lock's file. */
const dryOrLocked = (dry, dir, fn) => (dry ? fn() : brainLocked(dir, fn));
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

  // The link plan for the page: short paths only (never a full path), and the plain words of each action.
  const linkOpts = () => ({ brain: brainDir(places().dir), ...(opts.link || {}) });
  const linkView = (list) => {
    const entries = list.map((p) => ({
      id: p.id, tool: p.tool, tools: p.tools, what: p.what, ...(p.short ? { short: p.short } : {}), link: p.linkShort, target: p.targetShort, action: p.action, words: tildeText(planWords(p)),
      ...(p.why ? { why: tildeText(p.why) } : {}), ...(p.done ? { done: tildeText(p.done) } : {}), ...(p.error ? { error: tildeText(p.error) } : {}),
    }));
    // Per coding tool that is on: linked (everything of it is), todo (something to link) or left (only conflicts left).
    const tools = [...new Set(entries.flatMap((e) => e.tools || []))].map((id) => {
      const mine = entries.filter((e) => (e.tools || []).includes(id));
      const todo = mine.filter((e) => !['already', 'conflict'].includes(e.action) && !e.error).length;
      const left = mine.filter((e) => e.action === 'conflict' || e.error).length;
      return { id, name: findTool(id)?.name || id, state: !todo && !left ? 'linked' : todo ? 'todo' : 'left', todo, left };
    });
    return { entries, tools, todo: entries.filter((e) => !['already', 'conflict'].includes(e.action)).length, already: entries.every((e) => e.action === 'already') };
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

  const drops = pageDrop({ ctx: places, tilde: (t) => tildeText(t), ...(opts.run ? { run: opts.run } : {}), ...(opts.share ? { share: opts.share } : {}) });
  const mine = (req, what, o = {}) => ownerPageOnly(req, sctx, what, { tokenId: tokenIdOf, ...o });
  const NAME = /^[A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._-]{1,100}){0,3}$/;
  const nameOf = (v, what = 'name a project of the map') => {
    if (typeof v !== 'string' || !NAME.test(v)) throw fail(400, what);
    return v;
  };
  const isMine = async (req) => {
    try {
      await mine(req, 'it');
      return true;
    } catch {
      return false;
    }
  };

  const routes = [
    ['GET', /^\/api\/workspace\/whohas$/, async (req) => {
      ownerOnly(req);
      const w = await import('./whohas.mjs');
      return w.whoHas({ ...places(), machines: await w.machineNames(), ...(opts.run ? { run: opts.run } : {}) });
    }],
    ['GET', /^\/api\/workspace\/find$/, async (req, m, q) => {
      ownerOnly(req);
      const place = q.get('in');
      if (!place || place.length > 200) throw fail(400, 'say the place: ?in=<group> or <group>/<held folder>');
      const { findInPlace } = await import('./findcmd.mjs');
      return findInPlace(place, { ...places(), ...(opts.gh ? { gh: opts.gh } : {}), ...(opts.site ? { site: opts.site } : {}) });
    }],
    ['POST', /^\/api\/workspace\/drop\/check$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['name']);
      // Read only for anyone who may read the workspace; the sheet's ticket only for the owner's own page.
      return drops.check(nameOf(b.name), { ticket: await isMine(req) });
    }],
    ['POST', /^\/api\/workspace\/drop$/, async (req) => {
      ownerOnly(req);
      await mine(req, 'a drop');
      const b = await sctx.readJson(req);
      keys(b, ['ticket', 'work', 'defaults', 'typed']);
      if (b.work !== undefined && typeof b.work !== 'boolean') throw fail(400, 'work is true or false');
      if (b.typed !== undefined && (typeof b.typed !== 'string' || b.typed.length > 200)) throw fail(400, 'typed is the name you typed');
      if (b.defaults !== undefined && (!b.defaults || typeof b.defaults !== 'object' || Array.isArray(b.defaults) || Object.values(b.defaults).some((v) => !['push', 'wip', 'stop'].includes(v)))) throw fail(400, 'each default branch is answered push, wip or stop');
      return drops.drop(b.ticket, { work: b.work === true, defaults: b.defaults || {}, typed: b.typed || '' });
    }],
    ['POST', /^\/api\/workspace\/group$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['dir', 'repo', 'holds', 'dryRun', 'writeIgnore']);
      const dry = bool(b.dryRun, 'dryRun');
      if (!dry) await mine(req, 'a change of the groups of the map');
      for (const k of ['dir', 'repo', 'holds']) if (b[k] !== undefined && (typeof b[k] !== 'string' || b[k].length > 300)) throw fail(400, `${k} is text`);
      if (typeof b.dir !== 'string' || !b.dir.trim()) throw fail(400, 'name the group\'s folder');
      const { groupAdd } = await import('./groupcmd.mjs');
      const p = places();
      const go = () => groupAdd(b.dir.trim(), { ...(b.repo ? { repo: b.repo.trim() } : {}), ...(b.holds ? { holds: b.holds.trim() } : {}), dryRun: dry, writeIgnore: bool(b.writeIgnore, 'writeIgnore'), ...p, ...(opts.run ? { run: opts.run } : {}) });
      const r = await (dry ? go() : brainLocked(p.dir, go));
      return { ...r, ...(r.ignore ? { ignore: { ...r.ignore, file: tildeText(r.ignore.file) } } : {}), notes: (r.notes || []).map((t) => tildeText(t)) };
    }],
    ['POST', /^\/api\/workspace\/group\/remove$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['dir', 'dryRun']);
      const dry = bool(b.dryRun, 'dryRun');
      if (!dry) await mine(req, 'a change of the groups of the map');
      if (typeof b.dir !== 'string' || !b.dir.trim() || b.dir.length > 300) throw fail(400, 'name the group\'s folder');
      const { groupRemove } = await import('./groupcmd.mjs');
      const p = places();
      return dry ? groupRemove(b.dir.trim(), { dryRun: true, dir: p.dir }) : brainLocked(p.dir, () => groupRemove(b.dir.trim(), { dir: p.dir }));
    }],
    ['GET', /^\/api\/workspace\/rules$/, async (req) => {
      ownerOnly(req);
      const w = await import('../pcsetup/wsrules.mjs');
      const r = await w.currentWorkspaceRules(places());
      const st = w.workspaceRulesState({ text: r.text });
      return { text: tildeText(r.text), left: r.left, file: tildeText(st.file), state: w.rulesFileState(st), ...(w.notWrittenWhy(st) ? { why: tildeText(w.notWrittenWhy(st)) } : {}) };
    }],
    ['POST', /^\/api\/workspace\/rules$/, async (req) => {
      ownerOnly(req);
      await mine(req, 'writing the text for coding sessions');
      keys(await sctx.readJson(req), []);
      const w = await import('../pcsetup/wsrules.mjs');
      const r = w.writeWorkspaceRules({ text: (await w.currentWorkspaceRules(places())).text });
      return { file: tildeText(r.file), changed: r.changed };
    }],
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
      return brainIndex({ dir: p.dir, projects: p.projects, groups: (await foldersHere({ dir: p.dir, projects: p.projects })).folders });
    }],
    ['GET', /^\/api\/brain\/item$/, async (req, m, q) => {
      ownerOnly(req);
      const id = q.get('id');
      if (!id || id.length > 400) throw fail(400, 'name an item: ?id= from /api/brain');
      const p = places();
      return brainRead(id, { dir: p.dir, projects: p.projects, groups: (await foldersHere({ dir: p.dir, projects: p.projects })).folders });
    }],
    ['GET', /^\/api\/workspace\/link$/, async (req) => {
      ownerOnly(req);
      const o = linkOpts();
      return { brain: fs.existsSync(o.brain), ...linkView(planLink(o)) };
    }],
    ['POST', /^\/api\/workspace\/link$/, async (req) => {
      ownerOnly(req);
      keys(await sctx.readJson(req), []);
      return linkView(applyLink(linkOpts()));
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
      // The brain's lock, as the upkeep holds it: a save never lands between the steps of the map's rule.
      return brainLocked(places().dir, async () => {
        // Nothing changed since the brain's last commit (or no map, or no git): nothing to save, and that is fine.
        if (!(await mapSaved({ dir: places().dir, ...run })).unsaved) return { done: true, already: true };
        const r = await commitMap({ dir: places().dir, ...run });
        if (!r.done) throw fail(409, r.staged ? 'the AI brain has other staged changes; nothing was saved, so they stay as they are' : `it could not be saved: ${tildeText(r.why)}`);
        return { done: true };
      });
    }],
    ['POST', /^\/api\/workspace\/restore$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['url', 'dryRun', 'withProjects']);
      if (typeof b.url !== 'string' || !b.url.trim() || b.url.length > 300) throw fail(400, 'give the address of your AI brain');
      const restore = opts.restore || restoreWorkspace;
      // The projects folder is restore's to decide (this computer's choice, else the map's): only the workspace here.
      // No project is cloned unless the owner asks for every one (withProjects).
      const p = { dir: places().dir, ...(opts.projectsDir ? { projects: opts.projectsDir() } : {}), ...(bool(b.withProjects, 'withProjects') ? { withProjects: true } : {}) };
      if (bool(b.dryRun, 'dryRun')) return restore(b.url.trim(), { ui: jobUi(() => {}).ui, dryRun: true, ...p });
      return startJob('restore', (onLine) => restore(b.url.trim(), { ui: jobUi(onLine).ui, ...p }));
    }],
    ['POST', /^\/api\/workspace\/sync$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['memory', 'push', 'with', 'dryRun']);
      const o = { memory: bool(b.memory, 'memory'), push: bool(b.push, 'push'), dryRun: bool(b.dryRun, 'dryRun') };
      // Uploading (push, and the memory commit it pushes) is the owner's: his page, or Tia's card he confirmed. A
      // script's token or another dashboard's gets the dry run and the pull-only sync.
      // Uploading is his own press on this page: Tia's card for it only opens the page (domains.mjs workspace_sync).
      if (o.push && !o.dryRun) await mine(req, 'a sync that pushes');
      else if (o.memory && !o.dryRun) await mine(req, 'a sync that commits the memory', { card: true });
      const p = places();
      if (b.with !== undefined) {
        if (typeof b.with !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(b.with)) throw fail(400, 'name a computer from the list');
        if (o.push || o.memory) throw fail(400, 'with another computer it only gets commits (pull only)');
        return startJob('sync', (onLine) => dryOrLocked(o.dryRun, p.dir, () => (opts.syncWith || syncWith)(b.with, { ...p, dryRun: o.dryRun, onLine })));
      }
      return startJob('sync', (onLine) => dryOrLocked(o.dryRun, p.dir, () => (opts.sync || syncAll)({ ...p, ...o, onLine })));
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
    // This computer in the workspace (computer.mjs): its label, given once, and which computer has what.
    ['GET', /^\/api\/workspace\/computers$/, async () => {
      const c = await import('./computer.mjs');
      const who = c.whoHasWhat(places().dir);
      return { ...who, ...(who.label ? {} : { suggestion: c.suggestLabel() }) };
    }],
    ['POST', /^\/api\/workspace\/label$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['label', 'again']);
      if (typeof b.label !== 'string' || b.label.length > 64) throw fail(400, 'give this computer a short name');
      const c = await import('./computer.mjs');
      const { dir, projects } = places();
      try {
        return await brainLocked(dir, () => c.setLabel(b.label, { dir, projects, again: bool(b.again, 'again') }));
      } catch (e) {
        throw Object.assign(fail(e.status || 400, e.message), e.code ? { code: e.code } : {});
      }
    }],
    // Set-up's one path in the page: the owner's brain on GitHub (a repository of his with "brain" in its name that
    // holds a map), so the page offers to get it, or to start a workspace when there is none.
    ['GET', /^\/api\/workspace\/git\/brains$/, async () => {
      const dir = places().dir;
      const st = await (opts.gitState || gitState)({ dir });
      if (!st.gh.signedIn) return { signedIn: false, brains: [] };
      const got = await (opts.brainCandidates || brainCandidates)(opts.run || capture);
      const { list, failed } = Array.isArray(got) ? { list: got, failed: '' } : got;
      const brains = list.filter((x) => x.hasMap).slice(0, 9).map(({ owner, name, url }) => ({ owner, name, url }));
      // GitHub could not be asked: the page offers no new workspace (the owner's brain may be one it could not see).
      return { signedIn: true, brains, ...(failed && !brains.length ? { error: `GitHub could not be asked about your workspace: ${failed}` } : {}) };
    }],
    // The brain's files not saved to its git server yet, for the page's sheet: the first few names, how many more,
    // the repository's name. Read only.
    ['GET', /^\/api\/workspace\/git\/brain$/, async (req) => {
      ownerOnly(req);
      const c = await (opts.brainChanges || brainChanges)({ dir: places().dir, run: opts.run || capture });
      return c && c.movedOut ? { ...c, movedOut: tildeText(c.movedOut) } : c;
    }],
    // "This link is mine": a link in the workspace that leads out is followed from now on, on this computer. The same
    // function as the command; the owner's own page only, as the save is. The dry run is his sheet's question.
    ['POST', /^\/api\/workspace\/mylink$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['path', 'dryRun', 'seen']);
      if (typeof b.path !== 'string' || !path.isAbsolute(b.path) || b.path.length > 4096 || b.path.includes('\0')) throw fail(400, 'path is the full path of the link');
      const dry = bool(b.dryRun, 'dryRun');
      await mine(req, 'naming a link as yours');
      // His yes names the place his sheet showed by the dry run's `seen` (an exact value of the real place, not the
      // page's text of it, which writes the home as ~): only that place is saved.
      if (!dry && (typeof b.seen !== 'string' || !/^[0-9a-f]{64}$/.test(b.seen))) throw fail(400, 'seen is where the sheet showed the link leads: open it again');
      const p = places();
      const r = (opts.addMyLink || addMyLink)(b.path, { dir: p.dir, projects: p.projects }, { dryRun: dry, ...(dry ? {} : { seen: b.seen }) });
      return { ok: true, path: tildeText(r.path), to: tildeText(r.to), added: r.added, ...(dry ? { dryRun: true, seen: r.seen } : {}), ...(r.moved ? { moved: tildeText(r.moved) } : {}) };
    }],
    // The save sheet's Move out: the owner's press on his own page only, as the save is (never Tia, a script's or a
    // session's token, another site, or by itself). The names come from the sheet; brainmove.mjs checks each again
    // against this moment's refusal list, inside the brain, never a private folder or a link that leads out.
    ['POST', /^\/api\/workspace\/git\/brain\/moveout$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['files', 'seen']);
      if (!Array.isArray(b.files) || !b.files.length || b.files.length > 500 || b.files.some((f) => typeof f !== 'string' || !f || f.length > 4096)) throw fail(400, 'files are the paths the sheet named');
      if (typeof b.seen !== 'string' || !/^[0-9a-f]{64}$/.test(b.seen)) throw fail(400, 'seen is the list the sheet showed: open the save again');
      await mine(req, 'moving files out of the AI brain');
      const dir = places().dir;
      const r = await brainLocked(dir, () => (opts.moveOut || moveOut)({ dir, files: b.files, seen: b.seen, run: opts.run || capture }));
      return { ok: true, folder: tildeText(r.folder), moved: r.moved.map((m) => ({ from: m.from, to: tildeText(m.to) })), untracked: r.untracked };
    }],
    ['POST', /^\/api\/workspace\/git\/brain$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      if (b && b.save !== undefined) {
        // { save: true }: the owner's yes in the sheet: save the brain's changes and upload them, as a job. Only his
        // own page (or a hub of his, relayed): never Tia, a script's or a session's token, never by itself.
        keys(b, ['save', 'seen']);
        if (b.save !== true) throw fail(400, 'save is true or left out');
        // The list his sheet showed (brainChanges' seen): only those files are saved, never one that came after. A page
        // of an older Hoprig (a hub not updated yet) sends none: it saves as it did before.
        if (b.seen !== undefined && (typeof b.seen !== 'string' || !/^[0-9a-f]{64}$/.test(b.seen))) throw fail(400, 'seen is the list the sheet showed: open the sheet again');
        await mine(req, 'saving the AI brain to its git server (it uploads it)');
        const dir = places().dir;
        const seen = b.seen;
        return startJob('brain-save', (onLine) => (opts.saveBrain || saveBrain)({ dir, run: opts.run || capture, onLine, seen }));
      }
      await mine(req, 'starting the AI brain on GitHub (it pushes it)');
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
