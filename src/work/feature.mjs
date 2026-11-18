// Work in the dashboard, as a server feature: { name, routes }.
//
//   GET  /api/work                       the list, Today, where the data lives, the settings, the workspace's projects;
//                                        { problem } (and no items) when the Work folder cannot be used; { recovered }
//                                        (one sentence) or { interrupted: { message, kept } } for a save that was
//                                        interrupted (resume.mjs: finished, or shown until the owner drops it)
//   POST /api/work/items { title, date?, approx?, kind?, priority?, note?, project?, by? }      add an item
//   POST /api/work/items/<id> { at, …the same, status? }   change it (null clears date, note, project, priority)
//   POST /api/work/items/<id>/status { at, status }    done | open | dropped | waiting | review | doing
//   POST /api/work/items/<id>/remove { at }            remove one the owner added (one from a plan is dropped instead)
//        `at`: the item's place in the list, as GET gave it; with the id it names the one item (doubled ids)
//   POST /api/work/fix-ids {}            give every item whose id an earlier one has a new id of its own
//   GET  /api/work/save                  what a save would commit: { repo, files, changes, nothing, problem? }
//   GET  /api/work/save?fetch=1          the same with the server's news: a merge with another computer's changes
//   POST /api/work/save { hash?, upstream?, decisions? }   commit the Work file by name and send it (save.mjs);
//                                        `hash` and `upstream`: the plan the owner saw (when the file or the server
//                                        moved since, nothing is committed); `decisions`: key → "mine" | "theirs"
//   POST /api/work/save/drop {}          drop the record of an interrupted save the owner has looked at (resume.mjs)
//   GET  /api/work/tidy                  what "Tidy the file once" would write: { alters, diff, hash, changed,
//                                        shownChanged, cut } (the sheet's part of the difference, and how much that is)
//   POST /api/work/tidy { hash }         write it, only while the file is still the one whose difference was shown
//   POST /api/work/settings { place?, project?, path?, saveSubject?, timeZone?, ownerId? }
//
// Behind the owner's login like every /api route; Tia's token is refused (her Work tools are a later part, through
// her door). The browser never sends a path to a file: only an item id (checked against the id pattern, then looked
// up in the list) and, in the settings, a project name and a folder inside it, both checked here (place.mjs). No
// route reads or returns anything but the Work list file, and no full path leaves the server.
import { todayView } from './today.mjs';
import { cleanSettings, projectNames, resolvePlace, workSettings } from './place.mjs';
import { dropInterrupted, publicPlan, savePlan, saveWork } from './save.mjs';
import { finishInterrupted } from './resume.mjs';
import { workStore } from './store.mjs';
import { alterText } from './jsontext.mjs';
import { workRuns } from './doit.mjs';
import { commandHandle, doRoutes, dropCommandToken, writeCommandToken } from './dofeature.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (b, allowed) => {
  if (!isObj(b)) throw fail(400, 'the body must be a JSON object');
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw fail(400, `"${String(k).slice(0, 30)}" is not something this takes`);
};
// An item is named by its place in the list AND its id, never by its id alone: two items may share an id (two
// computers that added the same title), and the place alone may have moved since the page drew it.
const refOf = (m, at) => {
  let id;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    throw fail(400, 'that is not an item id');
  }
  if (!Number.isInteger(at) || at < 0) throw fail(400, 'give the place of the item in the list ("at") with its id');
  return { id, at };
};

/** The owner's choices for the conflicts of a merge: { "<key>": "mine" | "theirs" }, checked. */
function cleanDecisions(d) {
  if (d === undefined || d === null) return {};
  if (!isObj(d) || Object.keys(d).length > 1000) throw fail(400, 'the choices must be an object of keys and "mine" or "theirs"');
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (k.length > 300 || (v !== 'mine' && v !== 'theirs')) throw fail(400, 'each choice is "mine" or "theirs"');
    Object.defineProperty(out, k, { value: v, enumerable: true });
  }
  return out;
}

/**
 * `opts`: { places: () => ({ workspace, projects }) and `run` (git) and `now` stand-ins, for tests and the demo;
 * chat: the chat feature, which "Do it" opens a session with (without it there is no "Do it") }.
 */
