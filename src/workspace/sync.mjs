// `hoprig workspace sync [--memory] [--push] [--with <computer>]`: every repository of the workspace map, the brain
// first. The engine is the one `project sync` uses (pcsetup/workspace.mjs syncRepo): fetch; fast-forward a clean
// branch that is only behind; push a branch that is only ahead, and only with --push; never merge, rebase, force or
// stash. Whatever needs a decision is listed with the exact command. --memory first commits the memory folders (and
// only them). --dry-run fetches nothing: it asks the server for each branch's commit (git ls-remote) and says what it would do. --with syncs from another computer over SSH instead of the git server (peer.mjs, pull only).
import fs from 'node:fs';
import path from 'node:path';
import { todoKind } from '../pcsetup/feature.mjs';
import { commitMemory, notFollowed as notFollowedRepo, syncRepo, syncWorkspace } from '../pcsetup/workspace.mjs';
import { capture } from '../setup/system.mjs';
import { WORKTREE_LEFT, isGitRepo, isLinkedWorktree, projectsIn, workspaceDir } from './layout.mjs';
import { mapTargets, placesOf } from './groups.mjs';
import { leaves } from './inside.mjs';
import { readMap, refOf, scanWorkspace } from './map.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const kindOf = (why) => (/commits? to push$/.test(why) ? 'to-push' : todoKind(why));

/**
 * The repositories to sync, in order: [{ label, dir, kind, project?, tool?, exclude? }]: the brain, each group that
 * is a repository (its members left out of its changes), each project in every place with its code repositories,
 * the others. A member that comes with its group's repository has no parent of its own: only its code repositories
 * are listed. Missing ones are kept (reported). `tool`: the map says sync false (an SDK or tool checkout): restore
 * gets it, sync leaves it alone.
 */
export async function syncTargets({ dir = workspaceDir(), projects = projectsIn(), run = capture } = {}) {
  const m = readMap(dir);
  if (m.errors) throw fail(409, `the workspace map was refused: ${m.errors.join('; ')}`);
  const map = m.exists ? m.map : (await scanWorkspace({ dir, projects, run })).map;
  const out = [{ label: 'ai_brain', dir: path.join(dir, 'ai_brain'), root: path.join(dir, 'ai_brain'), kind: 'brain' }];
  const places = placesOf(map, { dir, projects });
  // Every folder comes from mapTargets (groups.mjs): a target behind a link that is not followed carries `blocked`.
  const all = await mapTargets(map, { dir, projects }, run);
  const keep = (t) => ({ dir: t.dir, root: t.root, ...(t.blocked ? { blocked: t.blocked } : {}) });
  for (const t of all.filter((x) => x.kind === 'group')) {
    const g = t.entry;
    if (!g.url) continue;
    const exclude = (g.holds || []).map((h) => (h.parent === 'group' ? `${h.dir}/*/code` : `${h.dir}/*`));
    // --memory: the group's own memory, and the memory folders of its members that come with the group's repository
    // (the group's repository tracks those), each relative to the group's folder.
    const memories = { ...(g.memories || {}) };
    for (const h of (g.holds || []).filter((x) => x.parent === 'group')) {
      for (const p of map.projects.filter((x) => x.in === `${g.dir}/${h.dir}`)) for (const [k, v] of Object.entries(p.memories || {})) memories[`${h.dir}/${p.name}/${k}`] = `${h.dir}/${p.name}/${v}`;
    }
    out.push({ label: g.dir, ...keep(t), kind: 'group', exclude, memories: Object.keys(memories).length ? memories : undefined });
  }
  for (const t of all.filter((x) => x.kind === 'project')) {
    const p = t.entry;
    const tool = p.sync === false;
    const withGroup = (places.find((x) => x.id === (p.in || '')) || {}).members === 'group';
    if (!withGroup) out.push({ label: t.label, ...keep(t), kind: 'project', project: t.label, tool });
    for (const r of all.filter((x) => x.kind === 'repo' && x.project === t.label)) out.push({ label: r.label, rel: r.entry.dir, ...keep(r), kind: 'repo', project: t.label, tool: tool || r.entry.sync === false });
  }
  for (const t of all.filter((x) => x.kind === 'other')) out.push({ label: t.label, ...keep(t), kind: 'other', tool: t.entry.sync === false });
  return { targets: out, fromMap: m.exists };
}

/** A target that leads out of its folder (inside.mjs): said, never acted on. */
export const notFollowed = (t, b = t.blocked) => ({ label: t.label, ...notFollowedRepo(t.label, b) });

const notHere = (t) => ({ label: t.label, did: [], todo: [{ why: 'not on this computer', command: 'hoprig workspace restore <brain address>', kind: 'missing' }] });

/**
 * Sync everything. → { fromMap, memory: [{ label, committed, why? }], repos: [{ label, did, todo: [{ why, command,
 * kind }], state? }], tools: [label: left alone], done, todo }.
 */
