// Settings → Skills in the dashboard, as a server feature: { name, routes, start, close }.
//
// Behind the owner's login like every /api route (or another dashboard's machine token: that is the same owner
// looking at this computer). Tia's token is not accepted here, and every project folder must be inside the
// dashboard's folders (server.roots).
//
//   GET  /api/skillhub?project=<dir>          installed skills (user, and the project), recent project folders, settings
//   GET  /api/skillhub/suggest?project=<dir>  catalog suggestions with their reasons (no project: the ones for you,
//                                             in every project)
//   GET  /api/skillhub/find?q=<words>         catalog + skills.sh search
//   POST /api/skillhub/review   { spec, project?, scope }   fetch into quarantine → the review (files, scan, SKILL.md)
//   POST /api/skillhub/approve  { id, overwriteLocal? }     install the reviewed files
//   POST /api/skillhub/cancel   { id }
//   POST /api/skillhub/check    { project? }                newer versions (network)
//   POST /api/skillhub/update-review { name, project? }     the review of an update, with the diff
//   POST /api/skillhub/remove   { name, project? }          POST /api/skillhub/undo { name, project? }
//   GET  /api/skillhub/tools                    tools catalog skills need: installed / latest / command
//   POST /api/skillhub/tools/<id>/update        run that command (the page asked the owner first)
//   POST /api/skillhub/settings { weekly }      the weekly update check (it only tells; it never installs)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recentFolders, reachRoots, within } from '../server/folders.mjs';
import * as hub from './hub.mjs';
import { hubDir } from './store.mjs';
import { catalogTools, checkTool, updateTool } from './tools.mjs';

const WEEK = 7 * 24 * 3600_000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const settingsFile = () => path.join(hubDir(), 'settings.json');

export function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return { weekly: s.weekly === true, lastCheck: Number(s.lastCheck) || 0, lastResult: Array.isArray(s.lastResult) ? s.lastResult : [] };
  } catch {
    return { weekly: false, lastCheck: 0, lastResult: [] };
  }
}

function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  fs.mkdirSync(hubDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s));
  return s;
}

/** A review for the page: everything except the server's own quarantine path. */
const forPage = (r) => {
  const { folder, ...rest } = r;
  return rest;
};

/** The catalog's skills meant for the person in every project (scope "user"), shaped like a project's suggestions. */
function forYou() {
  const have = new Set(hub.installed({}).skills.map((s) => s.name));
  const suggestions = hub.loadCatalog().entries.filter((e) => e.scope === 'user').map((e) => ({
    id: e.id, name: e.skill, for: e.for, license: e.license,
    source: e.bundled ? 'bundled with Hoprig' : `${e.repo}/${e.path}@${e.commit.slice(0, 7)}`,
    scope: 'user', why: ['useful in every project'], installed: have.has(e.skill), tool: e.tool ? e.tool.id : null,
    command: `hoprig skills add ${e.id} --user`,
  }));
  return { project: null, stacks: {}, artifacts: {}, repos: [], suggestions, ideas: [] };
}

