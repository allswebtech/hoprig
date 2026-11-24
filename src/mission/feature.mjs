// Missions in the dashboard: the part of the Work feature (src/work/feature.mjs adds these routes) that gives a goal to
// Tia, shows her missions, the Team tab and the morning brief, and holds the owner's switches and limits.
//
//   GET  /api/work/missions                 { settings, providers (Claude Code's, by name and kind), missions (each
//                                           mission's report), broken (files of a mission's name that do not pass),
//                                           team (per role), brief (the morning brief), slots }
//   GET  /api/work/missions/<id>            { mission: its report, its tasks and its line }
//   POST /api/work/missions { goal, project, tool?, provider?, model?, effort? }   a goal: a mission when both switches
//                                           are on for the project, else a plain proposal of Plan with AI (as before)
//   POST /api/work/missions/<id>/stop {}    the mission stops (what runs: as his setting says)
//   POST /api/work/missions/<id>/add { task }   his press: a task of the list joins the mission
//   POST /api/work/missions/settings { … }  the switches and limits (settings.mjs cleanPatch)
//   POST /api/work/missions/off {}          "Tia OFF": the master switch off, in one press
//   POST /api/work/missions/<id>/tasks/<task>/run-tests { outside? }   his "Run the tests here": in the box; with
//                                           outside: true, outside it, as him (his second confirmation)
//
// Behind the owner's login; Tia's token is refused here as on all of Work (her tool reaches these through her door).
import { correctionCounts } from '../operator/corrections.mjs';
import { readSettings } from '../automation/settings.mjs';
import { serves } from '../chat/tools.mjs';
import { listProfiles } from '../profiles.mjs';
import { addDays, todayIn } from '../work/model.mjs';
import { missionEngine } from './engine.mjs';
import { MISSION_ID_RE } from './file.mjs';
import { commandWords } from './gate.mjs';
import { readRun, writerId } from '../work/runs.mjs';
import { faceOf, missionReport, morningBrief, teamView } from './report.mjs';
import { cleanPatch, missionSettings, stepsOf, worksOn } from './settings.mjs';
import { boxTools, toolDoor } from './boxtool.mjs';
import { box as seamBox } from './seam.mjs';
import { fromHerDoor } from '../server/herdoor.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (b, allowed) => {
  if (!isObj(b)) throw fail(400, 'the body must be a JSON object');
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw fail(400, `"${String(k).slice(0, 30)}" is not something this takes`);
};
const idOf = (m) => {
  const id = m[1];
  if (!MISSION_ID_RE.test(id)) throw fail(400, 'that is not a mission');
  return id;
};

/** Claude Code's providers of this computer: [{ name, kind }] (names and kinds only, never a value of one). */
export function claudeProviders() {
  try {
    return listProfiles().filter((p) => serves(p.name, 'claude')).map((p) => ({ name: p.name, kind: p.kind, label: p.label || null }));
  } catch {
    return [];
  }
}

/**
 * o: { sctx, cfg(), places(), place(), store(), planner, runner (alone.mjs), accept(id) (Work's Accept), ownerOnly,
 * now, run, engine (a test's own options) }. → { routes, engine, planner (with the Accept that hands a mission its
 * tasks), start(), close() }.
 */
