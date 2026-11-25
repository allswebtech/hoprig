// The map's upgrade from version 1 to 2 on the Workspace page (POST /api/workspace/map/upgrade), and its undo. The
// upgrade itself is mapupgrade.mjs upgradeMap, the very function `hoprig workspace map --upgrade` calls; this module
// adds what the page needs around it:
//
//   - the plan in plain words (upgradeMap's dry run: the entries that leave the map, that nothing on disk changes,
//     every line of upgradeWords, what undo can and cannot do) with a short id of it (`seen`): the real call sends the
//     id back and is refused when the plan made now is another one, so what the owner says yes to is what is done;
//   - before the real upgrade, the version-1 map's exact text is kept in Hoprig's state folder (never in the brain,
//     never in the workspace), with a hash of what the upgrade wrote;
//   - undo writes that text back only while the map file is still exactly what the upgrade wrote (else one sentence
//     says why nothing was done), and then removes the kept copy. Undo works on this computer only: once the new map
//     is saved in the brain's history and shared, the other computers have it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../automation/store.mjs';
import { stateDir } from '../paths.mjs';
import { readIn, removeIn, writeIn } from './inside.mjs';
import { projectsIn, workspaceDir } from './layout.mjs';
import { mapFile, readMap, validateMap } from './map.mjs';
import { upgradeMap, upgradeWords } from './mapupgrade.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const idOf = (v) => hash(JSON.stringify(v)).slice(0, 16);

/** The one sentence for a plan that is not the one the owner saw. */
export const CHANGED = 'This changed since you looked: look again.';
/** What undo can and cannot do, said before the yes. */
export const UNDO_WORDS = [
  'Undo puts the old map back on this computer, as long as the map has not changed since the upgrade.',
  'Once the new map is saved in the AI brain\'s history and shared, your other computers get the new form: undo here does not reach them.',
];
const NOTHING = 'There is no upgrade to undo on this computer.';
const MOVED_ON = 'The map changed since the upgrade, so undo would lose that change: the map stays as it is.';

/** Where the version-1 map is kept until it is undone or upgraded again: Hoprig's state folder. */
export const keptFile = () => path.join(stateDir(), 'workspace-map-v1.json');

function readKept() {
  try {
    const k = JSON.parse(fs.readFileSync(keptFile(), 'utf8'));
    return k && typeof k.text === 'string' && typeof k.wrote === 'string' ? k : null;
  } catch {
    return null;
  }
}
// Through inside.mjs like every remove of this folder of modules (insidegrep.test.mjs); the state folder is its root.
const removeKept = () => removeIn({ root: stateDir() }, keptFile());

/** The map file's text as it is on disk (inside the brain, never through a link), or null. */
function mapText(dir) {
  const file = mapFile(dir);
  const buf = readIn({ root: path.dirname(file), dir }, file, { below: true });
  return buf ? buf.toString('utf8') : null;
}

/**
 * The page's plan: upgradeMap's dry run in plain words. → { already: true, version: 2 } when there is nothing to do,
 * else { dryRun, from, to, dropped, lines, undo, seen }. Writes nothing.
 */
export function upgradePlan({ dir = workspaceDir(), projects = projectsIn() } = {}) {
  const r = upgradeMap({ dir, projects, dryRun: true });
  if (r.already) return { already: true, version: 2 };
  const lines = [
    ...r.dropped.map((d) => `${d} leaves the map: its folder here is a second checkout of another repository (a linked worktree), not a repository of its own.`),
    'Nothing on disk changes: only the map file is written again, in the new form (version 2, which knows groups of projects).',
    ...upgradeWords(r),
  ];
  return { dryRun: true, from: r.from, to: r.to, dropped: r.dropped, lines, undo: UNDO_WORDS, seen: idOf({ from: r.from, to: r.to, dropped: r.dropped, lines }) };
}

/**
 * The real upgrade with its kept copy: the version-1 text goes to the state folder first, then upgradeMap writes the
 * map, then the copy learns the hash of what was written (undo compares against it). The command's --upgrade and the
 * page both call this. → upgradeMap's result, with kept: true.
 */
export function upgradeKept({ dir = workspaceDir(), projects = projectsIn() } = {}) {
  const cur = readMap(dir);
  // No map, a refused one or version 2 already: upgradeMap says so itself, and nothing is kept.
  if (!cur.exists || cur.errors || cur.map.version === 2) return upgradeMap({ dir, projects });
  const text = mapText(dir);
  if (text === null) return upgradeMap({ dir, projects }); // its own refusal says why
  const at = new Date().toISOString();
  writeAtomic(keptFile(), { text, wrote: '', at });
  let r;
  try {
    r = upgradeMap({ dir, projects });
  } catch (e) {
    removeKept();
    throw e;
  }
  writeAtomic(keptFile(), { text, wrote: hash(mapText(dir) || ''), at });
  return { ...r, kept: true };
}

/** The page's yes: refused unless `seen` is the id of the plan made now. */
export function upgradeFromPage({ dir = workspaceDir(), projects = projectsIn(), seen } = {}) {
  const plan = upgradePlan({ dir, projects });
  if (plan.already) return { already: true, version: 2 };
  if (seen !== plan.seen) throw fail(409, CHANGED);
  const r = upgradeKept({ dir, projects });
  return { done: true, from: r.from, to: r.to, dropped: r.dropped, undo: true };
}

/** Whether undo can run now: { undo: true, dryRun: true, can, why? | lines, seen }. Writes nothing. */
export function undoPlan({ dir = workspaceDir() } = {}) {
  const k = readKept();
  if (!k) return { undo: true, dryRun: true, can: false, why: NOTHING };
  const now = mapText(dir);
  if (now === null || hash(now) !== k.wrote) return { undo: true, dryRun: true, can: false, why: MOVED_ON };
  return { undo: true, dryRun: true, can: true, lines: ['This puts the map of version 1 back, exactly as it was before the upgrade.', UNDO_WORDS[1]], seen: k.wrote.slice(0, 16) };
}

/**
 * Undo the upgrade: the kept version-1 text written back (checked by the map's own strict check, written the way the
 * map module writes, inside the brain and never through a link), then the kept copy goes. `dryRun`: undoPlan.
 * The command's --undo and the page both call this.
 */
export function undoUpgrade({ dir = workspaceDir(), dryRun = false, seen } = {}) {
  const p = undoPlan({ dir });
  if (dryRun) return p;
  if (!p.can) throw fail(409, p.why);
  if (seen !== undefined && seen !== p.seen) throw fail(409, CHANGED);
  const k = readKept();
  let raw;
  try {
    raw = JSON.parse(k.text);
  } catch {
    raw = null;
  }
  if (!raw || !validateMap(raw).ok) throw fail(409, 'The kept copy of the old map is not a map Hoprig can read: the map stays as it is.');
  const file = mapFile(dir);
  writeIn({ root: path.dirname(file), dir }, file, k.text, { atomic: true });
  removeKept();
  return { undone: true, version: raw.version };
}

/** For the page: { exists, version, undo } (undo: an upgrade on this computer can be undone now). Read only. */
export function upgradeState({ dir = workspaceDir() } = {}) {
  const cur = readMap(dir);
  return { exists: cur.exists, version: cur.map ? cur.map.version : null, undo: undoPlan({ dir }).can };
}
