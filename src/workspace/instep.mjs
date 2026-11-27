// Projects in step between this person's computers. A light look (every 30 minutes by the upkeep, and right before a
// session or chat starts in a project) fetches each project's repositories and moves ONE kind of branch: a clean
// branch that is only behind, with nothing under way, no session or chat open in that folder, in a place whose switch
// (automation.workspace.ffProjects: { "<place>": true }, "projects" for the projects folder) is on. The move is git's
// fast-forward only (`merge --ff-only`): it refuses by itself when a changed file of the owner's is among the new
// commits. Never a merge, a reset, a rebase, a stash or a push; a default branch is never pushed here.
//
// What is left is kept as one row each (a file in the state folder, read without any network by the page):
//   behind    the git server has newer commits and the branch was not moved (switch off, a session open, a rebase under way)
//   dirty     newer commits, but they touch a file changed here
//   diverged  both sides have new commits
//   unpushed  commits only on this computer
// Nothing in step has a row: the list is empty and the page shows nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from '../automation/store.mjs';
import { FAST_FORWARD, repoInfo } from '../pcsetup/workspace.mjs';
import { stateDir } from '../paths.mjs';
import { capture } from '../setup/system.mjs';
import { mapTargets } from './groups.mjs';
import { gitIn, leaves } from './inside.mjs';
import { isGitRepo, isLinkedWorktree, projectsIn, workspaceDir } from './layout.mjs';
import { readMap } from './map.mjs';
import { PROJECTS_PLACE } from './mapcheck.mjs';
import { gitRead } from '../gitread.mjs';
import { loadConfig } from '../config.mjs';
import { readSettings } from '../automation/settings.mjs';
import { isSecret } from '../editor/paths.mjs';

export const LOOK_EVERY_MS = 30 * 60_000;
export const START_FRESH_MS = 10 * 60_000;
export const START_CAP_MS = 3000;
const AT_ONCE = 4;
const FETCH_MS = 60_000;
// The look runs by itself: no hook of the repository (a tracked hooks folder can bring one in the very commit that is
// fetched) may run in it. A pull the owner presses keeps its hooks.
let emptyHooks = null;
const noHooks = () => {
  if (process.platform !== 'win32') return ['-c', 'core.hooksPath=/dev/null'];
  if (!emptyHooks || !fs.existsSync(emptyHooks)) emptyHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-nohooks-'));
  return ['-c', `core.hooksPath=${emptyHooks.replaceAll('\\', '/')}`];
};
const ENV = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

const realOf = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
export const instepFile = () => path.join(stateDir(), 'workspace-instep.json');
const placeKey = (place) => place || PROJECTS_PLACE;

/** What the last looks kept: { at, items: [row], looked: { label: ms } }; empty when there is nothing yet. */
export function readInstep(file = instepFile()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && typeof d === 'object' && !Array.isArray(d)) return { at: Number(d.at) || 0, items: Array.isArray(d.items) ? d.items : [], looked: d.looked && typeof d.looked === 'object' ? d.looked : {} };
  } catch {
    /* nothing kept yet */
  }
  return { at: 0, items: [], looked: {} };
}

/** The list for the page: rows only, from the last look. */
export const instepList = (file = instepFile()) => {
  const { at, items } = readInstep(file);
  return { at, items };
};

/** The list and the credentials row (read from this computer's folders, no network). */
export async function instepNow({ dir = workspaceDir(), file = instepFile() } = {}) {
  const l = instepList(file);
  const row = await (await import('./credrepo.mjs')).credentialsRow({ dir }).catch(() => null);
  return row ? { ...l, items: [...l.items, row] } : l;
}

const n = (k) => `${k} commit${k > 1 ? 's' : ''}`;
const ROWS = {
  behind: (s, why) => `${n(s.behind)} newer on the git server${why ? `, ${why}` : ''}`,
  dirty: (s) => `${n(s.behind)} newer on the git server, in files you changed here`,
  diverged: (s) => `${n(s.ahead)} here and ${n(s.behind)} there`,
  unpushed: (s) => `${n(s.ahead)} only on this computer`,
};
const BUTTON = { behind: 'Get it', dirty: 'Show', diverged: 'Show', unpushed: 'Show' };

/** A rebase, merge, cherry-pick or revert under way in the repository: nothing is moved under it. */
async function underWay(dir, run) {
  const g = await gitRead(dir, ['rev-parse', '--git-dir'], { run });
  if (!g.ok) return true;
  const gd = path.resolve(dir, g.stdout.trim());
  return ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((f) => fs.existsSync(path.join(gd, f)));
}

/** The folders of the sessions and chats open now (read once per look). */
async function openFolders() {
  const { listRuns } = await import('../runs.mjs');
  return listRuns({ chats: true, usage: false }).filter((r) => r.cwd).map((r) => path.resolve(r.cwd));
}

/** Is a session or chat open in this folder (or in a folder that holds it, inside its project)? */
export const sessionOpenIn = (folders) => (dir, root) => {
  const inside = (a, b) => a === b || a.startsWith(b + path.sep);
  // Sessions and chats stand in real folders: the workspace may be reached through a link.
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const here = real(dir);
  const top = real(root || dir);
  return folders.some((c0) => {
    const c = real(c0);
    return inside(c, here) || (inside(here, c) && inside(c, top));
  });
};

