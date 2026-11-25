// The routes of "Do it" and the runs (doit.mjs), beside Work's own (feature.mjs, which adds these):
//
//   GET  /api/work/items/<id>/do?at=N&project=&folder=&tool=   what Start would start: the brief, the projects and
//                                        their folders, the coding tools, providers, models, efforts and the defaults
//   POST /api/work/items/<id>/do { at, brief? | seen?, project?, folder?, tool?, provider?, model?, effort?, dryRun? }
//                                        start a run → { run, existing? } (existing: a run of it works already); the
//                                        brief written, or `seen`, the task's brief as shown (409 when it changed since)
//   POST /api/work/items/<id>/accept { at }              a task in review is done
//   POST /api/work/items/<id>/send-back { at, text }     open again; the text is added to the brief of the next run
//   POST /api/work/items/<id>/remove-branch {}           the branch of its Do it runs and its worktree go, when no
//                                        commit of it is only there and nothing is left uncommitted (else kept: why)
//   GET  /api/work/runs?item=&project=&day=&id=          the runs, newest first (Activity, a task's runs; id: that one run)
//   POST /api/work/command/do            `hoprig tasks do` on this computer: { id, brief? | seen?, project?, folder?,
//                                        tool?, provider?, model?, effort?, dryRun? } with the command token (below)
//
// Every id, project and folder from the browser is checked here: an item by its id and place, a project by name among
// the workspace's projects, a folder as one of that project's choices (folders.mjs), never a path. Nothing of a file
// outside the Work folder can be read through these routes, and no full path leaves the server.
//
// The command token: a random token in Hoprig's state folder (mode 600, new at every start), which `hoprig tasks do`
// reads to start a run through the running dashboard. It is good for that one route and nothing else; whoever can
// read the state folder is the owner already (his config and password hash are there).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { ID_RE, PROJECT_RE, isYmd } from './model.mjs';
import { RUN_ID_RE, cleanFolder } from './runs.mjs';
import { runUse } from './runuse.mjs';

export const COMMAND_PATH = '/api/work/command/do';
// The token goes in a header of its own, not as a bearer: a bearer token is another computer's (src/machines).
export const COMMAND_HEADER = 'x-hoprig-work-command';
export const commandTokenFile = () => path.join(stateDir(), 'work-command-token');
const TOKEN_RE = /^hwc_[0-9a-f]{64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,119}$/; // also "sonnet[1m]", as Settings allows

const fail = (status, message) => Object.assign(new Error(message), { status });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (b, allowed) => {
  if (!isObj(b)) throw fail(400, 'the body must be a JSON object');
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw fail(400, `"${String(k).slice(0, 30)}" is not something this takes`);
};

/** The choices of a start, checked: { brief, project, folder, tool, provider, model, effort } (undefined: not given). */
export function cleanChoices(b) {
  const out = {};
  const str = (k, re, what) => {
    if (b[k] === undefined || b[k] === null || b[k] === '') return;
    if (typeof b[k] !== 'string' || !re.test(b[k])) throw fail(400, `that is not ${what}`);
    out[k] = b[k];
  };
  str('project', PROJECT_RE, 'a project of the workspace');
  str('tool', /^[a-z]{1,20}$/, 'a coding tool');
  str('provider', NAME_RE, 'a provider');
  str('model', MODEL_RE, 'a model');
  str('effort', /^[a-z]{1,20}$/, 'an effort');
  if (b.folder !== undefined && b.folder !== null) {
    if (!cleanFolder(b.folder)) throw fail(400, 'choose the project\'s own folder or one of its code repositories');
    out.folder = b.folder;
  }
  if (b.brief !== undefined && b.brief !== null) {
    if (typeof b.brief !== 'string' || b.brief.length > 8000) throw fail(400, 'the brief is text of up to 4000 characters');
    out.brief = b.brief;
  }
  if (b.seen !== undefined && b.seen !== null) {
    if (typeof b.seen !== 'string' || b.seen.length > 8000) throw fail(400, 'seen is the brief that was shown, as text');
    out.seen = b.seen;
  }
  if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') throw fail(400, 'dryRun is true or false');
  // In the project's folder itself, not on a branch of its own (the default for a git repository).
  if (b.inFolder !== undefined && b.inFolder !== null) {
    if (typeof b.inFolder !== 'boolean') throw fail(400, 'inFolder is true or false');
    if (b.inFolder) out.inFolder = true;
  }
  return out;
}

const CHOICES = ['brief', 'seen', 'project', 'folder', 'tool', 'provider', 'model', 'effort', 'dryRun', 'inFolder'];

/** A start names the brief its owner saw (seen) or wrote (brief): nothing starts on text nobody was shown. */
function shownFirst(c, dryRun) {
  if (!dryRun && c.brief === undefined && c.seen === undefined) throw fail(400, 'say which brief was shown (seen), or give the brief: a session starts only on a brief you saw');
  return c;
}

/**
 * o: { runs (doit.mjs workRuns), readJson, refOf(m, at), ownerOnly(req), resume(), learn (src/skillhub/learnfeature.mjs:
 * a send back is handed to it; it does nothing while learning is off) } → [[method, re, fn]].
 */
