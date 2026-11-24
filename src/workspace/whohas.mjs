// Which computer has what: the one reader the Workspace page, `hoprig workspace status --all --json` and
// `hoprig get --list --json` share. Read only: each computer's own file in the brain (ai_brain/computers/<label>.json,
// computer.mjs), the brain's git history of those files (through gitread.mjs, nothing fetched), the map, and this
// computer's disk. Nothing is written, and nothing runs unless someone asks (a page, a command).
//
//   - an entry: the computers that have it, by their labels; this computer from its disk, the others from their files;
//   - a computer: what it has, and when its file was written (the last brain commit that touched it; this computer's
//     own: its disk time when that is newer). Every other computer's answer is "as of" that time, and marked old
//     after OLD_DAYS days;
//   - a computer of the Computers list whose name has no file is named as unknown, never as "has nothing";
//   - "last here": when an entry that is not on this computer was last in this computer's own file (the brain's
//     history of that file, its last HISTORY commits). Nothing is said when the history does not say.
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import { COMPUTERS, checkComputerFile, fileOf, hereOnThisComputer, relFileOf, whoHasWhat } from './computer.mjs';
import { isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { readMap, refOf } from './map.mjs';
import { placeOf } from './groups.mjs';

export const OLD_DAYS = 7;
const HISTORY = 200;
const DAY = 86_400_000;

/** When each computer's file was last committed in the brain: Map(label → ms). One git read, nothing fetched. */
async function committedAt(brain, run) {
  const out = new Map();
  if (!isGitRepo(brain)) return out;
  const r = await gitRead(brain, ['log', `--max-count=${HISTORY}`, '--format=%x01%ct', '--name-only', '--', `${COMPUTERS}/`], { run });
  if (!r.ok) return out;
  let at = 0;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('\x01')) at = Number(line.slice(1)) * 1000;
    else {
      const m = new RegExp(`^${COMPUTERS}/([a-z0-9][a-z0-9_-]{0,31})\\.json$`).exec(line.trim());
      if (m && at && !out.has(m[1])) out.set(m[1], at);
    }
  }
  return out;
}

/**
 * Each commit's version of this computer's own file, newest first: [{ at: ms, here: Set | null }] (null: that version
 * is not a file that passes the check, or the commit removed it). One git read: the patch with the whole file as its
 * context, so the new version is the context and the added lines of each commit.
 */
async function versionsOf(brain, label, run) {
  const r = await gitRead(brain, ['log', `--max-count=${HISTORY}`, '--format=%x01%ct', '--patch', '--unified=100000', '--', relFileOf(label)], { run });
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  const done = () => {
    if (!cur || !cur.patched) return; // a merge shows no patch: not a version of its own
    let here = null;
    try {
      const c = checkComputerFile(JSON.parse(cur.lines.join('\n')), label);
      if (c.ok) here = new Set(c.file.here);
    } catch {
      /* removed, or not JSON */
    }
    out.push({ at: cur.at, here });
  };
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('\x01')) {
      done();
      cur = { at: Number(line.slice(1)) * 1000, lines: [], patched: false, inHunk: false };
    } else if (cur) {
      if (line.startsWith('@@')) cur.patched = cur.inHunk = true;
      else if (line.startsWith('diff --git')) cur.patched = true;
      else if (cur.inHunk && (line.startsWith(' ') || line.startsWith('+'))) cur.lines.push(line.slice(1));
    }
  }
  done();
  return out;
}

/**
 * When each entry left this computer's own file, from the brain's history of it: Map(entry → ms). An entry the newest
 * version still lists gets nothing (the file says it is here); else the time of the commit whose version first lacks
 * it after one that held it. A name only moved in the list (a comma added after it) never counts.
 */
async function lastHereOf(brain, label, run) {
  const out = new Map();
  if (!label || !isGitRepo(brain)) return out;
  const v = (await versionsOf(brain, label, run)).filter((x) => x.here);
  if (!v.length) return out;
  const newest = v[0].here;
  for (let i = 0; i + 1 < v.length; i++) {
    for (const name of v[i + 1].here) if (!v[i].here.has(name) && !newest.has(name) && !out.has(name)) out.set(name, v[i].at);
  }
  return out;
}

