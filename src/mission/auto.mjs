// Auto, per project: with its own switch on (settings.mjs autoOn), Tia starts a READY task of the project's Work list
// by herself, as a mission of that one task, one start per look of the engine (engine.mjs autoStart), and only when the
// owner's limits allow a start (limits.mjs whyNot). This file says what "ready" is, one condition at a time, and keeps
// the tasks he ended under Auto, which Auto never takes again. Pure but for that one small file.
//
// Ready: a task (no deadline, gate or opportunity) of this project by name; done by "ai" or one of her roles that is on
// (never his own, never the reviewer's); open (not done, dropped, in review, being done or waiting); no run time of his
// (his schedule runs it then); its date has come or it has none; every task of its `after` is done; not added by another program (a Work token); no run of it goes
// on; no mission ever had it (one that runs, or one that ended: Auto takes a task once, so a failed one is not tried
// again and again); and he never ended an Auto mission of it.
import fs from 'node:fs';
import path from 'node:path';
import { ID_RE, isYmd, statusOf, whoOf } from '../work/model.mjs';
import { writeText } from '../work/store.mjs';
import { missionsDir } from './file.mjs';
import { ROLE_NAMES } from './roles.mjs';

/** Who an Auto start is, in Activity and on the mission's line. */
export const AUTO_WHO = 'Tia (Auto)';
export const STARTED_WORDS = `Started by ${AUTO_WHO}`;
/** The roles Auto starts a task for: every role of hers but the reviewer (it reads other sessions' work only). */
export const AUTO_ROLES = Object.freeze(ROLE_NAMES.filter((r) => r !== 'reviewer'));
export const ENDED_FILE = 'auto-ended.json';
const ENDED_MAX = 2000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Why `raw` (an item of Work's list) is not a ready task for Auto, or null when it is. c: { project, ownerId, today
 * (YYYY-MM-DD in Work's time zone), items (the list's items), missions (every mission of the place), running (a Set of
 * item ids a run of which goes on), ended (a Set of ids he ended under Auto), rolesOff }.
 */
export function notReady(raw, c) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return 'not a task of the list';
  if (raw.kind !== undefined && raw.kind !== 'task') return 'not a task (a deadline, a gate or an opportunity)';
  if (raw.project !== c.project) return 'of another project';
  const who = whoOf(raw, c.ownerId);
  if (who === 'me') return 'yours to do';
  if (who === 'reviewer') return 'a review: yours to close';
  if (who === 'ai' ? (c.rolesOff || []).includes('developer') : !AUTO_ROLES.includes(who) || (c.rolesOff || []).includes(who)) return 'not for a role of hers that is on';
  const st = statusOf(raw);
  if (st !== 'open') return `it is ${st}`;
  // A run time of his ("run by AI at 07:30"): his schedule starts it then, so Auto never starts it early or twice.
  if (isObj(raw.work) && isObj(raw.work.at)) return 'it has a run time of yours: it runs then';
  if (raw.date !== undefined && raw.date !== null && raw.date !== '') {
    if (!isYmd(raw.date)) return 'its date is not a day';
    if (raw.date > c.today) return 'its date has not come';
  }
  if (raw.after !== undefined && !Array.isArray(raw.after)) return 'what it waits for cannot be read';
  for (const a of raw.after || []) {
    const b = (c.items || []).find((x) => isObj(x) && x.id === a);
    if (!b || statusOf(b) !== 'done') return 'it waits for a task that is not done';
  }
  if (raw.from) return 'another program added it';
  if (c.running.has(raw.id)) return 'a run of it goes on';
  if (c.missions.some((m) => m.tasks.some((t) => t.id === raw.id))) return 'a mission has it already';
  if (c.ended.has(raw.id)) return 'you ended it under Auto';
  return null;
}

/** The first ready task of the list, in his order, or null. */
export const readyTask = (items, c) => (items || []).find((x) => notReady(x, c) === null) || null;

const endedPath = (place) => path.join(missionsDir(place), ENDED_FILE);

/** The ids of the tasks he ended under Auto in this Work place (a file that cannot be read: none, and nothing starts). */
export function readEnded(place) {
  let text;
  try {
    text = fs.readFileSync(endedPath(place), 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? new Set() : null;
  }
  try {
    const j = JSON.parse(text);
    if (!isObj(j) || j.v !== 1 || !Array.isArray(j.tasks) || !j.tasks.every((x) => typeof x === 'string' && ID_RE.test(x))) return null;
    return new Set(j.tasks);
  } catch {
    return null;
  }
}

/**
 * Keep `id` as ended under Auto (the caller holds the Work file's lock). → false when the list cannot be read: it is
 * left as it is (never replaced by this one id), and Auto starts nothing while it cannot be read (readEnded null).
 */
export function addEnded(place, id) {
  const now = readEnded(place);
  if (!now) return false;
  now.add(id);
  const tasks = [...now].slice(-ENDED_MAX);
  missionsDir(place, { make: true });
  writeText(endedPath(place), `${JSON.stringify({ v: 1, tasks }, null, 2)}\n`);
  return true;
}
