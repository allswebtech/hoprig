// The owner's marks for the whole-computer check (`hoprig pc leave`, leave.mjs and leavehome.mjs): a home dot-folder he
// backs up himself ("keep") or does not care about ("ignore"), a folder he keeps his own way and wants left out
// ("outside"), and a database engine that holds test data only ("testData"). Each is asked once, then remembered.
//
// They live in this computer's own file in the brain (computer.mjs, key "leave"), written only through that module's
// own writer, so the marks travel with the brain and come back after a format. That file never holds a path of this
// computer: a folder is kept by its name from the home folder ("~/.toolx", "~/Desktop/old"), never outside the home,
// and never by a name that holds this computer's host name. A mark is the only thing the whole check ever writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEAVE_ENGINES, LEAVE_LISTS, LEAVE_MAX, computersHere, leaveNameWhy, leaveOf, thisComputer, writeOwnFile } from './computer.mjs';
import { claudeDir, configDir, stateDir } from '../paths.mjs';
import { isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { placesOf } from './groups.mjs';
import { readMap } from './map.mjs';
import { shown } from './needswalk.mjs';

const KINDS = [...LEAVE_LISTS, 'testData'];
const inOrAt = (p, top) => p === top || p.startsWith(top.endsWith(path.sep) ? top : top + path.sep);

/**
 * Why a folder may not be left out by the owner's word, or null. The check must look at the workspace, every place of
 * it, every project here, every repository of the map, the brain, the credentials, the SSH keys, the Android keystore,
 * Hoprig's own settings and state and the coding tool's folder: a mark that is or holds one of them (or lies inside one
 * that is not merely a folder of places) would let it say a computer can be formatted while work exists only there. A
 * stray folder of the workspace or of a place is the owner's to mark. `abs`: the folder's full path.
 */
export function outsideWhy(abs, { dir = workspaceDir(), projects = projectsIn(), home = os.homedir() } = {}) {
  const m = readMap(dir);
  const map = m.exists && !m.errors ? m.map : null;
  const places = placesOf(map, { dir, projects }).map((pl) => pl.dir);
  const repos = [...((map && map.groups) || []), ...((map && map.others) || [])].map((g) => path.join(dir, ...g.dir.split('/')));
  const here = places.flatMap((pl) => {
    try {
      return fs.readdirSync(pl).map((n) => path.join(pl, n)).filter((d) => isGitRepo(d));
    } catch {
      return [];
    }
  });
  // [folder, its name, a mark inside it is refused too]
  const kept = [[dir, 'the workspace', false], ...places.map((p) => [p, 'a place of the workspace', false]),
    ...here.map((p) => [p, 'a project of the workspace', true]), ...repos.map((p) => [p, 'a repository of the workspace map', true]),
    [path.join(dir, 'ai_brain'), 'the AI brain', true], [path.join(dir, 'credentials'), 'the credentials folder', true],
    [path.join(home, '.ssh'), 'your SSH keys', true], [path.join(home, '.android'), 'the Android keystore', true],
    [configDir(), 'Hoprig\'s settings', true], [stateDir(), 'Hoprig\'s state', true], [claudeDir(), 'the coding tool\'s folder', true]];
  const a = path.resolve(abs);
  for (const [k, what, inside] of kept) {
    const p = path.resolve(k);
    if (inOrAt(p, a) || (inside && inOrAt(a, p))) return `${what} is looked at by the check itself, so it cannot be left out (a folder you keep your own way, such as ~/Desktop/old, can)`;
  }
  return null;
}
export const NO_LABEL = 'this computer has no label in the workspace yet, and the marks are kept in its own file: give it one with  hoprig workspace label <name>';

const empty = () => ({ keep: [], ignore: [], outside: [], testData: [] });

/** The marks this computer's own file holds (empty lists when it has no label or no file yet). */
export function readMarks({ dir = workspaceDir() } = {}) {
  const me = thisComputer();
  const out = { ...empty(), label: me.label };
  if (!me.label) return out;
  // Only the file that is really this computer's (its id too): another computer's file under the label is not its word.
  const file = computersHere(dir).files.find((f) => f.label === me.label && f.id === me.id);
  const leave = file && file.leave ? file.leave : {};
  // A mark that now holds this computer's host name (the host was renamed after it was made) is left out.
  for (const k of KINDS) out[k] = [...(leave[k] || [])].filter((n) => k === 'testData' || !leaveNameWhy(n));
  return out;
}

/**
 * A folder as typed (absolute, relative to the current folder, or "~/…") → { name: "~/…" } | { why }. ".." is refused
 * as typed, before anything is resolved: a mark names one folder plainly.
 */
export function homeName(what, home = os.homedir()) {
  const s = typeof what === 'string' ? what.trim() : '';
  if (!s) return { why: 'name a folder to mark' };
  if (s.split(/[\\/]/).includes('..')) return { why: `"${shown(s)}": a folder is named without ".."` };
  const top = path.resolve(home);
  const abs = s === '~' ? top : s.startsWith('~/') ? path.join(top, s.slice(2)) : path.resolve(s);
  const rel = path.relative(top, abs);
  if (!rel) return { why: 'the home folder itself cannot be marked: name a folder in it' };
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { why: `"${shown(s)}" is outside your home folder: only a folder of the home can be marked, because the computer's file holds no other path` };
  const name = `~/${rel.split(path.sep).join('/')}`;
  const why = leaveNameWhy(name);
  return why ? { why: `"${shown(s)}": ${why}` } : { name };
}

/** Keep `next` through the computer file's own writer. → { ok, why?, marks } */
async function save(dir, before, next) {
  const w = await writeOwnFile({ dir, leave: leaveOf(next) });
  if (!w.written && !w.same) return { ok: false, why: w.why || 'the computer\'s file was not written', marks: before };
  return { ok: true, marks: readMarks({ dir }) };
}

/**
 * Mark `what`: kind 'keep' | 'ignore' (a home dot-folder), 'outside' (any folder of the home), 'testData' (an engine
 * name). One folder has one mark: a new one takes the place of the old. → Promise<{ ok, why?, marks }>
 */
export async function setMark({ dir = workspaceDir(), home = os.homedir(), kind, what } = {}) {
  const before = readMarks({ dir });
  const no = (why) => ({ ok: false, why, marks: before });
  if (!KINDS.includes(kind)) return no(`a mark is one of ${KINDS.join(', ')}`);
  if (!before.label) return no(NO_LABEL);
  const next = { ...before };
  if (kind === 'testData') {
    const engine = typeof what === 'string' ? what.trim().toLowerCase() : '';
    if (!LEAVE_ENGINES.includes(engine)) return no(`"${shown(what)}" is not a database engine Hoprig knows: one of ${LEAVE_ENGINES.join(', ')}`);
    next.testData = [...new Set([...before.testData, engine])];
  } else {
    const n = homeName(what, home);
    if (n.why) return no(n.why);
    if (kind === 'outside') {
      const why = outsideWhy(path.join(home, ...n.name.slice(2).split('/')), { dir, home });
      if (why) return no(`${n.name}: ${why}`);
    }
    if (kind !== 'outside' && !n.name.slice(2).startsWith('.')) return no(`${n.name} is not a dot-folder of the home: keep and ignore are for those; a folder you back up your own way is left out with --outside`);
    for (const k of LEAVE_LISTS) next[k] = before[k].filter((x) => x !== n.name);
    next[kind] = [...next[kind], n.name];
    if (next[kind].length > LEAVE_MAX) return no(`at most ${LEAVE_MAX} folders can be marked ${kind}`);
  }
  return save(dir, before, next);
}

/** Take the mark off a folder or an engine, whichever it has. → Promise<{ ok, why?, marks }> */
export async function unmark({ dir = workspaceDir(), home = os.homedir(), what } = {}) {
  const before = readMarks({ dir });
  if (!before.label) return { ok: false, why: NO_LABEL, marks: before };
  const engine = typeof what === 'string' ? what.trim().toLowerCase() : '';
  const n = LEAVE_ENGINES.includes(engine) ? { engine } : homeName(what, home);
  if (n.why) return { ok: false, why: n.why, marks: before };
  const next = { ...before, testData: before.testData.filter((e) => e !== n.engine) };
  for (const k of LEAVE_LISTS) next[k] = before[k].filter((x) => x !== n.name);
  if (KINDS.every((k) => next[k].length === before[k].length)) return { ok: false, why: `${n.engine || n.name} has no mark`, marks: before };
  return save(dir, before, next);
}
