// `hoprig workspace sync [--memory] [--push] [--with <computer>]`: every repository of the workspace map, the brain
// first. The engine is the one `project sync` uses (pcsetup/workspace.mjs syncRepo): fetch; fast-forward a clean
// branch that is only behind; push a branch that is only ahead, and only with --push; never merge, rebase, force or
// stash. Whatever needs a decision is listed with the exact command. --memory first commits the memory folders (and
// only them). --dry-run fetches and says what it would do. --with syncs from another computer over SSH instead of the git server (peer.mjs, pull only).
import fs from 'node:fs';
import path from 'node:path';
import { todoKind } from '../pcsetup/feature.mjs';
import { commitMemory, syncRepo, syncWorkspace } from '../pcsetup/workspace.mjs';
import { capture } from '../setup/system.mjs';
import { isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { readMap, scanWorkspace } from './map.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const kindOf = (why) => (/commits? to push$/.test(why) ? 'to-push' : todoKind(why));

/**
 * The repositories to sync, in order: [{ label, dir, kind, project?, tool? }]. Missing ones are kept (reported).
 * `tool`: the map says sync false (an SDK or tool checkout): restore gets it, sync leaves it alone.
 */
export async function syncTargets({ dir = workspaceDir(), projects = projectsIn(), run = capture } = {}) {
  const m = readMap(dir);
  if (m.errors) throw fail(409, `the workspace map was refused: ${m.errors.join('; ')}`);
  const map = m.exists ? m.map : (await scanWorkspace({ dir, projects, run })).map;
  const out = [{ label: 'ai_brain', dir: path.join(dir, 'ai_brain'), kind: 'brain' }];
  for (const p of map.projects) {
    const root = path.join(projects, p.name);
    const tool = p.sync === false;
    out.push({ label: p.name, dir: root, kind: 'project', project: p.name, tool });
    for (const r of p.repos) out.push({ label: `${p.name}/${r.dir}`, rel: r.dir, dir: path.join(root, r.dir), kind: 'repo', project: p.name, tool: tool || r.sync === false });
  }
  for (const o of map.others) out.push({ label: o.dir, dir: path.join(dir, o.dir), kind: 'other', tool: o.sync === false });
  return { targets: out, fromMap: m.exists };
}

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
  if (isGitRepo(brain.dir)) {
    if (memory) out.memory.push({ label: 'ai_brain', ...(dryRun ? { committed: false, why: 'dry run: would commit claude-memory when it changed' } : await commitMemory(brain.dir, { '.': 'claude-memory' }, run)) });
    add('ai_brain', await syncRepo(brain.dir, '.', run, { push, dryRun }));
  } else add('ai_brain', notHere(brain));
  const covered = new Set([brain.dir]);
  for (const t of targets.filter((x) => x.kind === 'project')) {
    covered.add(t.dir);
    if (!isGitRepo(t.dir)) {
      add(t.label, notHere(t));
      continue;
    }
    // A project: its parent and the code repositories its project.json names, as `project sync` does.
    const skip = all.targets.filter((x) => x.kind === 'repo' && x.project === t.project && x.tool).map((x) => x.rel);
    const r = await syncWorkspace(t.dir, { memory, run, push, dryRun, skip });
    if (r.memory) out.memory.push({ label: t.label, ...r.memory });
    for (const x of r.repos) {
      const full = x.rel === '.' ? t.dir : path.join(t.dir, x.rel);
      covered.add(full);
      add(x.rel === '.' ? t.label : `${t.label}/${x.rel}`, x);
    }
  }
  // Code repositories the map has but project.json does not, and the other repositories.
  for (const t of targets.filter((x) => x.kind !== 'project' && x.kind !== 'brain' && !covered.has(x.dir) && !all.targets.some((p) => p.kind === 'project' && p.tool && p.project === x.project))) {
    if (!fs.existsSync(t.dir)) add(t.label, notHere(t));
    else add(t.label, await syncRepo(t.dir, t.label, run, { push, dryRun }));
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
