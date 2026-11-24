// `hoprig workspace sync [--memory] [--push] [--with <computer>]`: every repository of the workspace map, the brain
// first. The engine is the one `project sync` uses (pcsetup/workspace.mjs syncRepo): fetch; fast-forward a clean
// branch that is only behind; push a branch that is only ahead, and only with --push; never merge, rebase, force or
// stash. Whatever needs a decision is listed with the exact command. --memory first commits the memory folders (and
// only them). --dry-run fetches nothing: it asks the server for each branch's commit (git ls-remote) and says what it would do. --with syncs from another computer over SSH instead of the git server (peer.mjs, pull only).
import fs from 'node:fs';
import path from 'node:path';
import { todoKind } from '../pcsetup/feature.mjs';
import { commitMemory, notFollowed as notFollowedRepo, repoInfo, syncRepo, syncWorkspace } from '../pcsetup/workspace.mjs';
import { capture, showCommand } from '../setup/system.mjs';
import { WORKTREE_LEFT, isGitRepo, isLinkedWorktree, projectsIn, workspaceDir } from './layout.mjs';
import { findProject, mapTargets, placesOf } from './groups.mjs';
import { leaves } from './inside.mjs';
import { readMap, refOf, scanWorkspace } from './map.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const kindOf = (why) => (/commits? to push$/.test(why) ? 'to-push' : todoKind(why));

/**
 * The repositories to sync, in order: [{ label, dir, kind, project?, tool?, exclude? }]: the brain, the credentials
 * repository when the map names one, each group that
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
  // The credentials repository the map names (restore clones it into <workspace>/credentials): kept in step like the
  // other repositories, by the upkeep too.
  if (map.credentials && map.credentials.url) out.push({ label: 'credentials', dir: path.join(dir, 'credentials'), root: path.join(dir, 'credentials'), kind: 'credentials', url: map.credentials.url });
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

/** The targets of one run: all; the upkeep's (never a project: only the brain, groups and others); one project's. */
function scopeOf(targets, { upkeep = false, only = null } = {}) {
  if (upkeep) return targets.filter((t) => !['project', 'repo'].includes(t.kind));
  if (only) return targets.filter((t) => t.project === only);
  return targets;
}

/**
 * Sync everything. → { fromMap, memory: [{ label, committed, why? }], repos: [{ label, did, todo: [{ why, command,
 * kind }], state? }], tools: [label: left alone], notHere: [label], done, todo }.
 * A project (or a code repository of one) that is only in the map is the normal state: never listed as something to
 * do, only counted in `notHere`. `upkeep`: the upkeep's round, which never touches a project. `only`: one project of
 * the map (its name as `hoprig get` takes it), its parent and code repositories alone. `mapRule`: the upkeep's map part
 * runs the map's rule in this round (commitMap and push on), so a brain it settles is no thing to decide.
 */
export async function syncAll({ dir = workspaceDir(), projects = projectsIn(), memory = false, push = false, dryRun = false, run = capture, onLine = () => {}, upkeep = false, only = null, mapRule = false } = {}) {
  const found = await syncTargets({ dir, projects, run });
  let one = null;
  if (only) {
    const m = readMap(dir);
    if (!m.exists) throw fail(404, 'there is no workspace map yet, so no project can be named (hoprig workspace map)');
    one = refOf(findProject(m.map, only));
  }
  const all = { ...found, targets: scopeOf(found.targets, { upkeep, only: one }) };
  const { fromMap } = all;
  // Tools are never fetched or fast-forwarded: that would be an upgrade nobody asked for (and slow).
  const tools = all.targets.filter((t) => t.tool).map((t) => t.label);
  const targets = all.targets.filter((t) => !t.tool);
  const out = { fromMap, memory: [], repos: [], tools, notHere: [] };
  if (tools.length) onLine(`· tools, left alone: ${tools.join(', ')}`);
  const add = (label, r) => {
    const e = { label, did: r.did, todo: r.todo.map((t) => ({ ...t, kind: t.kind || kindOf(t.why) })), ...(r.state ? { state: r.state } : {}) };
    out.repos.push(e);
    onLine(lineOf(e));
  };
  const brain = targets[0] && targets[0].kind === 'brain' ? targets[0] : null;
  const at = { dir, projects };
  if (brain && isGitRepo(brain.dir)) {
    if (memory) out.memory.push({ label: 'ai_brain', ...(dryRun ? { committed: false, why: 'dry run: would commit claude-memory when it changed' } : await commitMemory(brain.dir, { '.': 'claude-memory' }, run, at)) });
    // The computers' own files are Hoprig's to commit (the upkeep's commitMap): never a change for the owner to decide.
    const r = await syncRepo(brain.dir, '.', run, { push, dryRun, root: brain.root, at, exclude: ['computers'] });
    // The upkeep with the map kept on the git server: a brain that moved on both sides with only Hoprig's own commits
    // here is settled by the map's rule in the same round (mapkeep.mjs), never a thing for the owner to decide.
    if (mapRule && r.todo.some((t) => todoKind(t.why) === 'diverged') && (await (await import('./mapkeep.mjs')).ruleSettles({ dir, run }))) r.todo = r.todo.filter((t) => todoKind(t.why) !== 'diverged');
    add('ai_brain', r);
  } else if (brain) add('ai_brain', notHere(brain)); // (one project only: no brain)
  const covered = new Set(brain ? [brain.dir] : []);
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
      // Only in the map: a project comes to a computer when its owner asks for it (hoprig get). Not something to do.
      out.notHere.push(t.label);
      for (const x of targets) if (x.kind === 'repo' && x.project === t.project) covered.add(x.dir);
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
    else if (!fs.existsSync(t.dir) && t.kind === 'repo') out.notHere.push(t.label); // hoprig get <project> fetches it
    else if (!fs.existsSync(t.dir)) add(t.label, notHere(t));
    else if (t.kind === 'credentials') add(t.label, await syncCredentials(t, { push, dryRun, run, at }));
    else add(t.label, await syncRepo(t.dir, t.label, run, { push, dryRun, root: t.root, at }));
  }
  // The upkeep never moves a project, but it still says what sits only on this computer or waits on the server: counted
  // from the refs already here (no fetch, nothing moved), so the owner keeps learning about work that is not pushed.
  if (upkeep) for (const e of await projectsLook(found.targets, at, run)) add(e.label, e);
  out.done = out.repos.filter((r) => !r.todo.length).length;
  out.todo = out.repos.reduce((n, r) => n + r.todo.length, 0);
  return out;
}