export function doRoutes({ runs, readJson, refOf, ownerOnly, resume, learn = null, partsByRun = null, corrected = null, fromTia = () => false }) {
  return [
    ['GET', /^\/api\/work\/items\/([^/]+)\/do$/, async (req, m, q) => {
      ownerOnly(req);
      const at = Number(q.get('at'));
      const want = {};
      for (const k of ['project', 'folder', 'tool']) if (q.has(k)) want[k] = q.get(k);
      const c = cleanChoices(want);
      return runs.plan(refOf(m, Number.isInteger(at) ? at : -1), { ...(q.has('project') ? { project: c.project ?? null } : {}), ...(c.folder ? { folder: c.folder } : {}), ...(c.tool ? { tool: c.tool } : {}) });
    }],
    ['POST', /^\/api\/work\/items\/([^/]+)\/do$/, async (req, m) => {
      ownerOnly(req);
      const b = await readJson(req);
      keys(b, ['at', ...CHOICES]);
      const c = shownFirst(cleanChoices(b), b.dryRun === true);
      await resume();
      // Started through Tia's door (manage_work start, on the owner's yes to her card): the session is hers.
      return runs.start(refOf(m, b.at), c, { dryRun: b.dryRun === true, hers: fromTia(req) });
    }],
    ['POST', /^\/api\/work\/items\/([^/]+)\/accept$/, async (req, m) => {
      ownerOnly(req);
      const b = await readJson(req);
      keys(b, ['at']);
      await resume();
      return runs.accept(refOf(m, b.at));
    }],
    ['POST', /^\/api\/work\/items\/([^/]+)\/send-back$/, async (req, m) => {
      ownerOnly(req);
      const b = await readJson(req);
      keys(b, ['at', 'text']);
      await resume();
      const out = await runs.sendBack(refOf(m, b.at), b.text);
      if (learn) learn.sentBack(out.item, b.text);
      if (corrected) corrected('sent-back', out.item, b.text);
      return out;
    }],
    ['POST', /^\/api\/work\/items\/([^/]+)\/remove-branch$/, async (req, m) => {
      ownerOnly(req);
      keys(await readJson(req), []);
      if (!ID_RE.test(m[1])) throw fail(400, 'that is not an item id');
      const out = await runs.removeBranch(m[1]);
      if (!out) throw fail(404, 'this task has no branch of its own on this computer');
      return out;
    }],
    ['GET', /^\/api\/work\/runs$/, async (req, m, q) => {
      ownerOnly(req);
      const f = {};
      if (q.get('item')) {
        if (!ID_RE.test(q.get('item'))) throw fail(400, 'that is not an item id');
        f.item = q.get('item');
      }
      if (q.get('project')) {
        if (!PROJECT_RE.test(q.get('project'))) throw fail(400, 'that is not a project');
        f.project = q.get('project');
      }
      if (q.get('day')) {
        if (!isYmd(q.get('day'))) throw fail(400, 'a day is YYYY-MM-DD');
        f.day = q.get('day');
      }
      if (q.get('id')) {
        if (!RUN_ID_RE.test(q.get('id'))) throw fail(400, 'that is not a run id');
        f.id = q.get('id');
      }
      const list = runs.list(f);
      // Who did what (Lead model): read through workUnits (pulse.mjs), attached to the runs that had helpers.
      const parts = partsByRun && list.length ? await partsByRun().catch(() => new Map()) : new Map();
      // What it used and what the cheaper way saved (runuse.mjs): from the run's record and that same card only.
      return { runs: list.map((r) => ({ ...(parts.has(r.id) ? { ...r, parts: parts.get(r.id) } : r), use: runUse(r, parts.get(r.id) || null, r.billing || null) })) };
    }],
  ];
}

/** Make the command token anew (at every start of the dashboard). */
export function writeCommandToken() {
  const token = `hwc_${crypto.randomBytes(32).toString('hex')}`;
  const file = commandTokenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return token;
}

/** The command token as the file has it, or null. */
export function readCommandToken() {
  try {
    const t = fs.readFileSync(commandTokenFile(), 'utf8').trim();
    return TOKEN_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** Remove the token when the dashboard stops (only while it is the one this process made). */
export function dropCommandToken(mine) {
  if (mine && readCommandToken() === mine) fs.rmSync(commandTokenFile(), { force: true });
}

/**
 * The command's route, before the login (server.mjs runs a feature's handle first): only POST COMMAND_PATH with the
 * token in COMMAND_HEADER. `token()`: this dashboard's token. `go(id, choices, dryRun)` starts the run.
 */
export async function commandHandle(req, res, { token, readJson, go, plain }) {
  if (req.method !== 'POST' || String(req.url).split('?')[0] !== COMMAND_PATH) return false;
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const m = /^(hwc_[0-9a-f]{64})$/.exec(String((req.headers && req.headers[COMMAND_HEADER]) || ''));
  const mine = token();
  const ok = !!(m && mine && m[1].length === mine.length && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(mine)));
  if (!ok) {
    send(401, { error: 'the command token is not this dashboard\'s: run the command again' });
    return true;
  }
  try {
    const b = await readJson(req);
    keys(b, ['id', ...CHOICES]);
    if (typeof b.id !== 'string' || !ID_RE.test(b.id)) throw fail(400, 'that is not an item id');
    send(200, await plain(() => go(b.id, shownFirst(cleanChoices(b), b.dryRun === true), b.dryRun === true)));
  } catch (e) {
    send(Number.isInteger(e.status) ? e.status : 500, { error: Number.isInteger(e.status) ? e.message : 'Work could not do that because of an error on this computer; the dashboard\'s log has the details', ...(e.details ? { code: e.details.code } : {}) });
  }
  return true;
}
