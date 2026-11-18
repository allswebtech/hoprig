// `hoprig workspace map --upgrade`: the map from version 1 to version 2 (groups, mapcheck.mjs), only when the owner
// runs it. A computer whose Hoprig knows only version 1 refuses a version-2 map and changes nothing in it (its strict
// check stops before any write), but its map then stands still until Hoprig is updated there. So the upgrade first
// says which computers are behind, from each computer's own file in the brain (ai_brain/computers/<label>.json,
// { "hoprig": "<version>" }, written by each computer for itself), and always that a computer that never reported
// cannot be seen from here; it asks once, with no as the default. The upkeep never upgrades a map.
//
// The content stays the same, with one exception: an entry whose folder here is a linked worktree (a second checkout
// of another repository that an older map took for a repository) is dropped.
import fs from 'node:fs';
import path from 'node:path';
import { isLinkedWorktree, projectsIn, workspaceDir } from './layout.mjs';
import { refOf } from './mapcheck.mjs';
import { readMap, writeMap } from './map.mjs';

/** The first Hoprig release that reads a map of version 2. */
export const READS_V2 = '0.3.0';
const fail = (status, message) => Object.assign(new Error(message), { status });
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}\.json$/;

/** a < b for versions like 1.2.3 (anything after the numbers is left out). */
export function olderThan(a, b) {
  const n = (v) => String(v).split(/[^0-9.]/)[0].split('.').map((x) => Number(x) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

/** What each computer's file in the brain says: { known, computers: [{ label, hoprig }], behind: [{ label, hoprig }] }. */
export function computersBehind(dir = workspaceDir(), need = READS_V2) {
  const folder = path.join(dir, 'ai_brain', 'computers');
  let files = [];
  try {
    files = fs.readdirSync(folder).filter((f) => LABEL_RE.test(f)).sort();
  } catch {
    /* none yet */
  }
  const computers = files.map((f) => {
    let v = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'));
      v = j && typeof j.hoprig === 'string' && /^\d{1,4}\.\d{1,5}\.\d{1,6}/.test(j.hoprig) ? j.hoprig : null;
    } catch {
      /* unreadable: counted as unknown */
    }
    return { label: f.replace(/\.json$/, ''), hoprig: v };
  });
  return { known: computers.length > 0, need, computers, behind: computers.filter((c) => !c.hoprig || olderThan(c.hoprig, need)) };
}

/**
 * The upgrade. → { already?, dryRun, from, to, dropped: [label], computers: computersBehind(), map }. Nothing is
 * written with dryRun, nor when the map is version 2 already.
 */
export function upgradeMap({ dir = workspaceDir(), projects = projectsIn(), dryRun = false } = {}) {
  const cur = readMap(dir);
  if (cur.errors) throw fail(409, `the workspace map was refused, so it was not upgraded: ${cur.errors.join('; ')}`);
  if (!cur.exists) throw fail(404, 'there is no workspace map yet (hoprig workspace map makes one)');
  const computers = computersBehind(dir);
  if (cur.map.version === 2) return { already: true, dryRun, from: 2, to: 2, dropped: [], computers, map: cur.map };
  const m = JSON.parse(JSON.stringify(cur.map));
  const dropped = [];
  const wt = (p) => isLinkedWorktree(p);
  m.projects = m.projects.filter((p) => {
    const root = path.join(projects, p.name);
    if (wt(root)) {
      dropped.push(refOf(p));
      return false;
    }
    p.repos = p.repos.filter((r) => !(wt(path.join(root, r.dir)) && dropped.push(`${p.name}/${r.dir}`)));
    return true;
  });
  m.others = m.others.filter((o) => !(wt(path.join(dir, o.dir)) && dropped.push(o.dir)));
  const next = { ...m, version: 2, groups: [] };
  const written = dryRun ? next : writeMap(next, dir);
  return { dryRun, from: 1, to: 2, dropped, computers, map: written };
}

/**
 * The lines a person reads before saying yes: what the computers' files show, and what they cannot show (a computer
 * that never reported is not seen from here, so "nobody is behind" is never claimed).
 */
export function upgradeWords(r) {
  const c = r.computers;
  const unseen = `A computer that never reported cannot be seen from here: update Hoprig to ${c.need} or later on every computer first.`;
  const refuses = `A computer with an older Hoprig refuses a map of version 2 and keeps its map as it is until Hoprig is updated there.`;
  if (!c.known) return ['No computer has reported its Hoprig version yet (ai_brain/computers/).', refuses, unseen];
  const ok = c.computers.filter((x) => !c.behind.includes(x));
  const lines = [];
  if (ok.length) lines.push(`${ok.length} computer${ok.length === 1 ? ' has' : 's have'} reported a Hoprig that reads this (${ok.map((x) => x.label).join(', ')}).`);
  if (c.behind.length) lines.push(`${c.behind.length === 1 ? 'This computer reported' : 'These computers reported'} a Hoprig older than ${c.need}: ${c.behind.map((x) => `${x.label} (${x.hoprig || 'unknown'})`).join(', ')}.`, refuses);
  lines.push(unseen);
  return lines;
}
