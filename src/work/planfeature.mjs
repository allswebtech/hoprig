// The routes of plans and "Plan with AI", beside Work's own (feature.mjs, which adds these):
//
//   GET  /api/work/plans                         the plans with their progress and next date: { plans, unreadable }
//   POST /api/work/plans { title, goal, projects?, milestones? }        a plan made by hand
//   GET  /api/work/plans/<id>                    one plan: its goal, note, milestones with their tasks, the timeline,
//                                                and `hash` (what a change names as seen)
//   POST /api/work/plans/<id> { seen, title?, goal?, projects?, milestones?, status? }   change it, mark it done or dropped
//   POST /api/work/items/<id>/plan { at, plan (an id or null), milestone?, after? }       a task into a plan, or out
//   GET  /api/work/propose?project=&tool=        what Plan would start: projects, tools, providers, models, the defaults
//   POST /api/work/propose { goal, project, also?, tool?, provider?, model?, effort?, dryRun? }   start a planning session
//   GET  /api/work/proposals/<id>                one proposal: where it stands, the answer, the proposal or the reason
//   POST /api/work/proposals/<id>/accept { seen, title?, goal?, milestones?, tasks?, drop? }   write it with the owner's
//                                                changes (proposal.mjs applyEdits): plan, note and tasks at once
//   POST /api/work/proposals/<id>/clean {}       read an answer again without the characters that cannot be seen
//   POST /api/work/proposals/<id>/dismiss {}     throw it away
//
// Every id from the browser is checked against its pattern, then looked up: a plan among the plans folder's files of
// Work, a proposal among this dashboard's records for this Work list; a project by name among the workspace's. No route
// takes a path, and none returns a full path.
import { ID_RE, PROJECT_RE } from './model.mjs';
import { listPlans, readNote, readPlan } from './plans.mjs';
import { planHash, createPlan, editPlan, setTaskPlan } from './planstore.mjs';
import { planRow, planView, withWaits } from './planview.mjs';
import { RUN_ID_RE } from './runs.mjs';
import { cleanChoices } from './dofeature.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (b, allowed) => {
  if (!isObj(b)) throw fail(400, 'the body must be a JSON object');
  for (const k of Object.keys(b)) if (!allowed.includes(k)) throw fail(400, `"${String(k).slice(0, 30)}" is not something this takes`);
};
const idOf = (m, re = ID_RE, what = 'a plan') => {
  let id;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    throw fail(400, `that is not ${what}`);
  }
  if (!re.test(id)) throw fail(400, `that is not ${what}`);
  return id;
};

/**
 * o: { place(), store() (store.mjs workStore), ctx() ({ today, ownerId, projects, now }), planner (planai.mjs, or null
 * without the chat feature), readJson, refOf, ownerOnly, resume } → [[method, re, fn]].
 */