/** One repository: fetch, then move it when that is safe. → { label, row?, moved?: n, fetched } */
async function lookOne(t, { dir, projects, move, busy, run, fetchMs, cancelled }) {
  const at = { root: t.root, dir, projects };
  const f = await gitIn(at, t.dir, [...noHooks(), 'fetch', '--prune', '--quiet'], run, { env: ENV(), timeout: fetchMs });
  const s = await repoInfo(t.dir, run);
  const out = { label: t.label, fetched: f.ok };
  if (!s.ok || !s.upstream || s.branch === '(detached)') return out;
  const name = t.project || t.label;
  const row = (state, why) => ({ id: t.label, label: t.label, project: name, state, why: ROWS[state](s, why), button: BUTTON[state] });
  if (s.ahead && s.behind) return { ...out, row: row('diverged') };
  if (s.ahead) return { ...out, row: row('unpushed') };
  if (!s.behind) return out;
  if (!move) return { ...out, row: row('behind') };
  if (cancelled()) return out; // the start it was for went on without it
  if (await underWay(t.dir, run)) return { ...out, row: row('behind', 'something is under way there') };
  if (await busy(t.dir, t.root)) return { ...out, row: row('behind', 'a session is open there') };
  if (cancelled()) return out;
  const p = await gitIn(at, t.dir, [...noHooks(), ...FAST_FORWARD('@{u}')], run, { env: ENV(), timeout: 60_000 });
  if (p.ok) return { ...out, moved: s.behind };
  return { ...out, row: row(s.changes ? 'dirty' : 'behind', s.changes ? '' : 'it could not be moved') };
}

async function pool(list, k, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(k, list.length) }, async () => {
    while (i < list.length) {
      const j = i++;
      out[j] = await fn(list[j]);
    }
  }));
  return out;
}

/**
 * The look. `ff`: the places whose switch is on ({ projects: true }); `only`: one project's name (its rows are
 * replaced, the others kept); `busy(dir, root)`: is a session open there. → { at, items, moved: [{ label, n }] }
 */
export async function lookProjects({ dir = workspaceDir(), projects = projectsIn(), ff = { [PROJECTS_PLACE]: true }, only = null, busy = null, run = capture, now = () => Date.now(), file = instepFile(), fetchMs = FETCH_MS, onlyDirs = null, cancelled = () => false } = {}) {
  const m = readMap(dir);
  const kept = readInstep(file);
  const out = { at: now(), items: [], moved: [] };
  if (!m.exists || m.errors) return { ...out, items: kept.items };
  const isBusy = busy || sessionOpenIn(await openFolders().catch(() => []));
  const all = await mapTargets(m.map, { dir, projects }, run);
  const skipTool = new Set(all.filter((x) => x.kind === 'project' && x.entry.sync === false).map((x) => x.project));
  const targets = all.filter((t) => {
    if (!['project', 'repo'].includes(t.kind) || t.blocked || t.entry.sync === false || skipTool.has(t.project)) return false;
    if (only && t.project !== only) return false;
    if (onlyDirs && !onlyDirs(t)) return false;
    // A secret place (the credentials folder, one set aside, a sign-in folder) is never fetched or moved by the look.
    if (isSecret(realOf(t.dir))) return false;
    return isGitRepo(t.dir) && !isLinkedWorktree(t.dir) && !leaves(t.root, t.dir, { dir, projects });
  });
  const done = await pool(targets, AT_ONCE, async (t) => {
    try {
      return await lookOne(t, { dir, projects, move: ff[placeKey(t.place)] === true, busy: isBusy, run, fetchMs, cancelled });
    } catch (e) {
      return { label: t.label, fetched: false, error: e.message };
    }
  });
  const looked = { ...kept.looked };
  const mine = new Set(targets.map((t) => t.label));
  for (const r of done) {
    if (r.fetched) looked[r.label] = out.at;
    if (r.moved) out.moved.push({ label: r.label, n: r.moved });
  }
  // The rows of the repositories looked at are replaced by this look's; the rest are kept (a look of one project).
  out.items = [...kept.items.filter((i) => !mine.has(i.label)), ...done.filter((r) => r.row).map((r) => r.row)];
  if (cancelled()) return out;
  writeAtomic(file, { at: only || onlyDirs ? kept.at || out.at : out.at, items: out.items, looked });
  return out;
}

/**
 * Right before a session or a chat starts in `cwd`: the project's repositories that were not looked at for 10 minutes
 * are fetched (3 seconds at most in all) and moved when that is safe. Never throws, never waits longer than the cap, and
 * does nothing where the place's switch is off.
 */
export async function lookBeforeStart(cwd, { dir = workspaceDir(), projects = projectsIn(), ff = null, file = instepFile(), now = () => Date.now(), cap = START_CAP_MS, ...rest } = {}) {
  try {
    const sw = ff || readSettings(loadConfig().automation).workspace.ffProjects;
    if (!sw || !Object.values(sw).some(Boolean)) return null;
    const folder = path.resolve(cwd);
    const inside = (a, b) => a === b || a.startsWith(b + path.sep);
    const kept = readInstep(file);
    const stale = (t) => now() - (kept.looked[t.label] || 0) >= START_FRESH_MS;
    const want = (t) => sw[placeKey(t.place)] === true && (inside(t.dir, folder) || inside(folder, t.dir) || inside(folder, t.root)) && stale(t);
    let timer;
    const stop = { v: false };
    const late = new Promise((res) => {
      timer = setTimeout(() => ((stop.v = true), res(null)), cap);
      timer.unref?.();
    });
    const go = lookProjects({ dir, projects, ff: sw, file, now, fetchMs: Math.max(500, cap - 200), onlyDirs: want, cancelled: () => stop.v, ...rest }).catch(() => null);
    const r = await Promise.race([go, late]);
    clearTimeout(timer);
    return r;
  } catch {
    return null;
  }
}