export async function syncAll({ dir = workspaceDir(), projects = projectsIn(), memory = false, push = false, dryRun = false, run = capture, onLine = () => {} } = {}) {
  const all = await syncTargets({ dir, projects, run });
  const { fromMap } = all;
  // Tools are never fetched or fast-forwarded: that would be an upgrade nobody asked for (and slow).
  const tools = all.targets.filter((t) => t.tool).map((t) => t.label);
  const targets = all.targets.filter((t) => !t.tool);
  const out = { fromMap, memory: [], repos: [], tools };
  if (tools.length) onLine(`· tools, left alone: ${tools.join(', ')}`);
  const add = (label, r) => {
    const e = { label, did: r.did, todo: r.todo.map((t) => ({ ...t, kind: t.kind || kindOf(t.why) })), ...(r.state ? { state: r.state } : {}) };
    out.repos.push(e);
    onLine(lineOf(e));
  };
  const brain = targets[0];
  const at = { dir, projects };
  if (isGitRepo(brain.dir)) {
    if (memory) out.memory.push({ label: 'ai_brain', ...(dryRun ? { committed: false, why: 'dry run: would commit claude-memory when it changed' } : await commitMemory(brain.dir, { '.': 'claude-memory' }, run, at)) });
    add('ai_brain', await syncRepo(brain.dir, '.', run, { push, dryRun, root: brain.root, at }));
  } else add('ai_brain', notHere(brain));
  const covered = new Set([brain.dir]);
  // Asked again right before acting (the map's look may be a moment old); the git calls check once more as they run.
  const stop = async (t) => t.blocked || leaves(t.root, t.dir, at);
  for (const t of targets.filter((x) => x.kind === 'group')) {
    covered.add(t.dir);
    const b = await stop(t);
    if (b) {
      add(t.label, notFollowed(t, b));
      continue;
    }
    if (!isGitRepo(t.dir)) {
      add(t.label, notHere(t));
      continue;
    }
    if (isLinkedWorktree(t.dir)) {
      add(t.label, { did: [WORKTREE_LEFT], todo: [] }); // a second checkout of another repository: never this group's
      continue;
    }
    if (memory && t.memories) out.memory.push({ label: t.label, ...(dryRun ? { committed: false, why: 'dry run: would commit the group\'s memory when it changed' } : await commitMemory(t.dir, t.memories, run, at)) });
    add(t.label, await syncRepo(t.dir, '.', run, { push, dryRun, exclude: t.exclude, root: t.root, at }));
  }
  for (const t of targets.filter((x) => x.kind === 'project')) {
    covered.add(t.dir);
    const b = await stop(t);
    if (b) {
      add(t.label, notFollowed(t, b));
      for (const x of targets) if (x.kind === 'repo' && x.project === t.project) covered.add(x.dir); // inside it: not followed either
      continue;
    }
    if (!isGitRepo(t.dir)) {
      add(t.label, notHere(t));
      continue;
    }
    if (isLinkedWorktree(t.dir)) {
      // A second checkout of another repository, not this project: it and what the map puts inside it are left alone.
      add(t.label, { did: [WORKTREE_LEFT], todo: [] });
      for (const x of targets) if (x.kind === 'repo' && x.project === t.project) covered.add(x.dir);
      continue;
    }
    // A project: its parent and the code repositories its project.json names, as `project sync` does.
    const skip = all.targets.filter((x) => x.kind === 'repo' && x.project === t.project && x.tool).map((x) => x.rel);
    const r = await syncWorkspace(t.dir, { memory, run, push, dryRun, skip, at });
    if (r.memory) out.memory.push({ label: t.label, ...r.memory });
    for (const x of r.repos) {
      const full = x.rel === '.' ? t.dir : path.join(t.dir, x.rel);
      covered.add(full);
      add(x.rel === '.' ? t.label : `${t.label}/${x.rel}`, x);
    }
  }
  // Code repositories the map has but project.json does not, and the other repositories.
  for (const t of targets.filter((x) => x.kind !== 'project' && x.kind !== 'brain' && !covered.has(x.dir) && !all.targets.some((p) => p.kind === 'project' && p.tool && p.project === x.project))) {
    const b = await stop(t);
    if (b) add(t.label, notFollowed(t, b));
    else if (!fs.existsSync(t.dir)) add(t.label, notHere(t));
    else add(t.label, await syncRepo(t.dir, t.label, run, { push, dryRun, root: t.root, at }));
  }
  out.done = out.repos.filter((r) => !r.todo.length).length;
  out.todo = out.repos.reduce((n, r) => n + r.todo.length, 0);
  return out;
}

/** One line a person can read: "shop/code/shop-web  pulled 2" or "…  2 commits to push → git -C … push". */
export function lineOf(e) {
  const state = e.state && e.state.ok ? [e.state.branch, e.state.upstream ? '' : 'no upstream'].filter(Boolean).join(' · ') : '';
  const what = e.did.length ? e.did.join(', ') : e.todo.length ? '' : state || 'in step';
  return `${e.todo.length ? '!' : '✓'} ${e.label}${what ? `  ${what}` : ''}${e.todo.map((t) => `\n    ${t.why}${t.command ? `  →  ${t.command}` : ''}`).join('')}`;
}