export function workFeature(sctx, opts = {}) {
  const cfg = () => (sctx.config ? sctx.config() : {});
  const places = () => (opts.places ? opts.places() : {});
  const ownerOnly = (req) => {
    if (/^Bearer\s+tia_/i.test(String((req.headers && req.headers.authorization) || ''))) throw fail(403, 'Work is the owner\'s only for now');
  };
  const run = opts.run ? { run: opts.run } : {};
  const place = () => resolvePlace(cfg(), places());
  const store = () => workStore(place(), { projects: projectNames(cfg(), places()), ...(opts.now ? { now: opts.now } : {}) });
  const where = (p) => ({ kind: p.kind, label: p.label, fileName: p.fileName, ...(p.project ? { project: p.project } : {}) });
  // A save that was interrupted is finished (or shown) before the list is read or changed: never passed over.
  const resume = async (p) => {
    try {
      return await finishInterrupted(p, run);
    } catch (e) {
      log('interrupted save', e && e.message);
      return {};
    }
  };

  // Every answer of these routes is plain: a sentence and a short code. What the system or git said (a temporary
  // file's full path, the server's address) goes to the server's log only, and an error no route expected becomes
  // one sentence without its own words.
  const CODES = { 400: 'bad-request', 403: 'not-allowed', 404: 'not-found', 409: 'conflict', 413: 'too-large', 415: 'not-json' };
  const log = (what, detail) => console.error(`work: ${what}: ${String(detail).slice(0, 500)}`);
  const plain = (fn) => async (req, m, q, res) => {
    try {
      const out = await fn(req, m, q, res);
      if (out && typeof out === 'object' && 'detail' in out) {
        if (out.detail) log(out.code || 'save', out.detail);
        const { detail, ...rest } = out;
        return rest;
      }
      return out;
    } catch (e) {
      if (!Number.isInteger(e.status)) {
        log('unexpected', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
        throw Object.assign(new Error('Work could not do that because of an error on this computer; the dashboard\'s log has the details'), { status: 500, details: { code: 'internal' } });
      }
      if (e.detail) log(e.details?.code || 'error', e.detail);
      const code = (e.details && e.details.code) || (typeof e.code === 'string' && /^[a-z][a-z-]+$/.test(e.code) ? e.code : CODES[e.status] || 'error');
      // Only the code goes to the page, and for a brief with characters that cannot be seen the brief without them
      // (model.mjs checkBrief: the owner's own text, for the sheet's "Take them out").
      const clean = code === 'brief-hidden' && typeof e.details.clean === 'string' ? { clean: e.details.clean } : {};
      throw Object.assign(new Error(e.message), { status: e.status, details: { code, ...clean } });
    }
  };

  // "Do it" and the runs (doit.mjs), when the dashboard has the chat feature to open a session with.
  const runs = opts.chat ? workRuns({ config: cfg, places, chat: opts.chat, defaultProvider: sctx.defaultProvider, ...run, ...(opts.now ? { now: opts.now } : {}), log: (s2) => log('runs', s2) }) : null;
  let commandToken = null;

  const routes = [
    ['GET', /^\/api\/work$/, async (req) => {
      ownerOnly(req);
      const settings = workSettings(cfg());
      const projects = projectNames(cfg(), places());
      let st;
      try {
        st = store();
      } catch (e) {
        if (!e.status) throw e;
        return { problem: e.message, settings, projects, items: [] };
      }
      const fin = await resume(st.place);
      let list;
      try {
        list = st.list();
      } catch (e) {
        if (!e.status) throw e;
        return { problem: e.message, settings, projects, place: where(st.place), items: [] };
      }
      const today = st.today();
      return {
        today, place: { ...where(st.place), exists: list.exists }, settings, projects, items: list.items, todayView: todayView(list.items, today),
        ...(runs ? { runs: runs.latest(), doIt: true } : {}),
        ...(list.untidy.length ? { untidy: list.untidy.map((a) => ({ kind: a.kind, text: alterText(a) })) } : {}),
        ...(list.doubles.length ? { doubles: list.doubles } : {}),
        ...(list.planner ? { planner: list.planner } : {}),
        ...(fin.sentence ? { recovered: fin.sentence } : {}),
        ...(fin.code === 'interrupted' ? { interrupted: { message: `${fin.problem.charAt(0).toUpperCase()}${fin.problem.slice(1)}.`, ...(fin.kept ? { kept: fin.kept } : {}) } } : {}),
      };
    }],
    ['POST', /^\/api\/work\/items$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['title', 'date', 'approx', 'kind', 'priority', 'note', 'project', 'by']);
      await resume(place());
      return store().add(b);
    }],
    ['POST', /^\/api\/work\/items\/([^/]+)$/, async (req, m) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['at', 'title', 'date', 'approx', 'kind', 'priority', 'note', 'project', 'by', 'status']);
      const { at, ...changes } = b;
      await resume(place());
      return store().edit(refOf(m, at), changes);
    }],
    ['POST', /^\/api\/work\/items\/([^/]+)\/status$/, async (req, m) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['at', 'status']);
      if (typeof b.status !== 'string') throw fail(400, 'give the status');
      await resume(place());
      return store().status(refOf(m, b.at), b.status);
    }],
    ['POST', /^\/api\/work\/items\/([^/]+)\/remove$/, async (req, m) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['at']);
      await resume(place());
      return store().remove(refOf(m, b.at));
    }],
    ['POST', /^\/api\/work\/fix-ids$/, async (req) => {
      ownerOnly(req);
      keys(await sctx.readJson(req), []);
      await resume(place());
      return store().fixIds();
    }],
    ['GET', /^\/api\/work\/save$/, async (req, m, q) => {
      ownerOnly(req);
      // ?fetch=1 (the Save sheet): with the server's news, so a merge with another computer's changes is shown first.
      const plan = await savePlan(place(), { ...run, fetch: q.get('fetch') === '1' });
      if (plan.detail) log(plan.code || 'save plan', plan.detail);
      return publicPlan(plan);
    }],
    ['POST', /^\/api\/work\/save$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['hash', 'upstream', 'decisions']);
      if (b.hash !== undefined && b.hash !== null && (typeof b.hash !== 'string' || !/^[0-9a-f]{32}$/.test(b.hash))) throw fail(400, 'that is not the hash of a plan');
      if (b.upstream !== undefined && (typeof b.upstream !== 'string' || !/^[0-9a-f]{40,64}$/.test(b.upstream))) throw fail(400, 'that is not a commit');
      const decisions = cleanDecisions(b.decisions);
      const p = place();
      const expect = b.hash === undefined && b.upstream === undefined ? null : { hash: b.hash ?? null, ...(b.upstream ? { upstream: b.upstream } : {}) };
      return saveWork(p, { subject: p.settings.saveSubject, expect, decisions, ...run });
    }],
    ['POST', /^\/api\/work\/save\/drop$/, async (req) => {
      ownerOnly(req);
      keys(await sctx.readJson(req), []);
      return { dropped: await dropInterrupted(place(), run) };
    }],
    ['GET', /^\/api\/work\/tidy$/, async (req) => {
      ownerOnly(req);
      const t = store().tidyPlan();
      return { alters: t.alters.map((a) => ({ kind: a.kind, text: alterText(a) })), diff: t.diff, hash: t.hash, changed: t.changed, shownChanged: t.shownChanged, cut: !!t.cut };
    }],
    ['POST', /^\/api\/work\/tidy$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      keys(b, ['hash']);
      if (typeof b.hash !== 'string' || !/^[0-9a-f]{32}$/.test(b.hash)) throw fail(400, 'give the hash of the difference you were shown');
      await resume(place());
      const r = await store().tidy(b.hash);
      return { written: r.written };
    }],
    ['POST', /^\/api\/work\/settings$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      const next = cleanSettings(b, workSettings(cfg()));
      // A project folder must be usable before it is kept: the project exists and the folder stays inside it.
      resolvePlace({ ...cfg(), work: next }, places());
      sctx.saveConfig({ work: next });
      return { settings: workSettings(cfg()) };
    }],
  ];
  if (runs) routes.push(...doRoutes({ runs, readJson: (req) => sctx.readJson(req), refOf, ownerOnly, resume: () => resume(place()) }));
  return {
    name: 'work',
    routes: routes.map(([method, re, fn]) => [method, re, plain(fn)]),
    // `hoprig tasks do` on this computer: its one route, with the command token (dofeature.mjs).
    handle: (req, res) => (runs ? commandHandle(req, res, { token: () => commandToken, readJson: (r) => sctx.readJson(r), plain: (fn) => plain(fn)(), go: async (id, c, dryRun) => {
      await resume(place());
      return runs.start(id, c, { dryRun });
    } }) : false),
    start() {
      if (!runs) return;
      try {
        commandToken = writeCommandToken();
      } catch (e) {
        log('command token', e.message);
      }
      runs.begin();
    },
    close() {
      runs?.close();
      dropCommandToken(commandToken);
    },
  };
}