/**
 * The projects (and their code repositories) on this computer with commits to push or to pull, read from the refs
 * already here: no fetch, no move. → [{ label, did: [], todo }]
 */
async function projectsLook(targets, at, run) {
  const out = [];
  for (const t of targets.filter((x) => (x.kind === 'project' || x.kind === 'repo') && !x.tool && !x.blocked)) {
    if (!isGitRepo(t.dir) || isLinkedWorktree(t.dir) || leaves(t.root, t.dir, at)) continue;
    const s = await repoInfo(t.dir, run);
    if (!s.ok || !s.upstream) continue;
    const name = t.project || t.label;
    const todo = [];
    const n = (k) => `${k} commit${k > 1 ? 's' : ''}`;
    if (s.ahead) todo.push({ why: `${n(s.ahead)} to push`, command: `hoprig sync ${name} --push` });
    if (s.behind) todo.push({ why: `${n(s.behind)} to pull (as of its last fetch): not pulled by itself`, command: `hoprig sync ${name}` });
    if (todo.length) out.push({ label: t.label, did: [], todo });
  }
  return out;
}

/**
 * The credentials repository, kept in step like the brain, with two rules of its own (credrepo.mjs): it is pushed only
 * to the address the map names, a GitHub one only while gh says it is private now; and what is said names no file in
 * it (git's lists of files in the way become plain words). syncRepo never pushes it: its plain `git push` would follow
 * the branch's push remote. The push is credrepo's own, by origin, after credPushWhy allowed it.
 */
async function syncCredentials(t, { push, dryRun, run: given, at }) {
  const cr = await import('./credrepo.mjs');
  const run = cr.withoutHooks(given); // no hook of the owner's runs in the folder (credrepo.mjs withoutHooks)
  const why = push ? await cr.credPushWhy({ dir: at.dir, url: t.url, run }) : '';
  const r = await syncRepo(t.dir, t.label, run, { push: dryRun && push && !why, dryRun, root: t.root, at });
  const ahead = r.todo.find((x) => /^\d+ commits? to push$/.test(x.why));
  if (ahead) ahead.command = showCommand(['git', '-C', t.dir, 'push', 'origin', 'HEAD']);
  if (push && !why && !dryRun && ahead) {
    const p = await cr.pushCredentials({ ...at, root: t.root }, t.dir, run, { upstream: true });
    if (p.ok) {
      r.todo = r.todo.filter((x) => x !== ahead);
      r.did.push(`pushed ${parseInt(ahead.why, 10)}`);
      r.state = await repoInfo(t.dir, run);
    } else ahead.why = `${ahead.why}: the push failed (${cr.gitWords(p)})`;
  }
  // git's own words (a fetch that failed, a server that could not be asked, a status) may name a file of the folder.
  const GIT_TEXT = /^(fetch failed|push failed|the server could not be asked): ([\s\S]*)$/;
  r.todo = r.todo.map((x) => (GIT_TEXT.test(x.why) ? { ...x, why: `${GIT_TEXT.exec(x.why)[1]}: ${cr.gitWords(GIT_TEXT.exec(x.why)[2])}` } : x));
  r.todo = r.todo.map((x) => (/commits? to push$/.test(x.why) && why ? { ...x, why: `${x.why}: not pushed, ${why}` } : /put files where|They also change/.test(x.why) ? { ...x, why: 'the incoming commits meet changes here: look at the credentials folder yourself (git status there)' } : x));
  return r;
}

/** One line a person can read: "shop/code/shop-web  pulled 2" or "…  2 commits to push → git -C … push". */
export function lineOf(e) {
  const state = e.state && e.state.ok ? [e.state.branch, e.state.upstream ? '' : 'no upstream'].filter(Boolean).join(' · ') : '';
  const what = e.did.length ? e.did.join(', ') : e.todo.length ? '' : state || 'in step';
  return `${e.todo.length ? '!' : '✓'} ${e.label}${what ? `  ${what}` : ''}${e.todo.map((t) => `\n    ${t.why}${t.command ? `  →  ${t.command}` : ''}`).join('')}`;
}
