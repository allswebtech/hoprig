// Changes to plans, under Work's one lock (lock.mjs: the list's lock covers the plans folder too, so a save never
// commits half of a change): a plan made or changed by hand, a task put into a plan or taken out, and the Accept of a
// proposal.
//
// ACCEPT writes three files, the note (plans/<id>.md), the plan (plans/<id>.json) and the task list, as ONE unit: a
// kill at any step leaves either nothing or everything. Before the first of them is written, a record of the unit (what
// each file holds before and what it is to hold after) is written and flushed to Hoprig's state folder
// (work-journal/accept-<…>.json, as a save's journal is); it is deleted when all three are written and the proposal is
// gone. Every look at the Work list (resume.mjs finishInterrupted: the page, a save, the command) finishes such a unit
// first: each file that still holds what it held before gets what it was to hold; when one holds anything else (a hand
// edit after a crash), nothing is touched and the owner is told, until he drops the record.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { JOURNAL_FOLDER, writeSynced } from './journal.mjs';
import { withLock } from './lock.mjs';
import { addItem, findItem, rawItems, setBrief, setKey } from './model.mjs';
import { PLAN_FILE_RE, NOTE_FILE_RE, checkPlan, cleanGoal, cleanMilestones, cleanTitle, newPlanId, noteText, planPaths, planText, putInPlan, readPlan, setWaits, takeOutOfPlan, writePlan } from './plans.mjs';
import { checkProposal } from './proposal.mjs';
import { dropProposal, readProposal } from './proposals.mjs';
import { changeHeld, formatOf, readDoc, serialize, untidy, writeText } from './store.mjs';