/** `opts`: { checkEveryMs (tests), now() }. */
export function skillhubFeature(sctx, opts = {}) {
  const roots = () => reachRoots(sctx.config().server);
  const allowed = (real) => roots().some((r) => within(real, r));
  const projectOf = (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !path.isAbsolute(v) || v.includes('\0')) throw fail(400, 'a project is an absolute folder path');
    return v;
  };
  const scopeOpts = (b) => (projectOf(b.project) && b.scope !== 'user' ? { project: b.project } : {});
  const nameOf = (v) => {
    if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v)) throw fail(400, 'bad skill name');
    return v;
  };
  // Tia's own token never reaches these routes (the server does not trust it outside her call route); refuse it
  // here too, so a change in that rule cannot open skill installs to her.
  const ownerOnly = (req) => {
    if (/^Bearer\s+tia_/i.test(String(req.headers.authorization || ''))) throw fail(403, 'skills are managed by the owner only');
  };
  let timer = null;

  async function weeklyCheck() {
    const s = readSettings();
    const now = (opts.now || Date.now)();
    if (!s.weekly || now - s.lastCheck < WEEK) return null;
    const found = [];
    const scopes = [{}];
    for (const f of recentFolders([], roots(), 30)) if (fs.existsSync(path.join(f.path, '.claude', 'skills', '.hoprig-skills.json'))) scopes.push({ project: f.path });
    for (const sc of scopes) {
      const r = await hub.checkUpdates(sc, { allowed }).catch(() => []);
      for (const u of r) if (u.state === 'update') found.push({ name: u.name, project: sc.project || null });
    }
    writeSettings({ lastCheck: now, lastResult: found });
    if (found.length) {
      await Promise.resolve(sctx.notify({ title: `Skill updates: ${found.length}`, message: `${found.map((f) => f.name).join(', ')}. Review them in Settings → Skills.`, status: 'automation', session: '', url: '' })).catch(() => {});
    }
    return found;
  }

  const routes = [
    ['GET', /^\/api\/skillhub$/, async (req, m, q) => {
      ownerOnly(req);
      const project = projectOf(q.get('project'));
      const s = readSettings();
      return {
        user: hub.installed({}),
        home: os.homedir(), // shown as ~/… on the page
        project: project ? hub.installed({ project }, { allowed }) : null,
        projects: recentFolders([], roots(), 20).map((f) => ({ path: f.path, short: f.short, name: f.name })),
        settings: s,
      };
    }],
    ['GET', /^\/api\/skillhub\/suggest$/, async (req, m, q) => {
      ownerOnly(req);
      const project = projectOf(q.get('project'));
      return project ? hub.suggest(project, { allowed }) : forYou();
    }],
    ['GET', /^\/api\/skillhub\/find$/, async (req, m, q) => {
      ownerOnly(req);
      return hub.find(String(q.get('q') || ''), opts.fetch ? { fetchImpl: opts.fetch } : {});
    }],
    ['POST', /^\/api\/skillhub\/review$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      if (typeof b.spec !== 'string' || !b.spec.trim() || b.spec.length > 500) throw fail(400, 'name a skill');
      const sc = scopeOpts(b);
      return forPage(await hub.prepare(b.spec.trim(), { project: sc.project || null, forceProject: Boolean(sc.project) && b.scope === 'project', allowed }));
    }],
    ['POST', /^\/api\/skillhub\/approve$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      return hub.approve(b.id, { overwriteLocal: b.overwriteLocal === true });
    }],
    ['POST', /^\/api\/skillhub\/cancel$/, async (req) => {
      ownerOnly(req);
      hub.cancel((await sctx.readJson(req)).id);
      return { ok: true };
    }],
    ['POST', /^\/api\/skillhub\/check$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      const project = projectOf(b.project);
      return { user: await hub.checkUpdates({}), project: project ? await hub.checkUpdates({ project }, { allowed }) : null };
    }],
    ['POST', /^\/api\/skillhub\/update-review$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      return forPage(await hub.prepareUpdate(nameOf(b.name), scopeOpts(b), { allowed }));
    }],
    ['POST', /^\/api\/skillhub\/remove$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      hub.remove(nameOf(b.name), scopeOpts(b), { allowed });
      return { ok: true };
    }],
    ['POST', /^\/api\/skillhub\/undo$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      hub.undo(nameOf(b.name), scopeOpts(b), { allowed });
      return { ok: true };
    }],
    ['GET', /^\/api\/skillhub\/tools$/, async (req) => {
      ownerOnly(req);
      return { tools: await Promise.all(catalogTools().map((t) => checkTool(t, opts.toolRun ? { run: opts.toolRun } : {}))) };
    }],
    ['POST', /^\/api\/skillhub\/tools\/([a-z0-9-]+)\/update$/, async (req, m) => {
      ownerOnly(req);
      await sctx.readJson(req);
      const t = catalogTools().find((x) => x.id === m[1]);
      if (!t) throw fail(404, 'no such tool');
      const checked = await checkTool(t, opts.toolRun ? { run: opts.toolRun } : {});
      const lines = [];
      const r = await updateTool(checked, { onLine: (l) => lines.push(l), ...(opts.toolStream ? { run: opts.toolStream } : {}) });
      return { ok: r.ok, command: checked.commandText, output: lines.slice(-60).join('\n') };
    }],
    ['POST', /^\/api\/skillhub\/settings$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      if (typeof b.weekly !== 'boolean') throw fail(400, 'weekly is true or false');
      return writeSettings({ weekly: b.weekly });
    }],
  ];

  return {
    name: 'skillhub',
    routes,
    weeklyCheck,
    start() {
      // Hourly look; the real check runs once a week and only when the owner turned it on.
      timer = setInterval(() => weeklyCheck().catch(() => {}), opts.checkEveryMs || 3600_000);
      timer.unref?.();
    },
    close() {
      clearInterval(timer);
    },
  };
}
