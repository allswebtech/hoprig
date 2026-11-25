// "Projects found on this computer" in the dashboard: the three steps of hoprig adopt for a person who never opens a
// terminal. Only from the owner's own signed-in page: never Tia's door (ctx.caller 'self'), never a bearer token
// (another computer's link, Tia's token, a Work token): each route refuses with 403 before it reads anything.
//
//   GET  /api/adopt                 the usual places that are there (only stat'ed, none entered), the places of the
//                                   last look, its projects, and the plans there are
//   POST /api/adopt/scan { places } look in these folders (the owner's yes): each an absolute folder, not a disk's root
//   POST /api/adopt/home {}         find the projects of the home folder (his press): a look with a budget, then the
//                                   same look as above in the folders it found (src/adopt/home.mjs)
//   POST /api/adopt/plan { dir }    the plan of a project the last look found (no other folder is taken)
//   GET  /api/adopt/plan?name=<n>   a plan, as the page shows it
//   POST /api/adopt/apply { name, dryRun?, identity? }   apply it (dryRun: what it would do, nothing written)
//   POST /api/adopt/retire/check { name }   retire's own look: what goes, what stays and why, and a one-use ticket
//                                   bound to it for ten minutes (retireweb.mjs)
//   POST /api/adopt/retire { ticket, typed }   the old folders removed by retire itself, only when `typed` is the
//                                   project's name and retire finds now what the sheet showed; there is no undo
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture } from '../setup/system.mjs';
import { tildeText } from '../pcsetup/feature.mjs';
import { projectsDir } from '../pcsetup/projects.mjs';
import { NAME_RE } from '../pcsetup/workspace.mjs';
import { claudeDir, hoprigOwnDirs } from '../paths.mjs';
import { workspaceDir } from '../workspace/layout.mjs';
import { scanPlaces } from './scan.mjs';
import { makePlan, planFile, readPlan, writePlan } from './plan.mjs';
import { applyPlan, busyIn, doneFile } from './apply.mjs';
import { usualPlaces } from './cli.mjs';
import { pageRetire } from './retireweb.mjs';
import { ownerPageOnly } from '../workspace/whomay.mjs';
import { tokenIdOf } from '../machines/index.mjs';

// The code goes in `details`, which the server's errorBody sends, so the page can offer the right next step.
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code, details: { code } } : {}) });
// Words for the page where apply's own words name a terminal command (a person here may have no terminal).
const PAGE_WORDS = {
  ENOIDENTITY: () => 'The new folder\'s first commit needs a name and an e-mail, and git has none on this computer. Type your name and e-mail above, then press Arrange again. Nothing is set for other programs.',
  ECHANGED: (plan) => `${plan} changed after its plan was made (a file, a commit or a branch), so the plan may be wrong. Nothing was copied. Make the plan again, then arrange.`,
};
const keys = (b, allowed) => {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail(400, 'send a JSON object');
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw fail(400, `"${String(k).slice(0, 30)}" is not something this takes`);
};
const PLACES_MAX = 20;

