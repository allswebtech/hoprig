// A mission is a file of Work: `missions/<id>.json` in Work's folder beside `runs/` (src/work/runs.mjs), written only
// by the dashboard that runs it (`writer`, its Work writer id), under the Work file's lock, atomically, and checked
// strictly on every write and every read (a file that does not pass is not a mission: it is named and left alone).
//
// { v: 1, id, writer, goal, project, proposal (the Plan with AI record while it plans), plan (the accepted plan's id),
//   state, why, createdAt, endedAt, tasks: [task], line: [{ at, task, words }], auto? (true: Tia started it by herself,
//   Auto per project, auto.mjs: one ready task, no plan) }
// state: planning | running | done | waits (for him) | failed | stopped (by him, or Tia OFF)
// task: { id (the Work task), title, role (null: a task the plan gives to him, never a session's), provider, model, effort, state, why, branch, base (the commit of the
//   default branch it was made from), run: { id, kind, budget, before? } | null (the run working now: work, review or fix,
//   the dollars of the cap it holds while it runs, and a review's snapshot { ref, sum } of the branch before it), runs:
//   [{ id, kind, provider, state, cost, tokens, minutes, day, budget (the dollars it was allowed, or null) }], fixes, restarts, gateFails, gate: { ok, words } | null,
//   firstPass (true | false | null: whether its gate and review passed the first time), verdicts: [{ verdict,
//   points }], limited: [{ provider, at (when it reached its usage limit: skipped for an hour) }], claim: { writer, pid, ident } | null (who runs it now), next: work | review |
//   fix | null (the run a queued task starts next), points: [what its fix is to change: the gate's words or the
//   reviewer's, kept as data] }
// task state: queued | running | review (waits for his Accept) | done | his (his to look at) | failed | dropped |
//   stopped
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ID_RE, PROJECT_RE } from '../work/model.mjs';
import { RUN_ID_RE, BRANCH_RE, cleanText } from '../work/runs.mjs';
import { writeText } from '../work/store.mjs';
import { ROLE_NAMES } from './roles.mjs';

export const MISSIONS_FOLDER = 'missions';
export const MISSION_ID_RE = /^m-\d{8}-[0-9a-f]{6}$/;
export const MISSION_STATES = ['planning', 'running', 'done', 'waits', 'failed', 'stopped'];
export const TASK_STATES = ['queued', 'running', 'review', 'done', 'his', 'failed', 'dropped', 'stopped'];
export const RUN_KINDS = ['work', 'review', 'fix'];
const RUN_STATES = ['running', 'done', 'failed', 'limit', 'stopped'];
export const LINE_MAX = 300;
const FILE_MAX = 256 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (why) => Object.assign(new Error(`a mission file ${why}`), { status: 500 });

const text = (v, max, nul = false) => (v === null && nul) || (typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(v));
// optional: keys a file may leave out (one written before them, or written only while they hold: a task's wait).
const keys = (o, list, what, optional = []) => {
  if (!isObj(o)) throw bad(`has a bad ${what}`);
  for (const k of Object.keys(o)) if (!list.includes(k) && !optional.includes(k)) throw bad(`has an unknown key "${String(k).slice(0, 30)}" in ${what}`);
  for (const k of list) if (!(k in o) && !optional.includes(k)) throw bad(`has no "${k}" in ${what}`);
};
const num = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e12);
const TOP = ['v', 'id', 'writer', 'goal', 'project', 'proposal', 'plan', 'state', 'why', 'createdAt', 'endedAt', 'tasks', 'line'];
const TASK = ['id', 'title', 'role', 'provider', 'model', 'effort', 'state', 'why', 'branch', 'base', 'run', 'runs', 'fixes', 'restarts', 'gateFails', 'gate', 'firstPass', 'verdicts', 'limited', 'claim', 'next', 'points', 'selfTests'];
// selfTests (optional): how often its sessions ran the tests themselves with the tool of the box, and how the last ended.
const SELF_ENDS = ['passed', 'failed', 'timeout'];

