// The proposals of "Plan with AI": one record per planning session, kept in this dashboard's state folder
// (`work-proposals/<id>.json`, mode 600), never in the Work repository. Nothing of a proposal exists in the repository
// before the owner's yes; a proposal he has not answered survives a restart of the dashboard and waits on Today.
//
// A record: { v: 1, id, place (which Work list it is for: a hash of that file's path), goal (the owner's words),
//   project, also (other projects he named), tool, provider, model, effort, session, conversation, message, startedAt,
//   endedAt, state, reason, answer (the session's last answer, as text: masked and without this computer's paths),
//   proposal (parsed: proposal.mjs) or null, problem: { message, code } or null, cleaned (characters that cannot be seen
//   were taken out on the owner's word) }
// state: working (the session plans) | ready (a proposal to look at) | unreadable (the answer did not parse: the
// reason, and the answer as text) | failed (the session ended without an answer: the reason). Accept and Dismiss
// remove the record (an accepted plan is in the repository then; a dismissed one is thrown away).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { RUN_ID_RE } from './runs.mjs';
import { proposalHash } from './proposal.mjs';

export const PROPOSALS_FOLDER = 'work-proposals';
export const PROPOSAL_STATES = ['working', 'ready', 'unreadable', 'failed'];
const RECORD_MAX = 1024 * 1024;

const dir = () => path.join(stateDir(), PROPOSALS_FOLDER);
const fileOf = (id) => path.join(dir(), `${id}.json`);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Which Work list a proposal is for: a hash of the list file's path (its folder's links resolved). */
export function placeKey(place) {
  let p = place.file;
  try {
    p = path.join(fs.realpathSync(path.dirname(place.file)), path.basename(place.file));
  } catch {
    /* as it is */
  }
  return crypto.createHash('sha256').update(p).digest('hex').slice(0, 24);
}

/** Write a record whole (a temporary file, then a rename). */
export function writeProposal(rec) {
  if (!isObj(rec) || typeof rec.id !== 'string' || !RUN_ID_RE.test(rec.id)) throw new Error('a proposal record has a bad id');
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${fileOf(rec.id)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, fileOf(rec.id));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return rec;
}

/** One record by its id (checked against the id pattern first), or null. */
export function readProposal(id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) return null;
  try {
    const st = fs.lstatSync(fileOf(id));
    if (!st.isFile() || st.size > RECORD_MAX) return null;
    const r = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
    return isObj(r) && r.v === 1 && r.id === id && PROPOSAL_STATES.includes(r.state) ? r : null;
  } catch {
    return null;
  }
}

/** The records of a Work list (`place`), what waits for the owner first, newest first within that; all when no place is given. */
export function listProposals(place = null) {
  let names = [];
  try {
    names = fs.readdirSync(dir()).filter((n) => /^\d{8}-\d{6}-[0-9a-f]{8}\.json$/.test(n)).sort().reverse();
  } catch {
    return [];
  }
  const key = place ? placeKey(place) : null;
  // What waits for the owner first: a proposal to look at, then one that could not be read or ended, then one planning.
  const rank = { ready: 0, unreadable: 1, failed: 1, working: 2 };
  return names.map((n) => readProposal(n.slice(0, -5))).filter((r) => r && (!key || r.place === key)).sort((a, b) => rank[a.state] - rank[b.state]);
}

/** Remove a record (accepted or dismissed). → whether there was one. */
export function dropProposal(id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) return false;
  const was = fs.existsSync(fileOf(id));
  fs.rmSync(fileOf(id), { force: true });
  return was;
}

/** A record as the page and the command get it: no session's first message, the rest as it is. */
export function viewProposal(r) {
  return {
    id: r.id, goal: r.goal, project: r.project, also: r.also, tool: r.tool, provider: r.provider, model: r.model, effort: r.effort,
    session: r.session, startedAt: r.startedAt, endedAt: r.endedAt, state: r.state, reason: r.reason, answer: r.answer,
    proposal: r.proposal, problem: r.problem, cleaned: !!r.cleaned, hash: r.proposal ? proposalHash(r.proposal) : null,
  };
}

/** A record in a list (Today): what it is about and where it stands, without the answer and the proposal's parts. */
export function rowOf(r) {
  return { id: r.id, goal: r.goal.length > 200 ? `${r.goal.slice(0, 199)}…` : r.goal, project: r.project, state: r.state, session: r.session, startedAt: r.startedAt, endedAt: r.endedAt, title: r.proposal ? r.proposal.title : null, tasks: r.proposal ? r.proposal.tasks.length : 0, reason: r.reason, problem: r.problem ? r.problem.message : null };
}