// A test's way to end the process right after one step of an Accept (the proof that a kill loses nothing): the
// step's name. The same variable a save's steps use (save.mjs). Never set otherwise.
const STOP_ENV = 'HOPRIG_TEST_WORK_STOP_AFTER';
const stopAfter = (step) => {
  if (process.env[STOP_ENV] === step) process.kill(process.pid, 'SIGKILL');
};

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hashOf = (bytes) => (bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex'));
const bytesAt = (file) => {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
};

/**
 * Under the lock, before any change of plans: an Accept that was interrupted is finished first, and while its record
 * waits on the owner (a file changed after the kill) nothing else of plans is written. Another Accept would put its
 * own record in that record's place (one per Work list), and a new plan could take the name that Accept was writing.
 */
function settleAccept(place) {
  const r = finishAcceptHeld(place);
  if (r.problem) throw fail(409, `${r.problem.charAt(0).toUpperCase()}${r.problem.slice(1)}.`, 'interrupted');
}

// ---------- by hand ----------

/** ctx: { today, ownerId, projects, now() }. */
const nowIso = (ctx) => (ctx.now ? ctx.now() : new Date()).toISOString();

/** A plan made by hand: { title, goal, projects?, milestones? }. → the plan. */
export function createPlan(place, input, ctx) {
  if (!isObj(input)) throw fail(400, 'a plan is an object');
  for (const k of Object.keys(input)) if (!['title', 'goal', 'projects', 'milestones'].includes(k)) throw fail(400, `"${String(k).slice(0, 30)}" is not a field of a plan`);
  return withLock(place.file, async () => {
    settleAccept(place);
    const title = cleanTitle(input.title);
    let items = [];
    try {
      items = rawItems(readDoc(place.file).doc);
    } catch {
      /* no list yet, or one that does not read: no task names a plan then */
    }
    const at = nowIso(ctx);
    const plan = {
      v: 1, id: newPlanId(place, title, { at, items }), title, goal: cleanGoal(input.goal ?? ''), projects: input.projects === undefined ? [] : input.projects,
      milestones: cleanMilestones(input.milestones || []), note: null, made: { at, how: 'hand' }, status: 'active',
    };
    writePlan(place, plan, { projects: ctx.projects });
    // A save commits a plan with the list: the list is made too when there is none yet (an empty one).
    if (!fs.existsSync(place.file)) writeText(place.file, '{\n  "items": []\n}\n');
    return plan;
  });
}

/**
 * Change a plan: { title?, goal?, projects?, milestones?, status? }. A milestone that still has tasks is not taken out
 * (they would point at nothing): its tasks are moved first. `seen`: the plan file's text as the page showed it (a
 * hash), so a plan changed meanwhile (a save brought another computer's) is not changed on what he never saw.
 */
export function editPlan(place, id, changes, ctx, { seen = null } = {}) {
  if (!isObj(changes)) throw fail(400, 'the changes are an object');
  for (const k of Object.keys(changes)) if (!['title', 'goal', 'projects', 'milestones', 'status'].includes(k)) throw fail(400, `"${String(k).slice(0, 30)}" is not something a plan has`);
  return withLock(place.file, async () => {
    settleAccept(place);
    const plan = readPlan(place, id);
    if (!plan) throw fail(404, `there is no plan "${String(id).slice(0, 80)}"`);
    if (seen !== null && seen !== planHash(plan)) throw fail(409, 'the plan changed since it was shown: look at it again', 'moved');
    const next = { ...plan };
    if (changes.title !== undefined) next.title = cleanTitle(changes.title);
    if (changes.goal !== undefined) next.goal = cleanGoal(changes.goal);
    if (changes.projects !== undefined) next.projects = changes.projects;
    if (changes.status !== undefined) next.status = changes.status;
    if (changes.milestones !== undefined) {
      next.milestones = cleanMilestones(changes.milestones, plan.milestones.map((m) => m.id));
      const gone = new Set(plan.milestones.map((m) => m.id).filter((m) => !next.milestones.some((x) => x.id === m)));
      const { doc } = readDoc(place.file);
      const still = (Array.isArray(doc.items) ? doc.items : []).filter((x) => isObj(x) && x.plan === id && gone.has(x.milestone));
      if (still.length) throw fail(409, `a milestone you took out still has ${still.length === 1 ? 'a task' : `${still.length} tasks`} (${still.slice(0, 3).map((x) => `"${String(x.title).slice(0, 60)}"`).join(', ')}): move ${still.length === 1 ? 'it' : 'them'} first`, 'milestone-tasks');
    }
    checkPlan(next, { projects: ctx.projects.concat(plan.projects) });
    if (planText(next) !== planText(plan)) writeText(planPaths(place, id).json, planText(next));
    return next;
  });
}

/** A short hash of a plan as written: what the page saw. */
export const planHash = (plan) => crypto.createHash('sha256').update(planText(plan)).digest('hex').slice(0, 16);

/**
 * Put a task into a plan, move it to another milestone, change what it waits for, or take it out (plan null). With no
 * plan at all (undefined), only what it waits for changes (setWaits). ref: the item ({ id, at } from the page). → the
 * item as written.
 */
export function setTaskPlan(place, ref, { plan: planId, milestone = null, after }, ctx) {
  return withLock(place.file, async () => {
    settleAccept(place);
    const r = await changeHeld(place.file, (doc) => {
      if (planId === undefined) return setWaits(doc, ref, after);
      if (planId === null) return takeOutOfPlan(doc, ref, { after });
      const plan = readPlan(place, planId);
      if (!plan) throw fail(404, `there is no plan "${String(planId).slice(0, 80)}"`);
      return putInPlan(doc, ref, { plan, milestone, after });
    });
    return r.result;
  });
}

// ---------- Accept ----------

const journalFile = (place) => path.join(stateDir(), JOURNAL_FOLDER, `accept-${crypto.createHash('sha256').update(realFile(place.file)).digest('hex').slice(0, 24)}.json`);
function realFile(file) {
  try {
    return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    return path.resolve(file);
  }
}
/** Where an Accept's record is, as the owner is told it: inside Hoprig's state folder. */
const journalName = (place) => `${JOURNAL_FOLDER}/${path.basename(journalFile(place))}`;

/**
 * What an Accept writes, worked out from the proposal and the list as it is now (nothing written): { plan, ids,
 * writes: [{ name, before, after }] } (name: the file's path inside the Work folder; before: a hash of what it holds
 * now, null when it is not there).
 */
function planAccept(place, proposal, ctx) {
  const p = checkProposal(proposal, ctx);
  const { doc, text, bad } = readDoc(place.file);
  if (untidy(text, bad).length) throw fail(409, 'the Work file has things a write would change: tidy it once (Tidy the file once, or hoprig tasks tidy), then accept', 'untidy');
  const at = nowIso(ctx);
  const id = newPlanId(place, p.title, { at, items: Array.isArray(doc.items) ? doc.items : [] });
  const paths = planPaths(place, id, { make: false });
  const plan = {
    v: 1, id, title: p.title, goal: p.goal, projects: p.projects, milestones: cleanMilestones(p.milestones),
    note: p.note ? `${id}.md` : null, made: { at, how: 'proposal' }, status: 'active',
  };
  checkPlan(plan, { projects: ctx.projects });
  if (!Array.isArray(doc.items)) doc.items = [];
  const source = `plans/${p.note ? `${id}.md` : `${id}.json`}`;
  // The tasks, each added as an add adds one (its id from its title, its place by its date), then tied to the plan.
  const made = p.tasks.map((t) => {
    const item = addItem(doc, { title: t.title, date: t.date, by: t.by, project: t.project || p.projects[0], ...(t.check ? { note: `Done when: ${t.check}` } : {}) }, ctx);
    setKey(item, 'source', source);
    return item;
  });
  p.tasks.forEach((t, i) => {
    const item = made[i];
    setKey(item, 'plan', id);
    if (t.milestone !== null) setKey(item, 'milestone', plan.milestones[t.milestone].id);
    if (t.after.length) setKey(item, 'after', t.after.map((a) => made[a].id));
    if (t.brief) setBrief(item, t.brief);
  });
  const writes = [];
  const rel = (f) => path.relative(place.folder, f).split(path.sep).join('/');
  if (plan.note) writes.push({ name: rel(paths.md), before: hashOf(bytesAt(paths.md)), after: noteText(p.note) });
  writes.push({ name: rel(paths.json), before: hashOf(bytesAt(paths.json)), after: planText(plan) });
  writes.push({ name: place.fileName, before: hashOf(bytesAt(place.file)), after: serialize(doc, formatOf(text)) });
  return { plan, ids: made.map((x) => x.id), writes };
}

/** A name of an Accept's record that is one of Work's own files here (the list, or a plan's file): its full path. */
function fileOfName(place, name) {
  if (name === place.fileName) return place.file;
  const m = /^plans\/([^/]+)$/.exec(String(name));
  if (!m || !(PLAN_FILE_RE.test(m[1]) || NOTE_FILE_RE.test(m[1]))) return null;
  return path.join(place.folder, 'plans', m[1]);
}

/**
 * Accept a proposal (`proposal`: as the owner saw and changed it; `pid`: its record, removed at the end): the note, the
 * plan and its tasks written as one unit. → { plan, tasks: [id] }.
 */
export function acceptProposal(place, proposal, ctx, { pid = null } = {}) {
  return withLock(place.file, async () => {
    // An earlier Accept that was interrupted first (it may be this one: finished, its proposal is gone then).
    settleAccept(place);
    // Looked at again under the lock: Accept pressed twice (two tabs, a double tap) waits here for the first, which
    // removed the record; the second writes nothing.
    if (pid && !readProposal(pid)) throw fail(409, 'this proposal was accepted or dismissed already: look at the plans', 'gone');
    const a = planAccept(place, proposal, ctx);
    stopAfter('accept-planned');
    // Never in the place of another Accept's record (settleAccept leaves none; this is the last word on it).
    if (fs.existsSync(journalFile(place))) throw fail(409, 'an Accept of a plan was interrupted and its record waits: look at the Work page first', 'interrupted');
    writeSynced(journalFile(place), `${JSON.stringify({ v: 1, kind: 'accept', at: nowIso(ctx), proposal: pid, plan: a.plan.id, title: a.plan.title, writes: a.writes }, null, 2)}\n`);
    stopAfter('accept-journal');
    for (const w of a.writes) {
      writeText(fileOfName(place, w.name), w.after);
      stopAfter(`accept-${w.name === place.fileName ? 'list' : w.name.endsWith('.md') ? 'note' : 'plan'}`);
    }
    if (pid) dropProposal(pid);
    stopAfter('accept-proposal');
    fs.rmSync(journalFile(place), { force: true });
    return { plan: a.plan.id, tasks: a.ids };
  });
}

/**
 * Finish an Accept that was interrupted (its record is there): → {} (none), { sentence } (finished: one sentence), or
 * { problem, code: "interrupted" } (a file holds what the Accept neither found nor wrote: nothing touched).
 * `dryRun`: say it, change nothing.
 */
export async function finishAccept(place, { dryRun = false } = {}) {
  if (!fs.existsSync(journalFile(place))) return {};
  return withLock(place.file, async () => finishAcceptHeld(place, { dryRun }));
}

/** finishAccept, for a caller that holds the lock. */
function finishAcceptHeld(place, { dryRun = false } = {}) {
  if (!fs.existsSync(journalFile(place))) return {};
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(journalFile(place), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {}; // finished meanwhile
  }
  const ok = isObj(j) && j.v === 1 && j.kind === 'accept' && Array.isArray(j.writes)
    && j.writes.every((w) => isObj(w) && typeof w.after === 'string' && (w.before === null || typeof w.before === 'string') && fileOfName(place, w.name));
  const drop = 'press "Drop the record" on the Work page, or run hoprig tasks save --drop-interrupted';
  if (!ok) return { problem: `an Accept of a plan was interrupted, and its record in Hoprig's state folder (${journalName(place)}) cannot be read: nothing was changed. Look at the Work folder, then drop the record (${drop})`, code: 'interrupted' };
  const title = typeof j.title === 'string' ? j.title.slice(0, 120) : 'a plan';
  const todo = [];
  for (const w of j.writes) {
    const now = hashOf(bytesAt(fileOfName(place, w.name)));
    if (now === hashOf(Buffer.from(w.after, 'utf8'))) continue;
    if (now !== w.before) return { problem: `the plan "${title}" you accepted was being written when Hoprig stopped, and ${w.name} changed since: nothing was changed. What the Accept was writing is kept in Hoprig's state folder (${journalName(place)}). Look at the Work folder, then drop the record (${drop})`, code: 'interrupted' };
    todo.push(w);
  }
  if (dryRun) return { problem: 'an Accept of a plan was interrupted: a look that is not a dry run finishes it (a dry run changes nothing)', code: 'interrupted' };
  for (const w of todo) writeText(fileOfName(place, w.name), w.after);
  if (typeof j.proposal === 'string') dropProposal(j.proposal);
  fs.rmSync(journalFile(place), { force: true });
  return { sentence: `The plan "${title}" you accepted was being written when Hoprig stopped: it is written in full now.` };
}

/** Drop the record of an interrupted Accept (the owner's word, after he looked). → whether there was one. */
export function dropAccept(place) {
  const was = fs.existsSync(journalFile(place));
  fs.rmSync(journalFile(place), { force: true });
  return was;
}
