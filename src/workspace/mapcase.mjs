// A folder whose name differs from its map entry only in letter case ("Shop" here, "shop" in the map), and its rename
// to the map's name (`hoprig workspace map --fix-case`, POST /api/workspace/map/case, the Workspace page's button).
//
// On a disk that ignores letter case (macOS, Windows by default) "Shop" IS the folder "shop", so the map's entry looks
// here while every other computer, and every command that names the folder, spells it another way. On a disk that
// keeps letter case the entry looks missing, and `hoprig get shop` would clone a second copy beside "Shop". Both are
// reported, the same sentence ("The folder Shop is shop in the map"); which kind of disk it is is asked of the disk
// (caseBlind: a probe file in the parent, removed at once) and can be given by a caller (a test).
//
// The rename goes through a temporary name in the same parent (Shop → .hoprig-case-shop → shop): on a case-blind disk
// a direct rename may do nothing. Each act goes through inside.mjs. Refused, each in one sentence: the map's name is
// there already as another folder, the folder is a link or not really inside its place, a program works in it now
// (busyIn, as adopt asks). Interrupted between the two renames: the next look finds the temporary name and finishes
// it, and status says so. Undo is the same rename back; what was renamed is kept in Hoprig's state folder.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../automation/store.mjs';
import { stateDir } from '../paths.mjs';
import { mapTargets } from './groups.mjs';
import { kindAt, leaves, removeIn, renameIn, writeIn } from './inside.mjs';
import { projectsIn, workspaceDir } from './layout.mjs';
import { readMap } from './map.mjs';

export const TMP_PREFIX = '.hoprig-case-';
export const CHANGED = 'This changed since you looked: look again.';
const fail = (status, message) => Object.assign(new Error(message), { status });
const idOf = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const namesIn = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
};
const lst = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

const probes = new Map();
/**
 * Does the disk under `parent` ignore letter case? A file of a new lowercase name is made there and looked for in
 * capitals, then removed at once. → true | false | null (it could not be asked: the folder cannot be written).
 */
export function caseBlind(parent, at = {}) {
  if (probes.has(parent)) return probes.get(parent);
  const a = { ...at, root: parent };
  const file = path.join(parent, `${TMP_PREFIX}probe-${crypto.randomBytes(4).toString('hex')}`);
  let blind = null;
  try {
    writeIn(a, file, '', { excl: true });
    try {
      blind = kindAt(path.join(parent, path.basename(file).toUpperCase())) !== 'none';
    } finally {
      removeIn(a, file);
    }
  } catch {
    return null;
  }
  probes.set(parent, blind);
  return blind;
}

/**
 * Every entry of the map whose folder here differs from its name only in letter case, or is halfway through its
 * rename. → [{ kind, label, name, parent, folder, half, many?, blind, words }]. `blind`: the disk's answer, given.
 */
export async function caseReport({ dir = workspaceDir(), projects = projectsIn(), map, blind } = {}) {
  if (!map) return [];
  const at = { dir, projects };
  const out = [];
  for (const t of await mapTargets(map, at)) {
    if (t.blocked) continue;
    const parent = path.dirname(t.dir);
    const name = path.basename(t.dir);
    const names = namesIn(parent);
    if (!names || names.includes(name)) continue;
    const half = names.includes(`${TMP_PREFIX}${name}`);
    const like = names.filter((n) => n.toLowerCase() === name.toLowerCase());
    if (!half && !like.length) continue;
    const folder = half ? `${TMP_PREFIX}${name}` : like[0];
    const words = half ? `The folder ${folder} is halfway through its rename to ${name}: finish it` : `The folder ${folder} is ${name} in the map`;
    out.push({ kind: t.kind, label: t.label, name, parent, folder, half, like, ...(like.length > 1 && !half ? { many: like } : {}), blind: blind ?? caseBlind(parent, at), words });
  }
  return out;
}

/** For mapStatus: the report, each entry's fix pointing to it, and whether the map's upgrade can be undone here. */
export async function statusExtras({ dir, projects, map, entries, blind }) {
  const caseOnly = await caseReport({ dir, projects, map, blind });
  for (const c of caseOnly) {
    const e = entries.find((x) => x.kind === c.kind && x.label === c.label);
    if (e) Object.assign(e, { caseOf: c.folder, fix: 'hoprig workspace map --fix-case' });
  }
  const { undoPlan } = await import('./mapundo.mjs');
  return { ...(caseOnly.length ? { caseOnly } : {}), ...(readRecord().length ? { caseUndo: true } : {}), ...(undoPlan({ dir }).can ? { upgradeUndo: true } : {}) };
}