const mtime = (p) => {
  try {
    return fs.lstatSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * The answer. `machines`: the names of the Computers list (another computer this dashboard shows); default: none.
 * → { label, computers: [{ label, mine, hoprig, here, written, old }], unknown: [name], entries: [{ kind, name, place,
 *   url, here, on, lastHere? }], refused, folderWhy?, noMap?, mapErrors?, notes }
 */
export async function whoHas({ dir = workspaceDir(), projects = projectsIn(), machines = [], now = Date.now(), run = capture } = {}) {
  const brain = path.join(dir, 'ai_brain');
  const who = whoHasWhat(dir);
  const times = await committedAt(brain, run);
  const m = readMap(dir);
  // This computer: from its disk whenever the map can say what is here, never from its own (maybe old) file.
  const disk = m.exists && !m.errors ? await hereOnThisComputer(m.map, { dir, projects }) : null;
  // A file under this computer's label with another computer's id is that other computer's: a conflict, no row.
  const conflict = who.label ? who.computers.find((c) => c.label === who.label && !c.mine) : null;
  const rows = who.computers.filter((c) => c !== conflict);
  if (who.label && disk && !rows.some((c) => c.mine)) rows.unshift({ label: who.label, mine: true, hoprig: null, here: [] });
  const computers = rows.map((c) => {
    let written = times.get(c.label) || null;
    if (c.mine) written = Math.max(written || 0, mtime(fileOf(c.label, dir))) || null;
    const fromDisk = c.mine && disk !== null;
    return { label: c.label, mine: c.mine, hoprig: c.hoprig, here: fromDisk ? disk : c.here, ...(c.mine ? { fromDisk } : {}), written, old: !c.mine && (!written || now - written > OLD_DAYS * DAY) };
  });
  const named = new Set(computers.map((c) => c.label));
  // A computer whose file was refused wrote one: it is named with why, never as one that wrote none.
  const refusedLabels = new Set(who.refused.map((r) => r.name.replace(/\.json$/, '')));
  // An entry of the Computers list is joined with a file by the workspace label that computer told this dashboard
  // (kept at pairing and at each look, machines.json info.workspace); without one, by its name. A joined entry whose
  // name differs is named on its file's row (listedAs); one that cannot be joined is unknown, with the files no entry
  // claims as what it may be (both names, never a guess written as fact).
  const list = machines.map((x) => (typeof x === 'string' ? { name: x } : x)).filter((x) => x && typeof x.name === 'string');
  const keyOf = (x) => x.workspace || x.name;
  const claimed = new Set(list.map(keyOf).filter((k) => named.has(k)));
  for (const c of computers) {
    const as = [...new Set(list.filter((x) => keyOf(x) === c.label && x.name !== c.label).map((x) => x.name))].sort();
    if (as.length) c.listedAs = as;
  }
  const loose = list.filter((x) => !named.has(keyOf(x)) && keyOf(x) !== who.label && !refusedLabels.has(keyOf(x)));
  const unknown = [...new Set(loose.map((x) => x.name))].sort();
  const unclaimed = computers.filter((c) => !c.mine && !claimed.has(c.label)).map((c) => c.label).sort();
  const unjoined = unclaimed.length ? [...new Set(loose.filter((x) => !x.workspace).map((x) => x.name))].sort().map((name) => ({ name, maybe: unclaimed })) : [];
  const notes = [];
  const conflicts = conflict ? [{ label: conflict.label, why: `ai_brain/${relFileOf(conflict.label)} holds another computer's id: two computers took the label ${conflict.label}, and this one does not write that file; give this computer another label (hoprig workspace label <name>)` }] : [];
  const base = { label: who.label, computers, unknown, ...(unjoined.length ? { unjoined } : {}), refused: who.refused, ...(conflicts.length ? { conflicts } : {}), ...(who.folderWhy ? { folderWhy: who.folderWhy } : {}) };
  if (m.errors) return { ...base, entries: [], mapErrors: m.errors, notes: [`the workspace map was refused: ${m.errors.join('; ')}`] };
  if (!m.exists) return { ...base, entries: [], noMap: true, notes: ['there is no workspace map yet (hoprig workspace map writes one)'] };
  const here = new Set(disk);
  const last = await lastHereOf(brain, who.label, run);
  const others = computers.filter((c) => !c.mine);
  const on = (name) => [...new Set([...(here.has(name) && who.label ? [who.label] : []), ...others.filter((c) => c.here.includes(name)).map((c) => c.label)])].sort();
  const entries = [
    ...(m.map.groups || []).filter((g) => g.url).map((g) => ({ kind: 'group', name: g.dir, place: g.dir, url: g.url })),
    ...m.map.projects.map((p) => ({ kind: 'project', name: refOf(p), place: placeOf(p), url: p.url || null, repos: p.repos.length })),
    ...m.map.others.map((o) => ({ kind: 'other', name: o.dir, place: '', url: o.url || null, ...(o.sync === false ? { tool: true } : {}) })),
  ].map((e) => ({ ...e, here: here.has(e.name), on: on(e.name), ...(!here.has(e.name) && last.has(e.name) ? { lastHere: last.get(e.name) } : {}) }));
  if (!computers.length) notes.push('no computer has written its file in the brain yet, so where each is checked out on another computer is not known');
  if (unknown.length) notes.push(`${unknown.join(', ')} ${unknown.length === 1 ? 'has' : 'have'} written no file in the brain: what ${unknown.length === 1 ? 'it has' : 'they have'} is not known`);
  for (const u of unjoined) notes.push(`${u.name} could not be joined with a computer's file: its Hoprig has not said its workspace label (update Hoprig there). It may be ${u.maybe.join(' or ')}`);
  if (!who.label) notes.push('this computer has no label in the workspace yet (hoprig workspace label <name>): it writes no file of its own');
  for (const r of who.refused) notes.push(`ai_brain/computers/${r.name} was refused: ${r.why}`);
  for (const c of conflicts) notes.push(c.why);
  if (who.folderWhy) notes.push(who.folderWhy);
  return { ...base, entries, notes };
}

/**
 * The Computers list on this dashboard (read only; none when it shows no other computer): each name, with the
 * workspace label that computer told this dashboard when it said one.
 */
export async function machineNames() {
  try {
    const { loadMachines } = await import('../machines/store.mjs');
    return loadMachines().map((x) => ({ name: x.name, ...(x.info && typeof x.info.workspace === 'string' ? { workspace: x.info.workspace } : {}) }));
  } catch {
    return [];
  }
}

/** "as of 3 Nov 2026" for a time, the words every reader uses. */
export const asOf = (ms) => (ms ? `as of ${new Date(ms).toISOString().slice(0, 10)}` : 'as of an unknown time');