/** Check a mission strictly. Throws with what is wrong. */
export function checkMission(m) {
  keys(m, TOP, 'the mission', ['auto']);
  if (m.auto !== undefined && !(m.auto === true && m.plan === null && m.proposal === null && Array.isArray(m.tasks) && m.tasks.length === 1)) throw bad('has a bad Auto mark');
  if (m.v !== 1 || !MISSION_ID_RE.test(m.id) || !/^[0-9a-f]{16}$/.test(m.writer)) throw bad('has a bad id, version or writer');
  if (!text(m.goal, 4000) || !m.goal.trim() || !PROJECT_RE.test(m.project)) throw bad('has a bad goal or project');
  if (m.proposal !== null && !RUN_ID_RE.test(m.proposal)) throw bad('has a bad proposal');
  if (m.plan !== null && !ID_RE.test(m.plan)) throw bad('has a bad plan');
  if (!MISSION_STATES.includes(m.state) || !text(m.why, 400, true)) throw bad('has a bad state');
  if (!AT_RE.test(m.createdAt) || !(m.endedAt === null || AT_RE.test(m.endedAt))) throw bad('has a bad time');
  if (!Array.isArray(m.tasks) || m.tasks.length > 60) throw bad('has a bad task list');
  for (const t of m.tasks) {
    keys(t, TASK, 'a task', ['selfTests', 'waitUntil', 'recheck']);
    if (t.waitUntil !== undefined && !AT_RE.test(t.waitUntil)) throw bad('has a bad wait in a task');
    if (t.recheck !== undefined && t.recheck !== true) throw bad('has a bad recheck flag in a task');
    if (!ID_RE.test(t.id) || !text(t.title, 200) || !(ROLE_NAMES.includes(t.role) || (t.role === null && t.state !== 'running' && !t.runs.length)) || !TASK_STATES.includes(t.state) || !text(t.why, 400, true)) throw bad('has a bad task');
    if (!(t.provider === null || NAME_RE.test(t.provider)) || !text(t.model, 40, true) || !text(t.effort, 20, true)) throw bad('has a bad choice in a task');
    if (!(t.branch === null || BRANCH_RE.test(t.branch)) || !(t.base === null || SHA_RE.test(t.base))) throw bad('has a bad branch in a task');
    const before = (b) => b === undefined || (isObj(b) && Object.keys(b).length === 2 && (b.ref === null || SHA_RE.test(b.ref)) && (b.sum === null || /^[0-9a-f]{64}$/.test(b.sum)));
    if (t.run !== null && !(isObj(t.run) && Object.keys(t.run).every((k) => ['id', 'kind', 'budget', 'before'].includes(k)) && RUN_ID_RE.test(t.run.id) && RUN_KINDS.includes(t.run.kind) && num(t.run.budget) && before(t.run.before))) throw bad('has a bad run in a task');
    if (!Array.isArray(t.runs) || t.runs.length > 30 || !t.runs.every((r) => isObj(r) && Object.keys(r).length === 9 && num(r.budget) && RUN_ID_RE.test(r.id) && RUN_KINDS.includes(r.kind) && (r.provider === null || NAME_RE.test(r.provider)) && RUN_STATES.includes(r.state) && num(r.cost) && num(r.tokens) && num(r.minutes) && DAY_RE.test(r.day))) throw bad('has a bad run list in a task');
    for (const k of ['fixes', 'restarts', 'gateFails']) if (!Number.isInteger(t[k]) || t[k] < 0 || t[k] > 20) throw bad(`has a bad "${k}" in a task`);
    if (t.gate !== null && !(isObj(t.gate) && typeof t.gate.ok === 'boolean' && Array.isArray(t.gate.words) && t.gate.words.length <= 10 && t.gate.words.every((w) => text(w, 300)))) throw bad('has a bad gate in a task');
    if (![true, false, null].includes(t.firstPass)) throw bad('has a bad first pass in a task');
    if (!Array.isArray(t.verdicts) || t.verdicts.length > 10 || !t.verdicts.every((v) => isObj(v) && ['pass', 'fix', 'unreadable', 'void'].includes(v.verdict) && Array.isArray(v.points) && v.points.length <= 5 && v.points.every((p) => text(p, 200)))) throw bad('has a bad verdict in a task');
    if (!Array.isArray(t.limited) || t.limited.length > 20 || !t.limited.every((p) => isObj(p) && Object.keys(p).length === 2 && NAME_RE.test(p.provider) && AT_RE.test(p.at))) throw bad('has a bad limit list in a task');
    if (!(t.next === null || RUN_KINDS.includes(t.next))) throw bad('has a bad next step in a task');
    if (!Array.isArray(t.points) || t.points.length > 10 || !t.points.every((p) => text(p, 300))) throw bad('has bad points in a task');
    const st = t.selfTests;
    if (st !== undefined && !(isObj(st) && Object.keys(st).every((k) => ['runs', 'last', 'at', 'limit'].includes(k)) && Number.isInteger(st.runs) && st.runs >= 1 && st.runs <= 1000 && SELF_ENDS.includes(st.last) && AT_RE.test(st.at) && (st.limit === undefined || st.limit === 'runs' || st.limit === 'time'))) throw bad('has a bad count of its own test runs in a task');
    if (t.claim !== null && !(isObj(t.claim) && /^[0-9a-f]{16}$/.test(t.claim.writer) && Number.isInteger(t.claim.pid) && text(t.claim.ident, 200, true))) throw bad('has a bad claim in a task');
  }
  if (new Set(m.tasks.map((t) => t.id)).size !== m.tasks.length) throw bad('names a task twice');
  if (!Array.isArray(m.line) || m.line.length > LINE_MAX || !m.line.every((l) => isObj(l) && Object.keys(l).length === 3 && AT_RE.test(l.at) && (l.task === null || ID_RE.test(l.task)) && text(l.words, 300))) throw bad('has a bad line');
  return m;
}