const busyOf = async (dirs) => (await import('../adopt/apply.mjs')).busyIn(dirs);
const UNSEEN = 'This system cannot show whether a session works in it: close any session in that folder first.';

/** One folder's checks at this moment: { action: 'rename' | 'finish', unseen? } or { refused }. */
async function checkOne(e, at) {
  const from = path.join(e.parent, e.folder);
  if (e.half && e.like && e.like.length) return { refused: `${e.like[0]} and ${e.folder} are both here: keep the one you want and rename the other yourself` };
  if (e.many) return { refused: `${e.many.join(' and ')} each differ from ${e.name} only in letter case: rename one of them yourself first` };
  const st = lst(from);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return { refused: `${e.folder} is not a folder of its own here (a link or a file): nothing is renamed` };
  if (leaves(e.parent, from, at)) return { refused: `${e.folder} is not really inside its place (a link on the way leads out): nothing is renamed` };
  const names = namesIn(e.parent) || [];
  // On a case-blind disk the map's name finds the folder itself; only an entry of exactly that name is another one.
  if (names.includes(e.name) || (e.blind === false && kindAt(path.join(e.parent, e.name)) !== 'none')) return { refused: `${e.name} is there already as another folder: nothing is renamed` };
  if (!e.half && names.includes(`${TMP_PREFIX}${e.name}`)) return { refused: `${TMP_PREFIX}${e.name} is in the way: nothing is renamed` };
  const busy = await busyOf([from]);
  if (busy) return { refused: `a program is working in ${e.folder} now (${busy} process${busy === 1 ? '' : 'es'}): end it, then look again` };
  return { action: e.half ? 'finish' : 'rename', ...(busy === null ? { unseen: true } : {}) };
}

const stepWords = (s) => (s.refused ? `${s.folder}: ${s.refused}.` : s.action === 'finish'
  ? `${s.folder} becomes ${s.name}: the rename that stopped halfway is finished.`
  : `${s.folder} becomes ${s.name}, through a temporary name in the same folder. Nothing inside it changes.`);
const view = (s) => ({ label: s.label, parent: s.parent, folder: s.folder, name: s.name, ...(s.action ? { action: s.action } : { refused: s.refused }), ...(s.unseen ? { unseen: UNSEEN } : {}), words: stepWords(s) });

/**
 * <folder> → <temporary name> → <name>, in one parent. The map's name is looked at again right before the second
 * step: a folder made there in between is never replaced (a rename onto an empty folder would), and the temporary
 * name stays, which the next look reports and finishes.
 */
function twoStep(a, s, first) {
  const tmp = path.join(s.parent, `${TMP_PREFIX}${s.name}`);
  if (first) renameIn(a, path.join(s.parent, s.folder), tmp);
  if (kindAt(path.join(s.parent, s.name)) !== 'none') throw fail(409, `${s.name} appeared while it was renamed: the folder waits as ${TMP_PREFIX}${s.name}; look again`);
  renameIn(a, tmp, path.join(s.parent, s.name));
}