/** `opts`: { home, projects, workspace, claude } for tests (else the real ones of this dashboard). */
export function adoptFeature(ctx, opts = {}) {
  const home = () => opts.home || os.homedir();
  const where = () => ({ projects: opts.projects ? opts.projects() : projectsDir(), workspace: opts.workspace ? opts.workspace() : workspaceDir(), claude: opts.claude ? opts.claude() : claudeDir() });
  const t = (s) => tildeText(s, home());
  let last = null; // the last look: { places, projects } (absolute paths, kept here only)
  let running = false;
  let looking = false; // a look over the home runs
  let retiring = false; // a retire runs
  const retirer = pageRetire({ projects: () => where().projects, tilde: (x) => t(x) });

  const ownPage = (req) => {
    const auth = String((req.headers && req.headers.authorization) || '');
    if (auth || (ctx.caller && ctx.caller(req) !== 'page')) throw fail(403, 'projects on this computer are arranged only from your own signed-in page here, not by Tia, a token or another computer', 'owner-page');
  };
  /** Removing old folders: the workspace's own rule of the owner's page (whomay.mjs), then this page's own. */
  const ownRetire = async (req) => {
    await ownerPageOnly(req, ctx, 'removing the old folders of a project', { tokenId: tokenIdOf });
    ownPage(req);
  };

  /** A folder the owner named: absolute, a real folder, not a disk's root. → its resolved path. */
  const place = (p) => {
    if (typeof p !== 'string' || !p || p.length > 1000 || /[\0\n\r]/.test(p)) throw fail(400, 'a folder is a path');
    const x = p.startsWith('~') ? path.join(home(), p.slice(1)) : p;
    if (!path.isAbsolute(x)) throw fail(400, `${p.slice(0, 80)} is not a full path (start it with / , ~ or a drive letter)`);
    const r = path.resolve(x);
    if (r === path.parse(r).root) throw fail(400, 'a whole disk is not looked at: name the folder your projects are in');
    let st;
    try {
      st = fs.statSync(r);
    } catch {
      throw fail(400, `${t(r)} is not there`);
    }
    if (!st.isDirectory()) throw fail(400, `${t(r)} is not a folder`);
    return r;
  };

  const shown = (projects) => projects.map((p) => ({
    name: p.name, dir: t(p.dir), layout: p.layout, ai: p.ai, neighbours: p.neighbours, privates: p.privates,
    planned: fs.existsSync(planFile(safeName(p.name))),
    ...arrangedOf(safeName(p.name)),
    repos: p.repos.map((r) => ({ ...r, dir: t(path.relative(p.dir, r.dir) || '.'), remote: r.remote ? t(r.remote) : null })),
  }));
  const safeName = (n) => (NAME_RE.test(n) ? n : 'project');
  /** Whether apply arranged this project, and where (its record, doneFile). */
  const arrangedOf = (n) => {
    try {
      const d = JSON.parse(fs.readFileSync(doneFile(n), 'utf8'));
      return { arranged: true, arrangedTo: t(String(d.to)) };
    } catch {
      return { arranged: false, arrangedTo: null };
    }
  };

  /** A plan for the page: paths with ~, nothing of a private folder (a plan never holds anything of one). */
  const planView = (p) => ({
    name: p.name, from: t(p.from), to: t(p.to), layout: p.layout, exists: fs.existsSync(p.to), made: p.made,
    repos: p.repos.map((r) => ({ rel: r.rel, to: r.to, visibility: r.visibility || null, worktrees: r.worktrees.map((w) => ({ from: t(w.from), to: w.to })) })),
    neighbours: p.neighbours.map((n) => ({ from: n.from, kind: n.kind, to: n.to, read: !!n.read, private: !!n.private, why: n.why || null })),
    tools: p.tools, sessions: p.sessions, breaks: p.breaks, notes: p.notes.map(t), nested: p.nested || [],
  });

  const routes = [
    ['GET', /^\/api\/adopt$/, async (req) => {
      ownPage(req);
      return { usual: usualPlaces(home()).map(t), places: last ? last.places.map((x) => ({ ...x, dir: t(x.dir) })) : [], projects: last ? shown(last.projects) : [], workspace: t(where().projects),
        home: last && last.home ? { ...last.home, links: last.home.links.map(t) } : null }; // what the look over the home did
    }],
    ['POST', /^\/api\/adopt\/scan$/, async (req) => {
      ownPage(req);
      const b = await ctx.readJson(req);
      keys(b, ['places']);
      if (!Array.isArray(b.places) || !b.places.length || b.places.length > PLACES_MAX) throw fail(400, `places: 1 to ${PLACES_MAX} folders`);
      const dirs = [...new Set(b.places.map(place))];
      const r = await scanPlaces(dirs);
      for (const p of r.projects) for (const x of p.repos) x.busy = (await busyIn([x.dir])) || 0;
      last = r;
      return { places: r.places.map((x) => ({ ...x, dir: t(x.dir) })), projects: shown(r.projects), privates: r.privates };
    }],
    // His press "Find the projects on this computer": a look over the home with a budget (src/adopt/home.mjs), then
    // the same scan as above of what it found. It answers within the budget; a second press while one runs is refused.
    ['POST', /^\/api\/adopt\/home$/, async (req) => {
      ownPage(req);
      keys(await ctx.readJson(req), []);
      if (looking) throw fail(409, 'Hoprig is already looking through your home folder: wait until it ends.');
      looking = true;
      try {
        const { findHome } = await import('./home.mjs');
        const w = where();
        const skip = [w.workspace, w.projects, w.claude, ...hoprigOwnDirs()];
        const r = await findHome({ home: home(), skip, projects: w.projects, usual: usualPlaces(home()), ...(opts.homeLook || {}) });
        for (const p of r.projects) for (const x of p.repos) x.busy = (await busyIn([x.dir])) || 0;
        last = r;
        const h = r.home;
        return { places: r.places.map((x) => ({ ...x, dir: t(x.dir) })), projects: shown(r.projects), privates: r.privates, home: { ...h, links: h.links.map(t) } };
      } finally {
        looking = false;
      }
    }],
    ['POST', /^\/api\/adopt\/plan$/, async (req) => {
      ownPage(req);
      const b = await ctx.readJson(req);
      keys(b, ['dir']);
      const found = last && last.projects.find((p) => t(p.dir) === b.dir || p.dir === b.dir);
      if (!found) throw fail(400, 'that is not a project of your last look: look again first');
      const w = where();
      // His press: the server is asked with this computer's sign-in whether each repository is public or private.
      const p = await makePlan(found.dir, { projects: w.projects, home: home(), claude: w.claude, ask: opts.ask || capture });
      writePlan(p);
      return planView(p);
    }],
    ['GET', /^\/api\/adopt\/plan$/, async (req, _m, q) => {
      ownPage(req);
      const name = q.get('name') || '';
      if (!NAME_RE.test(name)) throw fail(400, 'name: a project name');
      try {
        return planView(readPlan(name, { projects: where().projects }));
      } catch (e) {
        throw fail(e.code === 'EPLAN' ? 404 : 500, t(e.message));
      }
    }],
    ['POST', /^\/api\/adopt\/apply$/, async (req) => {
      ownPage(req);
      const b = await ctx.readJson(req);
      keys(b, ['name', 'dryRun', 'identity']);
      if (typeof b.name !== 'string' || !NAME_RE.test(b.name)) throw fail(400, 'name: a project name');
      if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') throw fail(400, 'dryRun is true or false');
      let identity = null;
      if (b.identity !== undefined) {
        keys(b.identity, ['name', 'email']);
        if (typeof b.identity.name !== 'string' || !/^[^\0-\x1f\x7f"\\<>]{1,100}$/.test(b.identity.name) || typeof b.identity.email !== 'string' || !/^[^\s@<>"\\]{1,64}@[A-Za-z0-9.-]{1,190}$/.test(b.identity.email)) throw fail(400, 'identity: a name and an e-mail');
        identity = { name: b.identity.name, email: b.identity.email };
      }
      if (running) throw fail(409, 'an arrange is running: wait until it ends');
      running = true;
      const w = where();
      const startedAt = Date.now();
      const report = async (x) => (await import('../field/wire.mjs')).reportAdopt(x, startedAt); // a field report (src/field)
      try {
        const r = await applyPlan(b.name, { projects: w.projects, workspace: w.workspace, dryRun: b.dryRun === true, identity });
        await report(r);
        return { ok: r.ok, dryRun: !!r.dryRun, to: t(r.plan.to), from: t(r.plan.from), lines: r.lines.map((l) => ({ ...l, words: t(l.words) })), needs: r.needs.map((n) => ({ ...n, words: t(n.words) })), error: r.error ? t(r.error) : null };
      } catch (e) {
        if (b.dryRun !== true) await report({ code: e.code });
        if (e.code) throw fail(e.code === 'EPLAN' ? 404 : 409, PAGE_WORDS[e.code] ? PAGE_WORDS[e.code](t(readPlan(b.name, { projects: w.projects }).from)) : t(e.message), e.code);
        throw e;
      } finally {
        running = false;
      }
    }],
    // After Arrange: the old folders removed from the page, as `hoprig adopt retire` does (retireweb.mjs). His own
    // page only, before anything is read; the name typed is compared here; retire checks everything again.
    ['POST', /^\/api\/adopt\/retire\/check$/, async (req) => {
      await ownRetire(req);
      const b = await ctx.readJson(req);
      keys(b, ['name']);
      if (typeof b.name !== 'string' || !NAME_RE.test(b.name)) throw fail(400, 'name: a project name');
      try {
        return await retirer.check(b.name);
      } catch (e) {
        throw fail(e.code === 'ENOTDONE' || e.code === 'EPLAN' ? 404 : 500, t(e.message), e.code);
      }
    }],
    ['POST', /^\/api\/adopt\/retire$/, async (req) => {
      await ownRetire(req);
      const b = await ctx.readJson(req);
      keys(b, ['ticket', 'typed']);
      if (b.typed !== undefined && (typeof b.typed !== 'string' || b.typed.length > 200)) throw fail(400, 'typed is the project\'s name as you typed it');
      if (retiring) throw fail(409, 'old folders are being removed: wait until it ends');
      retiring = true;
      const startedAt = Date.now();
      try {
        const r = await retirer.retire(b.ticket, b.typed);
        if (r.result === 'removed' || r.result === 'refused') await (await import('../field/wire.mjs')).reportRetire(r, startedAt); // a field report, as the command makes
        // Its old folder is gone: the last look no longer lists it as a project found here.
        if (r.result === 'removed' && last) last.projects = last.projects.filter((p) => safeName(p.name) !== r.name);
        return r;
      } finally {
        retiring = false;
      }
    }],
  ];
  return { name: 'adopt', routes };
}