export function planRoutes({ place, store, ctx, planner, readJson, refOf, ownerOnly, resume, corrected = null }) {
  const items = () => withWaits(store().list().items);
  const routes = [
    ['GET', /^\/api\/work\/plans$/, async (req) => {
      ownerOnly(req);
      await resume();
      const p = place();
      const { plans, unreadable } = listPlans(p);
      const all = items();
      const today = ctx().today;
      return { today, plans: plans.map((x) => planRow(x, all, today)), unreadable };
    }],
    ['POST', /^\/api\/work\/plans$/, async (req) => {
      ownerOnly(req);
      const b = await readJson(req);
      await resume();
      return { plan: await createPlan(place(), b, ctx()) };
    }],
    ['GET', /^\/api\/work\/plans\/([^/]+)$/, async (req, m) => {
      ownerOnly(req);
      const id = idOf(m);
      await resume();
      const p = place();
      const plan = readPlan(p, id);
      if (!plan) throw fail(404, `there is no plan "${id}" (or its file does not read as one)`);
      return { today: ctx().today, plan: planView(plan, items(), ctx().today), note: readNote(p, plan), hash: planHash(plan) };
    }],
    ['POST', /^\/api\/work\/plans\/([^/]+)$/, async (req, m) => {
      ownerOnly(req);
      const id = idOf(m);
      const b = await readJson(req);
      keys(b, ['seen', 'title', 'goal', 'projects', 'milestones', 'status']);
      if (typeof b.seen !== 'string' || !/^[0-9a-f]{16}$/.test(b.seen)) throw fail(400, 'say which version of the plan you saw (seen)');
      const { seen, ...changes } = b;
      await resume();
      const plan = await editPlan(place(), id, changes, ctx(), { seen });
      return { plan, hash: planHash(plan) };
    }],
    ['POST', /^\/api\/work\/items\/([^/]+)\/plan$/, async (req, m) => {
      ownerOnly(req);
      const b = await readJson(req);
      keys(b, ['at', 'plan', 'milestone', 'after']);
      // Without a plan, only what the task waits for changes (Stop waiting): its plan and milestone stay unread.
      if (b.plan === undefined && (b.milestone !== undefined || b.after === undefined)) throw fail(400, 'say the plan, or only what the task waits for (after)');
      if (b.plan !== undefined && b.plan !== null && (typeof b.plan !== 'string' || !ID_RE.test(b.plan))) throw fail(400, 'that is not a plan');
      if (b.milestone !== undefined && b.milestone !== null && (typeof b.milestone !== 'string' || !ID_RE.test(b.milestone))) throw fail(400, 'that is not a milestone');
      await resume();
      const item = await setTaskPlan(place(), refOf(m, b.at), b.plan === undefined ? { after: b.after } : { plan: b.plan, milestone: b.milestone ?? null, after: b.after }, ctx());
      return { item: { id: item.id, plan: item.plan || null, milestone: item.milestone || null } };
    }],
  ];
  if (!planner) return routes;
  routes.push(
    ['GET', /^\/api\/work\/propose$/, async (req, m, q) => {
      ownerOnly(req);
      const want = {};
      if (q.get('project')) {
        if (!PROJECT_RE.test(q.get('project'))) throw fail(400, 'that is not a project');
        want.project = q.get('project');
      }
      if (q.get('tool')) want.tool = cleanChoices({ tool: q.get('tool') }).tool;
      return planner.choices(want);
    }],
    ['POST', /^\/api\/work\/propose$/, async (req) => {
      ownerOnly(req);
      const b = await readJson(req);
      keys(b, ['goal', 'project', 'also', 'tool', 'provider', 'model', 'effort', 'lead', 'others', 'dryRun']);
      if (typeof b.goal !== 'string' || b.goal.length > 8000) throw fail(400, 'the goal is text of up to 4000 characters');
      if (b.also !== undefined && (!Array.isArray(b.also) || b.also.length > 20 || b.also.some((x) => typeof x !== 'string' || !PROJECT_RE.test(x)))) throw fail(400, 'also is a list of projects');
      const c = cleanChoices({ project: b.project, tool: b.tool, provider: b.provider, model: b.model, effort: b.effort, dryRun: b.dryRun });
      await resume();
      if (b.lead !== undefined && b.lead !== null && typeof b.lead !== 'boolean') throw fail(400, 'lead is true or false');
      return planner.start({ goal: b.goal, also: b.also || [], ...c, ...(typeof b.lead === 'boolean' ? { lead: b.lead } : {}), ...(b.others !== undefined ? { others: b.others } : {}) }, { dryRun: b.dryRun === true });
    }],
    ['GET', /^\/api\/work\/proposals\/([^/]+)$/, async (req, m) => {
      ownerOnly(req);
      return { proposal: planner.get(idOf(m, RUN_ID_RE, 'a proposal')) };
    }],
    ['POST', /^\/api\/work\/proposals\/([^/]+)\/accept$/, async (req, m) => {
      ownerOnly(req);
      const id = idOf(m, RUN_ID_RE, 'a proposal');
      const b = await readJson(req);
      await resume();
      const r = await planner.accept(id, b);
      // He changed her plan before he accepted it: one correction (what he changed is the plan itself, not kept here).
      if (corrected && b && typeof b === 'object' && ['title', 'goal', 'milestones', 'tasks', 'drop'].some((k) => b[k] !== undefined)) corrected('plan-changed', null, null);
      return r;
    }],
    ['POST', /^\/api\/work\/proposals\/([^/]+)\/clean$/, async (req, m) => {
      ownerOnly(req);
      const id = idOf(m, RUN_ID_RE, 'a proposal');
      keys(await readJson(req), []);
      return { proposal: planner.clean(id) };
    }],
    ['POST', /^\/api\/work\/proposals\/([^/]+)\/dismiss$/, async (req, m) => {
      ownerOnly(req);
      const id = idOf(m, RUN_ID_RE, 'a proposal');
      keys(await readJson(req), []);
      return planner.dismiss(id);
    }],
  );
  return routes;
}
