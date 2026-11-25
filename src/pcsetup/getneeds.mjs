// A project's needs from the page's Get (POST /api/pcsetup/project/needs, docs/WORKSPACE.md "Needs"): the terminal's
// own offer (getproject.mjs needsPlan, the words `hoprig get` prints), and his press "Get them too" doing what the
// terminal's yes does (takeNeeds, then each need by the same get). Nothing here decides anything of its own.
//   look(name, { dir })          the offer for a project here: its lines, the question, and a `seen` id of what it names
//   checkSeen(name, { dir, seen })   before the yes runs: the offer made again, refused when it is not the one he saw
//   take(checked, { dir, ui, runner })   the yes (in the page's background job): his yes on this computer and each
//                                need got by the same get, its setup questions never answered (as
//                                --yes never answers a need's); what the needs got here name in their turn comes back
//                                as a new offer (`more`), never got without another press. A name is offered once.
import crypto from 'node:crypto';
import path from 'node:path';
import { getProject, needsPlan, takeNeeds } from './getproject.mjs';
import { projectDirFor } from '../workspace/where.mjs';

export const CHANGED = 'This changed since you looked: look again.';
const fail = (status, message) => Object.assign(new Error(message), { status });
const pair = (ref) => (x) => ({ name: x.name, ...(x.of !== ref ? { of: x.of } : {}) });

/** The id of an offer: the project and exactly what a yes would get and allow. */
export const seenOf = (p) => crypto.createHash('sha256').update(JSON.stringify([p.ref, p.missing.map((x) => [x.of, x.name]), p.allow.map((x) => [x.of, x.name])])).digest('hex');

/** get's result for a project folder here, as needsPlan reads it. */
async function resultFor(name, dir) {
  const f = await projectDirFor(name, { projects: dir });
  return { result: 'here', ok: true, dir: f.root, folder: path.basename(f.root), ...(f.place ? { place: f.place } : {}) };
}

/** The page's view of a plan: the terminal's lines, its question, and what a yes gets and allows. */
function view(p) {
  if (!p) return { needs: [], missing: [], allow: [], lines: [], ask: false };
  const lines = [...p.lines.refused, ...(p.lines.allowed ? [p.lines.allowed] : []), ...p.lines.told, ...(p.lines.missing ? [p.lines.missing] : []), ...(p.lines.toRead ? [p.lines.toRead] : [])];
  const ask = p.missing.length + p.allow.length > 0;
  return {
    project: p.ref, needs: p.g.needs, missing: p.missing.map(pair(p.ref)), allow: p.allow.map(pair(p.ref)), lines, ask,
    ...(ask ? { question: p.question, later: p.later, seen: seenOf(p) } : {}),
  };
}

/** The offer for project `name` here (read only). */
export async function look(name, { dir }) {
  const r = await resultFor(name, dir);
  return view(await needsPlan(r, { dir }));
}

/**
 * His press "Get them too" on the offer he saw (`seen`), checked before anything runs: the offer made now must be that
 * one. → the plan to hand to `take` (in the page's background job).
 */
export async function checkSeen(name, { dir, seen }) {
  const r = await resultFor(name, dir);
  const offered = new Set([name]);
  const p = await needsPlan(r, { dir, offered });
  if (!p || !(p.missing.length + p.allow.length) || seenOf(p) !== seen) throw fail(409, CHANGED);
  return { p, offered };
}

/** The yes of a checked plan. → { project, allowed, got: [{ name, ok, result }], more } */
export async function take({ p, offered }, { dir, ui, runner }) {
  for (const x of [...p.missing.map((y) => `${y.of} ${y.name}`), ...p.allow.map((y) => `${y.of} ${y.name}`)]) offered.add(x);
  const took = await takeNeeds(p, offered);
  ui.line('ok', `allowed on this computer: ${took.words}`);
  // --yes answers the setup questions of what the owner named, never of a need (its installs run its own scripts).
  ui.yes = false;
  const got = [];
  for (const spec of took.names) {
    const g = await getProject(spec, { ui, dir, ask: false, ...(runner ? { runner } : {}) });
    got.push({ name: spec, ok: g.ok, result: g.result, ...(g.dir ? { dir: g.dir } : {}), ...(g.folder ? { folder: g.folder } : {}), ...(g.place ? { place: g.place } : {}) });
  }
  // What a need just got names in its turn (its own project.json may name more than the map knew): a new offer, made
  // as checkSeen makes it again at his next press, and only for a name not offered in this run (a loop ends).
  const more = [];
  for (const g of got.filter((x) => x.ok && ['cloned', 'here'].includes(x.result) && x.dir)) {
    const ref = g.place ? `${g.place}/${g.folder}` : g.folder;
    const v = view(await needsPlan({ result: g.result, dir: g.dir, folder: g.folder, place: g.place }, { dir, offered: new Set([ref]) }));
    if (v.ask && v.missing.some((x) => !offered.has(x.name))) more.push(v);
  }
  return { project: p.ref, allowed: took.words, got: got.map(({ name: n, ok, result }) => ({ name: n, ok, result })), more };
}