export function missionPart(o) {
  const slots = () => readSettings((o.cfg() || {}).automation).schedules.atOnce;
  // The tokens of her sessions' one tool (boxtool.mjs): this process's memory only; the engine makes them.
  let engine = null;
  const boxOf = (o.engine && o.engine.box) || seamBox;
  const tools = boxTools({ settings: () => missionSettings(o.cfg()), box: () => boxOf(), on: (project) => worksOn(missionSettings(o.cfg()), project), onRun: (rec, end) => engine && engine.selfRan(rec, end), onLimit: (rec, which) => engine && engine.selfLimited(rec, which) });
  engine = missionEngine({
    tools, ...(o.sctx && typeof o.sctx.listening === 'function' ? { address: () => o.sctx.listening() } : {}),
    config: o.cfg, places: o.places, runner: o.runner, planner: o.planner, providers: o.providers || claudeProviders, slots,
    accept: o.accept, door: o.door, reopen: (id) => o.store().status(id, 'open'), ...(o.now ? { now: o.now } : {}), ...(o.run ? { run: o.run } : {}),
    log: o.log, ...(o.engine || {}),
  });
  // Plan with AI's Accept, as the page and Tia press it: a planning mission of that proposal takes the tasks it made.
  const planner = o.planner ? {
    ...o.planner,
    async accept(id, edits) {
      engine.accepts.before(id);
      try {
        const r = await o.planner.accept(id, edits);
        await engine.accepts.after(id, r).catch((e) => o.log && o.log(`a mission could not take its plan: ${e.message}`));
        return r;
      } finally {
        engine.accepts.done(id);
      }
    },
  } : null;
  const now = o.now || (() => new Date());

  /** A mission's report as the page reads it: its face (the badge) and whether this dashboard runs it. */
  const shown = (m, s) => {
    const mine = m.writer === writerId();
    return { ...missionReport(m), face: faceOf(m, { on: s.on, mine }), mine };
  };

  function overview() {
    const s = missionSettings(o.cfg());
    const { missions, broken } = engine.list();
    let day = todayIn('', now());
    try {
      day = todayIn(o.place().settings.timeZone, now());
    } catch {
      /* no Work list yet */
    }
    return {
      settings: s, providers: (o.providers || claudeProviders)(), slots: slots(), projects: o.projects ? o.projects() : [], missions: missions.map((m) => ({ ...shown(m, s), line: m.line.slice(-3) })), broken, steps: stepsOf(s),
      team: teamView(missions, s.rolesOff), corrected: correctionCounts(now().getTime()).week.role, brief: morningBrief(missions, { from: addDays(day, -1) }), today: day, // corrected: his corrections per role this week (shown only)
    };
  }

  async function saveSettings(patch) {
    const cur = missionSettings(o.cfg());
    let projects = [];
    try {
      projects = o.store().projects || [];
    } catch {
      /* no Work list: no project may be named */
    }
    const names = o.projects ? o.projects() : projects;
    const next = cleanPatch(patch, cur, { projects: names, providers: (o.providers || claudeProviders)().map((p) => p.name) });
    o.sctx.saveConfig({ missions: next });
    if (cur.on && !next.on) await engine.off();
    else engine.tick();
    return { settings: missionSettings(o.cfg()) };
  }

  const routes = [
    ['GET', /^\/api\/work\/missions$/, async (req) => {
      o.ownerOnly(req);
      return overview();
    }],
    ['GET', /^\/api\/work\/missions\/(m-[^/]+)$/, async (req, m) => {
      o.ownerOnly(req);
      const x = engine.get(idOf(m));
      // A session that runs now: since when, and the budget it may spend (its numbers come when it ends).
      const since = (t) => {
        try {
          const r = readRun(o.place(), t.run.id);
          return r && typeof r.startedAt === 'string' ? r.startedAt : null;
        } catch {
          return null;
        }
      };
      const test = (missionSettings(o.cfg()).projects[x.project] || {}).test;
      // Only while a task waits for his press: whether a press in the box can work here, and what would give one. Never
      // waited for: what is known now, or "checking" (the answer comes with a later read).
      const waits = x.tasks.some((t) => t.state === 'review' && t.gate && t.gate.testsNotRun);
      const b = waits ? engine.boxSeen() : null;
      const box = !waits ? null : !b ? { checking: true } : { ok: b.ok, ...(b.ok ? {} : { why: b.why, ...(b.step ? { step: b.step } : {}) }) };
      return { mission: { ...shown(x, missionSettings(o.cfg())), line: x.line, box, plan: x.plan, proposal: x.proposal, testCommand: Array.isArray(test) && test.length ? commandWords(test) : null, tasksFull: x.tasks.map((t) => ({ id: t.id, provider: t.provider, model: t.model, effort: t.effort, fixes: t.fixes, restarts: t.restarts, gate: t.gate, selfTests: t.selfTests || null, verdicts: t.verdicts.map((v) => v.verdict), run: t.run ? { kind: t.run.kind, budget: t.run.budget, startedAt: since(t) } : null })) } };
    }],
    ['POST', /^\/api\/work\/missions$/, async (req) => {
      o.ownerOnly(req);
      const b = await o.sctx.readJson(req);
      keys(b, ['goal', 'project', 'tool', 'provider', 'model', 'effort', 'dryRun']);
      const { dryRun, ...c } = b;
      // A goal given through Tia's door (manage_work goal): its planning session is hers.
      const r = await engine.give(c, { dryRun: dryRun === true, hers: fromHerDoor(o.sctx, req) });
      return { plain: r.plain, ...(r.why ? { why: r.why } : {}), ...(r.proposal ? { proposal: r.proposal } : {}), ...(r.mission ? { mission: { id: r.mission.id, state: r.mission.state } } : {}), ...(r.dryRun ? { dryRun: true, would: r.would } : {}) };
    }],
    ['POST', /^\/api\/work\/missions\/settings$/, async (req) => {
      o.ownerOnly(req);
      return saveSettings(await o.sctx.readJson(req));
    }],
    ['POST', /^\/api\/work\/missions\/off$/, async (req) => {
      o.ownerOnly(req);
      keys(await o.sctx.readJson(req), []);
      return saveSettings({ on: false });
    }],
    ['POST', /^\/api\/work\/missions\/(m-[^/]+)\/stop$/, async (req, m) => {
      o.ownerOnly(req);
      keys(await o.sctx.readJson(req), []);
      const x = await engine.stop(idOf(m));
      return { mission: { id: x.id, state: x.state, why: x.why } };
    }],
    ['POST', /^\/api\/work\/missions\/(m-[^/]+)\/add$/, async (req, m) => {
      o.ownerOnly(req);
      const b = await o.sctx.readJson(req);
      keys(b, ['task']);
      if (typeof b.task !== 'string') throw fail(400, 'name the task');
      const x = await engine.add(idOf(m), b.task);
      return { mission: { id: x.id, state: x.state, tasks: x.tasks.length } };
    }],
    ['POST', /^\/api\/work\/missions\/(m-[^/]+)\/tasks\/([a-z0-9][a-z0-9-]{0,79})\/run-tests$/, async (req, m) => {
      o.ownerOnly(req);
      // { outside: true } is his second, separate confirmation (the tests run as him, outside the box): a field the
      // press in the box never sends. Anything else is refused.
      const b = await o.sctx.readJson(req);
      keys(b, ['outside']);
      if (b.outside !== undefined && b.outside !== true) throw fail(400, '"outside" is true or left out');
      // Outside the box only from his own page (his sign-in, same origin): never with another computer's token or from
      // Tia's door, where no sheet was shown to him.
      if (b.outside === true && (typeof o.sctx.caller !== 'function' || o.sctx.caller(req) !== 'page')) throw fail(403, 'the tests run outside the box only from your own page on this computer', 'page-only');
      const here = await engine.runTestsHere(idOf(m), m[2], { outside: b.outside === true });
      return { here };
    }],
  ];

  return { routes, engine, planner, tools, door: toolDoor(tools), start: () => engine.begin(), close: async () => {
    tools.dropAll();
    await engine.close();
  } };
}