/** The missions folder of a Work place, checked: a plain folder inside the Work folder. */
export function missionsDir(place, { make = false } = {}) {
  const dir = path.join(place.folder, MISSIONS_FOLDER);
  let st = null;
  try {
    st = fs.lstatSync(dir);
  } catch {
    /* none yet */
  }
  if (st && !st.isDirectory()) throw Object.assign(new Error(`${place.label}/${MISSIONS_FOLDER} is not a plain folder: missions leave it alone`), { status: 409, details: { code: 'missions-folder' } });
  if (!st && make) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** A new mission's id: the day and six random hex digits. */
export const newMissionId = (now = new Date()) => `m-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;

/** One act on the mission's line (kept to the last LINE_MAX). Words are this code's own; names come from Work. */
export function say(m, at, task, words) {
  m.line.push({ at, task: task || null, words: cleanText(words, 300).replace(/\s+/g, ' ').slice(0, 300) });
  if (m.line.length > LINE_MAX) m.line.splice(0, m.line.length - LINE_MAX);
}

/** Write a mission (checked), atomically. The caller holds the Work file's lock. */
export function writeMission(place, m) {
  checkMission(m);
  const body = `${JSON.stringify(m, null, 2)}\n`;
  if (Buffer.byteLength(body) > FILE_MAX) throw bad('is too large');
  const file = path.join(missionsDir(place, { make: true }), `${m.id}.json`);
  try {
    if (!fs.lstatSync(file).isFile()) throw bad('is not a plain file');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  writeText(file, body);
  return m;
}

/** One mission by id, or null (not there, or a file that does not pass). */
export function readMission(place, id) {
  if (typeof id !== 'string' || !MISSION_ID_RE.test(id)) return null;
  try {
    const file = path.join(missionsDir(place), `${id}.json`);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > FILE_MAX) return null;
    const m = checkMission(JSON.parse(fs.readFileSync(file, 'utf8')));
    return m.id === id ? m : null;
  } catch {
    return null;
  }
}

/** Every mission of the place, newest first; `broken`: the names of files of a mission's name that do not pass. */
export function listMissions(place) {
  let names = [];
  try {
    names = fs.readdirSync(missionsDir(place)).filter((n) => /^m-\d{8}-[0-9a-f]{6}\.json$/.test(n)).sort().reverse();
  } catch {
    return { missions: [], broken: [] };
  }
  const missions = [];
  const broken = [];
  for (const n of names.slice(0, 500)) {
    const m = readMission(place, n.slice(0, -5));
    if (m) missions.push(m);
    else broken.push(n);
  }
  return { missions, broken };
}

/** A task of a mission as it begins: queued, with its role. */
export const newTask = (id, title, role) => ({ id, title: String(title).slice(0, 200), role, provider: null, model: null, effort: null, state: 'queued', why: null, branch: null, base: null, run: null, runs: [], fixes: 0, restarts: 0, gateFails: 0, gate: null, firstPass: null, verdicts: [], limited: [], claim: null, next: 'work', points: [] });