export const recordFile = () => path.join(stateDir(), 'workspace-case.json');
const readRecord = () => {
  try {
    const r = JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
    return Array.isArray(r.renames) ? r.renames.filter((x) => x && typeof x.parent === 'string' && typeof x.from === 'string' && typeof x.to === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * Give each folder the map's name. `dryRun`: { dryRun, steps: [{ label, folder, name, action | refused, words }],
 * seen }, nothing written. Else `seen` must be the id of the look made now; every step that may go is renamed (the
 * record for undo is written before the first rename). → { done: [{ label, from, to }], refused }
 */
export async function fixCase({ dir = workspaceDir(), projects = projectsIn(), dryRun = false, seen, blind } = {}) {
  const cur = readMap(dir);
  if (cur.errors) throw fail(409, `the workspace map was refused, so nothing is renamed: ${cur.errors.join('; ')}`);
  const at = { dir, projects };
  const list = await caseReport({ ...at, map: cur.exists ? cur.map : null, blind });
  const steps = [];
  for (const e of list) steps.push({ ...e, ...(await checkOne(e, at)) });
  const shown = steps.map(view);
  if (dryRun) return { dryRun: true, steps: shown, seen: idOf(shown) };
  if (seen !== idOf(shown)) throw fail(409, CHANGED);
  const go = steps.filter((s) => s.action);
  // What was renamed, kept for undo; a step resumed from its temporary name keeps the name it had before, if known.
  const old = readRecord();
  const record = go.map((s) => ({ parent: s.parent, to: s.name, from: s.half ? (old.find((r) => r.parent === s.parent && r.to === s.name) || {}).from : s.folder })).filter((r) => r.from);
  if (record.length) writeAtomic(recordFile(), { renames: record, at: new Date().toISOString() });
  const done = [];
  for (const s of go) {
    twoStep({ ...at, root: s.parent }, s, s.action === 'rename');
    done.push({ label: s.label, from: s.folder, to: s.name });
  }
  return { done, refused: steps.length - go.length };
}

/** The same renames back. `dryRun`: { undo, dryRun, can, steps | why, seen }. Else refused unless every one can go. */
export async function undoFixCase({ dir = workspaceDir(), projects = projectsIn(), dryRun = false, seen } = {}) {
  const at = { dir, projects };
  const rec = readRecord();
  if (!rec.length) {
    if (dryRun) return { undo: true, dryRun: true, can: false, why: 'There is no rename to undo on this computer.' };
    throw fail(409, 'There is no rename to undo on this computer.');
  }
  const steps = [];
  for (const r of rec) {
    const e = { parent: r.parent, folder: r.to, name: r.from, label: r.to, half: false, blind: false };
    const names = namesIn(r.parent) || [];
    // The map's name must be there exactly, and the old name free (on a case-blind disk it finds the same folder).
    const c = !names.includes(r.to) ? { refused: `${r.to} is not there any more: nothing is renamed` } : names.includes(r.from) ? { refused: `${r.from} is there already as another folder: nothing is renamed` } : await checkOne({ ...e, blind: true }, at);
    steps.push({ ...e, ...c });
  }
  const shown = steps.map(view);
  const why = steps.find((s) => s.refused);
  if (dryRun) return { undo: true, dryRun: true, can: !why, steps: shown, ...(why ? { why: why.refused } : {}), seen: idOf(shown) };
  if (why) throw fail(409, why.refused);
  if (seen !== undefined && seen !== idOf(shown)) throw fail(409, CHANGED);
  for (const s of steps) twoStep({ ...at, root: s.parent }, s, true);
  removeIn({ root: stateDir() }, recordFile());
  return { undone: steps.map((s) => ({ from: s.folder, to: s.name })) };
}

/** `hoprig workspace map --fix-case [--undo] [--dry-run] [--yes] [--json]`: the look, one question, the renames. */
export async function fixCaseMain(o, { ui, json, failed, locked }) {
  const call = (x) => (o.undo ? undoFixCase(x) : fixCase(x));
  let look;
  try {
    look = await call({ dryRun: true });
  } catch (e) {
    return failed(e);
  }
  const todo = o.undo ? (look.can ? look.steps : []) : look.steps.filter((s) => s.action);
  if (o['dry-run'] || !todo.length) {
    if (o.json) return json(look);
    if (o.undo && !look.can) return failed(new Error(look.why));
    if (!look.steps.length) ui.line('ok', 'every folder has the name the map gives it');
    for (const s of look.steps) ui.line(s.refused ? 'warn' : 'info', `${o['dry-run'] && !s.refused ? '(dry run) ' : ''}${s.words}`);
    return todo.length || !look.steps.length ? 0 : 1;
  }
  if (!o.json) for (const s of look.steps) ui.out(`  ${s.words}${s.unseen ? ` ${s.unseen}` : ''}`);
  const sure = o.yes || ui.yes || (!o.json && ui.interactive && (await ui.confirm(o.undo ? 'Give the folders their old names back?' : 'Rename these folders?', false)));
  if (!sure) return failed(new Error(`nothing was renamed${ui.interactive || o.json ? '' : ' (add --yes to rename without a question)'}`));
  let r;
  try {
    r = await locked(() => call({ seen: look.seen }));
  } catch (e) {
    return failed(e);
  }
  if (o.json) return json(r);
  for (const d of r.done || r.undone) ui.line('ok', `${d.from} is ${d.to} now`);
  if (!o.undo) ui.note('hoprig workspace map --fix-case --undo gives them their old names back');
  return 0;
}
